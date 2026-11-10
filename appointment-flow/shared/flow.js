// The appointment rules from the discussion doc, as pure functions over the
// demo state: booking and slots, check-in and tokens, the queue line, grace
// and late patients, the wait estimate (Feature 1), reminders (Feature 10),
// location rules and arrival calls (Feature 2), and the refund rule
// (Feature 11). The queue is dynamic: everyone's expected arrival (live
// location, trip plan, the arrival call, "I'll be late") feeds projection(),
// which places late patients by when they'll actually get here instead of at
// the end. runEngine() applies every time-based rule; the store calls it
// after each write, so whichever app moves the clock moves the day forward.

import { MIN, HOUR, at, minOfDay, round5, t12, tms, uid, ymd, rupees } from "./util.js";
import { MODE_LABELS, travelMin } from "./trip.js";

const ACTIVE = ["booked", "reserved", "late", "checked_in", "in_consult"];
const NOT_ARRIVED = ["booked", "reserved", "late"];
const BUFFER_MIN = 5;
const RING_MIN = 2;
const STALE_LOCATION_MIN = 15;
const NEAR_KM = 0.3;
export const TRAVEL_MODES = MODE_LABELS;

export const isActive = a => ACTIVE.includes(a.status);
export const notArrived = a => NOT_ARRIVED.includes(a.status);
export const holdsSlot = a => isActive(a) || a.status === "pending_payment" || a.status === "completed";

export const doctorOf = (s, a) => s.doctors.find(d => d.id === a.doctorId);
export const patientOf = (s, a) => s.patients.find(p => p.id === a.patientId);
export const apptMs = a => at(a.date, a.slot);
export const today = s => ymd(s.clock.nowMs);
export const nowMin = s => minOfDay(s.clock.nowMs);

function log(s, text) {
  s.log.unshift({ at: s.clock.nowMs, text });
  s.log.length = Math.min(s.log.length, 200);
}

export function notify(s, a, { kind, title, body, actions = [] }, patientId = a?.patientId) {
  s.notifications.unshift({ id: uid("n"), at: s.clock.nowMs, patientId, apptId: a?.id ?? null, kind, title, body, actions, read: false });
  s.notifications.length = Math.min(s.notifications.length, 100);
}

// ---------- slots and booking ----------

export function slotsFor(s, doctor, date) {
  const taken = new Set(s.appointments.filter(a => a.doctorId === doctor.id && a.date === date && holdsSlot(a)).map(a => a.slot));
  const cutoff = date === today(s) ? nowMin(s) : -1;
  const slots = [];
  for (let m = doctor.start; m + doctor.slotMin <= doctor.end; m += doctor.slotMin) {
    slots.push({ min: m, label: t12(m), free: !taken.has(m) && m > cutoff, past: m <= cutoff });
  }
  return slots;
}

// "10 to 11" style: one choice per hour; the booking takes the first free
// exact slot in it, and the patient gets their check-in time ~2 hours before.
export function rangesFor(s, doctor, date) {
  const byHour = new Map();
  for (const slot of slotsFor(s, doctor, date)) {
    const h = Math.floor(slot.min / 60);
    if (!byHour.has(h)) byHour.set(h, { start: h * 60, end: Math.min((h + 1) * 60, doctor.end), first: null });
    const r = byHour.get(h);
    if (slot.free && r.first == null) r.first = slot.min;
  }
  return [...byHour.values()].map(r => ({ ...r, free: r.first != null, label: `${t12(r.start).replace(":00", "")} to ${t12(r.end).replace(":00", "")}` }));
}

export function nextAvailable(s, doctor) {
  for (let i = 0; i < 7; i++) {
    const date = ymd(s.clock.nowMs + i * 24 * HOUR);
    const slot = slotsFor(s, doctor, date).find(x => x.free);
    if (slot) return { date, slot: slot.min };
  }
  return null;
}

export function slotLabel(s, a) {
  return a.slotEnd != null ? `${t12(a.slot).replace(":00", "")} to ${t12(a.slotEnd).replace(":00", "")}` : t12(a.slot);
}

