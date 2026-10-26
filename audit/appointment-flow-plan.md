# Appointment flow POC (clinic app + patient app, Razorpay)

## What this is

A clickable, working prototype of the appointment journey in "Ninto Appointment Flow: What We
Discussed" (15 Oct 2026): booking to seeing the doctor, across the **patient app** and the
**clinic app**, with payments on **Razorpay**. It covers the doc's scope only: Feature 1
(estimated wait, with Leave Time replaced by "patients ahead + estimate"), Feature 2 (grace, late
patients, no-shows, location rules), Feature 10 (reminders, confirmation, directions), Feature 11
(payment states and refund rule), booking in both apps, location as an add-on, and AI / IVR arrival
calls. Family booking, priority cases, buffer time, follow-ups and Compass booking are out.

Served at `/appointment-flow/` on the shared POCs Netlify site:

```
appointment-flow/
  index.html        -- split view: clinic app + patient app side by side, one demo clock
  patient/          -- patient app (boards P1-P4)
  clinic/           -- clinic app (boards F1-F3)
  shared/
    flow.js         -- the rules: slots, booking, check-in/tokens, the line, grace, estimate,
                       reminders, location rules, calls, refund rule; runEngine() applies the
                       time-based ones on every write
    payments.js     -- Razorpay from the browser (Checkout, verify, re-check, refunds, links),
                       or the simulated gateway when no keys are configured
    store.js        -- shared demo state in localStorage (stands in for the backend)
    seed.js         -- "Normal morning" and "Late patient example" scenarios
    ui.js, util.js, base.css
  server.mjs        -- local dev: static files + the Razorpay function at /api/razorpay/*
netlify/functions/razorpay.mjs  -- the only server code: Razorpay proxy (key secret stays here)
```

## Running it

- **Local:** `cd appointment-flow && pnpm install && pnpm serve` → <http://localhost:8000/>.
  Copy `.env.example` to `.env` with Razorpay **test** keys to use real Checkout; without them
  the apps use the simulated gateway (a stand-in checkout sheet with succeed / decline / lost
  callback / close).
- **Netlify:** set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (and optionally
  `RAZORPAY_WEBHOOK_SECRET`) in the site's environment. `rzp_live_` keys are refused.
- Clinic Settings → Payment gateway can force "Simulated" even when keys are present.
- The two apps share state through localStorage, so open them in the same browser (split view, or
  two tabs). The demo clock (top strip) drives everything time-based.

## Payments: what's real

With test keys, these are real Razorpay test-mode calls:

| Where | Flow | Razorpay API |
|---|---|---|
| Patient app | Pay now at booking | `POST /v1/orders` → Checkout.js → signature verify (HMAC `order_id\|payment_id`) |
| Patient app | Lost success callback ("money deducted, not confirmed") | `GET /v1/orders/:id/payments`, captures an `authorized` payment if needed, then confirms, or refunds in full if the slot was lost |
| Clinic app | Collect now: UPI / card on the reception device | Orders + Checkout with `prefill.method` |
| Clinic app | Send payment link | `POST /v1/payment_links` (SMS notify), polled with `GET /v1/payment_links/:id` |
| Both | Refunds (patient cancel, doctor cancel, no-show %, not confirmed) | `POST /v1/payments/:id/refund` |
| Server | Webhook | `/api/razorpay/webhook` verifies `X-Razorpay-Signature` and logs only |

Cash is marked collected by reception; cash refunds are "due at counter" until reception marks
them done.

**Patient app payment rules** (Settings → Patient app bookings): prepaid only, patient chooses, or
pay at clinic only. A prepaid booking holds the slot (`pending_payment`, 10 min, adjustable) and is
confirmed only when Paid. Failed or closed Checkout → clear message, Try again, and Pay at clinic
if allowed. The refund rule is shown on the review screen before paying.

**Clinic app**: every booking (calendar slot or Patients) offers Cash / UPI / Card / Send payment
link / Pay at visit. Reception bookings are confirmed whatever the payment state. "Collect payment"
is on every unpaid appointment.

## Rules as implemented (interpretations to confirm)

- **Wait estimate:** patients genuinely ahead × rolling average of the doctor's last 6 consults
  (seeded at 9 / 12 min), + 5 min buffer, the current consult counted as its remaining time,
  shown as a 10-minute range. Not-yet-arrived patients also see "expected around" (never earlier
  than their slot). Push only when the expected time moves 15+ min. "At 2 patients ahead" is read
  as **one patient ahead of you** (you're second in line) → "You're next after this patient."
- **Grace:** at slot time, not checked in → Reserved (10 min). Arrives within grace → goes in right
  after the current patient (several in grace keep slot order). After grace → late arrival, placed
  at the end; reception reinserts after the next 1 or 2. Only checked-in patients are ever
  called, so "skip to the next one actually present" is automatic.
- **Location:** asked on the day only, from "I'm leaving now" (and the 2-hour reminder). Real
  permission prompt; movement is simulated from a demo distance. Stops at check-in. No update for
  15+ min = unknown. Location on and running late → late patient and next patient are told early.
  Location on but never left → no-show at slot + 30 min (adjustable).
- **Arrival calls:** anyone not arrived 15 min before their slot (adjustable), and on demand from
  the queue. The signed-in patient answers on the patient phone: Voice AI (quick replies or free
  text, English / Tamil, collects a note for the doctor) or IVR keypad. Unanswered after 2 min →
  No answer. Results land on the queue row. Calls are **simulated**; no telephony provider is wired.
- **Reminders:** day before and 2 h before with Confirm / Cancel; the 2-hour one carries the
  check-in time (expected start − 10 min, not earlier than slot − 15). No reply keeps the booking.
- **Slot style:** both, behind Settings → Slot style (open decision). Range bookings take the first
  free exact slot inside the hour, for queue order.

## POC shortcuts (not for production)

- No backend or database: state lives in the browser. Production: bookings, holds, payment state
  and the queue engine on the server, the webhook (`order.paid`, `payment.failed`,
  `payment_link.paid`, `refund.processed`) as the source of truth instead of polling.
- Amounts come from the browser (the function caps them at ₹5,000). Production prices the order
  server-side from the booking.
- One clinic, two doctors, sample patients; tokens are per doctor per day.
- Calls and the patient's movement are simulated; geolocation uses the real permission prompt.
