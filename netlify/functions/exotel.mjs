/**
 * Appointment-flow POC -- the arrival call as a real IVR phone call on Exotel.
 * Keypad only, no AI. Served by Netlify at /api/exotel/* and, for local dev, by
 * appointment-flow/server.mjs (which imports this same handler).
 *
 *   GET  /api/exotel/config               -> { live, reason, allowedTo }
 *   POST /api/exotel/call                 { to, apptId, greeting } -> { sid }
 *        Places the call: Exotel rings `to` and runs the IVR flow (an Exotel
 *        "App" built once in the Exotel dashboard, see below).
 *   GET  /api/exotel/result?sid=...       -> { done, status, answer }
 *        The clinic app polls this until the patient has pressed a key or the
 *        call has ended (no answer, busy, failed, hung up).
 *
 * Called BY EXOTEL (put these URLs in the flow; k = EXOTEL_WEBHOOK_SECRET):
 *   GET  /api/exotel/greeting?k=...                 Greeting applet, dynamic text (name, time, doctor)
 *   GET  /api/exotel/answer?q=attend&a=yes          Passthru applet after each keypress
 *   GET  /api/exotel/answer?q=done                  Passthru just before the closing message
 *        (k is optional here: a CallSid this server placed is accepted without it)
 *   POST /api/exotel/status?k=...                   StatusCallback when the call ends
 *
 * The IVR flow as built in Exotel (App 1383043, "Ninto arrival call"); audio
 * clips are in appointment-flow/ivr-audio/. Q2-Q5 use Gather (1 digit) followed
 * by a Passthru with q= only; this server maps the pressed digit (1/2, 9 = talk
 * to the team) to the answer, so the flow needs no per-key branches.
 *   Opening greeting -> Q1 IVR Menu
 *     1 -> Passthru q=attend&a=yes -> Gather Q2 -> Passthru q=late -> Gather Q4
 *          -> Passthru q=visit -> Gather Q5 -> Passthru q=companion
 *          -> Passthru q=done -> Gather step=closing (reply + closing) -> Hangup
 *     2 -> Passthru q=attend&a=no -> Gather Q3 -> Passthru q=change
 *          -> Passthru q=done -> Gather step=closing (reply + closing) -> Hangup
 *   (Q6 reports skipped for now. Not yet in the flow: 9 -> Connect to reception,
 *    * -> repeat, the "wrong input" clip.)
 *
 * Env:
 *   EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_ACCOUNT_SID   API credentials (Exotel dashboard -> API settings)
 *   EXOTEL_SUBDOMAIN        api.exotel.com (Singapore) or api.in.exotel.com (Mumbai); default api.exotel.com
 *   EXOTEL_CALLER_ID        your ExoPhone (the number patients see)
 *   EXOTEL_APP_ID           the IVR flow's App ID
 *   EXOTEL_WEBHOOK_SECRET   random string; Exotel's calls to us must carry ?k=<it>
 *   EXOTEL_PUBLIC_URL       this site's public https URL, for StatusCallback (locally: an ngrok URL)
 *   EXOTEL_ALLOWED_TO       comma-separated numbers calls may go to (the endpoint is public)
 *
 * Call state lives in Netlify Blobs (shared by all function instances); the
 * local dev server, which has no Blobs, keeps it in memory.
 */

import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const config = { path: "/api/exotel/*" };

const env = k => process.env[k] ?? "";
const REQUIRED = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_ACCOUNT_SID", "EXOTEL_CALLER_ID", "EXOTEL_APP_ID", "EXOTEL_WEBHOOK_SECRET"];
// Question -> allowed answers (same as shared/flow.js IVR_VALUES).
const ANSWERS = { attend: ["yes", "no"], late: ["yes", "no"], change: ["reschedule", "cancel"], visit: ["in_person", "video"], companion: ["yes", "no"], reports: ["yes", "no"], agent: ["yes"] };
const ENDED = ["completed", "failed", "busy", "no-answer", "canceled"];

