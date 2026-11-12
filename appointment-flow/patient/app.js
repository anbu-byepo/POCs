/**
 * Patient app (boards P1-P4 of the discussion doc): doctor profile -> date and
 * slot -> review (refund rule shown before paying) -> Razorpay -> confirmation;
 * reminders with Confirm / Cancel; "I'm leaving
 * now" trip planner (ways to get there with time, cost and a best pick, each
 * with Google Maps directions) and location sharing; "I'll be late"; QR
 * check-in and token; the live wait estimate and place in the dynamic queue;
 * the arrival call answered on this phone -- a live Claude conversation with
 * browser speech when the server has a key, otherwise scripted (or IVR).
 *
 * Payments follow the clinic's setting (prepaid only, patient's choice, or
 * pay at clinic). A prepaid booking holds the slot while paying and is
 * confirmed only when Razorpay says Paid; if the success callback never
 * arrives, the app re-checks the order with Razorpay and confirms or refunds.
 */

import { getState, update, subscribe } from "../shared/store.js";
import {
  slotsFor, rangesFor, nextAvailable, slotLabel, createAppointment, confirmBooking, markPaid, markFailed,
  refundRule, refundQuote, requestRefund, cancelAppointment, checkIn, estimate, estimateText, finishCall,
  startSharing, startTrip, locationFresh, holdsSlot, isActive, notArrived, doctorOf, patientOf, apptMs, notify, avgConsult,
  arrivalOf, etaMin, callFacts, TRAVEL_MODES, today, callChannel
} from "../shared/flow.js";
import { planTrip, costText, mapsUrl, travelMin, distanceKm, CLINIC_LL, DEMO_ORIGINS } from "../shared/trip.js";
import { pay, reconcile, gatewayInfo, paySimulatedLink, startBackgroundWork, payerOf } from "../shared/payments.js";
import { mountSimBar, paymentBadge, toast } from "../shared/ui.js";
import { receiptHtml } from "../shared/receipt.js";
import { etaDue, fetchEta } from "../shared/eta.js";
import { MIN, esc, rupees, t12, tms, ymd, dateLabel, shortDate, addDays, inFrame } from "../shared/util.js";

const frame = document.getElementById("frame");
const devInner = document.getElementById("devinner");

const ui = {
  screen: "home",
  doctorId: null,
  date: null,
  pick: null, // { slot, slotEnd }
  reason: "",
  payChoice: "now",
  apptId: null,
  error: null,
  busy: null,
  sheet: null, // "cancel" | "scan" | "late"
  dropCallback: false,
  call: null, // { apptId, callId, step, transcript: [] }
  gateway: null,
  ai: null, // /api/ai-call/config
  eleven: null, // /api/elevenlabs/config
  voice: true, // speak the AI's lines
  routes: null, // /api/routes/config
  // origin: where the trip starts (GPS fix near Chennai, else a demo
  // neighbourhood). google: Routes API result for that origin.
  trip: { origin: null, located: false, demo: "t_nagar", google: null, googleFor: null, googleBusy: false, googleError: null, pick: null, open: null, share: true, have: { two_wheeler: true, car: false } }
};
const seen = new Set();

if (inFrame()) document.body.classList.add("embedded");
else mountSimBar(document.getElementById("simbar"));

// ---------- helpers ----------

const me = s => s.patients.find(p => p.id === s.me);
const myAppts = s => s.appointments.filter(a => a.patientId === s.me);
const myNotifs = s => s.notifications.filter(n => n.patientId === s.me);
const findAppt = (s, id) => s.appointments.find(a => a.id === id);
const initials = name => name.replace(/^Dr\.\s*/, "").split(/\s+/).map(w => w[0]).slice(0, 2).join("");

function go(screen, extra = {}) {
  Object.assign(ui, { screen, error: null, busy: null, sheet: null }, extra);
  render();
  frame.querySelector(".body")?.scrollTo(0, 0);
}

function statusText(s, a) {
  return {
    pending_payment: "Not confirmed: payment pending",
    expired: "Not confirmed: slot hold expired",
    booked: "Confirmed",
    reserved: "Your slot is being held",
    late: "Reserved slot passed",
    checked_in: `Checked in · Token ${a.token}`,
    in_consult: "It's your turn",
    completed: "Visit complete",
    cancelled: a.cancelledBy === "doctor" ? "Cancelled by the doctor" : a.cancelledBy === "system" ? "Not confirmed, refunded" : "Cancelled",
    no_show: "Marked as no-show"
  }[a.status];
}

// Paid (from Checkout, or found by the re-check). Confirms the booking if the
// slot is still ours; if the hold lapsed and someone else took it, refunds in full.
function settlePaid(s, a, info) {
  if (a.payment.status !== "paid") markPaid(s, a, info);
  if (a.status === "pending_payment") return confirmBooking(s, a);
  if (a.status !== "expired") return;
  const clash = s.appointments.some(x => x.id !== a.id && x.doctorId === a.doctorId && x.date === a.date && x.slot === a.slot && holdsSlot(x));
  if (!clash) return confirmBooking(s, a);
  a.status = "cancelled";
  a.cancelledBy = "system";
  requestRefund(s, a, "not_confirmed");
  notify(s, a, { kind: "refund", title: "Booking couldn't be confirmed", body: `The slot was taken while your payment was being confirmed. A full refund of ${rupees(a.payment.amount)} has been started.` });
}

// ---------- booking and payment ----------

// Reuses this patient's unpaid hold on the same slot (a retry, or Back then
// Pay again) instead of clashing with it.
function holdOrCreate() {
  return update(s => {
    const a = s.appointments.find(x => x.patientId === s.me && x.doctorId === ui.doctorId && x.date === ui.date && x.slot === ui.pick.slot
      && (x.status === "pending_payment" || x.status === "expired") && x.payment.status !== "paid");
    if (a) {
      a.reason = ui.reason || a.reason;
      if (a.status === "pending_payment") return a.id;
      const clash = s.appointments.some(x => x.id !== a.id && x.doctorId === a.doctorId && x.date === a.date && x.slot === a.slot && holdsSlot(x));
      if (clash) throw new Error("That slot has been taken. Please pick another time.");
      a.status = "pending_payment";
      a.createdAt = s.clock.nowMs;
      return a.id;
    }
    return createAppointment(s, {
      doctorId: ui.doctorId, patientId: s.me, date: ui.date, slot: ui.pick.slot, slotEnd: ui.pick.slotEnd,
      source: "patient", reason: ui.reason, status: "pending_payment", payment: { mode: "online" }
    }).id;
  });
}

async function payNow() {
  let id;
  try {
    id = holdOrCreate();
  } catch (err) {
    ui.error = err.message;
    return render();
  }
  ui.apptId = id;
  ui.busy = "Opening Razorpay…";
  render();
  const s = getState();
  const a = findAppt(s, id);
  const doctor = doctorOf(s, a);
  try {
    const r = await pay({
      amountRupees: a.payment.amount,
      description: `Consultation, ${doctor.name}, ${dateLabel(a.date, today(s))} ${slotLabel(s, a)}`,
      prefill: payerOf(s, a),
      notes: { appointmentId: a.id, doctor: doctor.name },
      dropCallback: ui.dropCallback,
      onOrder: orderId => update(st => {
        const x = findAppt(st, id);
        Object.assign(x.payment, { orderId, status: "pending", error: null });
        x.payment.history.push({ at: st.clock.nowMs, text: `Order ${orderId} created` });
      })
    });
    if (r.status === "paid") {
      update(st => settlePaid(st, findAppt(st, id), { method: r.method, paymentId: r.paymentId, orderId: r.orderId, by: "Razorpay Checkout" }));
      return go(findAppt(getState(), id).status === "booked" ? "confirmed" : "appt", { apptId: id });
    }
    if (r.status === "unknown") return checkPayment(id, { delayMs: RECHECK_DELAY_MS });
    update(st => markFailed(st, findAppt(st, id), r.status === "dismissed" ? "You closed the payment window before paying." : r.error));
    go("failed", { apptId: id });
  } catch (err) {
    update(st => markFailed(st, findAppt(st, id), err.message));
    go("failed", { apptId: id });
  }
}

// "Money deducted but booking not confirmed": ask Razorpay about the order.
// After a lost callback the first re-check waits a few seconds, as a real
// app would poll, which also leaves time for the demo's "slot taken" button.
const RECHECK_DELAY_MS = 8000;
let recheckTimer = null;

async function checkPayment(id, { quiet = false, delayMs = 0 } = {}) {
  clearTimeout(recheckTimer);
  if (!quiet) go("checking", { apptId: id });
  if (delayMs) {
    recheckTimer = setTimeout(() => {
      if (ui.screen === "checking" && ui.apptId === id) checkPayment(id);
    }, delayMs);
    return;
  }
  const a = findAppt(getState(), id);
  if (!a?.payment.orderId) return;
  try {
    const r = await reconcile(a.payment.orderId);
    if (r.status === "paid") {
      update(st => settlePaid(st, findAppt(st, id), { method: r.method ?? "online", paymentId: r.paymentId, by: "re-check with Razorpay" }));
      if (!quiet) go(findAppt(getState(), id).status === "booked" ? "confirmed" : "appt", { apptId: id });
      else toast("Payment found", "Your booking has been updated.");
    } else if (r.status === "failed" && !quiet) {
      update(st => markFailed(st, findAppt(st, id), r.error));
      go("failed", { apptId: id });
    } else if (!quiet) {
      ui.busy = null;
      ui.error = "We haven't heard from the bank yet. If money was taken, this booking is confirmed or refunded automatically.";
      render();
    }
  } catch (err) {
    if (!quiet) {
      ui.error = err.message;
      render();
    }
  }
}

function payAtClinicInstead(id) {
  try {
    update(s => {
      const a = findAppt(s, id);
      if (a.status === "expired") {
        const clash = s.appointments.some(x => x.id !== a.id && x.doctorId === a.doctorId && x.date === a.date && x.slot === a.slot && holdsSlot(x));
        if (clash) throw new Error("That slot has been taken. Please pick another time.");
      }
      Object.assign(a.payment, { mode: "clinic", status: "pending", error: null });
      a.payment.history.push({ at: s.clock.nowMs, text: "Switched to pay at clinic" });
      confirmBooking(s, a);
    });
    go("confirmed", { apptId: id });
  } catch (err) {
    ui.error = err.message;
    render();
  }
}