export function createAppointment(s, { doctorId, patientId, date, slot, slotEnd = null, source, kind = "scheduled", reason = "", status, payment }) {
  const doctor = s.doctors.find(d => d.id === doctorId);
  if (s.appointments.some(a => a.doctorId === doctorId && a.date === date && a.slot === slot && holdsSlot(a))) {
    throw new Error("That slot was just taken. Please pick another.");
  }
  const a = {
    id: uid("a"),
    doctorId,
    patientId,
    date,
    slot,
    slotEnd,
    kind,
    source,
    reason,
    status,
    createdAt: s.clock.nowMs,
    payment: { mode: "clinic", status: "pending", amount: doctor.fee, method: null, history: [], ...payment },
    reminders: {},
    token: null,
    seq: slot,
    calls: [],
    location: null,
    flags: {}
  };
  s.appointments.push(a);
  log(s, `Booked ${patientOf(s, a).name} with ${doctor.name} at ${t12(slot)} (${source}, ${status})`);
  return a;
}

export function confirmBooking(s, a) {
  a.status = "booked";
  const doctor = doctorOf(s, a);
  notify(s, a, {
    kind: "confirmed",
    title: "Appointment confirmed",
    body: `${doctor.name}, ${a.date === today(s) ? "today" : a.date} at ${slotLabel(s, a)}. ${paymentLine(a)}`
  });
}

function paymentLine(a) {
  const p = a.payment;
  if (p.status === "paid") return `Paid ${rupees(p.amount)}.`;
  if (p.mode === "link") return `Pay ${rupees(p.amount)} using the link we sent.`;
  return `Pay ${rupees(p.amount)} at the clinic.`;
}

// ---------- payments and refunds (state side; gateway calls live in payments.js) ----------

export function markPaid(s, a, { method, paymentId = null, orderId = a.payment.orderId ?? null, by }) {
  const p = a.payment;
  p.status = "paid";
  p.method = method;
  p.paymentId = paymentId;
  p.orderId = orderId;
  p.paidAt = s.clock.nowMs;
  p.error = null;
  p.tax = taxSnapshot(s);
  if (!p.receiptNo) {
    s.receiptSeq = (s.receiptSeq ?? 0) + 1;
    p.receiptNo = `RCPT-${ymd(s.clock.nowMs).replaceAll("-", "")}-${String(s.receiptSeq).padStart(4, "0")}`;
  }
  p.history.push({ at: s.clock.nowMs, text: `Paid ${rupees(p.amount)} by ${method}${by ? ` (${by})` : ""}` });
  log(s, `${patientOf(s, a).name}: payment ${rupees(p.amount)} ${method}`);
}

// GST details frozen onto a payment when it's marked paid (see receipt.js).
export function taxSnapshot(s) {
  return { gstin: s.clinic.gstin ?? "", rate: Number(s.settings.gstRate ?? 0), sac: s.settings.sac ?? "9993", state: s.clinic.state ?? "" };
}

export function markFailed(s, a, error) {
  a.payment.status = "failed";
  a.payment.error = error;
  a.payment.history.push({ at: s.clock.nowMs, text: `Failed: ${error}` });
}

export function refundRule(settings) {
  return [
    ["Doctor cancels", "Full refund"],
    [`You cancel ${settings.fullRefundHours}+ hours before`, "Full refund"],
    ["You cancel later", settings.lateCancelRefundPct ? `${settings.lateCancelRefundPct}% refund` : "No refund"],
    ["You don't show up", settings.noShowRefundPct ? `${settings.noShowRefundPct}% refund` : "No refund"]
  ];
}

export function refundQuote(s, a, reason) {
  const p = a.payment;
  if (p.status !== "paid") return { pct: 0, amount: 0, text: "Nothing has been paid, so there's nothing to refund." };
  const hoursLeft = (apptMs(a) - s.clock.nowMs) / HOUR;
  const st = s.settings;
  let pct = 0;
  if (reason === "doctor" || reason === "not_confirmed") pct = 100;
  else if (reason === "patient") pct = hoursLeft >= st.fullRefundHours ? 100 : st.lateCancelRefundPct;
  else if (reason === "no_show") pct = st.noShowRefundPct;
  const amount = Math.round((p.amount * pct) / 100);
  const where = p.paymentId ? "to your original payment method" : "in cash at the counter";
  return { pct, amount, text: amount ? `${rupees(amount)} (${pct}%) will be refunded ${where}.` : "No refund under this clinic's rule." };
}

