// Starting data for the demo. Two scenarios: a normal morning (the default),
// and the late-patient example from the discussion doc (P1 with the doctor,
// P2 late, P3-P5 waiting), with the signed-in patient as P2.

import { MIN, at, ymd, addDays } from "./util.js";

function baseState(nowMs) {
  return {
    version: 1,
    clock: { nowMs, lastEngineMs: nowMs },
    clinic: {
      name: "Nair Endocrine Clinic",
      address: "12 Greams Road, Thousand Lights, Chennai 600006",
      gstin: "33AABCN1234F1Z5",
      state: "Tamil Nadu (33)",
      note: "2nd floor, parking behind the building",
      mapUrl: "https://maps.google.com/?q=13.0604,80.2496"
    },
    settings: {
      paymentMode: "choice", // prepaid | choice | clinic
      slotStyle: "exact", // exact | range
      graceMin: 10,
      callBeforeMin: 15,
      callType: "ivr", // arrival calls are IVR phone calls (keypad menu, no AI)
      callLanguage: "en", // en | ta
      callEngine: "claude", // script | claude (Claude + browser speech, in the app) | elevenlabs (ElevenLabs voice + Claude)
      elevenDelivery: "app", // phone step with ElevenLabs: app = simulated phone call (demo) | phone = real call (SIP/Twilio)
      testPhone: "", // real calls go to this number instead of the demo patient's
      noShowCutoffMin: 30,
      holdMin: 10,
      fullRefundHours: 24,
      lateCancelRefundPct: 50,
      noShowRefundPct: 0,
      gateway: "auto", // auto | mock
      gstRate: 18, // % of the fee, GST-inclusive; 0 = exempt (bill of supply)
      sac: "9993"
    },
    doctors: [
      { id: "d1", name: "Dr. Meera Nair", specialty: "Endocrinology", fee: 500, start: 9 * 60, end: 13 * 60, slotMin: 15, room: "Room 2", seedAvg: 9, consultLog: [] },
      { id: "d2", name: "Dr. Karthik Raman", specialty: "General Medicine", fee: 400, start: 10 * 60, end: 14 * 60, slotMin: 20, room: "Room 1", seedAvg: 12, consultLog: [] }
    ],
    patients: [
      { id: "p1", name: "Arjun Kumar", phone: "+919840012345" },
      { id: "p2", name: "Lakshmi Srinivasan", phone: "+919841122334" },
      { id: "p3", name: "Rahul Menon", phone: "+919884455667" },
      { id: "p4", name: "Priya Das", phone: "+919790011223" },
      { id: "p5", name: "Vikram Iyer", phone: "+919600334455" },
      { id: "p6", name: "Fathima Begum", phone: "+919444556677" }
    ],
    me: "p1",
    appointments: [],
    notifications: [],
    tokens: {},
    mockGateway: { orders: {}, links: {}, seq: 1 },
    log: []
  };
}

function appt(s, { id, doctorId = "d1", patientId, slot, status = "booked", source = "clinic", payment, ...rest }) {
  const date = ymd(s.clock.nowMs);
  const doctor = s.doctors.find(d => d.id === doctorId);
  return {
    id,
    doctorId,
    patientId,
    date,
    slot,
    slotEnd: null,
    kind: "scheduled",
    source,
    reason: "",
    status,
    createdAt: s.clock.nowMs - 2 * 24 * 60 * MIN,
    payment: { mode: "clinic", status: "pending", amount: doctor.fee, method: null, history: [], ...payment, ...(payment?.status === "paid" && { paidAt: s.clock.nowMs - 2 * 24 * 60 * MIN }) },
    reminders: {},
    token: null,
    seq: slot,
    calls: [],
    location: null,
    flags: {},
    ...rest
  };
}

// Visits from the last two weeks, so History and receipts have something to
// show. Paid ones carry the GST details that were in force when they were paid.
const PAST = [
  // days ago, doctor, patient, slot, method (null = no-show, unpaid)
  [13, "d1", "p1", 615, "upi"],
  [12, "d2", "p4", 640, "cash"],
  [9, "d1", "p2", 660, "card"],
  [7, "d2", "p1", 700, "cash"],
  [6, "d1", "p6", 630, null],
  [5, "d1", "p5", 600, "upi"],
  [3, "d2", "p3", 620, "upi"],
  [2, "d1", "p1", 645, "card"],
  [1, "d1", "p4", 690, "cash"],
  [1, "d2", "p6", 760, "upi"]
];

