// The appointment rules from the discussion doc, as pure functions over the
// demo state: booking and slots, check-in and tokens, the queue line, grace
// and late patients, the wait estimate (Feature 1), reminders (Feature 10),
// location rules and arrival calls (Feature 2), and the refund rule
// (Feature 11). runEngine() applies every time-based rule; the store calls it
// after each write, so whichever app moves the clock moves the day forward.

import { MIN, HOUR, at, minOfDay, round5, t12, tms, uid, ymd, rupees } from "./util.js";

const ACTIVE = ["booked", "reserved", "late", "checked_in", "in_consult"];
const NOT_ARRIVED = ["booked", "reserved", "late"];
const BUFFER_MIN = 5;
const RING_MIN = 2;
const STALE_LOCATION_MIN = 15;
const NEAR_KM = 0.3;
export const SPEED_KMH = { walk: 5, two_wheeler: 22, car: 18, bus: 14 };
export const TRAVEL_MODES = { walk: "Walk", two_wheeler: "Two-wheeler", car: "Car or cab", bus: "Bus or train" };

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
  p.history.push({ at: s.clock.nowMs, text: `Paid ${rupees(p.amount)} by ${method}${by ? ` (${by})` : ""}` });
  log(s, `${patientOf(s, a).name}: payment ${rupees(p.amount)} ${method}`);
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
  if (was === "reserved") {
    // Arrived within grace: seen right after whoever is with the doctor now.
    // Several in grace at once keep their original slot order.
    a.seq = -100000 + a.slot;
    a.flags.arrivedInGrace = true;
  } else if (was === "late" || was === "no_show") {
    const { waiting } = line(s, a.doctorId, a.date);
    a.seq = (waiting.at(-1)?.seq ?? a.slot) + 1;
    a.flags.lateArrival = true;
  } else {
    a.seq = a.slot;
  }
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

export function estimate(s, a) {
  const doctor = doctorOf(s, a);
  const avg = avgConsult(doctor);
  const now = s.clock.nowMs;
  if (a.status === "in_consult") return { turn: true };
  const { serving, waiting } = line(s, a.doctorId, a.date);
  let present;
  if (a.status === "checked_in") {
    present = waiting.slice(0, waiting.findIndex(w => w.id === a.id));
  } else {
    // Not here yet: present patients who'd go before their slot, plus
    // patients booked earlier who can still turn up.
    present = waiting.filter(w => w.seq < a.slot);
    present = present.concat(s.appointments.filter(x => x.doctorId === a.doctorId && x.date === a.date && x.id !== a.id && x.status === "booked" && x.slot < a.slot));
  }
  const ahead = present.length + (serving ? 1 : 0);
  const remainingCurrent = serving ? Math.max(1, avg - (now - serving.startedAt) / MIN) : 0;
  let wait = remainingCurrent + present.length * avg + BUFFER_MIN;
  if (a.status !== "checked_in") wait = Math.max(wait, (apptMs(a) - now) / MIN);
  const lo = round5(wait - 5);
  const hi = lo + 10;
  return { ahead, avg: Math.round(avg), lo, hi, startMs: now + ((lo + hi) / 2) * MIN };
}

export function estimateText(est, arrived) {
  if (est.turn) return { head: "It's your turn", sub: "Please go in now." };
  if (arrived && est.ahead === 1) return { head: "You're next after this patient.", sub: "Please be ready." };
  if (arrived && est.ahead === 0) return { head: "You're next.", sub: "Please be ready." };
  return {
    head: `${est.ahead} patient${est.ahead === 1 ? "" : "s"} ahead`,
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

export function startCall(s, a, trigger) {
  const call = { id: uid("call"), type: s.settings.callType, lang: s.settings.callLanguage, trigger, status: "ringing", startedAt: s.clock.nowMs, outcome: null, etaMin: null, transcript: [] };
  a.calls.push(call);
  log(s, `${call.type === "ivr" ? "IVR" : "Voice AI"} call to ${patientOf(s, a).name} (${trigger})`);
  return call;
}

// note: anything extra the patient told the Voice AI for the doctor.
export function finishCall(s, a, { outcome, etaMin = null, transcript = [], note = "" }) {
  const call = a.calls.at(-1);
  if (!call || call.status === "done") return;
  Object.assign(call, { status: "done", outcome, etaMin, transcript, note, endedAt: s.clock.nowMs });
  if (outcome === "cancelled") cancelAppointment(s, a, "patient");
  log(s, `Call result for ${patientOf(s, a).name}: ${callResultText(call)}`);
}

export function callResultText(call) {
  if (!call) return "";
  if (call.status === "ringing") return "Calling now…";
  if (call.status === "in_progress") return "On the call now…";
  return {
    eta: `Said about ${call.etaMin} min`,
    at_clinic: "At the clinic, not checked in",
    cancelled: "Cancelled on the call",
    no_answer: "No answer"
  }[call.outcome] ?? call.outcome;
}

// ---------- location ----------

export function locationFresh(s, a) {
  const loc = a.location;
  return !!loc?.sharing && s.clock.nowMs - loc.updatedAt < STALE_LOCATION_MIN * MIN;
}

export function etaMin(loc) {
  return Math.ceil((loc.distanceKm / SPEED_KMH[loc.mode ?? "car"]) * 60);
}

export function startSharing(s, a, mode, distanceKm) {
  a.location = { sharing: true, mode, distanceKm, startKm: distanceKm, startedAt: s.clock.nowMs, updatedAt: s.clock.nowMs, moving: true, sending: true };
  log(s, `${patientOf(s, a).name} is on the way (${TRAVEL_MODES[mode]}, ${distanceKm.toFixed(1)} km)`);
}

// ---------- the time-based rules ----------

const LATE_MSG = minutes => `We're seeing another patient while we wait for you. Your slot is held. Please arrive within ${minutes} minutes.`;
const GRACE_OVER_MSG = "Your reserved slot has passed. Please check in at reception and you'll be seen as soon as possible.";

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
      if (loc.moving && dt) loc.distanceKm = Math.max(0, loc.distanceKm - (SPEED_KMH[loc.mode] * dt) / HOUR);
      loc.updatedAt = now;
      if (loc.distanceKm <= NEAR_KM && !a.flags.nearPrompted) {
        a.flags.nearPrompted = true;
        notify(s, a, { kind: "near", title: "You're near the clinic", body: "Scan the QR at the counter to check in.", actions: ["checkin"] });
      }
    }

    // Location on, running late before their turn: tell them, and tell the
    // next patient they may be seen early.
    if (a.status === "booked" && locationFresh(s, a) && !a.flags.lateWarned && now + etaMin(loc) * MIN > slotMs) {
      a.flags.lateWarned = true;
      notify(s, a, { kind: "late", title: "Running a little late?", body: LATE_MSG(st.graceMin) });
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

    // Arrival call for anyone not here by the trigger time.
    if (notArrived(a) && !a.calls.length && now >= slotMs - st.callBeforeMin * MIN) startCall(s, a, "auto");
    const call = a.calls.at(-1);
    if (call?.status === "ringing" && now - call.startedAt >= RING_MIN * MIN) finishCall(s, a, { outcome: "no_answer" });

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