// Queues the refund. Online payments are picked up by processRefunds() in
// payments.js; cash is handed back at the counter and marked there.
export function requestRefund(s, a, reason) {
  const q = refundQuote(s, a, reason);
  if (!q.amount) return q;
  a.payment.refund = { amount: q.amount, pct: q.pct, reason, status: a.payment.paymentId ? "requested" : "counter", at: s.clock.nowMs };
  a.payment.history.push({ at: s.clock.nowMs, text: `Refund ${rupees(q.amount)} requested (${reason})` });
  return q;
}

export function cancelAppointment(s, a, by) {
  if (!isActive(a) && a.status !== "pending_payment") return null;
  a.status = "cancelled";
  a.cancelledBy = by;
  a.cancelledAt = s.clock.nowMs;
  if (a.location) a.location.sharing = false;
  const q = requestRefund(s, a, by === "doctor" ? "doctor" : "patient");
  const doctor = doctorOf(s, a);
  notify(s, a, {
    kind: "cancelled",
    title: by === "doctor" ? `${doctor.name} had to cancel` : "Appointment cancelled",
    body: `${slotLabel(s, a)} on ${a.date === today(s) ? "today" : a.date}. ${q.amount ? q.text : ""}`.trim()
  });
  log(s, `${patientOf(s, a).name} cancelled by ${by}${q.amount ? `, refund ${rupees(q.amount)}` : ""}`);
  return q;
}

export function markNoShow(s, a, why) {
  a.status = "no_show";
  a.noShowAt = s.clock.nowMs;
  if (a.location) a.location.sharing = false;
  const q = requestRefund(s, a, "no_show");
  log(s, `${patientOf(s, a).name} marked no-show (${why})${q.amount ? `, refund ${rupees(q.amount)}` : ""}`);
}

// ---------- check-in, tokens, the line ----------

function nextToken(s, a) {
  const key = `${a.doctorId}|${a.date}`;
  s.tokens[key] = (s.tokens[key] ?? 0) + 1;
  return s.tokens[key];
}

export function line(s, doctorId, date) {
  const mine = s.appointments.filter(a => a.doctorId === doctorId && a.date === date);
  return {
    serving: mine.find(a => a.status === "in_consult") ?? null,
    waiting: mine.filter(a => a.status === "checked_in").sort((x, y) => x.seq - y.seq || x.slot - y.slot)
  };
}

export function checkIn(s, a, by) {
  if (!notArrived(a) && a.status !== "no_show") return;
  const was = a.status;
  a.token = a.token ?? nextToken(s, a);
  a.checkedInAt = s.clock.nowMs;
  a.checkedInBy = by;
  if (a.location) a.location.sharing = false;
  // Place in line by arrival, not "late = last": within grace they keep their
  // slot; later than that they go in as if booked for (arrival - grace).
  a.seq = queueKey(s, a, s.clock.nowMs);
  if (was === "reserved") a.flags.arrivedInGrace = true;
  if (a.seq !== a.slot) a.flags.lateArrival = true;
  a.status = "checked_in";
  a.estStartMs = null; // new baseline; checking in isn't a "wait changed" push
  const doctor = doctorOf(s, a);
  notify(s, a, { kind: "checked_in", title: `Checked in. Your token is ${a.token}`, body: `You're in the queue for ${doctor.name}.` });
  log(s, `${patientOf(s, a).name} checked in (${by}), token ${a.token}${was !== "booked" ? `, was ${was}` : ""}`);
}

// Late arrival or no-show back in line, after the next n waiting patients.
export function reinsert(s, a, afterN) {
  if (a.status !== "checked_in") checkIn(s, a, "reception");
  const others = line(s, a.doctorId, a.date).waiting.filter(w => w.id !== a.id);
  const before = others[afterN - 1];
  const after = others[afterN];
  if (!before) a.seq = (others[0]?.seq ?? a.slot) - 1;
  else a.seq = after ? (before.seq + after.seq) / 2 : before.seq + 1;
  log(s, `${patientOf(s, a).name} reinserted after ${afterN} patient(s)`);
}

export function swapWithNext(s, a) {
  const { waiting } = line(s, a.doctorId, a.date);
  const i = waiting.findIndex(w => w.id === a.id);
  const next = waiting[i + 1];
  if (!next) return;
  [a.seq, next.seq] = [next.seq, a.seq];
  log(s, `Swapped ${patientOf(s, a).name} and ${patientOf(s, next).name}`);
}

