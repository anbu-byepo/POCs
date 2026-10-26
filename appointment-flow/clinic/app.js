/**
 * Clinic app (boards F1-F3 of the discussion doc). Schedule -> doctor -> the
 * day's queue (All, Checked in, Completed, Booked, Others) with Now serving,
 * Reserved + grace countdown, Waiting, On the way and No-show; location and
 * call results on each expected patient's row; the manual actions that are
 * always available (Mark arrived, Mark no-show, Reinsert, Swap, Call patient).
 * Booking from a calendar slot (walk-in or scheduled) and from Patients, both
 * with payment at booking: collect now (cash, or UPI / card through Razorpay
 * on this device), send a Razorpay payment link, or pay at visit. Payment can
 * be collected later from the appointment. Settings holds the grace, call and
 * payment rules.
 */

import { getState, update, subscribe } from "../shared/store.js";
import {
  slotsFor, createAppointment, confirmBooking, markPaid, cancelAppointment, markNoShow, checkIn, reinsert, swapWithNext,
  callNext, completeCurrent, startConsult, line, estimate, estimateText, avgConsult, startCall, finishCall, callResultText, locationFresh,
  etaMin, refundRule, refundQuote, isActive, notArrived, patientOf, doctorOf, notify, slotLabel, TRAVEL_MODES, today, nowMin
} from "../shared/flow.js";
import { pay, createLink, gatewayInfo, startBackgroundWork, payerOf } from "../shared/payments.js";
import { mountSimBar, paymentBadge, toast } from "../shared/ui.js";
import { MIN, esc, rupees, t12, tms, dateLabel, addDays, inFrame } from "../shared/util.js";

const side = document.getElementById("side");
const main = document.getElementById("main");
const modalEl = document.getElementById("modal");

const ui = {
  tab: "schedule",
  doctorId: "d1",
  date: null,
  view: "queue",
  filter: "all",
  search: "",
  modal: null,
  gateway: null,
  open: new Set()
};

if (inFrame()) document.body.classList.add("embedded");
else mountSimBar(document.getElementById("simbar"));

const findAppt = (s, id) => s.appointments.find(a => a.id === id);

// ---------- queue rows ----------

const GROUPS = [
  { key: "serving", title: "Now serving", test: a => a.status === "in_consult", filter: ["all", "checked"] },
  { key: "reserved", title: "Reserved: next in line", test: a => a.status === "reserved", filter: ["all", "booked"] },
  { key: "waiting", title: "Waiting (checked in)", test: a => a.status === "checked_in", filter: ["all", "checked"] },
  { key: "late", title: "Late, grace over (not arrived)", test: a => a.status === "late", filter: ["all", "booked"] },
  { key: "expected", title: "On the way / not arrived yet", test: a => a.status === "booked", filter: ["all", "booked"] },
  { key: "noshow", title: "No-show", test: a => a.status === "no_show", filter: ["all", "others"] },
  { key: "done", title: "Completed", test: a => a.status === "completed", filter: ["all", "completed"] },
  { key: "other", title: "Cancelled / unconfirmed", test: a => ["cancelled", "pending_payment", "expired"].includes(a.status), filter: ["others"] }
];
const FILTERS = [["all", "All"], ["checked", "Checked in"], ["completed", "Completed"], ["booked", "Booked"], ["others", "Others"]];

function locationLine(s, a) {
  const loc = a.location;
  if (!loc) return `<span class="muted">Location not shared</span>`;
  if (!loc.sharing) return `<span class="muted">Location sharing stopped</span>`;
  if (!locationFresh(s, a)) return `📍 No update for ${Math.round((s.clock.nowMs - loc.updatedAt) / MIN)} min, treated as unknown`;
  return `📍 ${loc.distanceKm.toFixed(1)} km away · about ${etaMin(loc)} min by ${esc(TRAVEL_MODES[loc.mode].toLowerCase())} · updated ${tms(loc.updatedAt)}${loc.moving ? "" : " · not moving"}`;
}

function callLine(a) {
  const call = a.calls.at(-1);
  if (!call) return "";
  const kind = call.type === "ivr" ? "IVR" : "Voice AI";
  return `📞 ${esc(callResultText(call))} <span class="muted">(${kind}${call.lang === "ta" ? ", Tamil" : ""}, ${call.trigger}, ${tms(call.startedAt)})</span>${call.note ? `<br>“${esc(call.note)}”` : ""}`;
}

