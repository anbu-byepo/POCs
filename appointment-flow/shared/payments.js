// Razorpay, from the browser's side. With test keys on the server
// (/api/razorpay/config says configured), this opens the real Razorpay
// Checkout and every order, verify, re-check, refund and payment link goes to
// Razorpay's test API through the function. Without keys -- or with Settings
// -> Gateway set to Simulated -- the same calls hit a simulated gateway kept in
// the shared demo state, with a stand-in checkout sheet, so the flows can be
// clicked through anywhere.

import { getState, update } from "./store.js";
import { markPaid, patientOf, doctorOf, notify } from "./flow.js";
import { esc, rupees, uid } from "./util.js";

const API = "/api/razorpay";
let configPromise = null;

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Payment server error ${res.status}`);
  return data;
}

export function serverConfig() {
  configPromise ??= api("GET", "/config").catch(err => ({ configured: false, reason: `No payment function reachable (${err.message})` }));
  return configPromise;
}

export async function gatewayInfo() {
  const cfg = await serverConfig();
  const forcedMock = getState().settings.gateway === "mock";
  const real = cfg.configured && !forcedMock;
  return {
    real,
    label: real ? `Razorpay test mode (${cfg.keyId})` : "Simulated gateway",
    reason: real ? "" : forcedMock ? "Set to Simulated in clinic Settings" : cfg.reason
  };
}

// ---------- real Razorpay ----------

let checkoutScript = null;
function loadCheckout() {
  checkoutScript ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://checkout.razorpay.com/v1/checkout.js";
    el.onload = resolve;
    el.onerror = () => reject(new Error("Couldn't load Razorpay Checkout"));
    document.head.appendChild(el);
  });
  return checkoutScript;
}

function openRazorpay({ order, amount, description, prefill, method, notes }) {
  return new Promise(resolve => {
    let lastError = null;
    const s = getState();
    const rzp = new window.Razorpay({
      key: order.keyId,
      amount,
      currency: "INR",
      order_id: order.id,
      name: s.clinic.name,
      description,
      prefill: { ...prefill, ...(method ? { method } : {}) },
      notes,
      theme: { color: "#0EA04A" },
      handler: resp => resolve({ outcome: "success", paymentId: resp.razorpay_payment_id, signature: resp.razorpay_signature }),
      modal: {
        ondismiss: () => resolve(lastError ? { outcome: "failed", error: lastError } : { outcome: "dismissed" })
      }
    });
    // Checkout stays open after a failure so the patient can retry inside it;
    // remember the reason in case they close it instead.
    rzp.on("payment.failed", resp => {
      lastError = resp.error?.description ?? "Payment failed";
    });
    rzp.open();
  });
}

// ---------- simulated gateway ----------

function mockOrder(amount, notes) {
  return update(s => {
    const id = `order_SIM${s.mockGateway.seq++}`;
    s.mockGateway.orders[id] = { id, amount, notes, payments: [] };
    return { id, amount, keyId: "simulated" };
  });
}

function mockAddPayment(orderId, status, method, error) {
  return update(s => {
    const payment = { id: `pay_SIM${s.mockGateway.seq++}`, status, method, error };
    s.mockGateway.orders[orderId].payments.push(payment);
    return payment;
  });
}

// Stand-in for Razorpay Checkout. It also offers "paid, but the app never
// heard back" -- the case the re-check exists for.
function openMockCheckout({ order, amount, description, prefill, method }) {
  return new Promise(resolve => {
    const wrap = document.createElement("div");
    wrap.className = "mock-rzp";
    wrap.innerHTML = `
      <div class="mock-rzp-card" role="dialog" aria-label="Simulated checkout">
        <div class="mock-rzp-head">
          <div><div class="mock-rzp-brand">Simulated Razorpay Checkout</div><div class="mock-rzp-sub">${esc(description)}</div></div>
          <div class="mock-rzp-amt">${rupees(amount / 100)}</div>
        </div>
        <div class="mock-rzp-body">
          <div class="mock-rzp-row"><span>Order</span><code>${esc(order.id)}</code></div>
          <div class="mock-rzp-row"><span>Payer</span><span>${esc(prefill.name ?? "")} · ${esc(prefill.contact ?? "")}</span></div>
          <label class="mock-rzp-row"><span>Method</span>
            <select data-m="method">${["upi", "card", "netbanking"].map(m => `<option value="${m}" ${m === (method ?? "upi") ? "selected" : ""}>${m.toUpperCase()}</option>`).join("")}</select>
          </label>
          <button class="mock-rzp-btn ok" data-m="success">Pay ${rupees(amount / 100)} (succeeds)</button>
          <button class="mock-rzp-btn bad" data-m="fail">Pay (bank declines)</button>
          <button class="mock-rzp-btn ghost" data-m="drop">Pay, then the app loses the callback</button>
          <button class="mock-rzp-btn link" data-m="close">Close without paying</button>
        </div>
        <div class="mock-rzp-foot">No keys configured, so no real gateway is called. Add Razorpay test keys to use real Checkout.</div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", event => {
      const action = event.target.closest("[data-m]")?.dataset.m;
      if (!action || action === "method") return;
      const chosen = wrap.querySelector("[data-m=method]").value;
      wrap.remove();
      if (action === "close") return resolve({ outcome: "dismissed" });
      if (action === "fail") {
        mockAddPayment(order.id, "failed", chosen, "Payment declined by the bank (simulated)");
        return resolve({ outcome: "failed", error: "Payment declined by the bank (simulated)" });
      }
      const payment = mockAddPayment(order.id, "captured", chosen);
      resolve(action === "drop" ? { outcome: "dropped" } : { outcome: "success", paymentId: payment.id, signature: "simulated", method: chosen });
    });
  });
}