export function avgConsult(doctor) {
  const recent = doctor.consultLog.slice(-6);
  return recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : doctor.seedAvg;
}

export function completeCurrent(s, doctorId, date) {
  const { serving } = line(s, doctorId, date);
  if (!serving) return;
  serving.status = "completed";
  serving.endedAt = s.clock.nowMs;
  const minutes = Math.max(1, Math.round((serving.endedAt - serving.startedAt) / MIN));
  s.doctors.find(d => d.id === doctorId).consultLog.push(minutes);
  log(s, `${patientOf(s, serving).name} done after ${minutes} min`);
}

export function startConsult(s, a) {
  const doctor = doctorOf(s, a);
  a.status = "in_consult";
  a.startedAt = s.clock.nowMs;
  const early = apptMs(a) - s.clock.nowMs >= 5 * MIN;
  notify(s, a, early
    ? { kind: "called", title: "It's your turn", body: `The doctor is ready for you a bit early. Please head in now. (${doctor.room})` }
    : { kind: "called", title: "It's your turn", body: `Please go in to ${doctor.room}.` });
  log(s, `${patientOf(s, a).name} called in${early ? " (early)" : ""}`);
}

// The doctor finishes and the next present patient goes in. Reserved
// patients who haven't arrived are skipped automatically -- only checked-in
// patients are ever in `waiting`.
export function callNext(s, doctorId, date) {
  completeCurrent(s, doctorId, date);
  const next = line(s, doctorId, date).waiting[0];
  if (next) startConsult(s, next);
  return next ?? null;
}

// ---------- wait estimate (Feature 1) ----------

// ---------- dynamic queue: expected arrivals and the projected order ----------

// Where a not-yet-arrived patient's expected arrival comes from, best first:
// live location; else the newest of the trip they started, the arrival call
// and "I'll be late"; else their slot (assumed on time) while it's still
// ahead; else the end of their grace while reserved; else unknown (null).
export function arrivalOf(s, a) {
  if (!notArrived(a)) return null;
  const now = s.clock.nowMs;
  const loc = a.location;
  if (loc?.sharing && locationFresh(s, a)) {
    const mins = etaMin(loc, now);
    return { etaMs: now + mins * MIN, source: "location", label: `${loc.distanceKm.toFixed(1)} km away, ~${mins} min by ${MODE_LABELS[loc.mode]?.toLowerCase() ?? "road"}`, firm: true };
  }
  const told = [];
  if (a.trip) told.push({ at: a.trip.startedAt, etaMs: a.trip.etaMs, source: "trip", label: `Left at ${tms(a.trip.startedAt)} by ${MODE_LABELS[a.trip.mode]?.toLowerCase()}` });
  const call = a.calls.filter(c => c.status === "done").at(-1);
  const callAt = call ? (call.endedAt ?? call.startedAt) : 0;
  if (call?.outcome === "eta" && call.etaMin != null) told.push({ at: callAt, etaMs: callAt + call.etaMin * MIN, source: "call", label: `Said ~${call.etaMin} min on the call${call.mode ? ` (${MODE_LABELS[call.mode]?.toLowerCase()})` : ""}` });
  if (call?.outcome === "at_clinic") told.push({ at: callAt, etaMs: callAt + 2 * MIN, source: "call", label: "Said they're at the clinic" });
  if (a.lateNote) told.push({ at: a.lateNote.at, etaMs: apptMs(a) + a.lateNote.minutes * MIN, source: "patient", label: `Said ~${a.lateNote.minutes} min late` });
  if (told.length) {
    const t = told.reduce((x, y) => (y.at > x.at ? y : x));
    // Promised time has passed and they're still not here: assume a few more minutes.
    return { ...t, etaMs: Math.max(t.etaMs, now + 3 * MIN), overdue: t.etaMs < now, firm: true };
  }
  if (a.status === "booked" && apptMs(a) > now) return { etaMs: apptMs(a), source: "slot", label: "Assumed on time", firm: false };
  if (a.status === "reserved") return { etaMs: a.graceUntil, source: "grace", label: `Slot held until ${tms(a.graceUntil)}`, firm: false };
  return null;
}