function bookPayAtClinic() {
  try {
    const id = update(s => {
      const a = createAppointment(s, {
        doctorId: ui.doctorId, patientId: s.me, date: ui.date, slot: ui.pick.slot, slotEnd: ui.pick.slotEnd,
        source: "patient", reason: ui.reason, status: "booked", payment: { mode: "clinic" }
      });
      confirmBooking(s, a);
      return a.id;
    });
    go("confirmed", { apptId: id });
  } catch (err) {
    ui.error = err.message;
    render();
  }
}

// ---------- location ----------


// The phone's real permission prompt. A fix within 40 km of the clinic is the
// trip's starting point; otherwise (or with location off) a demo neighbourhood.
function locate() {
  ui.trip.located = "asking";
  render();
  const done = (origin, why) => {
    Object.assign(ui.trip, { origin, located: why });
    fetchRoutes();
    render();
  };
  const demo = () => ({ ...DEMO_ORIGINS[ui.trip.demo] });
  if (!navigator.geolocation) return done(demo(), "demo");
  // The permission prompt can sit unanswered; don't wait on it. A fix that
  // arrives later still replaces the demo start.
  setTimeout(() => ui.trip.located === "asking" && done(demo(), "waiting"), 5000);
  navigator.geolocation.getCurrentPosition(
    pos => {
      const here = { label: "Your location", lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (distanceKm(here, CLINIC_LL) <= 40) done(here, "gps");
      else done(demo(), "far");
    },
    () => done(demo(), "denied"),
    { timeout: 8000, maximumAge: 60000 }
  );
}

function useDemoOrigin(key) {
  ui.trip.demo = key;
  if (ui.trip.located !== "gps") {
    ui.trip.origin = { ...DEMO_ORIGINS[key] };
    ui.trip.located = ui.trip.located || "demo";
    fetchRoutes();
  }
  render();
}

// Real times, distances, tolls and transit fares from the Google Maps Routes
// API (through /api/routes, OAuth with a service account on the server). Without it the
// planner uses its built-in estimates.
async function fetchRoutes() {
  const o = ui.trip.origin;
  if (!o || !ui.routes?.live) return;
  const forKey = `${o.lat.toFixed(3)},${o.lng.toFixed(3)}`;
  if (ui.trip.googleFor === forKey || ui.trip.googleBusy) return;
  Object.assign(ui.trip, { googleBusy: true, googleError: null });
  render();
  try {
    const res = await fetch("/api/routes/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: { lat: o.lat, lng: o.lng }, destination: CLINIC_LL })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Routes API ${res.status}`);
    Object.assign(ui.trip, { google: data, googleFor: forKey });
  } catch (err) {
    Object.assign(ui.trip, { google: null, googleFor: null, googleError: err.message });
  }
  ui.trip.googleBusy = false;
  render();
}

const tripOrigin = () => ui.trip.origin ?? { ...DEMO_ORIGINS[ui.trip.demo] };
const tripKm = () => distanceKm(tripOrigin(), CLINIC_LL);
const googleFresh = () => {
  const o = tripOrigin();
  return ui.trip.google && ui.trip.googleFor === `${o.lat.toFixed(3)},${o.lng.toFixed(3)}` ? ui.trip.google : null;
};

// The time the trip is planned around: their booked slot; within grace, the
// end of grace; after that, now. The app never suggests any other
// "be there by" time.
function arriveBy(s, a) {
  const now = s.clock.nowMs;
  if (a.status === "reserved") return a.graceUntil;
  if (a.status === "late") return now;
  return Math.max(now, apptMs(a));
}

function tripPlan(s, a) {
  const by = arriveBy(s, a);
  const onDay = a.date === today(s);
  const departMs = onDay ? s.clock.nowMs : by - 30 * MIN;
  const plan = planTrip({ straightKm: tripKm(), departMs, arriveBy: by, origin: tripOrigin(), google: googleFresh() });
  plan.options = plan.options.filter(o => !(o.key in ui.trip.have) || ui.trip.have[o.key]);
  if (!plan.options.includes(plan.best)) plan.best = plan.options[0];
  return { ...plan, onDay };
}

// Expected time of reaching the clinic, for today's appointments not yet
// checked in. On the way: from live location, the trip or what they said.
// Not left yet: if they leave now by the best way (Google times when live).
function reachInfo(s, a) {
  if (a.date !== today(s) || !notArrived(a)) return null;
  const now = s.clock.nowMs;
  if (a.trip || a.location?.sharing) {
    const arr = arrivalOf(s, a);
    if (!arr) return null;
    return { onWay: true, etaMs: arr.etaMs, mins: Math.max(0, Math.round((arr.etaMs - now) / MIN)), mode: a.trip?.mode ?? a.location?.mode };
  }
  const b = tripPlan(s, a).best;
  if (!b) return null;
  return { onWay: false, etaMs: now + b.totalMin * MIN, mins: b.totalMin, mode: b.key, label: b.label, live: b.source === "google" };
}

const reachText = r => r.onWay
  ? `Reaching clinic ~${tms(r.etaMs)} · ${r.mins} min away`
  : `Leave now, reach ~${tms(r.etaMs)} · ${r.mins} min by ${r.label.toLowerCase()}${r.live ? " (live traffic)" : ""}`;

function beginTrip(id) {
  const s = getState();
  const a = findAppt(s, id);
  const plan = tripPlan(s, a);
  const o = plan.options.find(x => x.key === ui.trip.pick) ?? plan.best;
  const km = tripKm();
  update(st => {
    const x = findAppt(st, id);
    startTrip(st, x, { mode: o.key, etaMs: st.clock.nowMs + o.totalMin * MIN, distanceKm: km, cost: o.cost, source: o.source });
    if (ui.trip.share) {
      startSharing(st, x, o.key, km, tripOrigin());
      // Keep the simulated movement on Google's pace for this route.
      x.location.paceFactor = o.rideMin / travelMin(o.key, km, st.clock.nowMs);
    }
  });
  go("appt", { apptId: id });
  toast(`On your way by ${o.label.toLowerCase()}`, ui.trip.share ? "Sharing your arrival time with the clinic until you check in. Your location stays on your phone." : "The clinic knows when to expect you.");
}

// ---------- arrival call ----------

const SCRIPTS = {
  en: {
    hello: (s, a) => `Hello ${patientOf(s, a).name.split(" ")[0]}, this is Ninto calling for ${s.clinic.name} about your ${slotLabel(s, a)} appointment with ${doctorOf(s, a).name}. How long will it take you to reach the clinic?`,
    replies: [["10", "I'll be there in 10 minutes"], ["20", "About 20 minutes"], ["30", "About 30 minutes"], ["here", "I'm already at the clinic"], ["cancel", "I can't come, please cancel"]],
    askMode: n => `Thanks, about ${n} minutes. How are you travelling?`,
    modes: [["auto", "By auto"], ["two_wheeler", "On my two-wheeler"], ["cab", "In a cab"], ["transit", "By bus or metro"], ["walk", "Walking"]],
    thanks: n => `Got it. I've told the clinic you'll be there in about ${n} minutes, and you'll be fitted in by when you arrive. Is there anything you'd like the doctor to know before your visit?`,
    noMore: "No, that's all",
    here: "Great, please scan the QR at the counter to check in.",
    confirmCancel: q => `Should I cancel your appointment? ${q}`,
    yes: "Yes, cancel it",
    no: "No, keep it",
    cancelled: "Your appointment is cancelled.",
    unsure: "Sorry, about how many minutes will it take?",
    bye: "Thank you, see you soon.",
    placeholder: "Or type what you'd say…"
  },
  ta: {
    hello: (s, a) => `வணக்கம் ${patientOf(s, a).name.split(" ")[0]}, ${s.clinic.name} சார்பாக Ninto அழைக்கிறது. ${doctorOf(s, a).name} உடனான உங்கள் ${slotLabel(s, a)} சந்திப்பு பற்றி. கிளினிக்கை அடைய எவ்வளவு நேரம் ஆகும்?`,
    replies: [["10", "10 நிமிடத்தில் வந்துவிடுவேன்"], ["20", "சுமார் 20 நிமிடம்"], ["30", "சுமார் 30 நிமிடம்"], ["here", "நான் ஏற்கனவே கிளினிக்கில் இருக்கிறேன்"], ["cancel", "வர முடியாது, ரத்து செய்யுங்கள்"]],
    askMode: n => `நன்றி, சுமார் ${n} நிமிடம். எப்படி வருகிறீர்கள்?`,
    modes: [["auto", "ஆட்டோவில்"], ["two_wheeler", "என் டூ-வீலரில்"], ["cab", "கேபில்"], ["transit", "பஸ் அல்லது மெட்ரோவில்"], ["walk", "நடந்து"]],
    thanks: n => `சரி. நீங்கள் சுமார் ${n} நிமிடத்தில் வருவீர்கள் என்று கிளினிக்கிடம் சொல்லிவிட்டேன். மருத்துவரிடம் சொல்ல வேண்டியது ஏதாவது உள்ளதா?`,
    noMore: "இல்லை, அவ்வளவுதான்",
    here: "சரி, கவுண்டரில் உள்ள QR-ஐ ஸ்கேன் செய்து செக்-இன் செய்யுங்கள்.",
    confirmCancel: q => `உங்கள் சந்திப்பை ரத்து செய்யட்டுமா? ${q}`,
    yes: "ஆம், ரத்து செய்யுங்கள்",
    no: "இல்லை, வைத்திருங்கள்",
    cancelled: "உங்கள் சந்திப்பு ரத்து செய்யப்பட்டது.",
    unsure: "மன்னிக்கவும், சுமார் எத்தனை நிமிடம் ஆகும்?",
    bye: "நன்றி, விரைவில் சந்திப்போம்.",
    placeholder: "அல்லது நீங்கள் சொல்வதை தட்டச்சு செய்யுங்கள்…"
  }
};

const IVR = {
  en: {
    menu: (s, a) => `Ninto, for ${s.clinic.name}, about your ${slotLabel(s, a)} appointment with ${doctorOf(s, a).name}. Press 1 if you're on the way. Press 2 if you're at the clinic. Press 3 to cancel.`,
    far: "How far away are you? Press 1 for under 10 minutes. 2 for 10 to 20 minutes. 3 for 20 to 40 minutes. 4 for more than 40 minutes.",
    confirmCancel: "Press 1 to confirm cancelling. Press 2 to go back.",
    done: "Thank you. The clinic has been told. Goodbye.",
    here: "Please scan the QR at the counter to check in. Goodbye.",
    cancelled: "Your appointment is cancelled. Goodbye.",
    invalid: "Sorry, that's not an option."
  },
  ta: {
    menu: (s, a) => `${doctorOf(s, a).name} உடனான உங்கள் ${slotLabel(s, a)} சந்திப்பு பற்றி Ninto. வழியில் இருந்தால் 1 அழுத்தவும். கிளினிக்கில் இருந்தால் 2. ரத்து செய்ய 3.`,
    far: "எவ்வளவு தூரத்தில் இருக்கிறீர்கள்? 10 நிமிடத்திற்குள் 1. 10 முதல் 20 நிமிடம் 2. 20 முதல் 40 நிமிடம் 3. 40 நிமிடத்திற்கு மேல் 4.",
    confirmCancel: "ரத்து செய்ய 1 அழுத்தவும். திரும்ப 2.",
    done: "நன்றி. கிளினிக்கிடம் தெரிவிக்கப்பட்டது.",
    here: "கவுண்டரில் உள்ள QR-ஐ ஸ்கேன் செய்து செக்-இன் செய்யுங்கள்.",
    cancelled: "உங்கள் சந்திப்பு ரத்து செய்யப்பட்டது.",
    invalid: "மன்னிக்கவும், அது தவறான தேர்வு."
  }
};

// Calls that ring in this app (phone calls ring the patient's phone instead).
function ringingCall(s) {
  for (const a of myAppts(s)) {
    const call = a.calls.at(-1);
    if (call?.status === "ringing" && callChannel(call) === "app") return { a, call };
  }
  return null;
}

// Engine for an in-app call: what the clinic chose, if the server can run it.
function engineFor(call) {
  if (call.type === "ivr") return "ivr";
  if (call.provider === "elevenlabs" && ui.eleven?.live && ui.eleven?.agent) return "elevenlabs";
  if ((call.provider === "claude" || call.provider === "elevenlabs") && ui.ai?.live) return "claude";
  return "script";
}

function answerCall() {
  const s = getState();
  const { a, call } = ringingCall(s);
  const engine = engineFor(call);
  const ai = engine === "claude";
  // Answering stops the no-answer timer.
  update(st => {
    Object.assign(findAppt(st, a.id).calls.at(-1), { status: "in_progress", engine });
  });
  ui.call = { apptId: a.id, callId: call.id, type: call.type, lang: call.lang, engine, ai, step: call.type === "ivr" ? "menu" : "ask", transcript: [], result: null, note: "", verdict: null, thinking: false, error: null };
  if (call.provider === "elevenlabs" && engine !== "elevenlabs") ui.call.error = `ElevenLabs isn't set up on the server (${ui.eleven?.reason ?? "no config"}), so this call uses ${ai ? "Claude with browser speech" : "the script"}.`;
  if (engine === "elevenlabs") return elevenStart();
  if (ai) return aiTurn();
  botSay(call.type === "ivr" ? IVR[call.lang].menu(s, a) : SCRIPTS[call.lang].hello(s, a));
  render();
}

function endCall(result) {
  const { apptId, transcript, note } = ui.call;
  stopListening();
  update(s => finishCall(s, findAppt(s, apptId), { ...result, transcript, note: result.note ?? note }));
  ui.call = null;
  render();
}

function botSay(text) {
  ui.call.transcript.push({ who: "bot", text });
  speak(text, ui.call.lang);
}

// ---------- live AI call (Claude through /api/ai-call) ----------

// What the AI knows about this appointment and the queue right now.
const callContext = (s, a) => callFacts(s, a, ui.call.lang);

// ---------- ElevenLabs call in the app (voice agent with Claude as its LLM) ----------

// ElevenLabs' browser SDK, loaded only when a call needs it.
const ELEVEN_SDK = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.30.0/+esm";
let elevenSession = null;

async function elevenStart() {
  const c = ui.call;
  c.status = "Connecting…";
  render();
  try {
    const [{ Conversation }, signed] = await Promise.all([
      import(ELEVEN_SDK),
      fetch("/api/elevenlabs/signed-url").then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? `signed URL failed (${r.status})`);
        return d;
      })
    ]);
    const s = getState();
    const vars = callFacts(s, findAppt(s, c.apptId), c.lang);
    elevenSession = await Conversation.startSession({
      signedUrl: signed.signedUrl,
      dynamicVariables: Object.fromEntries(Object.entries(vars).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))),
      onMessage: m => {
        if (ui.call !== c || !m.message) return;
        c.transcript.push({ who: (m.role ?? m.source) === "user" ? "me" : "bot", text: m.message });
        render();
      },
      onModeChange: ({ mode }) => {
        if (ui.call !== c) return;
        c.status = mode === "speaking" ? "Assistant speaking…" : "Listening…";
        render();
      },
      onDisconnect: () => ui.call === c && elevenFinish(c),
      onError: err => {
        if (ui.call !== c) return;
        c.error = `ElevenLabs: ${err?.message ?? err}`;
        render();
      }
    });
    c.conversationId = elevenSession.getId();
    c.status = "Listening…";
    render();
  } catch (err) {
    if (ui.call !== c) return;
    // Fall back so the patient isn't left hanging.
    Object.assign(c, { engine: ui.ai?.live ? "claude" : "script", ai: !!ui.ai?.live, status: null, error: `ElevenLabs unavailable (${err.message}). Continuing ${ui.ai?.live ? "with Claude" : "with the scripted call"}.` });
    if (c.ai) return aiTurn();
    const s = getState();
    botSay(SCRIPTS[c.lang].hello(s, findAppt(s, c.apptId)));
    render();
  }
}