function pastVisits(s) {
  const tax = { gstin: s.clinic.gstin, rate: s.settings.gstRate, sac: s.settings.sac, state: s.clinic.state };
  return PAST.map(([ago, doctorId, patientId, slot, method], i) => {
    const date = addDays(ymd(s.clock.nowMs), -ago);
    const fee = s.doctors.find(d => d.id === doctorId).fee;
    const visitMs = at(date, slot);
    const no = String(i + 1).padStart(4, "0");
    const a = appt(s, {
      id: `a_past${i + 1}`, doctorId, patientId, slot, date,
      status: method ? "completed" : "no_show",
      source: method === "cash" ? "clinic" : "patient",
      token: method ? (i % 5) + 1 : null,
      createdAt: visitMs - 2 * 24 * 60 * MIN
    });
    if (method) {
      a.checkedInAt = visitMs - 5 * MIN;
      a.startedAt = visitMs + 3 * MIN;
      a.completedAt = visitMs + 14 * MIN;
      a.payment = {
        mode: method === "cash" ? "clinic" : "online", status: "paid", amount: fee, method,
        paymentId: method === "cash" ? null : `pay_past_${no}`, paidAt: method === "cash" ? a.completedAt : a.createdAt,
        receiptNo: `RCPT-${date.replaceAll("-", "")}-P${no}`, tax,
        history: [{ at: method === "cash" ? a.completedAt : a.createdAt, text: `Paid ${"₹" + fee} by ${method}` }]
      };
    } else {
      a.noShowAt = visitMs + 30 * MIN;
    }
    return a;
  });
}

function today(minutes) {
  const now = new Date();
  return at(ymd(now.getTime()), minutes);
}

export function seedMorning() {
  const s = baseState(today(9 * 60 + 50));
  s.appointments = [
    appt(s, { id: "a_seed1", patientId: "p2", slot: 600 }),
    appt(s, { id: "a_seed2", patientId: "p3", slot: 615, source: "patient", payment: { mode: "online", status: "paid", method: "upi", paymentId: "pay_seed_1", receiptNo: "RCPT-SEED-0001" } }),
    appt(s, { id: "a_seed3", patientId: "p4", slot: 645 }),
    appt(s, { id: "a_seed4", patientId: "p5", slot: 660, source: "patient", payment: { mode: "online", status: "paid", method: "card", paymentId: "pay_seed_2", receiptNo: "RCPT-SEED-0002" } }),
    appt(s, { id: "a_seed5", doctorId: "d2", patientId: "p6", slot: 620 }),
    ...pastVisits(s)
  ];
  for (const a of s.appointments) a.reminders = { day: a.createdAt, twoHour: a.createdAt };
  return s;
}

export function seedLateExample() {
  const s = baseState(today(10 * 60 + 25));
  const now = s.clock.nowMs;
  const mk = (id, patientId, slot, extra = {}) => appt(s, { id, patientId, slot, ...extra });
  s.appointments = [
    mk("a_p1", "p2", 600, { status: "in_consult", checkedInBy: "QR", token: 1, checkedInAt: now - 30 * MIN, startedAt: now - 9 * MIN }),
    mk("a_p2", "p1", 630, { source: "patient", payment: { mode: "online", status: "paid", method: "upi", paymentId: "pay_seed_3", receiptNo: "RCPT-SEED-0003", amount: 500 } }),
    mk("a_p3", "p3", 645, { status: "checked_in", checkedInBy: "reception", token: 2, checkedInAt: now - 20 * MIN }),
    mk("a_p4", "p4", 660, { status: "checked_in", checkedInBy: "QR", token: 3, checkedInAt: now - 12 * MIN }),
    mk("a_p5", "p5", 675, { status: "checked_in", checkedInBy: "QR", token: 4, checkedInAt: now - 5 * MIN }),
    ...pastVisits(s)
  ];
  s.tokens[`d1|${ymd(now)}`] = 4;
  s.doctors[0].consultLog = [10, 8, 11, 9];
  // The 2-hour reminder already went out this morning. The arrival call has
  // too, so the demo's first event is the 10:30 grace rule, not a call.
  for (const a of s.appointments) a.reminders = { day: a.createdAt, twoHour: a.createdAt };
  s.appointments[1].calls = [{ id: "call_seed", type: "voice", lang: "en", trigger: "auto", status: "done", startedAt: now - 10 * MIN, endedAt: now - 9 * MIN, outcome: "eta", etaMin: 20, coming: "yes", mode: "auto", summary: "Coming by auto, about 20 minutes.", transcript: [] }];
  return s;
}

export const SCENARIOS = {
  morning: { label: "Normal morning (9:50 AM)", build: seedMorning },
  late: { label: "Late patient example (10:25 AM)", build: seedLateExample }
};