// Queue priority in minutes of the day (lower goes first). Arriving by the end
// of grace keeps the booked slot; arriving later counts as booked for
// (arrival - grace) -- they lose only the time they were late, never sent to
// the back.
export function queueKey(s, a, arrivalMs) {
  const grace = s.settings.graceMin * MIN;
  if (arrivalMs <= apptMs(a) + grace) return a.slot;
  return Math.max(a.slot, minOfDay(arrivalMs - grace));
}

// The doctor's day from now on: whoever is ready (checked in, or expected to
// have arrived by then) with the lowest queue key goes next. Checked-in
// patients are ready now; others from their expected arrival. Patients with
// no idea of arrival go last, flagged unknown.
export function projection(s, doctorId, date) {
  const doctor = s.doctors.find(d => d.id === doctorId);
  const avgMs = avgConsult(doctor) * MIN;
  const now = s.clock.nowMs;
  const { serving, waiting } = line(s, doctorId, date);
  let t = Math.max(now, at(date, doctor.start));
  if (serving) t = now + Math.max(MIN, avgMs - (now - serving.startedAt));
  const pool = waiting.map(a => ({ a, here: true, readyMs: now, key: a.seq, arrival: null }));
  const unknown = [];
  for (const a of s.appointments) {
    if (a.doctorId !== doctorId || a.date !== date || !notArrived(a)) continue;
    const arrival = arrivalOf(s, a);
    if (!arrival || !Number.isFinite(arrival.etaMs)) unknown.push({ a, here: false, readyMs: null, key: Infinity, arrival: null, unknown: true });
    else pool.push({ a, here: false, readyMs: Math.max(now, arrival.etaMs), key: queueKey(s, a, Math.max(now, arrival.etaMs)), arrival });
  }
  const order = [];
  while (pool.length) {
    const ready = pool.filter(c => c.readyMs <= t);
    if (!ready.length) {
      t = Math.min(...pool.map(c => c.readyMs)); // doctor free until the next arrival
      continue;
    }
    const c = ready.reduce((x, y) => (y.key < x.key || (y.key === x.key && y.readyMs < x.readyMs) ? y : x));
    order.push({ ...c, startMs: t });
    pool.splice(pool.indexOf(c), 1);
    t += avgMs;
  }
  for (const c of unknown.sort((x, y) => x.a.slot - y.a.slot)) {
    order.push({ ...c, startMs: t });
    t += avgMs;
  }
  return { serving, order, avg: avgMs / MIN };
}

export function estimate(s, a) {
  if (a.status === "in_consult") return { turn: true };
  const now = s.clock.nowMs;
  const p = projection(s, a.doctorId, a.date);
  const i = p.order.findIndex(c => c.a.id === a.id);
  const mine = p.order[i];
  const before = i < 0 ? [] : p.order.slice(0, i);
  const projectedMs = mine ? mine.startMs : Math.max(now, apptMs(a));
  const ahead = before.length + (p.serving ? 1 : 0);
  const wait = (projectedMs - now) / MIN + (a.status === "checked_in" ? BUFFER_MIN : 0);
  const lo = round5(wait - 5);
  const hi = lo + 10;
  return {
    ahead, onWay: before.filter(c => !c.here).length, position: i + 1, avg: Math.round(p.avg), lo, hi,
    projectedMs, startMs: now + ((lo + hi) / 2) * MIN, unknown: !!mine?.unknown
  };
}

export function estimateText(est, arrived) {
  if (est.turn) return { head: "It's your turn", sub: "Please go in now." };
  if (arrived && est.ahead === 1) return { head: "You're next after this patient.", sub: "Please be ready." };
  if (arrived && est.ahead === 0) return { head: "You're next.", sub: "Please be ready." };
  return {
    head: `${est.ahead} patient${est.ahead === 1 ? "" : "s"} ahead${est.onWay ? ` (${est.onWay} on the way)` : ""}`,
    sub: est.lo ? `Estimated wait: ${est.lo} to ${est.hi} min` : `Estimated wait: under ${est.hi} min`
  };
}

// Suggested check-in time, sent with the 2-hour reminder: when they're likely
// to be seen, less 10 minutes, never earlier than 15 minutes before the slot.
export function checkInTime(s, a) {
  const est = estimate(s, a);
  return Math.max(apptMs(a) - 15 * MIN, est.startMs - 10 * MIN);
}

