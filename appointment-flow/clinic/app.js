/**
 * Clinic app (boards F1-F3 of the discussion doc). Schedule -> doctor -> the
 * day's queue, led by "Up next": the live projected order, with patients
 * still on the way placed by when they'll arrive (live ETA, trip, AI
 * call, "I'll be late") instead of late = last. Then the filters (All,
 * Checked in, Completed, Booked, Others) with Now serving,
 * Reserved + grace countdown, Waiting, On the way and No-show; live ETA and
 * AI call results (coming or not, ETA, travel mode, summary, note for the
 * doctor) on each expected patient's row; the manual actions that are
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
  callNext, completeCurrent, startConsult, line, estimate, estimateText, avgConsult, startCall, finishCall, callResultText, callChannel, locationFresh,
  etaMin, refundRule, refundQuote, isActive, notArrived, patientOf, doctorOf, notify, slotLabel, today, nowMin,
  projection, arrivalOf, callFacts
} from "../shared/flow.js";
import { pay, createLink, gatewayInfo, startBackgroundWork, payerOf } from "../shared/payments.js";
import { mountSimBar, paymentBadge, toast } from "../shared/ui.js";
import { receiptHtml, GST_RATES } from "../shared/receipt.js";
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
  hSearch: "",
  hDoctor: "all",
  hRange: 30,
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
  { key: "late", title: "Late, grace over (fitted in by arrival)", test: a => a.status === "late", filter: ["all", "booked"] },
  { key: "expected", title: "On the way / not arrived yet", test: a => a.status === "booked", filter: ["all", "booked"] },
  { key: "noshow", title: "No-show", test: a => a.status === "no_show", filter: ["all", "others"] },
  { key: "done", title: "Completed", test: a => a.status === "completed", filter: ["all", "completed"] },
  { key: "other", title: "Cancelled / unconfirmed", test: a => ["cancelled", "pending_payment", "expired"].includes(a.status), filter: ["others"] }
];
const FILTERS = [["all", "All"], ["checked", "Checked in"], ["completed", "Completed"], ["booked", "Booked"], ["others", "Others"]];

// The clinic never sees where the patient is: only whether their phone is
// sending a live ETA (worked out on the phone from their location).
function etaShareLine(s, a) {
  const loc = a.location;
  if (!loc) return `<span class="muted">Live ETA not shared</span>`;
  if (!loc.sharing) return `<span class="muted">Live ETA sharing stopped</span>`;
  if (!locationFresh(s, a)) return `⏱ No ETA update for ${Math.round((s.clock.nowMs - loc.updatedAt) / MIN)} min, treated as unknown`;
  return `⏱ Live ETA from their phone · updated ${tms(loc.updatedAt)}`;
}

// Where this patient lands in the projected order, and why.
// The clinic gets one exact arrival time and where it came from, never how
// the patient is travelling or where they are.
const ARRIVAL_SOURCE = { location: "live ETA from their phone", trip: "from their trip", call: "said on the call", patient: "said they're running late", slot: "assumed on time", grace: "slot held" };
function arrivalLine(s, a) {
  const arr = arrivalOf(s, a);
  const est = estimate(s, a);
  if (!arr) return `🧭 <b>Arrival unknown</b> · placed after everyone else until we hear from them`;
  const updated = arr.source === "location" && a.location?.eta?.at ? `, updated ${tms(a.location.eta.at)}` : "";
  return `🧭 ${arr.firm ? `<b>Arrives ${tms(arr.etaMs)}</b>` : `Arrives ${tms(arr.etaMs)}`} <span class="muted">(${ARRIVAL_SOURCE[arr.source] ?? ""}${updated}${arr.overdue ? ", now overdue" : ""})</span> → #${est.position} in line, in ~${tms(est.projectedMs)}`;
}

function callLine(a) {
  const call = a.calls.at(-1);
  if (!call) return "";
  const kind = call.provider === "exotel" ? "IVR phone call, Exotel" : call.provider === "ivr_phone" ? (ui.exotel?.live ? "IVR phone call, Exotel" : "IVR phone call, simulated") : call.provider === "phone_sim" ? "phone call, simulated" : call.type === "ivr" ? "IVR" : call.provider === "elevenlabs_phone" ? "ElevenLabs phone call" : call.engine === "elevenlabs" ? "ElevenLabs + Claude (in app)" : call.engine === "claude" ? "AI call (Claude)" : call.engine === "script" ? "Voice AI (scripted)" : "Voice AI";
  const meta = [call.durationSecs != null ? `${call.durationSecs} s` : "", call.costUsd != null ? `$${Number(call.costUsd).toFixed(3)}` : ""].filter(Boolean).join(", ");
  const tone = { yes: "ok", no: "red", unsure: "amber" }[call.coming];
  const badge = call.status === "done" && tone ? `<span class="badge ${tone}">${{ yes: "Coming", no: "Not coming", unsure: "Unsure" }[call.coming]}</span> ` : "";
  return `📞 ${badge}${esc(callResultText(call, { withMode: false }))} <span class="muted">(${callChannel(call) === "app" ? "in app · " : ""}${kind}${call.lang === "ta" ? ", Tamil" : ""}, ${call.trigger === "auto" ? "automatic" : call.trigger}, ${tms(call.startedAt)}${meta ? `, ${meta}` : ""})</span>${call.summary ? `<br><span class="muted">AI summary:</span> ${esc(call.summary)}` : ""}${call.note ? `<br>📝 For the doctor: “${esc(call.note)}”` : ""}`;
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
  if (a.payment.receiptNo) acts.push(btn("receipt", "Receipt"));
  if (a.payment.refund?.status === "counter") acts.push(btn("refund-done", `Mark ${rupees(a.payment.refund.amount)} refunded`));
  if (notArrived(a)) acts.push(btn("doctor-cancel", "Doctor cancels", "danger"));
  const ringing = a.calls.at(-1)?.status === "ringing";
  // Simulated answers: in-app calls for patients not open in the patient app,
  // and simulated phone calls (they ring a phone, not the app).
  if (ringing && a.calls.at(-1).provider !== "elevenlabs_phone" && (s.me !== a.patientId || a.calls.at(-1).provider === "phone_sim")) {
    acts.push(`<span class="muted" style="font-size:11px;align-self:center">Simulate their answer:</span>`);
    if (a.calls.at(-1).provider === "ivr_phone") {
      acts.push(`<span class="muted" style="font-size:11px;align-self:center">Their keypress:</span>`);
      acts.push(btn("ivr-10", "1→1 under 10 min"), btn("ivr-20", "1→2 10–20 min"), btn("ivr-40", "1→3 20–40 min"), btn("ivr-60", "1→4 40+ min"), btn("sim-here", "2 At the clinic"), btn("ivr-cancel", "3 Cancel"), btn("sim-noanswer", "No answer"));
    } else acts.push(btn("sim-20", "“20 min away”"), btn("sim-here", "“At the clinic”"), btn("sim-no", "“Can't come”"), btn("sim-noanswer", "No answer"));
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
    if (a.flags.arrivedInGrace) info.push("Arrived within grace: kept their slot");
    if (a.flags.lateArrival) info.push(`Late arrival: placed as if booked for ${t12(a.seq)} (arrival − grace), not at the end`);
  }
  if (notArrived(a) && a.date === today(s)) info.push(arrivalLine(s, a));
  if (notArrived(a)) {
    if (a.trip) info.push(`🧳 Set off ${tms(a.trip.startedAt)}`);
    info.push(etaShareLine(s, a));
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
        ${a.calls.length ? `<details open><summary>Calls</summary>${a.calls.map(c => `<div class="line">${tms(c.startedAt)} · ${esc(callResultText(c, { withMode: false }))}</div>${(c.transcript ?? []).map(m => `<div class="line">&nbsp;&nbsp;${m.who === "bot" ? "🤖" : "🗣"} ${esc(m.text)}</div>`).join("")}`).join("")}</details>` : ""}` : ""}
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
    ${isToday ? upNext(s, doctor) : ""}
    <div class="chips">${FILTERS.map(([k, label]) => `<span class="chip ${ui.filter === k ? "on" : ""}" data-action="filter" data-v="${k}">${label}<span class="n">${counts[k]}</span></span>`).join("")}</div>
    ${groups || `<div class="note">No appointments here.</div>`}`;
}

// The projected order from now: who goes in next and roughly when, with
// patients on the way slotted in by expected arrival.
function upNext(s, doctor) {
  const p = projection(s, doctor.id, ui.date);
  if (!p.order.length) return "";
  const chip = c => {
    if (c.here) return `<span class="badge ok">Here · token ${c.a.token}</span>`;
    if (c.unknown) return `<span class="badge red">Not heard from</span>`;
    const src = { location: "⏱ Live ETA", trip: "🧳 Trip", call: "📞 Call", patient: "🕑 Said late", slot: "Booked", grace: "Held" }[c.arrival.source];
    return `<span class="badge ${c.arrival.firm ? "amber" : ""}">${src} · arrives ${tms(c.arrival.etaMs)}</span>`;
  };
  return `<div class="upnext">
    <div class="between"><div class="group-title" style="margin:0">Up next (live projection)</div><span class="muted" style="font-size:11px">Late patients are fitted in by arrival time, not sent to the end</span></div>
    <table>${p.order.slice(0, 8).map((c, i) => `<tr class="${c.here ? "" : "away"}">
      <td class="pos">${i + 1}</td>
      <td><b>${esc(patientOf(s, c.a).name)}</b> <span class="muted">${esc(slotLabel(s, c.a))}${c.a.seq !== c.a.slot && c.here ? ` → placed ${t12(c.a.seq)}` : !c.here && c.key !== c.a.slot && Number.isFinite(c.key) ? ` → placed ${t12(c.key)}` : ""}</span></td>
      <td>${chip(c)}</td>
      <td class="at">~${tms(c.startMs)}</td></tr>`).join("")}</table>
  </div>`;
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
      const appts = s.appointments.filter(a => a.patientId === p.id && isActive(a)).sort((x, y) => (x.date + x.slot).localeCompare(y.date + y.slot));
      const past = s.appointments.filter(a => a.patientId === p.id && isPast(s, a)).sort(newestFirst);
      return `<div class="pcard"><div class="top"><div><div class="n">${esc(p.name)}</div><div class="s">${esc(p.phone)}</div></div>
        <button class="btn primary sm" data-action="book-patient" data-id="${p.id}">Book appointment</button></div>
        ${appts.map(a => `<div class="appt"><b>${dateLabel(a.date, today(s))} ${esc(slotLabel(s, a))}</b> · ${esc(doctorOf(s, a).name)} · ${esc(a.status.replace("_", " "))} ${paymentBadge(a)}
          ${a.payment.status === "pending" || a.payment.status === "failed" ? `<button class="btn outline sm" data-action="collect" data-id="${a.id}">Collect payment</button>` : ""}
          ${a.payment.receiptNo ? `<button class="btn outline sm" data-action="receipt" data-id="${a.id}">Receipt</button>` : ""}</div>`).join("")}
        ${past.length ? `<details><summary class="s" style="cursor:pointer">Past visits (${past.length})</summary>${past.map(a => `<div class="appt"><b>${dateLabel(a.date, today(s))} ${esc(slotLabel(s, a))}</b> · ${esc(doctorOf(s, a).name)} · ${esc(a.status.replace("_", " "))} ${paymentBadge(a)}
          ${a.payment.receiptNo ? `<button class="btn outline sm" data-action="receipt" data-id="${a.id}">Receipt</button>` : ""}</div>`).join("")}</details>` : ""}
      </div>`;
    }).join("") || `<div class="note">No patients match.</div>`}</div>`;
}

// Past appointments (anything before today, plus today's finished ones),
// newest first, with the receipt for each paid visit.
const PAST_STATUS = ["completed", "no_show", "cancelled"];
const isPast = (s, a) => a.date < today(s) ? a.status !== "expired" && a.status !== "pending_payment" : PAST_STATUS.includes(a.status) && a.date === today(s);
const newestFirst = (x, y) => (y.date + String(y.slot).padStart(4, "0")).localeCompare(x.date + String(x.slot).padStart(4, "0"));

function viewHistory(s) {
  const q = ui.hSearch.trim().toLowerCase();
  const from = addDays(today(s), -ui.hRange);
  const list = s.appointments
    .filter(a => isPast(s, a) && a.date >= from && (ui.hDoctor === "all" || a.doctorId === ui.hDoctor))
    .filter(a => {
      const p = patientOf(s, a);
      return !q || p.name.toLowerCase().includes(q) || p.phone.includes(q) || (a.payment.receiptNo ?? "").toLowerCase().includes(q);
    })
    .sort(newestFirst);
  const paid = list.filter(a => a.payment.status === "paid" || a.payment.status === "refunded");
  const collected = paid.reduce((n, a) => n + a.payment.amount - (a.payment.refund?.status === "processed" ? a.payment.refund.amount : 0), 0);
  let lastDate = null;
  const rows = list.map(a => {
    const head = a.date !== lastDate ? `<div class="group-title">${dateLabel(a.date, today(s))}</div>` : "";
    lastDate = a.date;
    const p = patientOf(s, a);
    return `${head}<div class="hrow">
      <span class="time">${esc(slotLabel(s, a))}</span>
      <span><b>${esc(p.name)}</b> <span class="muted">${esc(p.phone)}</span><br><span class="muted">${esc(doctorOf(s, a).name)} · ${esc(a.status.replace("_", " "))}${a.payment.receiptNo ? ` · <span class="mono">${esc(a.payment.receiptNo)}</span>` : ""}</span></span>
      <span class="end">${rupees(a.payment.amount)} ${paymentBadge(a)}
        ${a.payment.receiptNo ? `<button class="btn outline sm" data-action="receipt" data-id="${a.id}">Receipt</button>` : a.payment.status !== "refunded" && a.status === "completed" ? `<button class="btn outline sm" data-action="collect" data-id="${a.id}">Collect payment</button>` : ""}</span>
    </div>`;
  }).join("");
  return `<div class="toolbar"><h1>History</h1></div>
    <div class="toolbar">
      <div class="chips"><span class="chip ${ui.hDoctor === "all" ? "on" : ""}" data-action="h-doctor" data-v="all">All doctors</span>${s.doctors.map(d => `<span class="chip ${d.id === ui.hDoctor ? "on" : ""}" data-action="h-doctor" data-v="${d.id}">${esc(d.name)}</span>`).join("")}</div>
      <span class="seg">${[[7, "7 days"], [30, "30 days"], [365, "1 year"]].map(([v, l]) => `<button class="${ui.hRange === v ? "on" : ""}" data-action="h-range" data-v="${v}">${l}</button>`).join("")}</span>
    </div>
    <div class="field" style="max-width:420px"><input id="h-search" data-bind="hSearch" placeholder="Search patient, phone or receipt no." value="${esc(ui.hSearch)}" /></div>
    <div class="stats"><div><b>${list.length}</b>visits</div><div><b>${paid.length}</b>receipts</div><div><b>${rupees(collected)}</b>collected</div></div>
    <div class="hist">${rows || `<div class="note">No past appointments here.</div>`}</div>`;
}

function viewSettings(s) {
  const st = s.settings;
  const sel = (key, opts) => `<select data-setting="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(st[key]) === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const num = (key, min, max) => `<input type="number" data-setting="${key}" value="${st[key] ?? 1}" min="${min}" max="${max}" />`;
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
      <h2>GST billing</h2>
      <div class="two">
        <div class="field"><label>Clinic GSTIN</label><input data-setting="clinic.gstin" value="${esc(s.clinic.gstin ?? "")}" placeholder="33AABCN1234F1Z5" maxlength="15" /></div>
        <div class="field"><label>State (place of supply)</label><input data-setting="clinic.state" value="${esc(s.clinic.state ?? "")}" placeholder="Tamil Nadu (33)" /></div>
        <div class="field"><label>GST on consultation fee</label>${sel("gstRate", GST_RATES.map(r => [r, r ? `${r}% (CGST ${r / 2}% + SGST ${r / 2}%)` : "Exempt (bill of supply)"]))}
          <div class="hint">The fee includes GST; the receipt splits it out. Consultations at a clinical establishment are usually exempt.</div></div>
        <div class="field"><label>SAC code</label><input data-setting="sac" value="${esc(st.sac ?? "9993")}" /></div>
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
        <div class="field"><label>No-show cutoff, ETA sharing on but never left (min after slot)</label>${num("noShowCutoffMin", 10, 120)}</div>
      </div>
      <h2>Arrival calls</h2>
      <div class="two">
        <div class="field"><label>Call type</label><div><b>IVR phone call</b> (keypad menu, no AI)</div>
          <div class="hint">Rings the patient's phone: 1 on the way (then how far: 1 under 10 min, 2 10–20, 3 20–40, 4 over 40), 2 at the clinic, 3 cancel.</div></div>
        <div class="field"><label>Phone line</label><div><b>${ui.exotel?.live ? "Exotel: real calls" : "Simulated"}</b></div>
          <div class="hint">${ui.exotel?.live ? `Calls go only to numbers in EXOTEL_ALLOWED_TO (${esc((ui.exotel.allowedTo ?? []).join(", "))}).${ui.exotel.statusCallback ? "" : " EXOTEL_PUBLIC_URL isn't set, so unanswered calls are only marked after 4 minutes."} Patients must have agreed to calls (TRAI).` : `Exotel not set up (${esc(ui.exotel?.reason ?? "checking…")}). Enter the keypress from the patient's row.`}</div></div>
        ${ui.exotel?.live ? `<div class="field"><label>Demo: send real calls to</label><input data-setting="testPhone" value="${esc(s.settings.testPhone ?? "")}" placeholder="+91 98xxxxxxxx" />
          <div class="hint">Demo patients have made-up numbers, so real calls go here. It must be in EXOTEL_ALLOWED_TO.</div></div>` : ""}
        <div class="field"><label>Language</label>${sel("callLanguage", [["en", "English"], ["ta", "Tamil"]])}</div>
        <div class="field"><label>Call if not arrived, minutes before slot (open decision)</label>${num("callBeforeMin", 0, 60)}</div>
      </div>
      <h2>Clinic</h2>
      <div class="field"><label>Note shown on confirmation</label><input data-setting="clinic.note" value="${esc(s.clinic.note)}" /></div>
    </div>`;
}

// ---------- real phone calls (ElevenLabs) ----------
// Reception's device places the calls the rules engine asks for and collects
// the results. POC only: production does this on the server, with the
// post-call webhook as the source of truth.

const placing = new Set();

async function dispatchPhoneCalls() {
  const s = getState();
  for (const a of s.appointments) {
    const call = a.calls.at(-1);
    // IVR arrival calls: a real Exotel call when the server is set up,
    // otherwise they stay simulated (reception enters the keypress).
    if (call?.provider === "ivr_phone" && ui.exotel?.live && call.status === "ringing" && !call.dispatchedAt && !placing.has(call.id)) {
      placeExotelCall(a.id, call.id);
      continue;
    }
    if (call?.provider === "exotel" && call.status === "in_progress" && call.exotelSid && !placing.has(call.id)) {
      pollExotelCall(a.id, call.id, call.exotelSid);
      continue;
    }
    if (call?.provider !== "elevenlabs_phone" || placing.has(call.id)) continue;
    if (call.status === "ringing" && !call.dispatchedAt) placeCall(a.id, call.id);
    else if (call.status === "in_progress" && call.conversationId) pollCall(a.id, call.id, call.conversationId);
  }
}

async function placeCall(apptId, callId) {
  placing.add(callId);
  // Claim it first, so a second clinic tab doesn't dial too.
  const claimed = update(st => {
    const c = findAppt(st, apptId).calls.find(x => x.id === callId);
    if (c.dispatchedAt) return false;
    c.dispatchedAt = Date.now();
    return true;
  });
  if (!claimed) return placing.delete(callId);
  const s = getState();
  const a = findAppt(s, apptId);
  try {
    const res = await fetch("/api/elevenlabs/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: s.settings.testPhone || patientOf(s, a).phone, variables: callFacts(s, a) })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `Call failed (${res.status})`);
    update(st => Object.assign(findAppt(st, apptId).calls.find(x => x.id === callId), { status: "in_progress", conversationId: d.conversationId, engine: "elevenlabs" }));
    toast(`Calling ${patientOf(s, a).name}`, "Real phone call through ElevenLabs.");
  } catch (err) {
    update(st => finishCall(st, findAppt(st, apptId), { outcome: "no_answer", engine: "elevenlabs", summary: `Call not placed: ${err.message}` }));
    toast("Call not placed", err.message);
  }
  placing.delete(callId);
}

// ---------- real IVR calls (Exotel) ----------

function ivrGreeting(s, a, lang) {
  const first = patientOf(s, a).name.split(" ")[0];
  const doctor = doctorOf(s, a).name;
  return lang === "ta"
    ? `வணக்கம் ${first}, ${s.clinic.name} சார்பாக, ${doctor} உடனான இன்றைய ${slotLabel(s, a)} சந்திப்பு பற்றி அழைக்கிறோம்.`
    : `Hello ${first}. This is ${s.clinic.name}, about your ${slotLabel(s, a)} appointment with ${doctor} today.`;
}

async function placeExotelCall(apptId, callId) {
  placing.add(callId);
  const claimed = update(st => {
    const c = findAppt(st, apptId).calls.find(x => x.id === callId);
    if (c.dispatchedAt) return false;
    c.dispatchedAt = Date.now();
    return true;
  });
  if (!claimed) return placing.delete(callId);
  const s = getState();
  const a = findAppt(s, apptId);
  const call = a.calls.find(x => x.id === callId);
  try {
    const res = await fetch("/api/exotel/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: s.settings.testPhone || patientOf(s, a).phone, apptId, greeting: ivrGreeting(s, a, call.lang) })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `Call failed (${res.status})`);
    update(st => Object.assign(findAppt(st, apptId).calls.find(x => x.id === callId), { status: "in_progress", provider: "exotel", exotelSid: d.sid, realStartedAt: Date.now() }));
    toast(`Calling ${patientOf(s, a).name}`, "Real IVR call through Exotel.");
  } catch (err) {
    update(st => finishCall(st, findAppt(st, apptId), { outcome: "no_answer", engine: "ivr", summary: `Call not placed: ${err.message}` }));
    toast("Call not placed", err.message);
  }
  placing.delete(callId);
}

// Exotel's keypress -> the app's call result.
const EXOTEL_ANSWERS = {
  eta10: { outcome: "eta", etaMin: 10 },
  eta20: { outcome: "eta", etaMin: 20 },
  eta40: { outcome: "eta", etaMin: 40 },
  eta60: { outcome: "eta", etaMin: 60 },
  here: { outcome: "at_clinic" },
  cancel: { outcome: "cancelled" }
};
const EXOTEL_GIVE_UP_MS = 4 * 60 * 1000; // no keypress and no end-of-call report: treat as no answer

async function pollExotelCall(apptId, callId, sid) {
  placing.add(callId);
  try {
    const res = await fetch(`/api/exotel/result?sid=${encodeURIComponent(sid)}`);
    const d = await res.json();
    const call = findAppt(getState(), apptId)?.calls.find(x => x.id === callId);
    const finish = result => update(st => {
      const a = findAppt(st, apptId);
      if (a.calls.at(-1)?.id === callId) finishCall(st, a, { engine: "ivr", durationSecs: d.durationSecs ?? null, ...result });
    });
    if (res.ok && d.answer) finish(EXOTEL_ANSWERS[d.answer] ?? { outcome: "unsure" });
    else if (res.ok && d.done) finish(d.status === "completed" ? { outcome: "unsure", summary: "Answered but didn't press a key." } : { outcome: "no_answer", summary: `Exotel: ${d.status}` });
    else if (call && Date.now() - (call.realStartedAt ?? call.dispatchedAt) > EXOTEL_GIVE_UP_MS) finish({ outcome: "no_answer", summary: "No result from Exotel within 4 minutes." });
  } catch {}
  placing.delete(callId);
}

async function pollCall(apptId, callId, conversationId) {
  placing.add(callId);
  try {
    const res = await fetch(`/api/elevenlabs/conversation/${conversationId}`);
    const d = await res.json();
    if (res.ok && d.done) {
      update(st => {
        const a = findAppt(st, apptId);
        if (a.calls.at(-1)?.id === callId) finishCall(st, a, { ...d.result, transcript: d.transcript, costUsd: d.costUsd, durationSecs: d.durationSecs });
      });
    }
  } catch {}
  placing.delete(callId);
}

setInterval(dispatchPhoneCalls, 4000);

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
  if (m.kind === "receipt") {
    title = "Receipt";
    body = `${receiptHtml(s, findAppt(s, m.apptId))}
      <button class="btn primary block" data-action="print-receipt">Download or print</button>`;
  } else if (m.kind === "collect") {
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
      ${a.payment.receiptNo ? `<button class="btn outline block" data-action="receipt" data-id="${a.id}">View receipt</button>` : ""}
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
    const paid = findAppt(getState(), m.apptId);
    ui.modal = paid.payment.receiptNo ? { kind: "receipt", apptId: paid.id } : null;
  } catch (err) {
    Object.assign(m, { busy: null, error: err.message });
  }
  render();
}

// ---------- render ----------

function render() {
  const s = getState();
  side.innerHTML = `<div class="brand">ninto clinic</div><div class="clinic">${esc(s.clinic.name)}</div>
    ${[["schedule", "Schedule"], ["history", "History"], ["patients", "Patients"], ["settings", "Settings"]].map(([k, l]) => `<div class="nav ${ui.tab === k ? "on" : ""}" data-action="tab" data-v="${k}">${l}</div>`).join("")}
    <div class="gw">Payments: ${esc(ui.gateway?.label ?? "…")}</div>`;
  const typing = document.activeElement?.matches?.("input, textarea, select") && (main.contains(document.activeElement) || modalEl.contains(document.activeElement));
  if (!typing) {
    main.innerHTML = { schedule: viewSchedule, history: viewHistory, patients: viewPatients, settings: viewSettings }[ui.tab](s);
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
    case "h-doctor": ui.hDoctor = v; break;
    case "h-range": ui.hRange = Number(v); break;
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
    case "sim-20": act(st => finishCall(st, findAppt(st, id), { outcome: "eta", etaMin: 20, mode: "auto", summary: "Coming, about 20 min away." })); break;
    case "sim-no": act(st => finishCall(st, findAppt(st, id), { outcome: "unsure", coming: "no", summary: "Says they can't make it; didn't want to cancel on the call." })); break;
    case "sim-here": act(st => finishCall(st, findAppt(st, id), { outcome: "at_clinic" })); break;
    case "ivr-10": case "ivr-20": case "ivr-40": case "ivr-60": {
      const etaMin = Number(action.slice(4));
      act(st => finishCall(st, findAppt(st, id), { outcome: "eta", etaMin, engine: "ivr" }));
      break;
    }
    case "ivr-cancel": act(st => finishCall(st, findAppt(st, id), { outcome: "cancelled", engine: "ivr" })); break;
    case "sim-noanswer": act(st => finishCall(st, findAppt(st, id), { outcome: "no_answer" })); break;
    case "eleven-setup": {
      ui.elevenSetup = "Working…";
      render();
      fetch("/api/elevenlabs/setup", { method: "POST" }).then(r => r.json().then(d => ({ ok: r.ok, d }))).then(({ ok, d }) => {
        ui.elevenSetup = !ok ? `Failed: ${d.error}` : d.created ? `Agent created: ${d.agentId}. Set ELEVENLABS_AGENT_ID=${d.agentId} on the server and restart.` : `Agent ${d.agentId} updated.`;
        render();
      });
      break;
    }
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
    case "receipt": ui.modal = { kind: "receipt", apptId: id }; break;
    case "print-receipt": return window.print();
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
  if (t.id === "search" || t.id === "m-q" || t.id === "h-search") {
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
    if (key.startsWith("clinic.")) s.clinic[key.slice(7)] = key === "clinic.gstin" ? raw.trim().toUpperCase() : raw;
    else if (key === "gstRate") s.settings.gstRate = Number(raw);
    else s.settings[key] = event.target.type === "number" ? Number(raw) : raw;
  });
  if (key === "gateway") gatewayInfo().then(g => { ui.gateway = g; render(); });
  event.target.blur();
  render();
});

subscribe(render);
fetch("/api/exotel/config").then(r => r.json()).catch(() => ({ live: false, reason: "Exotel server not reachable" })).then(cfg => {
  ui.exotel = cfg;
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
render();
