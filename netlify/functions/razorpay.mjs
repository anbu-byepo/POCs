/**
 * Appointment-flow POC -- the only server-side piece: a thin proxy to
 * Razorpay's REST API so the key secret never reaches the browser. Served by
 * Netlify at /api/razorpay/* and, for local dev, by appointment-flow/server.mjs
 * (which imports this same handler).
 *
 * Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (test-mode keys only -- live keys
 * are refused), RAZORPAY_WEBHOOK_SECRET (optional). Without keys, /config says
 * so and both apps fall back to their simulated gateway.
 *
 * POC shortcuts, all called out in ../../audit/appointment-flow-plan.md: amounts
 * come from the browser (capped), and nothing is persisted here -- the webhook
 * only verifies and logs; the apps reconcile by asking Razorpay directly.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/razorpay/*" };

const API = "https://api.razorpay.com/v1";
// ₹5,000 -- consult fees only. Real amounts come from the booking, server-side.
const MAX_AMOUNT_PAISE = 500000;

function keys() {
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
  if (!keyId || !keySecret) return { ok: false, reason: "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set" };
  if (!keyId.startsWith("rzp_test_")) return { ok: false, reason: "Only rzp_test_ keys are allowed in this POC" };
  return { ok: true, keyId, keySecret };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function razorpay(k, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${k.keyId}:${k.keySecret}`).toString("base64")}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.description ?? `Razorpay ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function hmacHex(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

function checkAmount(amount) {
  if (!Number.isInteger(amount) || amount < 100 || amount > MAX_AMOUNT_PAISE) {
    const err = new Error(`amount must be whole paise between 100 and ${MAX_AMOUNT_PAISE}`);
    err.status = 400;
    throw err;
  }
}

// Fetches an order's payments and settles the outcome: captures an
// authorized-but-uncaptured payment (accounts with manual capture), and
// reports paid / failed / pending. This is the "money deducted but booking
// not confirmed" re-check.
async function reconcile(k, orderId) {
  const { items = [] } = await razorpay(k, "GET", `/orders/${encodeURIComponent(orderId)}/payments`);
  let payment = items.find(p => p.status === "captured");
  if (!payment) {
    const authorized = items.find(p => p.status === "authorized");
    if (authorized) {
      payment = await razorpay(k, "POST", `/payments/${authorized.id}/capture`, {
        amount: authorized.amount,
        currency: authorized.currency
      });
    }
  }
  if (payment) return { status: "paid", paymentId: payment.id, method: payment.method, amount: payment.amount };
  if (items.length && items.every(p => p.status === "failed")) {
    const last = items[0];
    return { status: "failed", error: last.error_description ?? "Payment failed" };
  }
  return { status: "pending" };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/api\/razorpay\/?/, "");
  const parts = route.split("/").filter(Boolean);
  const k = keys();

  try {
    if (req.method === "GET" && route === "config") {
      return json(k.ok ? { configured: true, keyId: k.keyId } : { configured: false, reason: k.reason });
    }

    if (req.method === "POST" && route === "webhook") {
      const raw = await req.text();
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) return json({ ok: false, reason: "RAZORPAY_WEBHOOK_SECRET not set" }, 501);
      if (!safeEqualHex(hmacHex(secret, raw), req.headers.get("x-razorpay-signature"))) {
        return json({ ok: false, reason: "bad signature" }, 400);
      }
      const event = JSON.parse(raw);
      // Production writes this to the appointment (order.paid, payment.failed,
      // payment_link.paid, refund.processed). The POC has no database, so it logs.
      console.log("razorpay webhook", event.event, event.payload?.payment?.entity?.id ?? "");
      return json({ ok: true });
    }

    if (!k.ok) return json({ error: k.reason }, 503);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // POST /orders {amount, receipt, notes}
    if (req.method === "POST" && route === "orders") {
      checkAmount(body.amount);
      const order = await razorpay(k, "POST", "/orders", {
        amount: body.amount,
        currency: "INR",
        receipt: String(body.receipt ?? "").slice(0, 40),
        notes: body.notes ?? {}
      });
      return json({ id: order.id, amount: order.amount, currency: order.currency, keyId: k.keyId });
    }

    // POST /verify {orderId, paymentId, signature}
    if (req.method === "POST" && route === "verify") {
      const expected = hmacHex(k.keySecret, `${body.orderId}|${body.paymentId}`);
      return json({ valid: safeEqualHex(expected, body.signature) });
    }

    // POST /orders/:id/reconcile
    if (req.method === "POST" && parts[0] === "orders" && parts[2] === "reconcile") {
      return json(await reconcile(k, parts[1]));
    }

    // POST /payments/:id/refund {amount, notes}
    if (req.method === "POST" && parts[0] === "payments" && parts[2] === "refund") {
      checkAmount(body.amount);
      const refund = await razorpay(k, "POST", `/payments/${encodeURIComponent(parts[1])}/refund`, {
        amount: body.amount,
        speed: "normal",
        notes: body.notes ?? {}
      });
      return json({ id: refund.id, status: refund.status, amount: refund.amount });
    }

    // POST /payment-links {amount, description, customer, referenceId, notes}
    if (req.method === "POST" && route === "payment-links") {
      checkAmount(body.amount);
      const link = await razorpay(k, "POST", "/payment_links", {
        amount: body.amount,
        currency: "INR",
        accept_partial: false,
        description: String(body.description ?? "").slice(0, 2048),
        reference_id: String(body.referenceId ?? "").slice(0, 40),
        customer: body.customer ?? {},
        notify: { sms: true, email: false },
        reminder_enable: true,
        expire_by: Math.floor(Date.now() / 1000) + 24 * 3600,
        notes: body.notes ?? {}
      });
      return json({ id: link.id, shortUrl: link.short_url, status: link.status });
    }

    // GET /payment-links/:id
    if (req.method === "GET" && parts[0] === "payment-links" && parts[1]) {
      const link = await razorpay(k, "GET", `/payment_links/${encodeURIComponent(parts[1])}`);
      const paid = (link.payments ?? []).find(p => p.status === "captured");
      return json({ id: link.id, status: link.status, paymentId: paid?.payment_id ?? null, method: paid?.method ?? null });
    }

    return json({ error: `No route for ${req.method} /api/razorpay/${route}` }, 404);
  } catch (err) {
    return json({ error: err.message, razorpay: err.data?.error ?? null }, err.status && err.status < 600 ? err.status : 500);
  }
}
