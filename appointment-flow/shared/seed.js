// Starting data for the demo. Two scenarios: a normal morning (the default),
// and the late-patient example from the discussion doc (P1 with the doctor,
// P2 late, P3-P5 waiting), with the signed-in patient as P2.

import { MIN, at, ymd } from "./util.js";

function baseState(nowMs) {
  return {
    version: 1,
    clock: { nowMs, lastEngineMs: nowMs },
    clinic: {
      name: "Nair Endocrine Clinic",
      address: "12 Greams Road, Thousand Lights, Chennai 600006",
      note: "2nd floor, parking behind the building",
      mapUrl: "https://maps.google.com/?q=13.0604,80.2496"
    },
    settings: {
      paymentMode: "choice", // prepaid | choice | clinic
      slotStyle: "exact", // exact | range
      graceMin: 10,
      callBeforeMin: 15,
      callType: "voice", // voice | ivr
      callLanguage: "en", // en | ta
      noShowCutoffMin: 30,
      holdMin: 10,
      fullRefundHours: 24,
      lateCancelRefundPct: 50,
      noShowRefundPct: 0,
      gateway: "auto" // auto | mock
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
    appt(s, { id: "a_seed5", doctorId: "d2", patientId: "p6", slot: 620 })
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
    mk("a_p5", "p5", 675, { status: "checked_in", checkedInBy: "QR", token: 4, checkedInAt: now - 5 * MIN })
  ];
  s.tokens[`d1|${ymd(now)}`] = 4;
  s.doctors[0].consultLog = [10, 8, 11, 9];
  // The 2-hour reminder already went out this morning. The arrival call has
  // too, so the demo's first event is the 10:30 grace rule, not a call.
  for (const a of s.appointments) a.reminders = { day: a.createdAt, twoHour: a.createdAt };
  s.appointments[1].calls = [{ id: "call_seed", type: "voice", lang: "en", trigger: "auto", status: "done", startedAt: now - 10 * MIN, outcome: "eta", etaMin: 20, transcript: [] }];
  return s;
}

export const SCENARIOS = {
  morning: { label: "Normal morning (9:50 AM)", build: seedMorning },
  late: { label: "Late patient example (10:25 AM)", build: seedLateExample }
};