// Call over: wait for ElevenLabs' post-call analysis (coming, ETA, mode, note,
// summary), then record it on the appointment.
async function elevenFinish(c) {
  if (c.finishing) return;
  c.finishing = true;
  c.status = "Call ended. Getting the result…";
  render();
  try {
    await elevenSession?.endSession();
  } catch {}
  elevenSession = null;
  let last = null;
  for (let i = 0; i < 30 && c.conversationId; i++) {
    try {
      const r = await fetch(`/api/elevenlabs/conversation/${c.conversationId}`);
      last = await r.json();
      if (last.done) break;
    } catch {}
    await new Promise(res => setTimeout(res, 2000));
  }
  const result = last?.done ? last.result : { outcome: c.transcript.some(m => m.who === "me") ? "unsure" : "no_answer", engine: "elevenlabs", summary: "Call ended before ElevenLabs returned a result." };
  ui.call = c;
  c.transcript = last?.transcript?.length ? last.transcript : c.transcript;
  endCall({ ...result, costUsd: last?.costUsd ?? null, durationSecs: last?.durationSecs ?? null });
}

function verdictResult(v) {
  if (!v) return { outcome: "no_answer" };
  const outcome = v.outcome === "in_progress" ? (v.coming === "yes" && v.eta_min >= 0 ? "eta" : v.coming === "unknown" ? "no_answer" : "unsure") : v.outcome;
  return {
    outcome,
    etaMin: v.eta_min >= 0 ? v.eta_min : null,
    coming: v.coming === "unknown" ? null : v.coming,
    mode: v.travel_mode !== "unknown" ? v.travel_mode : null,
    note: v.note_for_doctor,
    summary: v.summary_for_clinic,
    engine: "claude"
  };
}

async function aiTurn() {
  const c = ui.call;
  c.thinking = true;
  render();
  try {
    const s = getState();
    const res = await fetch("/api/ai-call/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: callContext(s, findAppt(s, c.apptId)), transcript: c.transcript })
    });
    const v = await res.json();
    if (!res.ok) throw new Error(v.error ?? `AI call failed (${res.status})`);
    if (ui.call !== c) return; // hung up meanwhile
    c.thinking = false;
    c.verdict = v;
    botSay(v.say);
    render();
    if (v.end_call) setTimeout(() => ui.call === c && endCall(verdictResult(v)), 1800);
  } catch (err) {
    if (ui.call !== c) return;
    // Carry on with the scripted call rather than drop the patient.
    Object.assign(c, { ai: false, thinking: false, step: "ask", error: `Live AI unavailable (${err.message}). Continuing with the scripted call.` });
    const s = getState();
    botSay(SCRIPTS[c.lang].hello(s, findAppt(s, c.apptId)));
    render();
  }
}

function aiReply(text) {
  if (!text || ui.call.thinking) return;
  ui.call.transcript.push({ who: "me", text });
  aiTurn();
}

const AI_SUGGESTIONS = {
  en: ["Yes, I'm on my way. About 15 minutes by auto.", "I'm running late, maybe half an hour.", "I'm already at the clinic.", "I can't make it today.", "Yes, please cancel it.", "No, that's all. Thanks."],
  ta: ["ஆமாம், வந்துகொண்டிருக்கிறேன். ஆட்டோவில் சுமார் 15 நிமிடம்.", "கொஞ்சம் தாமதம், அரை மணி நேரம் ஆகும்.", "நான் கிளினிக்கில் இருக்கிறேன்.", "இன்று வர முடியாது.", "ஆம், ரத்து செய்யுங்கள்.", "இல்லை, அவ்வளவுதான். நன்றி."]
};