// ---------- arrival calls ----------

// Which voice engine handles Voice AI calls: scripted, Claude (in the patient
// app, browser speech), or ElevenLabs + Claude (in the app, or a real phone call).
export function callEngine(s) {
  const e = s.settings.callEngine;
  return e === "auto" ? "claude" : e ?? "claude";
}

export function startCall(s, a, trigger) {
  const engine = s.settings.callType === "ivr" ? "ivr" : callEngine(s);
  const provider = engine === "elevenlabs" && s.settings.elevenDelivery === "phone" ? "elevenlabs_phone" : engine;
  const call = { id: uid("call"), type: s.settings.callType, lang: s.settings.callLanguage, trigger, provider, status: "ringing", startedAt: s.clock.nowMs, outcome: null, etaMin: null, coming: null, mode: null, summary: "", engine: null, transcript: [] };
  a.calls.push(call);
  log(s, `${call.type === "ivr" ? "IVR" : provider === "elevenlabs_phone" ? "ElevenLabs phone" : "Voice AI"} call to ${patientOf(s, a).name} (${trigger})`);
  return call;
}

// What the call knows: appointment and queue facts, as ElevenLabs dynamic
// variables (also the Claude-only call's context).
export function callFacts(s, a, lang = s.settings.callLanguage) {
  const est = estimate(s, a);
  const arr = arrivalOf(s, a);
  const first = patientOf(s, a).name.split(" ")[0];
  const doctor = doctorOf(s, a).name;
  const g = s.settings.graceMin;
  return {
    opening_line: lang === "ta"
      ? `வணக்கம் ${first}, ${s.clinic.name} சார்பாக அழைக்கிறேன். ${doctor} உடனான இன்றைய ${slotLabel(s, a)} சந்திப்புக்கு வந்துகொண்டிருக்கிறீர்களா?`
      : `Hello ${first}, this is the assistant from ${s.clinic.name} about your ${slotLabel(s, a)} appointment with ${doctor} today. Are you on your way?`,
    call_language: lang === "ta" ? "Tamil" : "English",
    lang,
    clinic: s.clinic.name,
    address: `${s.clinic.address} (${s.clinic.note})`,
    patient_name: first,
    patient: first,
    doctor,
    slot: slotLabel(s, a),
    now: tms(s.clock.nowMs),
    grace_min: g,
    graceMin: g,
    queue: `${est.ahead} patient(s) ahead of them in the projected order, doctor averaging ${est.avg} min per patient. If they arrive within ${g} min of the slot they keep their place; later than that they're fitted in by arrival time (as if booked for arrival minus ${g} min), never sent to the end. ${a.status === "reserved" ? `Their slot is held until ${tms(a.graceUntil)}.` : a.status === "late" ? "Their grace period has already passed." : ""}`.trim(),
    refund: refundQuote(s, a, "patient").text,
    known: [arr?.firm ? `${arr.label}, expected around ${tms(arr.etaMs)}` : "", a.lateNote ? `Told the app they'd be ~${a.lateNote.minutes} min late` : ""].filter(Boolean).join(". ") || "Nothing yet"
  };
}

// note: anything extra the patient told the Voice AI for the doctor.
// coming: yes | no | unsure; mode: how they're travelling; summary: one line
// for reception (the AI writes it on live calls).
export function finishCall(s, a, { outcome, etaMin = null, transcript = [], note = "", coming = null, mode = null, summary = "", engine = null, costUsd = null, durationSecs = null }) {
  const call = a.calls.at(-1);
  if (!call || call.status === "done") return;
  coming ??= { eta: "yes", at_clinic: "yes", cancelled: "no", no_answer: null }[outcome] ?? "unsure";
  Object.assign(call, { status: "done", outcome, etaMin, transcript, note, coming, mode, summary, engine: engine ?? call.engine, costUsd, durationSecs, endedAt: s.clock.nowMs });
  if (outcome === "cancelled") cancelAppointment(s, a, "patient");
  log(s, `Call result for ${patientOf(s, a).name}: ${callResultText(call)}`);
}