function rowActions(s, a) {
  const btn = (action, label, cls = "outline") => `<button class="btn ${cls} sm" data-action="${action}" data-id="${a.id}">${label}</button>`;
  const acts = [];
  if (a.status === "in_consult") acts.push(btn("complete", "Complete", "primary"));
  if (notArrived(a)) {
    acts.push(btn("checkin", "Mark arrived (check in)", "primary"));
    acts.push(btn("call", "Call patient"));
    acts.push(btn("noshow", "Mark no-show"));
  }
  if (a.status === "checked_in") {
    acts.push(btn("start", "Call in now", "primary"));
    acts.push(btn("reinsert1", "Reinsert after next 1"));
    acts.push(btn("reinsert2", "Reinsert after next 2"));
    acts.push(btn("swap", "Swap with next"));
  }
  if (a.status === "no_show") acts.push(btn("reinsert1", "Arrived: reinsert after next 1", "primary"));
  if (a.payment.status !== "paid" && a.payment.status !== "refunded" && (isActive(a) || a.status === "completed")) acts.push(btn("collect", "Collect payment"));
  if (a.payment.refund?.status === "counter") acts.push(btn("refund-done", `Mark ${rupees(a.payment.refund.amount)} refunded`));
  if (notArrived(a)) acts.push(btn("doctor-cancel", "Doctor cancels", "danger"));
  const ringing = a.calls.at(-1)?.status === "ringing";
  if (ringing && s.me !== a.patientId) {
    acts.push(`<span class="muted" style="font-size:11px;align-self:center">Simulate their answer:</span>`);
    acts.push(btn("sim-20", "“20 min”"), btn("sim-here", "“At the clinic”"), btn("sim-noanswer", "No answer"));
  }
  return acts.join("");
}

function qrow(s, a, group) {
  const p = patientOf(s, a);
  const info = [];
  if (a.status === "in_consult") info.push(`With the doctor since ${tms(a.startedAt)} (${Math.round((s.clock.nowMs - a.startedAt) / MIN)} min)`);
  if (a.status === "reserved") info.push(`<b>Reserved: next in line</b> · ${Math.max(0, Math.ceil((a.graceUntil - s.clock.nowMs) / MIN))} min left (until ${tms(a.graceUntil)})`);
  if (a.status === "checked_in") {
    const est = estimate(s, a);
    info.push(`Checked in ${tms(a.checkedInAt)} by ${esc(a.checkedInBy)} · ${est.ahead} ahead · ${esc(estimateText(est, true).sub.replace("Estimated wait: ", "est. "))}`);
    if (a.flags.arrivedInGrace) info.push("Arrived within grace: goes in right after the current patient");
    if (a.flags.lateArrival) info.push("Late arrival: reinsert to slot them in");
  }
  if (notArrived(a)) {
    info.push(locationLine(s, a));
    const cl = callLine(a);
    if (cl) info.push(cl);
    if (a.lateNote) info.push(`🕑 Patient says about ${a.lateNote.minutes} min late (told ${tms(a.lateNote.at)})`);
    if (a.flags.confirmedAt) info.push(`✓ Confirmed from reminder at ${tms(a.flags.confirmedAt)}`);
  }
  if (a.status === "no_show") info.push(`Marked no-show ${tms(a.noShowAt)}`);
  if (a.status === "cancelled") info.push(`Cancelled by ${esc(a.cancelledBy)}`);
  if (a.status === "pending_payment") info.push("Patient is paying online; slot held");
  if (a.status === "expired") info.push("Online payment not completed; hold expired");
  if (a.reason) info.push(`<span class="muted">Reason: ${esc(a.reason)}</span>`);
  const open = ui.open.has(a.id);
  return `<div class="qrow ${group === "serving" ? "serving-row" : ""} ${group === "reserved" ? "reserved-row" : ""} ${["done", "other", "noshow"].includes(group) ? "dim" : ""}">
    <div><div class="when">${esc(slotLabel(s, a))}</div><div class="tok">${a.token ? `Token<b>${a.token}</b>` : a.kind === "walkin" ? "Walk-in" : a.source === "patient" ? "App" : "Reception"}</div></div>
    <div>
      <div class="who"><span class="n">${esc(p.name)}</span>${paymentBadge(a)}${a.patientId === s.me ? `<span class="badge info">in patient app</span>` : ""}</div>
      <div class="info">${info.map(x => `<div>${x}</div>`).join("")}</div>
      <div class="acts">${rowActions(s, a)}<button class="btn ghost sm" data-action="toggle" data-id="${a.id}">${open ? "Hide" : "Details"}</button></div>
      ${open ? `<details open><summary>Payment</summary>${a.payment.history.map(h => `<div class="line">${tms(h.at)} · ${esc(h.text)}</div>`).join("") || `<div class="line">No payment activity.</div>`}
        ${a.payment.linkUrl ? `<div class="line">Link: <a href="${esc(a.payment.linkUrl)}" target="_blank" rel="noopener">${esc(a.payment.linkUrl)}</a></div>` : ""}
        ${a.payment.orderId ? `<div class="line mono">order ${esc(a.payment.orderId)} ${a.payment.paymentId ? `· ${esc(a.payment.paymentId)}` : ""}</div>` : ""}</details>
        ${a.calls.length ? `<details open><summary>Calls</summary>${a.calls.map(c => `<div class="line">${tms(c.startedAt)} · ${esc(callResultText(c))}</div>${(c.transcript ?? []).map(m => `<div class="line">&nbsp;&nbsp;${m.who === "bot" ? "🤖" : "🗣"} ${esc(m.text)}</div>`).join("")}`).join("")}</details>` : ""}` : ""}
    </div>
  </div>`;
}

