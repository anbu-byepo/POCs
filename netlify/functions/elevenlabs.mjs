/**
 * Appointment-flow POC -- the arrival call on ElevenLabs Agents, with Claude
 * as the agent's LLM. ElevenLabs runs the voice side (speech-to-text,
 * text-to-speech, turn-taking, the phone line through a SIP trunk or Twilio); Claude decides
 * what to say, using the same script as the Claude-only call
 * (../call-script.mjs). Served by Netlify at /api/elevenlabs/* and, for local
 * dev, by appointment-flow/server.mjs.
 *
 *   GET  /api/elevenlabs/config             -> { live, agent, phone, reason, llm }
 *   POST /api/elevenlabs/setup              -> creates the agent, or updates ELEVENLABS_AGENT_ID's
 *   GET  /api/elevenlabs/signed-url         -> { signedUrl } for an in-app (browser) call
 *   POST /api/elevenlabs/call               { to, variables } -> { conversationId } (real phone call)
 *   GET  /api/elevenlabs/conversation/:id   -> { status, done, transcript, result, durationSecs, costUsd }
 *   POST /api/elevenlabs/webhook            post-call webhook: verifies the signature and logs
 *
 * Env:
 *   ELEVENLABS_API_KEY            required for anything live
 *   ELEVENLABS_AGENT_ID           the agent (create it once with POST /setup, then set this)
 *   ELEVENLABS_PHONE_NUMBER_ID    the phone number imported into ElevenLabs, for real calls
 *   ELEVENLABS_PHONE_PROVIDER     sip (default: a SIP trunk from an Indian carrier such as
 *                                 Plivo or Exotel) or twilio. Twilio can only call Indian
 *                                 mobiles from a non-Indian number, so prefer SIP for India.
 *   ELEVENLABS_ALLOWED_TO         comma-separated numbers real calls may go to (POC safety:
 *                                 the endpoint is public, so it only dials these)
 *   ELEVENLABS_LLM                agent LLM, default claude-opus-5-5
 *   ELEVENLABS_VOICE_ID           optional TTS voice
 *   ELEVENLABS_WEBHOOK_SECRET     optional, to verify the post-call webhook
 *
 * POC shortcuts (see ../../audit/appointment-flow-plan.md): the clinic app
 * starts calls and polls for the result; production does both server-side,
 * with the webhook as the source of truth.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ELEVENLABS_PROMPT, ELEVENLABS_FIRST_MESSAGE, ELEVENLABS_DATA_COLLECTION, TRAVEL_MODES } from "../call-script.mjs";

export const config = { path: "/api/elevenlabs/*" };

const API = "https://api.elevenlabs.io";
const env = name => process.env[name] ?? "";
const llm = () => env("ELEVENLABS_LLM") || "claude-opus-5-5";

// Variables the agent prompt expects ({{name}}); anything else is dropped.
const VARIABLES = ["opening_line", "call_language", "clinic", "address", "patient_name", "doctor", "slot", "now", "queue", "grace_min", "refund", "known"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function eleven(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY"), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.detail;
    throw Object.assign(new Error(typeof detail === "string" ? detail : detail?.message ?? JSON.stringify(detail ?? data).slice(0, 300)), { status: 502 });
  }
  return data;
}

function agentBody() {
  return {
    name: "Ninto arrival call (appointment-flow POC)",
    conversation_config: {
      agent: {
        first_message: ELEVENLABS_FIRST_MESSAGE,
        language: "en",
        prompt: { prompt: ELEVENLABS_PROMPT, llm: llm(), temperature: 0 }
      },
      ...(env("ELEVENLABS_VOICE_ID") ? { tts: { voice_id: env("ELEVENLABS_VOICE_ID") } } : {})
    },
    platform_settings: { data_collection: ELEVENLABS_DATA_COLLECTION }
  };
}

const clip = (v, n = 400) => (typeof v === "number" || typeof v === "boolean" ? v : String(v ?? "").slice(0, n));
function variables(input = {}) {
  return Object.fromEntries(VARIABLES.map(k => [k, clip(input[k] ?? "")]));
}

const digits = n => String(n ?? "").replace(/[^\d+]/g, "");
function allowedTo(to) {
  const list = env("ELEVENLABS_ALLOWED_TO").split(",").map(digits).filter(Boolean);
  return list.includes(digits(to));
}

// The call's outcome from ElevenLabs' post-call analysis, in the shape the
// app's finishCall() takes.
function result(conv) {
  const d = conv.analysis?.data_collection_results ?? {};
  const v = k => d[k]?.value;
  const coming = ["yes", "no", "unsure"].includes(v("coming")) ? v("coming") : null;
  const eta = Number.isInteger(v("eta_min")) && v("eta_min") >= 0 ? v("eta_min") : null;
  const mode = TRAVEL_MODES.includes(v("travel_mode")) && v("travel_mode") !== "unknown" ? v("travel_mode") : null;
  const talked = (conv.transcript ?? []).some(t => t.role === "user" && t.message);
  let outcome;
  if (v("cancel_confirmed") === true) outcome = "cancelled";
  else if (v("at_clinic") === true) outcome = "at_clinic";
  else if (coming === "yes" && eta != null) outcome = "eta";
  else if (!talked) outcome = "no_answer";
  else outcome = "unsure";
  return {
    outcome, coming, etaMin: eta, mode,
    note: v("note_for_doctor") || "",
    summary: v("summary_for_clinic") || conv.analysis?.transcript_summary || "",
    engine: "elevenlabs"
  };
}

function verifyWebhook(raw, header) {
  const secret = env("ELEVENLABS_WEBHOOK_SECRET");
  if (!secret) return false;
  const parts = Object.fromEntries(String(header ?? "").split(",").map(p => p.split("=")));
  if (!parts.t || !parts.v0) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 30 * 60) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v0);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/api\/elevenlabs\/?/, "");
  const live = Boolean(env("ELEVENLABS_API_KEY"));
  try {
    if (req.method === "GET" && path === "config") {
      return json({
        live, llm: llm(),
        agent: Boolean(env("ELEVENLABS_AGENT_ID")),
        phone: Boolean(env("ELEVENLABS_PHONE_NUMBER_ID")),
        phoneProvider: env("ELEVENLABS_PHONE_PROVIDER") === "twilio" ? "twilio" : "sip",
        allowedTo: env("ELEVENLABS_ALLOWED_TO").split(",").map(digits).filter(Boolean).map(n => `${n.slice(0, 4)}…${n.slice(-3)}`),
        reason: !live ? "ELEVENLABS_API_KEY not set" : !env("ELEVENLABS_AGENT_ID") ? "ELEVENLABS_AGENT_ID not set (POST /api/elevenlabs/setup creates the agent)" : null
      });
    }
    if (req.method === "POST" && path === "webhook") {
      const raw = await req.text();
      const ok = verifyWebhook(raw, req.headers.get("elevenlabs-signature"));
      if (!ok) return json({ error: "Bad signature" }, 401);
      const event = JSON.parse(raw);
      console.log("ElevenLabs webhook", event.type, event.data?.conversation_id, event.data?.analysis?.call_successful);
      return json({ received: true });
    }
    if (!live) return json({ error: "ELEVENLABS_API_KEY not set" }, 503);

    if (req.method === "POST" && path === "setup") {
      const id = env("ELEVENLABS_AGENT_ID");
      if (id) {
        await eleven("PATCH", `/v1/convai/agents/${encodeURIComponent(id)}`, agentBody());
        return json({ agentId: id, updated: true });
      }
      const created = await eleven("POST", "/v1/convai/agents/create", agentBody());
      return json({ agentId: created.agent_id, created: true, next: "Set ELEVENLABS_AGENT_ID to this id and restart." });
    }
    const agentId = env("ELEVENLABS_AGENT_ID");
    if (!agentId) return json({ error: "ELEVENLABS_AGENT_ID not set" }, 503);

    if (req.method === "GET" && path === "signed-url") {
      const data = await eleven("GET", `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
      return json({ signedUrl: data.signed_url });
    }
    if (req.method === "POST" && path === "call") {
      const body = await req.json().catch(() => ({}));
      if (!env("ELEVENLABS_PHONE_NUMBER_ID")) return json({ error: "ELEVENLABS_PHONE_NUMBER_ID not set" }, 503);
      if (!allowedTo(body.to)) return json({ error: "That number isn't in ELEVENLABS_ALLOWED_TO" }, 403);
      const via = env("ELEVENLABS_PHONE_PROVIDER") === "twilio" ? "twilio" : "sip-trunk";
      const data = await eleven("POST", `/v1/convai/${via}/outbound-call`, {
        agent_id: agentId,
        agent_phone_number_id: env("ELEVENLABS_PHONE_NUMBER_ID"),
        to_number: digits(body.to),
        conversation_initiation_client_data: { dynamic_variables: variables(body.variables) },
        telephony_call_config: { ringing_timeout_secs: 45 }
      });
      if (!data.success) return json({ error: data.message || "Call not placed" }, 502);
      return json({ conversationId: data.conversation_id, callId: data.callSid ?? data.sip_call_id ?? null });
    }
    const m = path.match(/^conversation\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const conv = await eleven("GET", `/v1/convai/conversations/${m[1]}`);
      const done = conv.status === "done" || conv.status === "failed";
      return json({
        status: conv.status,
        done,
        transcript: (conv.transcript ?? []).filter(t => t.message).map(t => ({ who: t.role === "agent" ? "bot" : "me", text: t.message })),
        result: done ? (conv.status === "failed" ? { outcome: "no_answer", engine: "elevenlabs" } : result(conv)) : null,
        durationSecs: conv.metadata?.call_duration_secs ?? null,
        costUsd: conv.metadata?.cost_fiat ?? null
      });
    }
    return json({ error: `No route for ${req.method} /api/elevenlabs/${path}` }, 404);
  } catch (err) {
    return json({ error: err.message }, err.status ?? 500);
  }
}