export function callResultText(call) {
  if (!call) return "";
  if (call.status === "ringing") return "Calling now…";
  if (call.status === "in_progress") return "On the call now…";
  const how = call.mode && MODE_LABELS[call.mode] ? ` by ${MODE_LABELS[call.mode].toLowerCase()}` : "";
  return {
    eta: `Coming: about ${call.etaMin} min${how}`,
    at_clinic: "Coming: at the clinic, not checked in",
    cancelled: "Not coming: cancelled on the call",
    unsure: "Not sure they can make it",
    no_answer: "No answer"
  }[call.outcome] ?? call.outcome;
}

// ---------- location ----------

export function locationFresh(s, a) {
  const loc = a.location;
  return !!loc?.sharing && s.clock.nowMs - loc.updatedAt < STALE_LOCATION_MIN * MIN;
}

// paceFactor: set when the trip's time came from Google Maps, so the remaining
// estimate keeps Google's pace for that route.
export function etaMin(loc, atMs = Date.now()) {
  return Math.max(1, Math.round(travelMin(loc.mode ?? "car", loc.distanceKm, atMs) * (loc.paceFactor ?? 1)));
}

// The patient picked a way to travel and set off (trip planner). etaMs is
// what the planner showed; live location, if shared, takes over from it.
export function startTrip(s, a, { mode, etaMs, distanceKm, cost, source = "estimate" }) {
  a.trip = { mode, etaMs, distanceKm, cost, source, startedAt: s.clock.nowMs };
  log(s, `${patientOf(s, a).name} set off by ${MODE_LABELS[mode]}, expected ${tms(etaMs)}`);
}

export function startSharing(s, a, mode, distanceKm) {
  a.location = { sharing: true, mode, distanceKm, startKm: distanceKm, startedAt: s.clock.nowMs, updatedAt: s.clock.nowMs, moving: true, sending: true };
  log(s, `${patientOf(s, a).name} is on the way (${TRAVEL_MODES[mode]}, ${distanceKm.toFixed(1)} km)`);
}

// ---------- the time-based rules ----------

const LATE_MSG = minutes => `We're seeing another patient while we wait for you. Your slot is held. Please arrive within ${minutes} minutes.`;
const GRACE_OVER_MSG = "Your reserved slot has passed. Check in when you arrive: you'll be fitted in by when you get here, not sent to the end of the line.";
const LATE_MSG_DYNAMIC = (etaMs, est) => `We'll fit you in by when you arrive (about ${tms(etaMs)}), not at the end of the line. Expected to go in around ${tms(est.projectedMs)}${est.ahead ? `, after ${est.ahead} patient${est.ahead === 1 ? "" : "s"}` : ""}.`;