// ---------- spoken replies ----------
// After each answer the caller hears a reply for it ("சரி, லேட்டா வர்றீங்கன்னு
// டாக்டர் கிட்ட சொல்லிடறோம்") and then the next question. Exotel's Gather
// applets for Q2-Q5 and the closing load their prompt from GET /gather?step=...
// (dynamic URL mode); this server answers with an audio_url that joins
// [reply to the last answer] + [the step's clip], served by GET /audio/<a>+<b>.wav.
// Clips: appointment-flow/ivr-audio/*.wav (8 kHz mono 16-bit, Exotel's format).
const AUDIO_DIR = new URL("../../appointment-flow/ivr-audio/", import.meta.url);
const STEP_CLIP = { late: "02_q2_late", change: "03_q3_reschedule", visit: "04_q4_visit_mode", companion: "05_q5_companion", closing: "08_closing" };
const CLIPS = new Set([...Object.values(STEP_CLIP), ...Object.entries(ANSWERS).flatMap(([q, as]) => as.map(a => `r_${q}_${a}`))]);
const clipCache = new Map();
async function pcmOf(name) {
  if (!clipCache.has(name)) {
    const buf = await readFile(fileURLToPath(new URL(`${name}.wav`, AUDIO_DIR)));
    // Walk the RIFF chunks to the "data" chunk.
    let i = 12;
    while (i + 8 <= buf.length && buf.toString("ascii", i, i + 4) !== "data") i += 8 + buf.readUInt32LE(i + 4);
    clipCache.set(name, buf.subarray(i + 8, i + 8 + buf.readUInt32LE(i + 4)));
  }
  return clipCache.get(name);
}
function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const GAP = Buffer.alloc(8000 * 2 * 0.3); // 0.3 s pause between reply and question
const publicBase = req => (env("EXOTEL_PUBLIC_URL") || new URL(req.url).origin).replace(/\/$/, "");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const digits = n => String(n ?? "").replace(/[^\d+]/g, "");
const allowedList = () => env("EXOTEL_ALLOWED_TO").split(",").map(digits).filter(Boolean);
const mask = n => `${n.slice(0, 4)}…${n.slice(-3)}`;

// ---------- call state: Netlify Blobs, or memory for local dev ----------
const memory = new Map();
let blobs;
function store() {
  if (blobs !== undefined) return blobs;
  try {
    blobs = getStore("exotel-calls");
  } catch {
    blobs = null; // not running on Netlify
  }
  return blobs;
}
async function load(sid) {
  const s = store();
  if (s) {
    try {
      return await s.get(sid, { type: "json" });
    } catch {
      blobs = null;
    }
  }
  return memory.get(sid) ?? null;
}
async function save(sid, patch) {
  const next = { ...(await load(sid)), ...patch, updatedAt: Date.now() };
  const s = store();
  if (s) {
    try {
      await s.setJSON(sid, next);
      return next;
    } catch {
      blobs = null;
    }
  }
  memory.set(sid, next);
  return next;
}

function configState() {
  const missing = REQUIRED.filter(k => !env(k));
  if (missing.length) return { live: false, reason: `Missing ${missing.join(", ")}` };
  if (!allowedList().length) return { live: false, reason: "EXOTEL_ALLOWED_TO is empty" };
  return { live: true };
}

// Exotel's request back to us: the secret must match.
const fromExotel = url => env("EXOTEL_WEBHOOK_SECRET") && url.searchParams.get("k") === env("EXOTEL_WEBHOOK_SECRET");

// Exotel sends parameters as query string (Passthru, dynamic URLs) or as a
// form / JSON body (StatusCallback).
async function params(req, url) {
  const out = Object.fromEntries(url.searchParams);
  if (req.method === "POST") {
    const text = await req.text().catch(() => "");
    try {
      Object.assign(out, JSON.parse(text));
    } catch {
      Object.assign(out, Object.fromEntries(new URLSearchParams(text)));
    }
  }
  return out;
}