// Browser speech: the AI's lines are spoken, and the patient can talk back
// (Chrome / Edge / Safari speech recognition) or tap / type a reply.
function speak(text, lang) {
  if (!ui.voice || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "ta" ? "ta-IN" : "en-IN";
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;

function listen() {
  if (!Recognition || !ui.call) return;
  stopListening();
  window.speechSynthesis?.cancel();
  recognizer = new Recognition();
  recognizer.lang = ui.call.lang === "ta" ? "ta-IN" : "en-IN";
  recognizer.interimResults = false;
  recognizer.onresult = e => {
    const text = e.results[0]?.[0]?.transcript?.trim();
    ui.call.listening = false;
    if (!text) return render();
    if (ui.call.ai) aiReply(text);
    else voiceReply(ui.call.step === "note" ? "note" : ui.call.step === "confirm_cancel" ? (/yes|ஆம்/i.test(text) ? "yes" : "no") : "text", text);
  };
  recognizer.onerror = recognizer.onend = () => {
    if (ui.call?.listening) {
      ui.call.listening = false;
      render();
    }
  };
  ui.call.listening = true;
  recognizer.start();
  render();
}

function stopListening() {
  try {
    recognizer?.abort();
  } catch {}
  recognizer = null;
  window.speechSynthesis?.cancel();
}

function voiceReply(key, text) {
  const c = ui.call;
  const L = SCRIPTS[c.lang];
  c.transcript.push({ who: "me", text });
  const s = getState();
  const a = findAppt(s, c.apptId);
  if (c.step === "confirm_cancel") {
    if (key === "yes") {
      botSay(L.cancelled);
      return endCall({ outcome: "cancelled" });
    }
    c.step = "ask";
    botSay(SCRIPTS[c.lang].hello(s, a).split(". ").pop());
    return render();
  }
  if (c.step === "note") {
    if (key !== "none") c.note = text;
    botSay(L.bye);
    return endCall(c.result);
  }
  if (c.step === "mode" && key === "text") {
    key = /auto|ஆட்டோ/i.test(text) ? "auto" : /bike|scooter|two|டூ/i.test(text) ? "two_wheeler" : /cab|taxi|uber|ola|கேப்/i.test(text) ? "cab"
      : /bus|metro|train|பஸ்|மெட்ரோ/i.test(text) ? "transit" : /walk|நட/i.test(text) ? "walk" : /car|கார்/i.test(text) ? "car" : "unknown";
  }
  // Free text: pull out a number of minutes, or the intent.
  if (key === "text") {
    const n = text.match(/(\d{1,3})/)?.[1];
    if (/cancel|ரத்து/i.test(text)) key = "cancel";
    else if (/here|reached|at the clinic|கிளினிக்கில்/i.test(text)) key = "here";
    else if (n) key = n;
    else {
      botSay(L.unsure);
      return render();
    }
  }
  if (key === "here") {
    botSay(L.here);
    return endCall({ outcome: "at_clinic" });
  }
  if (key === "cancel") {
    c.step = "confirm_cancel";
    botSay(L.confirmCancel(refundQuote(s, a, "patient").text));
    return render();
  }
  if (c.step === "mode") {
    c.result.mode = key === "unknown" ? null : key;
    c.step = "note";
    botSay(L.thanks(c.result.etaMin));
    return render();
  }
  c.result = { outcome: "eta", etaMin: Number(key) };
  c.step = "mode";
  botSay(L.askMode(key));
  render();
}

function ivrPress(digit) {
  const c = ui.call;
  const L = IVR[c.lang];
  c.transcript.push({ who: "me", text: `Pressed ${digit}` });
  const s = getState();
  const a = findAppt(s, c.apptId);
  if (c.step === "menu") {
    if (digit === "1") {
      c.step = "far";
      botSay(L.far);
    } else if (digit === "2") {
      botSay(L.here);
      return endCall({ outcome: "at_clinic" });
    } else if (digit === "3") {
      c.step = "confirm_cancel";
      botSay(L.confirmCancel);
    } else botSay(L.invalid);
  } else if (c.step === "far") {
    const eta = { 1: 10, 2: 20, 3: 40, 4: 60 }[digit];
    if (!eta) botSay(L.invalid);
    else {
      botSay(L.done);
      return endCall({ outcome: "eta", etaMin: eta });
    }
  } else if (c.step === "confirm_cancel") {
    if (digit === "1") {
      botSay(L.cancelled);
      return endCall({ outcome: "cancelled" });
    }
    c.step = "menu";
    botSay(L.menu(s, a));
  }
  render();
}

// ---------- screens ----------

function topbar(title, back) {
  return `<div class="topbar">${back ? `<span class="back" data-action="nav" data-to="${back}" aria-label="Back">←</span>` : ""}<span class="title">${esc(title)}</span>
    <div class="right">${bell()}</div></div>`;
}

function bell() {
  const unread = myNotifs(getState()).filter(n => !n.read).length;
  return `<button class="bell" data-action="nav" data-to="inbox" aria-label="Notifications">🔔${unread ? `<span class="dot">${unread}</span>` : ""}</button>`;
}

function apptCard(s, a) {
  const d = doctorOf(s, a);
  return `<div class="card tap" data-action="open-appt" data-id="${a.id}">
    <div class="between"><div class="name">${esc(d.name)}</div>${paymentBadge(a)}</div>
    <div class="sub">${dateLabel(a.date, today(s))} · ${esc(slotLabel(s, a))} · ${esc(s.clinic.name)}</div>
    <div class="sub" style="color:var(--ink);font-weight:600">${esc(statusText(s, a))}</div>
    ${(r => (r ? `<div class="sub">🕒 ${esc(reachText(r))}</div>` : ""))(reachInfo(s, a))}
  </div>`;
}

function screenHome(s) {
  const mine = myAppts(s)
    .filter(a => isActive(a) || ((a.status === "pending_payment" || a.status === "expired") && a.payment.status === "failed"))
    .sort((x, y) => apptMs(x) - apptMs(y));
  const past = myAppts(s).filter(a => ["completed", "cancelled", "no_show"].includes(a.status)).sort((x, y) => apptMs(y) - apptMs(x)).slice(0, 3);
  return `
    <div class="appbar"><span class="brand">ninto</span>${bell()}</div>
    <div class="body">
      <div class="h1">Hi ${esc(me(s).name.split(" ")[0])}</div>
      ${mine.length ? `<div class="section-label">Your appointments</div>${mine.map(a => apptCard(s, a)).join("")}` : ""}
      <div class="section-label">Book an appointment</div>
      ${s.doctors.map(d => {
        const next = nextAvailable(s, d);
        return `<div class="card tap" data-action="open-doctor" data-id="${d.id}">
          <div class="row"><div class="avatar">${initials(d.name)}</div><div>
            <div class="name">${esc(d.name)}</div><div class="sub">${esc(d.specialty)} · ${rupees(d.fee)}</div>
            <div class="sub">Next available: ${next ? `${dateLabel(next.date, today(s))}, ${t12(next.slot)}` : "none this week"}</div>
          </div></div></div>`;
      }).join("")}
      ${past.length ? `<div class="section-label">Recent</div>${past.map(a => apptCard(s, a)).join("")}` : ""}
    </div>`;
}

function screenDoctor(s) {
  const d = s.doctors.find(x => x.id === ui.doctorId);
  const next = nextAvailable(s, d);
  return `${topbar("Doctor", "home")}
    <div class="body">
      <div class="row"><div class="avatar lg">${initials(d.name)}</div><div><div class="h1">${esc(d.name)}</div><div class="sub">${esc(d.specialty)}</div></div></div>
      <div>
        <div class="kv"><span class="k">Clinic</span><span class="v">${esc(s.clinic.name)}</span></div>
        <div class="kv"><span class="k">Address</span><span class="v">${esc(s.clinic.address)}</span></div>
        <div class="kv"><span class="k">Consultation fee</span><span class="v">${rupees(d.fee)}</span></div>
        <div class="kv"><span class="k">Timings</span><span class="v">Mon to Sat, ${t12(d.start)} to ${t12(d.end)}</span></div>
        <div class="kv"><span class="k">Next available</span><span class="v">${next ? `${dateLabel(next.date, today(s))}, ${t12(next.slot)}` : "None this week"}</span></div>
      </div>
    </div>
    <div class="footer"><button class="btn primary block" data-action="nav" data-to="slots" ${next ? "" : "disabled"}>Book appointment</button></div>`;
}

function screenSlots(s) {
  const d = s.doctors.find(x => x.id === ui.doctorId);
  const t = today(s);
  ui.date ??= nextAvailable(s, d)?.date ?? t;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(t, i));
  const range = s.settings.slotStyle === "range";
  const grid = range
    ? rangesFor(s, d, ui.date).map(r => `<div class="slot ${r.free ? "" : "off"} ${ui.pick?.slotEnd === r.end && ui.pick?.slot === r.first ? "on" : ""}" ${r.free ? `data-action="pick" data-slot="${r.first}" data-end="${r.end}"` : ""}>${r.label}</div>`).join("")
    : slotsFor(s, d, ui.date).map(x => `<div class="slot ${x.free ? "" : "off"} ${ui.pick?.slot === x.min ? "on" : ""}" ${x.free ? `data-action="pick" data-slot="${x.min}"` : ""}>${x.label}</div>`).join("");
  return `${topbar("Choose a time", "doctor")}
    <div class="body">
      <div class="section-label">Date</div>
      <div class="dates">${dates.map(date => {
        const sd = shortDate(date);
        return `<div class="date ${date === ui.date ? "on" : ""}" data-action="date" data-date="${date}"><div class="dow">${date === t ? "Today" : sd.dow}</div><div class="day">${sd.day}</div><div class="dow">${sd.month}</div></div>`;
      }).join("")}</div>
      <div class="section-label">${range ? "Time window" : "Time slot"}</div>
      <div class="slots ${range ? "ranges" : ""}">${grid || `<div class="sub">No slots.</div>`}</div>
    </div>
    <div class="footer"><button class="btn primary block" data-action="nav" data-to="review" ${ui.pick ? "" : "disabled"}>Continue</button></div>`;
}

function paymentOptions(s, d) {
  const mode = s.settings.paymentMode;
  if (mode === "clinic") return `<div class="note">Pay ${rupees(d.fee)} at the clinic when you visit.</div>`;
  const now = `<div class="choice ${mode === "prepaid" || ui.payChoice === "now" ? "on" : ""}" ${mode === "choice" ? `data-action="paychoice" data-v="now"` : ""}>
      <input type="radio" ${mode === "prepaid" || ui.payChoice === "now" ? "checked" : ""} tabindex="-1" />
      <div><div class="t">Pay now ${rupees(d.fee)}</div><div class="s">UPI, card or netbanking with Razorpay. Your booking is confirmed once the payment goes through.</div></div></div>`;
  if (mode === "prepaid") return now;
  return now + `<div class="choice ${ui.payChoice === "clinic" ? "on" : ""}" data-action="paychoice" data-v="clinic">
      <input type="radio" ${ui.payChoice === "clinic" ? "checked" : ""} tabindex="-1" />
      <div><div class="t">Pay at the clinic</div><div class="s">Booking is confirmed now. Pay at the counter on the day.</div></div></div>`;
}

function willPayNow(s) {
  return s.settings.paymentMode === "prepaid" || (s.settings.paymentMode === "choice" && ui.payChoice === "now");
}

function screenReview(s) {
  const d = s.doctors.find(x => x.id === ui.doctorId);
  const when = ui.pick.slotEnd != null ? `${t12(ui.pick.slot).replace(":00", "")} to ${t12(ui.pick.slotEnd).replace(":00", "")}` : t12(ui.pick.slot);
  const payNowSel = willPayNow(s);
  return `${topbar("Review", "slots")}
    <div class="body">
      <div>
        <div class="kv"><span class="k">Doctor</span><span class="v">${esc(d.name)}</span></div>
        <div class="kv"><span class="k">Date and time</span><span class="v">${dateLabel(ui.date, today(s))}, ${when}</span></div>
        <div class="kv"><span class="k">Patient</span><span class="v">${esc(me(s).name)}</span></div>
        <div class="kv"><span class="k">Fee</span><span class="v">${rupees(d.fee)}</span></div>
      </div>
      <div class="field"><label for="reason">Reason for visit (optional)</label><textarea id="reason" rows="2" data-bind="reason" placeholder="e.g. follow-up on thyroid results">${esc(ui.reason)}</textarea></div>
      <div class="section-label">Payment</div>
      ${paymentOptions(s, d)}
      <div class="section-label">Refund rule</div>
      <table class="rule">${refundRule(s.settings).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
      ${ui.error ? `<div class="error">${esc(ui.error)}</div>` : ""}
    </div>
    <div class="footer">
      <button class="btn primary block" data-action="${payNowSel ? "pay" : "book-clinic"}" ${ui.busy ? "disabled" : ""}>${ui.busy ? esc(ui.busy) : payNowSel ? `Pay ${rupees(d.fee)} and confirm` : "Confirm booking"}</button>
    </div>`;
}

function screenFailed(s) {
  const a = findAppt(s, ui.apptId);
  const canClinic = s.settings.paymentMode === "choice";
  return `${topbar("Payment", "home")}
    <div class="body">
      <div class="h1">Payment didn't go through</div>
      <div class="error">${esc(a.payment.error ?? "The payment failed.")}</div>
      <div class="lede">Your booking isn't confirmed yet. ${a.status === "pending_payment" ? `We're holding ${dateLabel(a.date, today(s))}, ${esc(slotLabel(s, a))} for you for a few minutes.` : "The slot hold has ended; trying again will re-check the slot."} If money was taken from your account, the booking is confirmed or refunded automatically.</div>
      ${ui.error ? `<div class="error">${esc(ui.error)}</div>` : ""}
    </div>
    <div class="footer">
      <button class="btn primary block" data-action="retry" ${ui.busy ? "disabled" : ""}>${ui.busy ? esc(ui.busy) : "Try again"}</button>
      ${canClinic ? `<button class="btn outline block" data-action="pay-clinic">Pay at the clinic instead</button>` : ""}
    </div>`;
}

function screenChecking(s) {
  const a = findAppt(s, ui.apptId);
  return `${topbar("Confirming payment", "home")}
    <div class="body">
      <div class="h1">Confirming your payment…</div>
      <div class="lede">We didn't get the payment result back from Razorpay. We'll check order <span class="mono">${esc(a.payment.orderId)}</span> with them directly in a few seconds.</div>
      ${ui.error ? `<div class="warn">${esc(ui.error)}</div>` : ""}
      <div class="note"><b>Demo:</b> to see the refund path, let the slot hold lapse and give the slot to someone else, then check again.
        <div class="actions" style="margin-top:8px"><button class="btn outline sm" data-action="steal-slot">Expire hold and book the slot for someone else</button></div></div>
    </div>
    <div class="footer"><button class="btn primary block" data-action="recheck">Check now</button></div>`;
}

function clinicBlock(s) {
  return `<div class="card">
    <div class="name">${esc(s.clinic.name)}</div>
    <div class="sub">${esc(s.clinic.address)}</div>
    <div class="sub">📍 ${esc(s.clinic.note)}</div>
    <a href="${esc(s.clinic.mapUrl)}" target="_blank" rel="noopener" class="btn outline sm" style="align-self:flex-start">Open in Maps</a>
  </div>`;
}

function screenConfirmed(s) {
  const a = findAppt(s, ui.apptId);
  const d = doctorOf(s, a);
  return `${topbar("Booked", "home")}
    <div class="body">
      <div class="big-tick">✓</div>
      <div class="h1 center">Booking confirmed</div>
      <div>
        <div class="kv"><span class="k">Doctor</span><span class="v">${esc(d.name)}</span></div>
        <div class="kv"><span class="k">Date and time</span><span class="v">${dateLabel(a.date, today(s))}, ${esc(slotLabel(s, a))}</span></div>
        <div class="kv"><span class="k">Payment</span><span class="v">${paymentBadge(a)}</span></div>
      </div>
      ${clinicBlock(s)}
      <div class="note">Your token number is given when you check in at the clinic. We'll remind you a day before and about 2 hours before.</div>
    </div>
    <div class="footer">
      <button class="btn primary block" data-action="open-appt" data-id="${a.id}">View appointment</button>
      ${a.payment.receiptNo ? `<button class="btn outline block" data-action="receipt" data-id="${a.id}">View receipt</button>` : ""}
      <button class="btn ghost block" data-action="nav" data-to="home">Back to home</button>
    </div>`;
}

// Payment receipt for a paid booking. Print uses the browser's dialog, which
// also covers "Save as PDF".
function screenReceipt(s) {
  const a = findAppt(s, ui.apptId);
  const html = receiptHtml(s, a);
  if (!html) {
    ui.screen = "home";
    return screenHome(s);
  }
  return `${topbar("Receipt", "appt")}
    <div class="body">${html}</div>
    <div class="footer">
      <button class="btn primary block" data-action="print-receipt">Download or print</button>
    </div>`;
}

// On the appointment screen before arrival: the trip in progress (with live
// location if shared), or a nudge into the planner with its best pick.
function tripCard(s, a) {
  const loc = a.location;
  const arr = arrivalOf(s, a);
  if (a.trip || loc?.sharing) {
    const mode = a.trip?.mode ?? loc.mode;
    const fresh = loc?.sharing && locationFresh(s, a);
    return `<div class="card tint">
      <div class="between"><div class="name">On your way · ${esc(TRAVEL_MODES[mode] ?? "")}</div>${loc?.sharing ? `<span class="badge ${fresh ? "ok" : "amber"}">${fresh ? "Live ETA on" : "No update"}</span>` : `<span class="badge info">Live ETA off</span>`}</div>
      ${arr ? `<div class="sub" style="color:var(--ink)"><b>Arriving around ${tms(arr.etaMs)}</b> · ${Math.max(0, Math.round((arr.etaMs - s.clock.nowMs) / MIN))} min away${loc?.sharing ? ` · ${loc.distanceKm.toFixed(1)} km to go` : ""}</div>` : ""}
      ${arr?.live ? `<div class="sub">⚡ ${esc(arr.live.label.charAt(0).toUpperCase() + arr.live.label.slice(1))}${loc.eta && !loc.eta.error ? ` · updated ${tms(loc.eta.at)}${loc.eta.trafficMin > 0 ? ` · +${loc.eta.trafficMin} min traffic` : ""}` : ""}</div>` : loc?.eta?.error ? `<div class="sub">Live ETA unavailable (${esc(loc.eta.error)}), using estimate</div>` : ""}
      <div class="sub">${loc?.sharing ? "The clinic sees only when you'll arrive, not where you are." : "The clinic is expecting you at that time."}</div>
      <div class="actions"><a class="btn primary sm" href="${esc(mapsUrl(mode, ui.trip.origin))}" target="_blank" rel="noopener">Navigate in Google Maps</a>
        ${loc?.sharing ? `<button class="btn outline sm" data-action="stop-sharing">Stop sharing</button>` : ""}
        <button class="btn ghost sm" data-action="sheet" data-sheet="late">Running late?</button></div>
    </div>`;
  }
  const plan = tripPlan(s, a);
  const b = plan.best;
  return `<div class="card">
    <div class="name">Getting there</div>
    ${b ? `<div class="sub">${plan.onDay ? `Your slot: ${tms(plan.arriveBy)}. Arrival if you leave now` : `Your slot: ${tms(plan.arriveBy)}. Leave by`} · ${plan.source === "google" ? "live traffic from Google Maps" : "estimated"} · ${esc(plan.traffic.label.toLowerCase())}</div>
      <table class="modes">${plan.options.map(o => `<tr${o === b ? ' class="best"' : ""}>
        <td>${o.icon}</td>
        <td>${esc(o.label)}${o === b ? ' <span class="badge ok">Best</span>' : ""}<div class="s">${costText(o.cost)}</div></td>
        <td class="n">${o.totalMin} min</td>
        <td class="n">${plan.onDay ? `<b>${tms(o.arriveMs)}</b><div class="s" style="color:${o.onTime ? "var(--accent-dark)" : "var(--warn-ink)"}">${o.onTime ? "on time" : `${-o.spareMin} min late`}</div>` : `leave ${tms(o.leaveBy)}`}</td>
      </tr>`).join("")}</table>` : ""}
    <div class="actions"><button class="btn primary sm" data-action="nav" data-to="trip">${plan.onDay ? "Plan my trip" : "See ways to get there"}</button>
    ${plan.onDay ? `<button class="btn outline sm" data-action="sheet" data-sheet="late">I'll be late</button>` : ""}</div>
    ${a.lateNote ? `<div class="sub">You told the clinic: about ${a.lateNote.minutes} min late (${tms(a.lateNote.at)}).</div>` : ""}
  </div>`;
}

function screenAppt(s) {
  const a = findAppt(s, ui.apptId);
  if (!a) {
    ui.screen = "home";
    return screenHome(s);
  }
  const d = doctorOf(s, a);
  const isToday = a.date === today(s);
  const parts = [];

  if (a.status === "in_consult") {
    parts.push(`<div class="status-hero green"><div class="h1">It's your turn</div><div class="sub">Please go in to ${esc(d.room)}.</div></div>`);
  } else if (a.status === "checked_in") {
    const est = estimate(s, a);
    const txt = estimateText(est, true);
    parts.push(`<div class="card tint center"><div class="section-label">Your token</div><div class="token">${a.token}</div><div class="sub">${esc(d.name)} · ${esc(d.room)}</div></div>`);
    parts.push(`<div class="card estimate"><div class="head">${esc(txt.head)}</div><div class="subline">${esc(txt.sub)}</div><div class="sub">Based on how the queue is moving today (about ${est.avg} min per patient). We'll notify you when it's your turn.</div></div>`);
    if (a.flags.lateArrival) parts.push(`<div class="note">You checked in after your reserved slot, so you'll be seen as soon as possible.</div>`);
  } else if (notArrived(a) && isToday) {
    if (a.status === "reserved") parts.push(`<div class="warn"><b>Your slot is held until ${tms(a.graceUntil)}</b> (${Math.max(0, Math.ceil((a.graceUntil - s.clock.nowMs) / MIN))} min left). We're seeing another patient while we wait for you.</div>`);
    if (a.status === "late") parts.push(`<div class="warn">Your reserved slot has passed. Please check in at reception and you'll be seen as soon as possible.</div>`);
    const est = estimate(s, a);
    const txt = estimateText(est, false);
    const arr = arrivalOf(s, a);
    parts.push(`<div class="card estimate"><div class="section-label">Your place in the queue</div><div class="head">${est.unknown ? "Fitted in when you arrive" : `#${est.position} · in around ${tms(est.projectedMs)}`}</div><div class="subline">${esc(txt.head)}</div>
      <div class="sub">Booked for ${esc(slotLabel(s, a))}. ${arr?.firm ? `Based on you arriving around ${tms(arr.etaMs)}.` : "Assuming you arrive on time."} If you're late, you're fitted in by when you arrive, not sent to the end. The doctor is taking about ${est.avg} min per patient today.</div>
</div>`);
    parts.push(tripCard(s, a));
  } else if (a.status === "booked") {
    parts.push(`<div class="card"><div class="name">${dateLabel(a.date, today(s))}, ${esc(slotLabel(s, a))}</div><div class="sub">We'll remind you a day before and about 2 hours before. Check-in and the live wait estimate open on the day.</div></div>`);
    parts.push(tripCard(s, a));
  } else if (a.status === "pending_payment" || a.status === "expired") {
    parts.push(`<div class="warn">This booking isn't confirmed: ${esc(a.payment.error ?? "payment pending")}.</div>
      <div class="actions"><button class="btn primary sm" data-action="retry">Try again</button>${a.payment.orderId ? `<button class="btn outline sm" data-action="recheck">Re-check payment</button>` : ""}</div>`);
  } else if (a.status === "completed") {
    parts.push(`<div class="okbox">Visit complete. Thank you for visiting ${esc(s.clinic.name)}.</div>`);
  } else if (a.status === "cancelled" || a.status === "no_show") {
    parts.push(`<div class="note">${esc(statusText(s, a))}.${a.payment.refund ? ` Refund: ${rupees(a.payment.refund.amount)} (${a.payment.refund.status}).` : ""}</div>`);
  }

  const p = a.payment;
  const payBlock = `<div class="card">
    <div class="between"><div class="name">Payment</div>${paymentBadge(a)}</div>
    ${p.status === "pending" && p.mode === "clinic" && isActive(a) ? `<div class="sub">Pay ${rupees(p.amount)} at the counter${a.status === "checked_in" ? " now" : " when you check in"}.</div>` : ""}
    ${p.status === "pending" && p.mode === "link" ? `<div class="sub">The clinic sent you a payment link.</div><button class="btn primary sm" style="align-self:flex-start" data-action="pay-link" data-id="${a.id}">Pay ${rupees(p.amount)}</button>` : ""}
    ${p.receiptNo ? `<button class="btn outline sm" style="align-self:flex-start" data-action="receipt" data-id="${a.id}">View receipt</button>` : ""}
    ${p.history.length ? `<details><summary class="sub">History</summary>${p.history.map(h => `<div class="sub">${tms(h.at)} · ${esc(h.text)}</div>`).join("")}</details>` : ""}
  </div>`;

  const canCheckIn = isToday && notArrived(a);
  const canCancel = notArrived(a) || a.status === "pending_payment";
  return `${topbar("Appointment", "home")}
    <div class="body">
      <div class="row"><div class="avatar">${initials(d.name)}</div><div><div class="name">${esc(d.name)}</div>
        <div class="sub">${dateLabel(a.date, today(s))}, ${esc(slotLabel(s, a))} · ${esc(statusText(s, a))}</div></div></div>
      ${parts.join("")}
      ${payBlock}
      ${clinicBlock(s)}
      ${ui.error ? `<div class="error">${esc(ui.error)}</div>` : ""}
    </div>
    ${canCheckIn || canCancel ? `<div class="footer">
      ${canCheckIn ? `<button class="btn primary block" data-action="sheet" data-sheet="scan">Scan QR at the counter to check in</button>` : ""}
      ${canCancel ? `<button class="btn ghost block" style="color:var(--danger)" data-action="sheet" data-sheet="cancel">Cancel appointment</button>` : ""}
    </div>` : ""}`;
}

// Trip planner: every sensible way to get there with time, cost and arrival,
// the best pick explained, Google Maps directions for each, and Start trip.
function screenTrip(s) {
  const a = findAppt(s, ui.apptId);
  if (ui.trip.located === false) setTimeout(locate);
  const plan = tripPlan(s, a);
  const pick = plan.options.find(o => o.key === ui.trip.pick) ?? plan.best;
  const now = s.clock.nowMs;
  const gps = ui.trip.located === "gps";
  const where = ui.trip.located === "asking" ? "Finding you…" : gps ? "From your current location"
    : `${{ denied: "Location is off. ", far: "You're far from the clinic. ", waiting: "No location yet. " }[ui.trip.located] ?? ""}Demo start: <select data-action-change="trip-origin" aria-label="Demo starting point">${Object.entries(DEMO_ORIGINS).map(([k, o]) => `<option value="${k}" ${k === ui.trip.demo ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
  const srcLine = plan.source === "google" ? `🗺️ Times from Google Maps${plan.onDay ? ", live traffic" : ""}`
    : ui.trip.googleBusy ? "🗺️ Asking Google Maps…" : ui.trip.googleError ? `Estimated times (Google Maps failed: ${esc(ui.trip.googleError)})` : `Estimated times${ui.routes && !ui.routes.live ? " · Google Maps not connected yet" : ""} · 🚦 ${esc(plan.traffic.label)}`;
  const breakup = o => `<details class="breakup" ${ui.trip.open === o.key ? "open" : ""} data-key="${o.key}"><summary>Cost breakup</summary>
      ${o.breakup.lines.length ? `<table>${o.breakup.lines.map(l => `<tr><td>${esc(l.label)}${l.detail ? `<div class="s">${esc(l.detail)}</div>` : ""}</td><td>₹${l.amount}</td></tr>`).join("")}
        <tr class="tot"><td>Total</td><td>${costText(o.cost)}</td></tr></table>` : ""}
      <div class="s">${esc(o.breakup.note)}</div></details>`;
  const row = o => `<div class="choice trip ${o === pick ? "on" : ""}" data-action="trip-pick" data-v="${o.key}">
      <div class="ticon">${o.icon}</div>
      <div style="flex:1;min-width:0">
        <div class="between"><div class="t">${esc(o.label)}</div><div class="t">${costText(o.cost)}</div></div>
        <div class="s">${o.totalMin} min${o.wait ? ` (incl. ~${o.wait} min to get going)` : ""} · ${o.km.toFixed(1)} km · arrive ${tms(plan.onDay ? o.arriveMs : o.leaveBy + o.totalMin * MIN)}</div>
        ${o.transitLines.length ? `<div class="s">${esc(o.transitLines.join(" → "))}${o.walkMin ? ` · ${o.walkMin} min walking` : ""}</div>` : ""}
        <div class="s">${plan.onDay ? (o.onTime ? (o.leaveBy > now + MIN ? `Leave by ${tms(o.leaveBy)} · ${o.spareMin} min spare` : `Leave now · ${o.spareMin} min spare`) : `<span style="color:var(--warn-ink)">About ${-o.spareMin} min after your slot</span>`) : `Leave by ${tms(o.leaveBy)}`}</div>
        ${o.tags.length ? `<div class="actions" style="margin-top:4px">${o.tags.map(t => `<span class="badge ${t === "Best pick" ? "ok" : "info"}">${t}</span>`).join("")}</div>` : ""}
        ${o.why ? `<div class="s" style="color:var(--accent-dark)">${esc(o.why)}</div>` : ""}
        ${breakup(o)}
      </div></div>`;
  return `${topbar("Getting there", "appt")}
    <div class="body">
      <div class="h1">${plan.onDay ? (a.status === "late" ? "Your slot has passed" : a.status === "reserved" ? `Slot held until ${tms(plan.arriveBy)}` : `Your slot: ${tms(plan.arriveBy)}`) : `Your slot: ${tms(plan.arriveBy)} on ${dateLabel(a.date, today(s))}`}</div>
      <div class="lede">${a.status === "late" ? "Your slot has passed, but you won't go to the end of the line: you're fitted in by when you arrive." : plan.onDay ? "If you arrive later, you're fitted in by your arrival time, not sent to the end." : "Times use the usual traffic for that hour. On the day, this updates with the live queue."}</div>
      <div class="sub">📍 ${where} · ${tripKm().toFixed(1)} km as the crow flies</div>
      <div class="sub">${srcLine}</div>
      <div class="actions">${[["two_wheeler", "🛵 I have a two-wheeler"], ["car", "🚗 I have a car"]].map(([k, l]) => `<span class="chip ${ui.trip.have[k] ? "on" : ""}" data-action="trip-have" data-v="${k}">${l}</span>`).join("")}</div>
      ${plan.options.map(row).join("") || `<div class="note">No routes found from here.</div>`}
      ${plan.onDay ? `<label class="choice ${ui.trip.share ? "on" : ""}" data-action="trip-share"><input type="checkbox" ${ui.trip.share ? "checked" : ""} tabindex="-1" /><div><div class="t">Keep the clinic updated on when I'll arrive</div><div class="s">Uses your location on this phone to work out a live arrival time. The clinic sees only that time, never where you are. Stops when you check in.</div></div></label>` : ""}
    </div>
    <div class="footer">
      ${pick ? `<a class="btn outline block" href="${esc(pick.url)}" target="_blank" rel="noopener">Open ${esc(pick.label.toLowerCase())} route in Google Maps</a>` : ""}
      ${plan.onDay && pick ? `<button class="btn primary block" data-action="trip-start">I'm leaving now by ${esc(pick.label.toLowerCase())}</button>` : ""}
    </div>`;
}

function screenInbox(s) {
  const list = myNotifs(s);
  const label = { confirm: "Confirm", cancel: "Cancel", leaving: "I'm leaving now", checkin: "Check in" };
  return `${topbar("Notifications", "home")}
    <div class="body" style="gap:0">
      ${list.length ? list.map(n => {
        const a = n.apptId ? findAppt(s, n.apptId) : null;
        const live = a && (notArrived(a) || a.status === "pending_payment");
        const done = a?.flags.confirmedAt && n.kind === "reminder";
        return `<div class="notif ${n.read ? "" : "unread"}">
          <div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div>
          <div class="when">${dateLabel(ymd(n.at), today(s))} ${tms(n.at)}</div>
          ${n.actions.length && live ? `<div class="actions">${done ? `<span class="badge ok">Confirmed</span>` : ""}${n.actions.filter(x => !(done && x === "confirm")).map(x => `<button class="btn ${x === "confirm" ? "primary" : "outline"} sm" data-action="notif-${x}" data-id="${a.id}">${label[x]}</button>`).join("")}</div>` : ""}
          ${a ? `<button class="btn ghost sm" style="align-self:flex-start" data-action="open-appt" data-id="${a.id}">View appointment</button>` : ""}
        </div>`;
      }).join("") : `<div class="sub">Nothing yet.</div>`}
    </div>`;
}

function sheetHtml(s) {
  if (!ui.sheet) return "";
  const a = findAppt(s, ui.apptId);
  let inner = "";
  if (ui.sheet === "cancel") {
    const q = refundQuote(s, a, "patient");
    inner = `<div class="h1">Cancel this appointment?</div>
      <div class="lede">${esc(doctorOf(s, a).name)}, ${dateLabel(a.date, today(s))} at ${esc(slotLabel(s, a))}. The slot is released straight away.</div>
      <div class="note">${esc(q.text)}</div>
      <button class="btn primary block" style="background:var(--danger)" data-action="do-cancel">Cancel appointment</button>
      <button class="btn ghost block" data-action="close-sheet">Keep it</button>`;
  } else if (ui.sheet === "scan") {
    inner = `<div class="h1">Scan the QR at the counter</div>
      <div class="viewfinder"><div class="qr"></div></div>
      <div class="sub center">Point your camera at the QR code at reception.</div>
      <button class="btn primary block" data-action="do-checkin">Simulate scan</button>
      <button class="btn ghost block" data-action="close-sheet">Close</button>`;
  } else if (ui.sheet === "late") {
    inner = `<div class="h1">How late will you be?</div>
      <div class="lede">We'll let the clinic know. Your slot is held for ${s.settings.graceMin} minutes after it starts.</div>
      <div class="actions">${[10, 20, 30, 45].map(m => `<button class="btn outline" data-action="do-late" data-v="${m}">${m} min</button>`).join("")}</div>
      <button class="btn ghost block" data-action="close-sheet">Close</button>`;
  }
  return `<div class="sheet-backdrop" data-action="close-sheet"><div class="sheet" data-stop>${`<div class="grabber"></div>`}${inner}</div></div>`;
}

function callHtml(s) {
  if (ui.call) {
    const c = ui.call;
    const a = findAppt(s, c.apptId);
    const chat = `<div class="chat" id="chat">${c.transcript.map(m => `<div class="bubble ${m.who}">${esc(m.text)}</div>`).join("")}</div>`;
    let controls;
    if (c.engine === "elevenlabs") {
      controls = `<div class="replies"><div class="typing">🎙️ ${esc(c.status ?? "")} Talk normally; the assistant hears you through the microphone.</div></div>`;
    } else if (c.type === "ivr") {
      controls = `<div class="keypad">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map(k => `<button data-action="ivr" data-v="${k}">${k}</button>`).join("")}</div>`;
    } else {
      const L = SCRIPTS[c.lang];
      const opts = c.ai ? AI_SUGGESTIONS[c.lang].map(t => ["ai", t]) : c.step === "confirm_cancel" ? [["yes", L.yes], ["no", L.no]] : c.step === "note" ? [["none", L.noMore]] : c.step === "mode" ? L.modes : L.replies;
      const mic = Recognition ? `<button class="mic ${c.listening ? "on" : ""}" data-action="mic" aria-label="Talk">${c.listening ? "● Listening…" : "🎤 Talk"}</button>` : "";
      controls = `<div class="replies">${c.thinking ? `<div class="typing">Assistant is thinking…</div>` : ""}
        <div class="reply-chips">${opts.map(([k, t]) => `<button data-action="say" data-k="${k}" data-t="${esc(t)}" ${c.thinking ? "disabled" : ""}>“${esc(t)}”</button>`).join("")}</div>
        <div class="row">${mic}<input id="say-text" placeholder="${esc(L.placeholder)}" ${c.thinking ? "disabled" : ""} /></div></div>`;
    }
    const v = c.verdict;
    const verdict = c.ai && v ? `<div class="verdict">Telling the clinic: <b>${esc({ yes: "Coming", no: "Not coming", unsure: "Not sure", unknown: "Asking…" }[v.coming])}</b>${v.eta_min >= 0 ? ` · ~${v.eta_min} min` : ""}${v.travel_mode !== "unknown" ? ` · ${esc(TRAVEL_MODES[v.travel_mode] ?? "")}` : ""}</div>` : "";
    return `<div class="call"><div class="who"><div class="n">${c.type === "ivr" ? "Clinic arrival line (IVR)" : "Ninto assistant (Voice AI)"}</div><div class="s">${esc(s.clinic.name)} · ${esc(slotLabel(s, a))}${c.type === "voice" ? ` · ${{ elevenlabs: "ElevenLabs voice + Claude", claude: "live AI (Claude)", script: "scripted" }[c.engine] ?? ""}` : ""}</div>
        ${c.type === "voice" && c.engine !== "elevenlabs" ? `<button class="voice-toggle" data-action="voice">${ui.voice ? "🔊 Voice on" : "🔇 Voice off"}</button>` : ""}</div>
      ${c.error ? `<div class="call-err">${esc(c.error)}</div>` : ""}${verdict}
      ${chat}${controls}<button class="round red hang" data-action="hangup">End</button></div>`;
  }
  const ringing = ringingCall(s);
  if (!ringing) return "";
  return `<div class="call"><div class="who" style="padding-top:90px"><div class="s">Incoming call</div><div class="n">${esc(s.clinic.name)}</div>
    <div class="s">About your ${esc(slotLabel(s, ringing.a))} appointment · ${ringing.call.type === "ivr" ? "IVR" : "Voice AI"}</div></div>
    <div class="ring-actions"><button class="round red" data-action="decline">Decline</button><button class="round green" data-action="answer">Answer</button></div></div>`;
}

const SCREENS = { home: screenHome, doctor: screenDoctor, slots: screenSlots, review: screenReview, failed: screenFailed, checking: screenChecking, confirmed: screenConfirmed, receipt: screenReceipt, appt: screenAppt, trip: screenTrip, inbox: screenInbox };

function render() {
  const s = getState();
  // Don't redraw under someone typing.
  if (document.activeElement?.matches?.("#frame input, #frame textarea") && frame.contains(document.activeElement)) return;
  frame.innerHTML = (SCREENS[ui.screen] ?? screenHome)(s) + sheetHtml(s) + callHtml(s);
  frame.querySelector("#chat")?.scrollTo(0, 1e6);
  if (ui.screen === "inbox" && myNotifs(s).some(n => !n.read)) {
    setTimeout(() => update(st => st.notifications.forEach(n => { if (n.patientId === st.me) n.read = true; })), 1500);
  }
  renderDev(s);
}

function renderDev(s) {
  if (devInner.contains(document.activeElement)) return;
  const mine = myAppts(s).filter(a => a.location?.sharing);
  devInner.innerHTML = `
    <label>Signed in as <select data-dev="me">${s.patients.map(p => `<option value="${p.id}" ${p.id === s.me ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
    <p>Gateway: <b>${esc(ui.gateway?.label ?? "…")}</b>${ui.gateway?.reason ? ` (${esc(ui.gateway.reason)})` : ""}</p>
    <p>Arrival calls: <b>IVR phone calls</b> (ring the patient's phone, not this app; the clinic enters the keypress in this demo)</p>
    <label><input type="checkbox" data-dev="drop" ${ui.dropCallback ? "checked" : ""} /> After a successful payment, lose Razorpay's success callback (tests the re-check)</label>
    <label>Demo starting point (when location is off or far away): <select data-dev="origin">${Object.entries(DEMO_ORIGINS).map(([k, o]) => `<option value="${k}" ${k === ui.trip.demo ? "selected" : ""}>${esc(o.label)} (${distanceKm(o, CLINIC_LL).toFixed(1)} km)</option>`).join("")}</select></label>
    <p>Routes: <b>${ui.routes?.live ? "Google Maps Routes API" : "Built-in estimates"}</b>${!ui.routes?.live && ui.routes?.reason ? ` (${esc(ui.routes.reason)})` : ""}</p>
    ${mine.map(a => `<div>
      <label><input type="checkbox" data-dev="moving" data-id="${a.id}" ${a.location.moving ? "checked" : ""} /> Moving (off = stuck, or never left home)</label>
      <label><input type="checkbox" data-dev="sending" data-id="${a.id}" ${a.location.sending ? "checked" : ""} /> Phone sending updates (off = no update, goes stale after 15 min)</label>
    </div>`).join("")}
    <p>Use the demo clock to move time. Reminders, the slot-time grace rule and arrival calls fire as time passes.</p>`;
}

// ---------- events ----------

frame.addEventListener("click", event => {
  // Cost breakup: open / close it without picking that option. Tracked in ui
  // so it stays open across re-renders.
  const summary = event.target.closest("details.breakup > summary");
  if (summary) {
    event.preventDefault();
    const key = summary.parentElement.dataset.key;
    ui.trip.open = ui.trip.open === key ? null : key;
    return render();
  }
  if (event.target.closest("select")) return;
  const el = event.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "close-sheet" && event.target.closest("[data-stop]") && el !== event.target.closest("[data-stop] [data-action]")) return;
  const s = getState();
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case "nav":
      if (el.dataset.to === "review" && !ui.pick) return;
      return go(el.dataset.to);
    case "open-doctor":
      return go("doctor", { doctorId: id, date: null, pick: null, reason: "", apptId: null, payChoice: "now" });
    case "open-appt": {
      const a = findAppt(s, id);
      if ((a.status === "pending_payment" || a.status === "expired") && a.payment.status === "failed") return go("failed", { apptId: id, doctorId: a.doctorId });
      return go("appt", { apptId: id });
    }
    case "date":
      ui.date = el.dataset.date;
      ui.pick = null;
      return render();
    case "pick":
      ui.pick = { slot: Number(el.dataset.slot), slotEnd: el.dataset.end ? Number(el.dataset.end) : null };
      return render();
    case "paychoice":
      ui.payChoice = el.dataset.v;
      return render();
    case "pay":
      ui.apptId = null;
      return payNow();
    case "book-clinic":
      return bookPayAtClinic();
    case "retry": {
      const a = findAppt(s, ui.apptId);
      Object.assign(ui, { doctorId: a.doctorId, date: a.date, pick: { slot: a.slot, slotEnd: a.slotEnd } });
      return payNow();
    }
    case "pay-clinic":
      return payAtClinicInstead(ui.apptId);
    case "recheck":
      return checkPayment(ui.apptId);
    case "steal-slot":
      update(st => {
        const a = findAppt(st, ui.apptId);
        a.createdAt -= st.settings.holdMin * MIN;
      });
      update(st => {
        const a = findAppt(st, ui.apptId);
        const other = st.patients.find(p => p.id !== st.me);
        createAppointment(st, { doctorId: a.doctorId, patientId: other.id, date: a.date, slot: a.slot, source: "clinic", status: "booked" });
      });
      toast("Slot given to someone else", "The hold expired and reception booked the slot.");
      return render();
    case "sheet":
      ui.sheet = el.dataset.sheet;
      return render();
    case "close-sheet":
      ui.sheet = null;
      return render();
    case "do-cancel": {
      update(st => cancelAppointment(st, findAppt(st, ui.apptId), "patient"));
      ui.sheet = null;
      return render();
    }
    case "do-checkin":
      update(st => checkIn(st, findAppt(st, ui.apptId), "QR"));
      ui.sheet = null;
      return render();
    case "do-late":
      update(st => {
        findAppt(st, ui.apptId).lateNote = { minutes: Number(el.dataset.v), at: st.clock.nowMs };
      });
      ui.sheet = null;
      toast("Clinic notified", `You'll be about ${el.dataset.v} minutes late.`);
      return render();
    case "trip-pick":
      ui.trip.pick = el.dataset.v;
      return render();
    case "trip-have":
      ui.trip.have[el.dataset.v] = !ui.trip.have[el.dataset.v];
      if (!ui.trip.have[el.dataset.v] && ui.trip.pick === el.dataset.v) ui.trip.pick = null;
      return render();
    case "trip-share":
      event.preventDefault();
      ui.trip.share = !ui.trip.share;
      return render();
    case "trip-start":
      return beginTrip(ui.apptId);
    case "stop-sharing":
      update(st => {
        findAppt(st, ui.apptId).location.sharing = false;
      });
      return render();
    case "pay-link":
      return payLink(id);
    case "receipt":
      return go("receipt", { apptId: id });
    case "print-receipt":
      return window.print();
    case "notif-confirm":
      update(st => {
        findAppt(st, id).flags.confirmedAt = st.clock.nowMs;
      });
      toast("Thanks for confirming");
      return render();
    case "notif-cancel":
      return go("appt", { apptId: id, sheet: "cancel" });
    case "notif-leaving":
      return go("trip", { apptId: id });
    case "notif-checkin":
      return go("appt", { apptId: id, sheet: "scan" });
    case "answer":
      return answerCall();
    case "decline": {
      const r = ringingCall(s);
      update(st => finishCall(st, findAppt(st, r.a.id), { outcome: "no_answer" }));
      return render();
    }
    case "hangup":
      if (ui.call.engine === "elevenlabs") return elevenFinish(ui.call);
      return endCall(ui.call.ai ? verdictResult(ui.call.verdict) : ui.call.result ?? { outcome: "no_answer" });
    case "say":
      return el.dataset.k === "ai" ? aiReply(el.dataset.t) : voiceReply(el.dataset.k, el.dataset.t);
    case "mic":
      return ui.call.listening ? (stopListening(), (ui.call.listening = false), render()) : listen();
    case "voice":
      ui.voice = !ui.voice;
      if (!ui.voice) window.speechSynthesis?.cancel();
      return render();
    case "ivr":
      return ivrPress(el.dataset.v);
  }
});

frame.addEventListener("keydown", event => {
  if (event.target.id === "say-text" && event.key === "Enter" && event.target.value.trim()) {
    const text = event.target.value.trim();
    event.target.blur();
    if (ui.call.ai) return aiReply(text);
    voiceReply(ui.call.step === "note" ? "note" : ui.call.step === "confirm_cancel" ? (/yes|ஆம்/i.test(text) ? "yes" : "no") : "text", text);
  }
});

frame.addEventListener("change", event => {
  if (event.target.dataset.actionChange === "trip-origin") useDemoOrigin(event.target.value);
});

frame.addEventListener("input", event => {
  const key = event.target.dataset.bind;
  if (key) ui[key] = event.target.value;
});

async function payLink(id) {
  const a = findAppt(getState(), id);
  if (a.payment.linkId.startsWith("plink_SIM")) {
    const ok = await paySimulatedLink(a.payment.linkId);
    if (ok) toast("Payment sent", "The clinic will see it in a few seconds.");
  } else {
    window.open(a.payment.linkUrl, "_blank", "noopener");
  }
}

devInner.addEventListener("change", event => {
  const t = event.target;
  const kind = t.dataset.dev;
  if (kind === "me") {
    update(s => {
      s.me = t.value;
    });
    for (const n of getState().notifications) seen.add(n.id);
    return go("home");
  }
  if (kind === "drop") ui.dropCallback = t.checked;
  if (kind === "origin") useDemoOrigin(t.value);
  if (kind === "moving" || kind === "sending") {
    update(s => {
      findAppt(s, t.dataset.id).location[kind] = t.checked;
    });
  }
});

// Toast new notifications for the signed-in patient, like a push.
function pushNew() {
  const s = getState();
  for (const n of myNotifs(s).slice().reverse()) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    toast(n.title, n.body);
  }
}

