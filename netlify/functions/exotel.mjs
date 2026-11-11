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
 *   GET  /api/exotel/greeting?k=...                  Greeting applet, dynamic text:
 *        "Hello Lakshmi, Nair Endocrine Clinic, about your 10:00 AM appointment..."
 *   GET  /api/exotel/answer?k=...&answer=eta20       Passthru applet on each branch
 *   POST /api/exotel/status?k=...                    StatusCallback when the call ends
 *
 * The IVR flow to build in Exotel (App Bazaar), English and/or Tamil:
 *   Greeting (dynamic URL /greeting)
 *   IVR Menu "Press 1 if you're on the way. 2 if you're at the clinic. 3 to cancel."
 *     1 -> IVR Menu "How far away are you? 1 under 10 minutes, 2 ten to twenty,
 *          3 twenty to forty, 4 more than forty."
 *            1..4 -> Passthru /answer?answer=eta10|eta20|eta40|eta60 -> Greeting "Thank you" -> Hangup
 *     2 -> Passthru /answer?answer=here   -> Greeting "Please scan the QR at the counter" -> Hangup
 *     3 -> IVR Menu "Press 1 to confirm cancelling, 2 to go back."
 *            1 -> Passthru /answer?answer=cancel -> Greeting "Cancelled" -> Hangup
 *            2 -> back to the first menu
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

export const config = { path: "/api/exotel/*" };

const env = k => process.env[k] ?? "";
const REQUIRED = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_ACCOUNT_SID", "EXOTEL_CALLER_ID", "EXOTEL_APP_ID", "EXOTEL_WEBHOOK_SECRET"];
const ANSWERS = ["eta10", "eta20", "eta40", "eta60", "here", "cancel"];
const ENDED = ["completed", "failed", "busy", "no-answer", "canceled"];

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
    form.set("StatusCallbackEvents[0]", "terminal");
    form.set("StatusCallbackContentType", "application/json");
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
  await save(callSid, { apptId: body?.apptId ?? null, greeting: String(body?.greeting ?? "").slice(0, 400), status: "ringing", answer: null, startedAt: Date.now() });
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
      return json({ done: Boolean(rec.answer) || ENDED.includes(rec.status), status: rec.status, answer: rec.answer, durationSecs: rec.durationSecs ?? null });
    }

    // ----- called by Exotel -----
    if (["greeting", "answer", "status"].includes(path)) {
      if (!fromExotel(url)) return new Response("Forbidden", { status: 403 });
      const p = await params(req, url);
      const callSid = p.CallSid ?? p.callSid ?? "";
      if (path === "greeting") {
        const rec = callSid ? await load(callSid) : null;
        return new Response(rec?.greeting || "Hello, this is your clinic calling about your appointment today.", { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (path === "answer") {
        const answer = p.answer;
        if (!ANSWERS.includes(answer) || !callSid) return new Response("Bad answer", { status: 400 });
        await save(callSid, { answer, status: "answered" });
        return new Response("OK"); // 200 = Passthru continues on its success branch
      }
      if (path === "status") {
        if (callSid) {
          const rec = await load(callSid);
          const status = String(p.Status ?? p.status ?? "").toLowerCase();
          await save(callSid, { status: rec?.answer ? "answered" : status || "completed", callStatus: status, durationSecs: Number(p.ConversationDuration ?? p.Duration ?? 0) || null });
        }
        return new Response("OK");
      }
    }
    return json({ error: `No route for ${req.method} /api/exotel/${path}` }, 404);
  } catch (err) {
    return json({ error: err.message }, err.status ?? 500);
  }
}