function viewQueue(s) {
  const doctor = s.doctors.find(d => d.id === ui.doctorId);
  const day = s.appointments.filter(a => a.doctorId === doctor.id && a.date === ui.date);
  const { serving, waiting } = line(s, doctor.id, ui.date);
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, GROUPS.filter(g => g.filter.includes(k)).reduce((n, g) => n + day.filter(g.test).length, 0)]));
  const ordered = { waiting: waiting };
  const isToday = ui.date === today(s);
  const groups = GROUPS.filter(g => g.filter.includes(ui.filter)).map(g => {
    const list = ordered[g.key] ?? day.filter(g.test).sort((x, y) => x.slot - y.slot);
    if (!list.length) return "";
    return `<div class="group-title">${g.title} · ${list.length}</div>${list.map(a => qrow(s, a, g.key)).join("")}`;
  }).join("");
  return `
    ${isToday ? `<div class="serving">
      <div class="big">${serving ? serving.token : "–"}</div>
      <div class="meta"><div class="t">${serving ? `Now serving: ${esc(patientOf(s, serving).name)}` : "Doctor is free"}</div>
        <div class="s">${serving ? `Since ${tms(serving.startedAt)} · ${doctor.room}` : waiting.length ? `${waiting.length} checked in and waiting` : "Nobody checked in yet"}</div></div>
      <div class="stats"><div><b>${Math.round(avgConsult(doctor))} min</b>avg consult</div><div><b>${waiting.length}</b>waiting</div><div><b>${s.settings.graceMin} min</b>grace</div></div>
      <button class="btn primary" data-action="next" ${!serving && !waiting.length ? "disabled" : ""}>${serving ? "Complete & call next" : "Call next patient"}</button>
    </div>` : ""}
    <div class="chips">${FILTERS.map(([k, label]) => `<span class="chip ${ui.filter === k ? "on" : ""}" data-action="filter" data-v="${k}">${label}<span class="n">${counts[k]}</span></span>`).join("")}</div>
    ${groups || `<div class="note">No appointments here.</div>`}`;
}

function viewCalendar(s) {
  const doctor = s.doctors.find(d => d.id === ui.doctorId);
  const byslot = new Map(s.appointments.filter(a => a.doctorId === doctor.id && a.date === ui.date && !["cancelled", "expired"].includes(a.status)).map(a => [a.slot, a]));
  return `<div class="note">Tap a free slot to book. Walk-in is offered only within 1 hour of now.</div>
    <div class="cal">${slotsFor(s, doctor, ui.date).map(slot => {
      const a = byslot.get(slot.min);
      if (a) return `<div class="slotrow"><span class="time">${slot.label}</span><span><b>${esc(patientOf(s, a).name)}</b> · ${esc(a.status.replace("_", " "))}</span>${paymentBadge(a)}</div>`;
      if (slot.past) return `<div class="slotrow past"><span class="time">${slot.label}</span><span>Past</span><span></span></div>`;
      return `<div class="slotrow free" data-action="slot" data-slot="${slot.min}"><span class="time">${slot.label}</span><span style="color:var(--accent-dark);font-weight:600">Free</span><span class="badge ok">Book</span></div>`;
    }).join("")}</div>`;
}