// ---------- the interface both apps use ----------

/**
 * Creates an order and opens checkout. onOrder(orderId) runs before checkout
 * opens so the caller can store the order on the appointment -- that's what
 * lets a later re-check find a payment whose callback never arrived.
 * Resolves to { status: "paid" | "failed" | "dismissed" | "unknown", ... }.
 */
export async function pay({ amountRupees, description, prefill, notes, method, onOrder, dropCallback = false }) {
  const amount = Math.round(amountRupees * 100);
  const gw = await gatewayInfo();
  const order = gw.real
    ? await api("POST", "/orders", { amount, receipt: notes?.appointmentId ?? uid("rcpt"), notes })
    : mockOrder(amount, notes);
  onOrder?.(order.id);

  let result;
  if (gw.real) {
    await loadCheckout();
    result = await openRazorpay({ order, amount, description, prefill, method, notes });
  } else {
    result = await openMockCheckout({ order, amount, description, prefill, method });
  }

  if (result.outcome === "success" && dropCallback) result = { outcome: "dropped" };
  if (result.outcome === "dropped") return { status: "unknown", orderId: order.id };
  if (result.outcome === "failed") return { status: "failed", orderId: order.id, error: result.error };
  if (result.outcome === "dismissed") return { status: "dismissed", orderId: order.id };

  if (gw.real) {
    const { valid } = await api("POST", "/verify", { orderId: order.id, paymentId: result.paymentId, signature: result.signature });
    if (!valid) return { status: "unknown", orderId: order.id, error: "Signature didn't verify" };
  }
  return { status: "paid", orderId: order.id, paymentId: result.paymentId, method: result.method ?? method ?? "online" };
}

// Asks the gateway what actually happened to an order.
export async function reconcile(orderId) {
  if (!orderId.startsWith("order_SIM")) return api("POST", `/orders/${encodeURIComponent(orderId)}/reconcile`);
  const order = getState().mockGateway.orders[orderId];
  const paid = order?.payments.find(p => p.status === "captured");
  if (paid) return { status: "paid", paymentId: paid.id, method: paid.method };
  if (order?.payments.length) return { status: "failed", error: order.payments.at(-1).error };
  return { status: "pending" };
}

export async function createLink({ amountRupees, description, customer, referenceId, notes }) {
  const amount = Math.round(amountRupees * 100);
  const gw = await gatewayInfo();
  if (gw.real) return api("POST", "/payment-links", { amount, description, customer, referenceId, notes });
  return update(s => {
    const id = `plink_SIM${s.mockGateway.seq++}`;
    s.mockGateway.links[id] = { id, amount, description, status: "created", paymentId: null };
    return { id, shortUrl: `https://rzp.io/sim/${id}`, status: "created" };
  });
}