export function runEngine(s) {
  const now = s.clock.nowMs;
  const dt = Math.max(0, now - (s.clock.lastEngineMs ?? now));
  s.clock.lastEngineMs = now;
  const st = s.settings;
  const day = today(s);

  for (const a of s.appointments) {
    // A pending payment holds the slot for a few minutes, then lets it go.
    if (a.status === "pending_payment" && now - a.createdAt >= st.holdMin * MIN) {
      a.status = "expired";
      log(s, `Payment hold expired for ${patientOf(s, a).name} at ${t12(a.slot)}`);
    }
    if (!isActive(a)) continue;
    const slotMs = apptMs(a);
    const doctor = doctorOf(s, a);

    // Reminders: a day before and ~2 hours before, each with Confirm / Cancel.
    // No reply keeps the booking.
    if (a.status === "booked") {
      if (!a.reminders.day && now >= slotMs - 24 * HOUR && a.createdAt < slotMs - 24 * HOUR) {
        a.reminders.day = now;
        notify(s, a, { kind: "reminder", title: "Appointment tomorrow", body: `${doctor.name} at ${slotLabel(s, a)}. Will you make it?`, actions: ["confirm", "cancel"] });
      }
      if (!a.reminders.twoHour && now >= slotMs - 2 * HOUR && a.createdAt < slotMs - 2 * HOUR) {
        a.reminders.twoHour = now;
        a.checkInBy = checkInTime(s, a);
        notify(s, a, { kind: "reminder", title: `Today at ${slotLabel(s, a)}`, body: `Based on how the clinic is running today, please check in by ${tms(a.checkInBy)}.`, actions: ["confirm", "cancel", "leaving"] });
      }
    }
    if (a.date !== day) continue;

    // Simulated movement for patients sharing location.
    const loc = a.location;
    if (loc?.sharing && loc.sending) {
      if (loc.moving && dt) {
        // Cover the remaining distance at the pace the route model expects now.
        const speed = loc.distanceKm / Math.max(1, etaMin(loc, now)) * 60;
        loc.distanceKm = Math.max(0, loc.distanceKm - (speed * dt) / HOUR);
      }
      loc.updatedAt = now;
      if (loc.distanceKm <= NEAR_KM && !a.flags.nearPrompted) {
        a.flags.nearPrompted = true;
        notify(s, a, { kind: "near", title: "You're near the clinic", body: "Scan the QR at the counter to check in.", actions: ["checkin"] });
      }
    }

    // Expected after their grace (location, trip, call or "I'll be late"):
    // tell them where they'll slot in, and tell the next patient they may be
    // seen early.
    const arr = notArrived(a) ? arrivalOf(s, a) : null;
    if (notArrived(a) && arr?.firm && !a.flags.lateWarned && arr.etaMs > slotMs + st.graceMin * MIN) {
      a.flags.lateWarned = true;
      const est = estimate(s, a);
      notify(s, a, { kind: "late", title: "Running late? Your place moves with you", body: LATE_MSG_DYNAMIC(arr.etaMs, est) });
      const next = s.appointments
        .filter(x => x.doctorId === a.doctorId && x.date === a.date && x.slot > a.slot && isActive(x) && x.status !== "in_consult")
        .sort((x, y) => x.slot - y.slot)[0];
      if (next) notify(s, next, { kind: "early", title: "You may be seen a bit early", body: "The patient before you is running late. Please be ready." });
    }

    // Slot time, not checked in: hold the place for the grace period.
    if (a.status === "booked" && now >= slotMs) {
      a.status = "reserved";
      a.graceUntil = slotMs + st.graceMin * MIN;
      notify(s, a, { kind: "late", title: "Your slot is held", body: LATE_MSG(Math.max(1, Math.ceil((a.graceUntil - now) / MIN))) });
      log(s, `${patientOf(s, a).name} reserved: next in line until ${tms(a.graceUntil)}`);
    }
    if (a.status === "reserved" && now >= a.graceUntil) {
      a.status = "late";
      notify(s, a, { kind: "grace_over", title: "Your reserved slot has passed", body: GRACE_OVER_MSG });
      log(s, `${patientOf(s, a).name}: grace over, late arrival`);
    }

    // Location on but never left home: no-show after the longer cutoff.
    if (notArrived(a) && locationFresh(s, a) && loc.distanceKm >= loc.startKm - 0.2 && now >= slotMs + st.noShowCutoffMin * MIN) {
      markNoShow(s, a, "location shows they never left");
      continue;
    }

    // Arrival call for anyone not here by the trigger time -- unless live
    // location already tells us. One follow-up if they promised a time and
    // are 10+ min past it.
    if (notArrived(a) && !a.calls.length && !locationFresh(s, a) && now >= slotMs - st.callBeforeMin * MIN) startCall(s, a, "auto");
    const last = a.calls.at(-1);
    if (notArrived(a) && a.calls.length === 1 && last.status === "done" && last.outcome === "eta" && !locationFresh(s, a) && now >= (last.endedAt ?? last.startedAt) + (last.etaMin + 10) * MIN) startCall(s, a, "follow-up");
    const call = a.calls.at(-1);
    // Real phone calls are settled by ElevenLabs' result, not the demo clock.
    if (call?.status === "ringing" && call.provider !== "elevenlabs_phone" && now - call.startedAt >= RING_MIN * MIN) finishCall(s, a, { outcome: "no_answer" });

    // Push only when the expected time shifts by 15+ minutes.
    if (a.status === "booked" || a.status === "checked_in") {
      const est = estimate(s, a);
      if (a.estStartMs == null) a.estStartMs = est.startMs;
      else if (Math.abs(est.startMs - a.estStartMs) >= 15 * MIN) {
        a.estStartMs = est.startMs;
        const text = estimateText(est, a.status === "checked_in");
        const body = [text.head, text.sub].map(x => (/[.!?]$/.test(x) ? x : `${x}.`)).join(" ");
        notify(s, a, { kind: "estimate", title: "Your wait has changed", body });
      }
    }
  }
}