function viewSchedule(s) {
  ui.date ??= today(s);
  return `<div class="toolbar"><h1>Schedule</h1></div>
    <div class="toolbar">
      <div class="chips">${s.doctors.map(d => `<span class="chip ${d.id === ui.doctorId ? "on" : ""}" data-action="doctor" data-v="${d.id}">${esc(d.name)}</span>`).join("")}</div>
      <span class="datenav"><button data-action="day" data-v="-1" aria-label="Previous day">‹</button>${dateLabel(ui.date, today(s))}<button data-action="day" data-v="1" aria-label="Next day">›</button></span>
      <span class="seg"><button class="${ui.view === "queue" ? "on" : ""}" data-action="view" data-v="queue">Queue</button><button class="${ui.view === "calendar" ? "on" : ""}" data-action="view" data-v="calendar">Calendar</button></span>
    </div>
    ${ui.view === "queue" ? viewQueue(s) : viewCalendar(s)}
    <details><summary class="section-label" style="cursor:pointer">Activity log</summary><div class="log">${s.log.slice(0, 60).map(l => `${tms(l.at)}  ${esc(l.text)}`).join("<br>")}</div></details>`;
}

function viewPatients(s) {
  const q = ui.search.trim().toLowerCase();
  const list = s.patients.filter(p => !q || p.name.toLowerCase().includes(q) || p.phone.includes(q));
  return `<div class="toolbar"><h1>Patients</h1></div>
    <div class="field" style="max-width:420px"><input id="search" data-bind="search" placeholder="Search by name or phone" value="${esc(ui.search)}" /></div>
    <div class="plist">${list.map(p => {
      const appts = s.appointments.filter(a => a.patientId === p.id && (isActive(a) || a.status === "completed")).sort((x, y) => (x.date + x.slot).localeCompare(y.date + y.slot));
      return `<div class="pcard"><div class="top"><div><div class="n">${esc(p.name)}</div><div class="s">${esc(p.phone)}</div></div>
        <button class="btn primary sm" data-action="book-patient" data-id="${p.id}">Book appointment</button></div>
        ${appts.map(a => `<div class="appt"><b>${dateLabel(a.date, today(s))} ${esc(slotLabel(s, a))}</b> · ${esc(doctorOf(s, a).name)} · ${esc(a.status.replace("_", " "))} ${paymentBadge(a)}
          ${a.payment.status === "pending" || a.payment.status === "failed" ? `<button class="btn outline sm" data-action="collect" data-id="${a.id}">Collect payment</button>` : ""}</div>`).join("")}
      </div>`;
    }).join("") || `<div class="note">No patients match.</div>`}</div>`;
}