// Any of my bookings whose payment result never came back: re-check quietly.
function recheckOrphans() {
  for (const a of myAppts(getState())) {
    if ((a.status === "pending_payment" || a.status === "expired") && a.payment.orderId && a.payment.status === "pending") {
      checkPayment(a.id, { quiet: true });
    }
  }
}

for (const n of getState().notifications) seen.add(n.id);
subscribe(() => {
  pushNew();
  render();
});
// Live ETA while sharing location: the phone works out pace and walk/drive
// (shared/eta.js) and asks Google, through our server, every few minutes.
const etaBusy = new Set();
async function refreshEtas() {
  if (!ui.routes?.live) return;
  const s = getState();
  for (const a of s.appointments.filter(x => x.patientId === s.me && notArrived(x) && x.location?.sharing)) {
    if (etaBusy.has(a.id) || !etaDue(a.location, s.clock.nowMs)) continue;
    etaBusy.add(a.id);
    const at = s.clock.nowMs;
    const km = a.location.distanceKm;
    const result = await fetchEta(a.location, CLINIC_LL).catch(err => ({ error: err.message, mode: "drive" }));
    update(st => {
      const x = findAppt(st, a.id);
      if (x?.location) x.location.eta = { ...result, at, km, realAt: Date.now() };
    });
    etaBusy.delete(a.id);
  }
}
setInterval(refreshEtas, 3000);

fetch("/api/routes/config").then(r => r.json()).catch(() => ({ live: false, reason: "Routes server not reachable" })).then(cfg => {
  ui.routes = cfg;
  fetchRoutes();
  render();
});
fetch("/api/elevenlabs/config").then(r => r.json()).catch(() => ({ live: false, reason: "ElevenLabs server not reachable" })).then(cfg => {
  ui.eleven = cfg;
  render();
});
fetch("/api/ai-call/config").then(r => r.json()).catch(() => ({ live: false, reason: "AI call server not reachable" })).then(cfg => {
  ui.ai = cfg;
  render();
});
gatewayInfo().then(g => {
  ui.gateway = g;
  render();
});
startBackgroundWork();
recheckOrphans();
render();