async function placeCall(body) {
  const to = digits(body?.to);
  if (!allowedList().includes(to)) throw Object.assign(new Error("That number isn't in EXOTEL_ALLOWED_TO"), { status: 403 });
  const sid = env("EXOTEL_ACCOUNT_SID");
  const form = new URLSearchParams({
    From: to,
    CallerId: env("EXOTEL_CALLER_ID"),
    Url: `http://my.exotel.com/${sid}/exoml/start_voice/${env("EXOTEL_APP_ID")}`,
    CallType: "trans",
    TimeLimit: "180",
    TimeOut: "30",
    CustomField: String(body?.apptId ?? "").slice(0, 64)
  });
  if (env("EXOTEL_PUBLIC_URL")) {
    form.set("StatusCallback", `${env("EXOTEL_PUBLIC_URL").replace(/\/$/, "")}/api/exotel/status?k=${encodeURIComponent(env("EXOTEL_WEBHOOK_SECRET"))}`);
    // Exotel sends this when the call ends (form-encoded); the event list and
    // content type are left at their defaults (the API rejected "StatusCallbackEvents[0]").
  }
  const auth = Buffer.from(`${env("EXOTEL_API_KEY")}:${env("EXOTEL_API_TOKEN")}`).toString("base64");
  const res = await fetch(`https://${env("EXOTEL_SUBDOMAIN") || "api.exotel.com"}/v1/Accounts/${sid}/Calls/connect.json`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.RestException?.Message ?? `Exotel ${res.status}`), { status: 502 });
  const callSid = data?.Call?.Sid;
  if (!callSid) throw Object.assign(new Error("Exotel returned no call id"), { status: 502 });
  await save(callSid, { apptId: body?.apptId ?? null, greeting: String(body?.greeting ?? "").slice(0, 400), status: "ringing", answers: {}, finished: false, startedAt: Date.now() });
  return { sid: callSid };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/api\/exotel\/?/, "");
  try {
    if (req.method === "GET" && path === "config") {
      return json({ ...configState(), allowedTo: allowedList().map(mask), statusCallback: Boolean(env("EXOTEL_PUBLIC_URL")) });
    }
    if (req.method === "POST" && path === "call") {
      const cfg = configState();
      if (!cfg.live) return json({ error: cfg.reason }, 503);
      return json(await placeCall(await req.json().catch(() => null)));
    }
    if (req.method === "GET" && path === "result") {
      const rec = await load(url.searchParams.get("sid") ?? "");
      if (!rec) return json({ error: "Unknown call" }, 404);
      return json({ done: rec.finished || ENDED.includes(rec.status), status: rec.status, answers: rec.answers ?? {}, durationSecs: rec.durationSecs ?? null });
    }

    // Audio for Exotel: one clip or several joined with "+". Only known clip names.
    const audio = path.match(/^audio\/([\w+]+)\.wav$/);
    if (req.method === "GET" && audio) {
      const names = audio[1].split("+");
      if (!names.length || names.length > 3 || !names.every(n => CLIPS.has(n))) return new Response("Not found", { status: 404 });
      const parts = [];
      for (const n of names) parts.push(...(parts.length ? [GAP] : []), await pcmOf(n));
      return new Response(wav(Buffer.concat(parts)), { headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" } });
    }

    // ----- called by Exotel -----
    if (["greeting", "answer", "status", "gather"].includes(path)) {
      const p = await params(req, url);
      const callSid = p.CallSid ?? p.callSid ?? "";
      // Either the secret is in the URL, or (Passthru links, which are typed into
      // the Exotel dashboard without it) the CallSid is one this server placed.
      // Call SIDs are long random ids, so they can't be guessed.
      const known = (path === "answer" || path === "gather") && callSid && (await load(callSid));
      if (!fromExotel(url) && !known) return new Response("Forbidden", { status: 403 });
      if (path === "greeting") {
        const rec = callSid ? await load(callSid) : null;
        return new Response(rec?.greeting || "Hello, this is your clinic calling about your appointment today.", { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (path === "answer") {
        if (!callSid) return new Response("No CallSid", { status: 400 });
        const rec = await load(callSid);
        if (p.q === "done") {
          await save(callSid, { finished: true, status: "answered" });
          return new Response("OK");
        }
        // a= given in the link, or worked out from the key pressed in the Gather
        // before it (Exotel sends it as digits="1"): 1 = first option, 2 = second,
        // 9 = talk to the team. Anything else is ignored and the flow carries on.
        const pressed = String(p.digits ?? "").replace(/"/g, "").trim();
        const a = p.a ?? (pressed === "9" ? null : ANSWERS[p.q]?.[Number(pressed) - 1]);
        const add = pressed === "9" ? { agent: "yes" } : ANSWERS[p.q]?.includes(a) ? { [p.q]: a } : null;
        if (!add) {
          await save(callSid, { last: null }); // no reply for a key we didn't understand
          return p.a ? new Response("Bad answer", { status: 400 }) : new Response("OK");
        }
        const [q, a2] = Object.entries(add)[0];
        await save(callSid, { answers: { ...(rec?.answers ?? {}), ...add }, last: q === "agent" ? null : `r_${q}_${a2}`, status: "answered" });
        return new Response("OK"); // 200 = Passthru continues on its success branch
      }
      if (path === "gather") {
        // Dynamic Gather: reply to the last answer, then this step's question.
        const step = url.searchParams.get("step");
        if (!STEP_CLIP[step]) return json({ error: "Unknown step" }, 400);
        const rec = await load(callSid);
        const reply = rec?.last && CLIPS.has(rec.last) ? rec.last : null;
        const base = `${publicBase(req)}/api/exotel/audio/`;
        const closing = step === "closing";
        return json({
          gather_prompt: { audio_url: `${base}${[reply, STEP_CLIP[step]].filter(Boolean).join("+")}.wav` },
          max_input_digits: 1,
          finish_on_key: "",
          input_timeout: closing ? 1 : 5,
          repeat_menu: closing ? 0 : 2,
          repeat_gather_prompt: { audio_url: `${base}${STEP_CLIP[step]}.wav` }
        });
      }
      if (path === "status") {
        if (callSid) {
          const rec = await load(callSid);
          const status = String(p.Status ?? p.status ?? "").toLowerCase();
          await save(callSid, { status: status || "completed", callStatus: status, durationSecs: Number(p.ConversationDuration ?? p.Duration ?? 0) || null });
        }
        return new Response("OK");
      }
    }
    return json({ error: `No route for ${req.method} /api/exotel/${path}` }, 404);
  } catch (err) {
    return json({ error: err.message }, err.status ?? 500);
  }
}