function viewSettings(s) {
  const st = s.settings;
  const sel = (key, opts) => `<select data-setting="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(st[key]) === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const num = (key, min, max) => `<input type="number" data-setting="${key}" value="${st[key]}" min="${min}" max="${max}" />`;
  return `<div class="toolbar"><h1>Settings</h1></div>
    <div class="form">
      <h2>Payment</h2>
      <div class="field"><label>Patient app bookings</label>${sel("paymentMode", [["prepaid", "Prepaid only"], ["choice", "Patient chooses (pay now or at clinic)"], ["clinic", "Pay at clinic only"]])}
        <div class="hint">Reception bookings always offer cash, UPI / card, payment link or pay at visit.</div></div>
      <div class="field"><label>Payment gateway</label>${sel("gateway", [["auto", "Razorpay (test keys on the server)"], ["mock", "Simulated"]])}
        <div class="hint">${esc(ui.gateway?.label ?? "")}${ui.gateway?.reason ? ` · ${esc(ui.gateway.reason)}` : ""}</div></div>
      <div class="two">
        <div class="field"><label>Payment hold (min)</label>${num("holdMin", 2, 30)}<div class="hint">How long a slot is held while the patient pays.</div></div>
      </div>
      <h2>Refund rule (shown before paying)</h2>
      <div class="two">
        <div class="field"><label>Full refund if cancelled (hours before)</label>${num("fullRefundHours", 0, 72)}</div>
        <div class="field"><label>Later cancellation refund (%)</label>${num("lateCancelRefundPct", 0, 100)}</div>
        <div class="field"><label>No-show refund (%)</label>${num("noShowRefundPct", 0, 100)}</div>
      </div>
      <table class="rule">${refundRule(st).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
      <h2>Booking</h2>
      <div class="field"><label>Slot style (open decision)</label>${sel("slotStyle", [["exact", "Exact time slots (10:00, 10:15, 10:30)"], ["range", "Time range (10 to 11) + check-in time later"]])}</div>
      <h2>Grace and late patients</h2>
      <div class="two">
        <div class="field"><label>Grace period (min)</label>${num("graceMin", 0, 30)}</div>
        <div class="field"><label>No-show cutoff, location on but never left (min after slot)</label>${num("noShowCutoffMin", 10, 120)}</div>
      </div>
      <h2>Arrival calls</h2>
      <div class="two">
        <div class="field"><label>Call type (open decision)</label>${sel("callType", [["voice", "Voice AI"], ["ivr", "IVR (keypress)"]])}</div>
        <div class="field"><label>Language</label>${sel("callLanguage", [["en", "English"], ["ta", "Tamil"]])}</div>
        <div class="field"><label>Call if not arrived, minutes before slot (open decision)</label>${num("callBeforeMin", 0, 60)}</div>
      </div>
      <h2>Clinic</h2>
      <div class="field"><label>Note shown on confirmation</label><input data-setting="clinic.note" value="${esc(s.clinic.note)}" /></div>
    </div>`;
}

// ---------- booking and payment modals ----------

const PAY_OPTS = [["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["link", "Send payment link"], ["visit", "Pay at visit"]];

function payPicker(m, { allowVisit }) {
  const opts = PAY_OPTS.filter(([k]) => allowVisit || k !== "visit");
  return `<div class="section-label">Payment</div>
    <div class="opts">${opts.map(([k, l]) => `<div class="opt ${m.pay === k ? "on" : ""}" data-action="m-pay" data-v="${k}">${l}</div>`).join("")}</div>
    <div class="hint" style="font-size:12px;color:var(--faint)">${{
      cash: "Mark as collected in cash now.",
      upi: "Opens Razorpay on this device with UPI selected (the patient scans or approves).",
      card: "Opens Razorpay on this device with card selected.",
      link: "Razorpay sends the patient a payment link by SMS. It also appears in their app.",
      visit: "Booking is confirmed; payment is collected at the visit."
    }[m.pay] ?? ""}</div>`;
}

function modalHtml(s) {
  const m = ui.modal;
  if (!m) return "";
  const doctor = s.doctors.find(d => d.id === m.doctorId);
  let title = "Book appointment";
  let body = "";
  if (m.kind === "collect") {
    const a = findAppt(s, m.apptId);
    title = "Collect payment";
    body = `<div class="kv"><span class="k">Patient</span><span class="v">${esc(patientOf(s, a).name)}</span></div>
      <div class="kv"><span class="k">Amount</span><span class="v">${rupees(a.payment.amount)}</span></div>
      ${payPicker(m, { allowVisit: false })}
      ${m.error ? `<div class="error">${esc(m.error)}</div>` : ""}
      <button class="btn primary block" data-action="m-collect" ${!m.pay || m.busy ? "disabled" : ""}>${m.busy ? esc(m.busy) : "Collect"}</button>`;
  } else if (m.step === "type") {
    const within = m.date === today(s) && m.slot - nowMin(s) <= 60;
    body = `<div class="lede">${esc(doctor.name)} · ${dateLabel(m.date, today(s))} at ${t12(m.slot)}</div>
      <div class="choice ${m.type === "walkin" ? "on" : ""} ${within ? "" : "dim"}" ${within ? `data-action="m-type" data-v="walkin"` : ""} style="${within ? "" : "opacity:.5;cursor:not-allowed"}">
        <div><div class="t">Book as walk-in</div><div class="s">${within ? "Patient is here now; checks in and gets a token straight away." : "Only within 1 hour of now."}</div></div></div>
      <div class="choice ${m.type === "scheduled" ? "on" : ""}" data-action="m-type" data-v="scheduled"><div><div class="t">Schedule appointment</div><div class="s">Patient gets a confirmation and reminders.</div></div></div>
      <button class="btn primary block" data-action="m-step" data-v="patient" ${m.type ? "" : "disabled"}>Continue</button>`;
  } else if (m.step === "patient") {
    const q = (m.q ?? "").toLowerCase();
    body = `<div class="field"><input id="m-q" data-mbind="q" placeholder="Search patient" value="${esc(m.q ?? "")}" /></div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto">${s.patients.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => `<div class="choice ${m.patientId === p.id ? "on" : ""}" data-action="m-patient" data-v="${p.id}"><div><div class="t">${esc(p.name)}</div><div class="s">${esc(p.phone)}</div></div></div>`).join("")}</div>
      <div class="section-label">Or add a new patient</div>
      <div class="two" style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div class="field"><input data-mbind="newName" placeholder="Name" value="${esc(m.newName ?? "")}" /></div><div class="field"><input data-mbind="newPhone" placeholder="+91 phone" value="${esc(m.newPhone ?? "")}" /></div></div>
      <button class="btn outline sm" data-action="m-add">Add patient</button>
      <button class="btn primary block" data-action="m-step" data-v="confirm" ${m.patientId ? "" : "disabled"}>Continue</button>`;
  } else if (m.step === "slot") {
    const dates = Array.from({ length: 7 }, (_, i) => addDays(today(s), i));
    body = `<div class="lede">For ${esc(patientOf(s, { patientId: m.patientId }).name)}</div>
      <div class="section-label">Doctor</div>
      <div class="chips">${s.doctors.map(d => `<span class="chip ${d.id === m.doctorId ? "on" : ""}" data-action="m-doctor" data-v="${d.id}">${esc(d.name)}</span>`).join("")}</div>
      <div class="section-label">Date</div>
      <div class="chips">${dates.map(d => `<span class="chip ${d === m.date ? "on" : ""}" data-action="m-date" data-v="${d}">${dateLabel(d, today(s))}</span>`).join("")}</div>
      <div class="section-label">Time</div>
      <div class="slots">${slotsFor(s, doctor, m.date).map(x => `<div class="opt ${x.free ? "" : "off"} ${m.slot === x.min ? "on" : ""}" ${x.free ? `data-action="m-slot" data-v="${x.min}"` : ""}>${x.label}</div>`).join("")}</div>
      <button class="btn primary block" data-action="m-step" data-v="confirm" ${m.slot != null ? "" : "disabled"}>Continue</button>`;
  } else if (m.step === "confirm") {
    title = "Confirm appointment";
    body = `<div>
        <div class="kv"><span class="k">Patient</span><span class="v">${esc(patientOf(s, { patientId: m.patientId }).name)}</span></div>
        <div class="kv"><span class="k">Doctor</span><span class="v">${esc(doctor.name)}</span></div>
        <div class="kv"><span class="k">When</span><span class="v">${dateLabel(m.date, today(s))}, ${t12(m.slot)}${m.type === "walkin" ? " (walk-in)" : ""}</span></div>
        <div class="kv"><span class="k">Fee</span><span class="v">${rupees(doctor.fee)}</span></div>
      </div>
      ${payPicker(m, { allowVisit: true })}
      ${m.error ? `<div class="error">${esc(m.error)}</div>` : ""}
      <button class="btn primary block" data-action="m-confirm" ${!m.pay || m.busy ? "disabled" : ""}>${m.busy ? esc(m.busy) : "Confirm appointment"}</button>`;
  } else if (m.step === "done") {
    title = "Appointment booked";
    const a = findAppt(s, m.apptId);
    body = `<div class="okbox"><b>Appointment booked!</b> A confirmation has been sent to the patient.</div>
      <div class="kv"><span class="k">Payment</span><span class="v">${paymentBadge(a)}</span></div>
      ${a.token ? `<div class="kv"><span class="k">Token</span><span class="v">${a.token}</span></div>` : ""}
      ${a.payment.linkUrl ? `<div class="note">Payment link: <a href="${esc(a.payment.linkUrl)}" target="_blank" rel="noopener">${esc(a.payment.linkUrl)}</a></div>` : ""}
      ${m.warn ? `<div class="warn">${esc(m.warn)}</div>` : ""}
      <button class="btn primary block" data-action="m-close">Back to schedule</button>`;
  }
  return `<div class="modal-bg" data-action="m-bg"><div class="modal" data-stop><div class="mh"><span class="t">${title}</span><button class="x" data-action="m-close" aria-label="Close">×</button></div>${body}</div></div>`;
}

// Runs one payment choice against an existing appointment. Returns a warning
// string if it didn't complete (the appointment stays booked, payment pending).
async function collect(apptId, choice) {
  const s = getState();
  const a = findAppt(s, apptId);
  const doctor = doctorOf(s, a);
  if (choice === "visit") return null;
  if (choice === "cash") {
    update(st => markPaid(st, findAppt(st, apptId), { method: "cash", by: "reception" }));
    return null;
  }
  if (choice === "link") {
    const p = patientOf(s, a);
    const link = await createLink({
      amountRupees: a.payment.amount,
      description: `Consultation, ${doctor.name}, ${dateLabel(a.date, today(s))} ${slotLabel(s, a)}`,
      customer: { name: p.name, contact: p.phone },
      referenceId: a.id,
      notes: { appointmentId: a.id }
    });
    update(st => {
      const x = findAppt(st, apptId);
      Object.assign(x.payment, { mode: "link", linkId: link.id, linkUrl: link.shortUrl, error: null });
      x.payment.history.push({ at: st.clock.nowMs, text: `Payment link sent (${link.id})` });
      notify(st, x, { kind: "pay_link", title: `Pay ${rupees(x.payment.amount)} for your appointment`, body: `${doctor.name}, ${dateLabel(x.date, today(st))} ${slotLabel(st, x)}. Tap to pay securely with Razorpay.` });
    });
    return null;
  }
  const r = await pay({
    amountRupees: a.payment.amount,
    description: `Consultation, ${doctor.name}`,
    prefill: payerOf(s, a),
    method: choice,
    notes: { appointmentId: a.id, collectedBy: "reception" },
    onOrder: orderId => update(st => {
      findAppt(st, apptId).payment.orderId = orderId;
    })
  });
  if (r.status === "paid") {
    update(st => markPaid(st, findAppt(st, apptId), { method: r.method ?? choice, paymentId: r.paymentId, orderId: r.orderId, by: "reception, Razorpay" }));
    return null;
  }
  const why = r.status === "dismissed" ? "Payment window closed before paying." : r.status === "unknown" ? "Payment result didn't come back; check the order in Razorpay." : r.error;
  update(st => findAppt(st, apptId).payment.history.push({ at: st.clock.nowMs, text: `${choice.toUpperCase()} attempt: ${why}` }));
  return `Payment not collected: ${why} You can collect it later from the appointment.`;
}

async function confirmModal() {
  const m = ui.modal;
  let apptId;
  try {
    apptId = update(s => {
      const a = createAppointment(s, {
        doctorId: m.doctorId, patientId: m.patientId, date: m.date, slot: m.slot,
        source: "clinic", kind: m.type === "walkin" ? "walkin" : "scheduled", status: "booked", payment: { mode: "clinic" }
      });
      confirmBooking(s, a);
      if (m.type === "walkin") checkIn(s, a, "reception");
      return a.id;
    });
  } catch (err) {
    m.error = err.message;
    return render();
  }
  m.apptId = apptId;
  m.busy = "Collecting payment…";
  render();
  try {
    m.warn = await collect(apptId, m.pay);
  } catch (err) {
    m.warn = `Payment not collected: ${err.message}`;
  }
  Object.assign(m, { step: "done", busy: null });
  render();
}

async function collectModal() {
  const m = ui.modal;
  m.busy = "Working…";
  render();
  try {
    const warn = await collect(m.apptId, m.pay);
    if (warn) {
      Object.assign(m, { busy: null, error: warn });
      return render();
    }
    toast("Payment updated");
    ui.modal = null;
  } catch (err) {
    Object.assign(m, { busy: null, error: err.message });
  }
  render();
}

// ---------- render ----------

function render() {
  const s = getState();
  side.innerHTML = `<div class="brand">ninto clinic</div><div class="clinic">${esc(s.clinic.name)}</div>
    ${[["schedule", "Schedule"], ["patients", "Patients"], ["settings", "Settings"]].map(([k, l]) => `<div class="nav ${ui.tab === k ? "on" : ""}" data-action="tab" data-v="${k}">${l}</div>`).join("")}
    <div class="gw">Payments: ${esc(ui.gateway?.label ?? "…")}</div>`;
  const typing = document.activeElement?.matches?.("input, textarea, select") && (main.contains(document.activeElement) || modalEl.contains(document.activeElement));
  if (!typing) {
    main.innerHTML = { schedule: viewSchedule, patients: viewPatients, settings: viewSettings }[ui.tab](s);
    modalEl.innerHTML = modalHtml(s);
  }
}

function act(fn) {
  update(fn);
}

document.addEventListener("click", async event => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const { action, v, id } = el.dataset;
  if (action === "m-bg" && event.target.closest("[data-stop]")) return;
  const s = getState();
  const m = ui.modal;
  switch (action) {
    case "tab": ui.tab = v; break;
    case "doctor": ui.doctorId = v; break;
    case "day": ui.date = addDays(ui.date, Number(v)); break;
    case "view": ui.view = v; break;
    case "filter": ui.filter = v; break;
    case "toggle": ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id); break;
    case "next": {
      const next = update(st => callNext(st, ui.doctorId, ui.date));
      if (next) toast(`Calling ${patientOf(getState(), next).name}`, `Token ${next.token}`);
      break;
    }
    case "complete": act(st => completeCurrent(st, ui.doctorId, ui.date)); break;
    case "start": act(st => {
      completeCurrent(st, ui.doctorId, ui.date);
      startConsult(st, findAppt(st, id));
    }); break;
    case "checkin": act(st => checkIn(st, findAppt(st, id), "reception")); break;
    case "noshow": act(st => markNoShow(st, findAppt(st, id), "reception")); break;
    case "reinsert1": act(st => reinsert(st, findAppt(st, id), 1)); break;
    case "reinsert2": act(st => reinsert(st, findAppt(st, id), 2)); break;
    case "swap": act(st => swapWithNext(st, findAppt(st, id))); break;
    case "call": act(st => startCall(st, findAppt(st, id), "manual")); toast("Calling the patient", "The result shows on their row."); break;
    case "sim-20": act(st => finishCall(st, findAppt(st, id), { outcome: "eta", etaMin: 20 })); break;
    case "sim-here": act(st => finishCall(st, findAppt(st, id), { outcome: "at_clinic" })); break;
    case "sim-noanswer": act(st => finishCall(st, findAppt(st, id), { outcome: "no_answer" })); break;
    case "doctor-cancel": {
      const q = refundQuote(s, findAppt(s, id), "doctor");
      act(st => cancelAppointment(st, findAppt(st, id), "doctor"));
      toast("Cancelled, patient notified", q.amount ? `Full refund ${rupees(q.amount)}` : "Nothing was paid");
      break;
    }
    case "refund-done": act(st => {
      const a = findAppt(st, id);
      a.payment.refund.status = "processed";
      a.payment.status = "refunded";
      a.payment.history.push({ at: st.clock.nowMs, text: `Refunded ${rupees(a.payment.refund.amount)} in cash at the counter` });
    }); break;
    case "collect": ui.modal = { kind: "collect", apptId: id, pay: null }; break;
    case "slot": ui.modal = { kind: "book", step: "type", doctorId: ui.doctorId, date: ui.date, slot: Number(el.dataset.slot), type: null, pay: null }; break;
    case "book-patient": ui.modal = { kind: "book", step: "slot", patientId: id, doctorId: ui.doctorId, date: today(s), slot: null, type: "scheduled", pay: null }; break;
    case "m-close": ui.modal = null; break;
    case "m-bg": ui.modal = null; break;
    case "m-type": m.type = v; break;
    case "m-step": m.step = v; break;
    case "m-patient": m.patientId = v; break;
    case "m-doctor": Object.assign(m, { doctorId: v, slot: null }); break;
    case "m-date": Object.assign(m, { date: v, slot: null }); break;
    case "m-slot": m.slot = Number(v); break;
    case "m-pay": m.pay = v; m.error = null; break;
    case "m-add": {
      if (!m.newName?.trim() || !m.newPhone?.trim()) {
        toast("Add a name and phone number");
        break;
      }
      m.patientId = update(st => {
        const p = { id: `p${st.patients.length + 1}_${Date.now().toString(36)}`, name: m.newName.trim(), phone: m.newPhone.replace(/\s+/g, "") };
        st.patients.push(p);
        return p.id;
      });
      break;
    }
    case "m-confirm": return confirmModal();
    case "m-collect": return collectModal();
    default: return;
  }
  render();
});

document.addEventListener("input", event => {
  const t = event.target;
  if (t.dataset.bind) ui[t.dataset.bind] = t.value;
  if (t.dataset.mbind && ui.modal) ui.modal[t.dataset.mbind] = t.value;
  // Search filters as you type: redraw, then put the caret back.
  if (t.id === "search" || t.id === "m-q") {
    const pos = t.selectionStart;
    t.blur();
    render();
    const again = document.getElementById(t.id);
    again.focus();
    again.setSelectionRange(pos, pos);
  }
});

document.addEventListener("change", event => {
  const key = event.target.dataset.setting;
  if (!key) return;
  const raw = event.target.value;
  update(s => {
    if (key === "clinic.note") s.clinic.note = raw;
    else s.settings[key] = event.target.type === "number" ? Number(raw) : raw;
  });
  if (key === "gateway") gatewayInfo().then(g => { ui.gateway = g; render(); });
  event.target.blur();
  render();
});

subscribe(render);
gatewayInfo().then(g => {
  ui.gateway = g;
  render();
});
startBackgroundWork();
render();