export async function fetchLink(id) {
  if (id.startsWith("plink_SIM")) {
    const link = getState().mockGateway.links[id];
    return { id, status: link?.status ?? "expired", paymentId: link?.paymentId ?? null, method: link?.method ?? null };
  }
  return api("GET", `/payment-links/${encodeURIComponent(id)}`);
}

// The patient paying a simulated link (a real link opens Razorpay's page).
export async function paySimulatedLink(id) {
  const link = getState().mockGateway.links[id];
  const order = { id: `order_for_${id}`, keyId: "simulated" };
  update(s => {
    s.mockGateway.orders[order.id] = { id: order.id, amount: link.amount, payments: [] };
  });
  const result = await openMockCheckout({ order, amount: link.amount, description: link.description, prefill: {}, method: "upi" });
  if (result.outcome !== "success" && result.outcome !== "dropped") return false;
  const paymentId = getState().mockGateway.orders[order.id].payments.at(-1).id;
  update(s => Object.assign(s.mockGateway.links[id], { status: "paid", paymentId, method: result.method ?? "upi" }));
  return true;
}

async function refund(paymentId, amountRupees, notes) {
  const amount = Math.round(amountRupees * 100);
  if (paymentId.startsWith("pay_SIM") || paymentId.startsWith("pay_seed")) {
    return { id: `rfnd_SIM${Date.now().toString(36)}`, status: "processed", amount };
  }
  return api("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, notes });
}

// ---------- background work either app runs ----------

let refundsRunning = false;

// Sends queued online refunds. Each one is claimed in the shared state first,
// so the patient tab and the clinic tab never both send it.
export async function processRefunds() {
  if (refundsRunning) return;
  refundsRunning = true;
  try {
    for (const a of getState().appointments.filter(x => x.payment.refund?.status === "requested")) {
      const claimed = update(s => {
        const x = s.appointments.find(y => y.id === a.id);
        if (x.payment.refund?.status !== "requested") return false;
        x.payment.refund.status = "processing";
        return true;
      });
      if (!claimed) continue;
      try {
        const r = await refund(a.payment.paymentId, a.payment.refund.amount, { appointmentId: a.id, reason: a.payment.refund.reason });
        update(s => {
          const x = s.appointments.find(y => y.id === a.id);
          Object.assign(x.payment.refund, { status: "processed", id: r.id, gatewayStatus: r.status });
          x.payment.status = "refunded";
          x.payment.history.push({ at: s.clock.nowMs, text: `Refund ${rupees(x.payment.refund.amount)} sent (${r.id})` });
          notify(s, x, { kind: "refund", title: `Refund of ${rupees(x.payment.refund.amount)} started`, body: "It usually reaches your account in 5 to 7 working days." });
        });
      } catch (err) {
        update(s => {
          const x = s.appointments.find(y => y.id === a.id);
          Object.assign(x.payment.refund, { status: "error", error: err.message });
        });
      }
    }
  } finally {
    refundsRunning = false;
  }
}

let linksRunning = false;

// Polls open payment links; marks the appointment paid when one is paid.
// Production would take Razorpay's payment_link.paid webhook instead.
export async function pollLinks() {
  if (linksRunning) return;
  linksRunning = true;
  try {
    const open = getState().appointments.filter(a => a.payment.linkId && a.payment.status === "pending");
    for (const a of open) {
      const link = await fetchLink(a.payment.linkId).catch(() => null);
      if (link?.status !== "paid") continue;
      update(s => {
        const x = s.appointments.find(y => y.id === a.id);
        if (x.payment.status === "paid") return;
        markPaid(s, x, { method: `link (${link.method ?? "online"})`, paymentId: link.paymentId, by: "payment link" });
        notify(s, x, { kind: "paid", title: "Payment received", body: `${rupees(x.payment.amount)} for ${doctorOf(s, x).name}. Thank you.` });
      });
    }
  } finally {
    linksRunning = false;
  }
}

export function startBackgroundWork() {
  const tick = () => {
    processRefunds();
    pollLinks();
  };
  tick();
  return setInterval(tick, 4000);
}

export function payerOf(s, a) {
  const p = patientOf(s, a);
  return { name: p.name, contact: p.phone };
}
