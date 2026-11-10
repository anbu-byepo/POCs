/**
 * Appointment-flow POC -- the AI arrival call. Each turn of the conversation
 * goes to Claude, which says the next line and keeps a running verdict for the
 * clinic: is the patient coming, how, in how many minutes, anything for the
 * doctor. Served by Netlify at /api/ai-call/* and, for local dev, by
 * appointment-flow/server.mjs (which imports this same handler).
 *
 *   GET  /api/ai-call/config  -> { live, model, reason }
 *   POST /api/ai-call/turn    { context, transcript: [{ who: "bot"|"me", text }] }
 *                             -> { say, end_call, outcome, coming, eta_min, travel_mode, note_for_doctor, summary_for_clinic }
 *
 * Env: ANTHROPIC_API_KEY. Without it, /config says so and the patient app runs
 * its scripted call instead.
 *
 * POC shortcuts (see ../../audit/appointment-flow-plan.md): the browser drives
 * the call and sends the appointment context; there's no telephony (the
 * patient app plays the call with the browser's speech APIs) and no rate
 * limiting beyond size caps. Production: the server places the call through a
 * telephony provider, builds the context from the booking, and streams
 * speech-to-text / text-to-speech around these same turns.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM, SCHEMA } from "../call-script.mjs";

export const config = { path: "/api/ai-call/*" };

const MODEL = "claude-opus-5-5";
const MAX_TURNS = 30;
const MAX_TEXT = 600;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const live = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const clip = (v, n = MAX_TEXT) => String(v ?? "").slice(0, n);

function contextBlock(c = {}) {
  return [
    `Call language: ${c.lang === "ta" ? "Tamil" : "English"}`,
    `Clinic: ${clip(c.clinic, 120)}, ${clip(c.address, 160)}`,
    `Patient first name: ${clip(c.patient, 60)}`,
    `Doctor: ${clip(c.doctor, 80)}, booked slot ${clip(c.slot, 30)}, the time now is ${clip(c.now, 30)}`,
    `Queue facts: ${clip(c.queue, 400)}`,
    `Grace period: ${Number(c.graceMin) || 10} minutes after the slot`,
    `If they cancel now: ${clip(c.refund, 200)}`,
    c.known ? `Already known: ${clip(c.known, 300)}` : ""
  ].filter(Boolean).join("\n");
}

// The call so far as alternating turns. The first user turn carries the
// appointment facts; the patient's words follow as user turns, our earlier
// lines as assistant turns (plain text, no prefill).
function toMessages(context, transcript) {
  const messages = [{ role: "user", content: `${contextBlock(context)}\n\n[The patient has just answered the phone. Greet them and begin.]` }];
  for (const m of transcript.slice(-MAX_TURNS)) {
    const role = m.who === "bot" ? "assistant" : "user";
    const text = clip(m.text) || "…";
    const last = messages.at(-1);
    if (last.role === role) last.content += `\n${text}`;
    else messages.push({ role, content: text });
  }
  if (messages.at(-1).role === "assistant") messages.push({ role: "user", content: "[silence]" });
  return messages;
}

async function turn(body) {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: toMessages(body.context, Array.isArray(body.transcript) ? body.transcript : [])
  });
  if (response.stop_reason === "refusal") {
    return { say: "Sorry, I'll ask the clinic to call you back. Goodbye.", end_call: true, outcome: "unsure", coming: "unknown", eta_min: -1, travel_mode: "unknown", note_for_doctor: "", summary_for_clinic: "AI call ended early; please call the patient." };
  }
  const text = response.content.find(b => b.type === "text")?.text;
  if (!text) throw new Error(`No reply (stop_reason ${response.stop_reason})`);
  return { ...JSON.parse(text), model: response.model };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/api\/ai-call\/?/, "");
  try {
    if (req.method === "GET" && route === "config") {
      return json(live() ? { live: true, model: MODEL } : { live: false, reason: "ANTHROPIC_API_KEY not set" });
    }
    if (req.method === "POST" && route === "turn") {
      if (!live()) return json({ error: "ANTHROPIC_API_KEY not set" }, 503);
      const body = await req.json().catch(() => null);
      if (!body) return json({ error: "Expected a JSON body" }, 400);
      return json(await turn(body));
    }
    return json({ error: `No route for ${req.method} /api/ai-call/${route}` }, 404);
  } catch (err) {
    const status = err instanceof Anthropic.RateLimitError ? 429 : err instanceof Anthropic.APIError ? 502 : 500;
    return json({ error: err.message }, status);
  }
}
