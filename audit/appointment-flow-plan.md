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
    flow.js         -- the rules: slots, booking, check-in/tokens, the line, grace, the dynamic
                       queue projection and estimate, reminders, location rules, calls, refund
                       rule; runEngine() applies the time-based ones on every write
    trip.js         -- ways to get to the clinic: time, itemised cost breakup (FARES), best pick,
                       Maps links; uses Google Routes results when available
    payments.js     -- Razorpay from the browser (Checkout, verify, re-check, refunds, links),
                       or the simulated gateway when no keys are configured
    store.js        -- shared demo state in localStorage (stands in for the backend)
    seed.js         -- "Normal morning" and "Late patient example" scenarios
    ui.js, util.js, base.css
  server.mjs        -- local dev: static files + the functions at /api/razorpay/* and /api/ai-call/*
netlify/functions/razorpay.mjs  -- Razorpay proxy (key secret stays here)
netlify/functions/routes.mjs    -- Google Maps Routes API proxy (key stays here), 5-min cache
netlify/functions/ai-call.mjs   -- AI arrival call: one Claude turn per request (@anthropic-ai/sdk,
                                   from the repo-root package.json)
netlify/functions/elevenlabs.mjs -- ElevenLabs voice agent (Claude as its LLM): agent setup, in-app
                                   session URL, real outbound calls (SIP trunk / Twilio), results
netlify/call-script.mjs         -- the call's script, shared by both engines
appointment-flow/costing.html   -- costing page: free tiers, prices, monthly calculator
```

## Running it

- **Local:** `pnpm install` at the repo root (function dependencies), then
  `cd appointment-flow && pnpm install && pnpm serve` → <http://localhost:8000/>.
  Copy `.env.example` to `.env` with Razorpay **test** keys to use real Checkout; without them
  the apps use the simulated gateway (a stand-in checkout sheet with succeed / decline / lost
  callback / close).
- **Netlify:** set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (and optionally
  `RAZORPAY_WEBHOOK_SECRET`) in the site's environment. `rzp_live_` keys are refused.
- **Routes:** set `GOOGLE_MAPS_API_KEY` (Routes API enabled) for real travel times. Without it
  the trip planner uses built-in estimates and says so.
- **AI calls:** set `ANTHROPIC_API_KEY` (in `.env` locally, or the Netlify environment) for live
  Claude calls (`claude-opus-5-5`, low effort, structured output, server-side refusal fallback).
  Without it, or with Clinic Settings → Voice AI engine → Scripted, calls are scripted.
- **ElevenLabs:** set `ELEVENLABS_API_KEY`, then Clinic Settings → Arrival calls → Voice AI engine →
  ElevenLabs → "Create the agent". Put the returned id in `ELEVENLABS_AGENT_ID` and restart. For
  real calls, also set `ELEVENLABS_PHONE_NUMBER_ID` (the number imported into ElevenLabs),
  `ELEVENLABS_PHONE_PROVIDER` (`sip` for an Indian carrier such as Plivo or Exotel, recommended;
  `twilio` can only call Indian mobiles from a non-Indian number) and `ELEVENLABS_ALLOWED_TO` (the
  only numbers it will dial). See `.env.example`.
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

- **Expected arrival** (`arrivalOf`), best source first: live location (distance ÷ the route
  model's speed for their mode at this hour); else the newest of the trip they started in the
  planner, the arrival call's answer and "I'll be late"; else their slot (assumed on time) while
  it's ahead; else the end of grace while reserved; else unknown. A promised time that has passed
  becomes "now + 3 min, overdue".
- **Dynamic queue** (`queueKey`, `projection`): arriving by slot + grace keeps the slot; arriving
  later counts as booked for (arrival − grace). Late patients lose only the time they were late
  and are never sent to the end. The projection walks the doctor's day: whoever is ready (checked
  in, or expected by then) with the lowest key goes next; patients with no known arrival go last,
  flagged. Check-in uses the same key, so the projection and the real line agree. Reception's
  Reinsert / Swap still override. The clinic's Up next panel shows this order, with the source
  of each arrival.
- **Wait estimate:** the patient's projected start in that order (doctor's rolling average of the
  last 6 consults, seeded at 9 / 12 min; the current consult counted as its remaining time),
  + 5 min buffer once checked in, shown as a 10-minute range with "N ahead (M on the way)". Push only when the expected time moves 15+ min. "At 2 patients ahead" is read
  as **one patient ahead of you** (you're second in line) → "You're next after this patient."
- **Grace:** at slot time, not checked in → Reserved (10 min). Arrives within grace → keeps their
  slot in the line. After grace → fitted in by arrival (above), not at the end. Only checked-in
  patients are ever called, so "skip to the next one actually present" is automatic. Anyone
  expected after their grace is told early where they'll slot in, and the next patient is told
  they may be seen early.
- **Getting there** (`trip.js`, patient app → Plan my trip): walk (route ≤ 3 km), own two-wheeler,
  auto, cab, own car, bus/metro. **Times and distances:** Google Maps Routes API through
  `/api/routes/compute`: four calls per plan, cached 5 min per ~100 m origin. Drive and two-wheeler
  are traffic-aware; drive includes tolls; transit includes fare, lines and walking. Autos use
  Google's drive time × 1.1. Cars, autos and cabs add the time to get going (2 / 5 / 7 min).
  Transit's time already includes waiting. Google's traffic is live (real clock, not the demo
  clock). **Without a key:** straight line × 1.35, city speeds × time-of-day traffic.
  **Starting point:** a GPS fix within 40 km of the clinic, else a demo neighbourhood (Anna Nagar,
  T. Nagar, Mylapore, Adyar, Velachery, Tambaram). The demo start is used if the location prompt
  isn't answered within 5 s.
- **Cost breakup** (`FARES` in `trip.js`, Chennai, editable), shown per option:
  - two-wheeler / car: petrol (km ÷ 45 or 14 km/l × ₹102/l) + parking (₹10 / ₹40) + tolls
    (Google);
  - auto: government meter (₹30 for the first 1.8 km + ₹15/km + ₹1/min waiting in traffic, the
    delay coming from Google's traffic vs. no-traffic time), up to 25% more if booked on an app;
  - cab: base ₹55 + ₹15/km + ₹1.5/min + ₹20 booking, ×1.3 surge at peak, sedan +30%;
  - bus/metro: Google's transit fare, else a fare band by distance (metro +₹10);
  - walk: free.
  Target = check-in time (or end of grace, or ASAP when late). Best pick = cheapest that arrives in
  time, time valued at ₹2/min; else fastest. Each option shows leave-by, spare minutes and a Google
  Maps directions link. "I'm leaving now" records the trip (ETA) and, optionally, shares location.
  The simulated movement keeps Google's pace for that route.
- **Routes API cost** (India, per 1,000 requests / free each month): Essentials $1.50 / 70k, Pro
  $3.00 / 35k, Enterprise $4.50 / 7k. Each request bills at the highest tier it touches. Live
  traffic is Pro; two-wheeler and tolls are Enterprise. One plan = walk + transit (Essentials,
  presumably: Google doesn't name them), drive with tolls (Enterprise), two-wheeler (Enterprise).
  So about 3,500 free plans a month, then about $12 per 1,000 plans. See `appointment-flow/costing.html`.
- **Location:** asked on the day only, from the trip planner (and the 2-hour reminder's "I'm
  leaving now"). Real
  permission prompt; movement is simulated from a demo distance. Stops at check-in. No update for
  15+ min = unknown. Location on and running late → late patient and next patient are told early.
  Location on but never left → no-show at slot + 30 min (adjustable).
- **Arrival calls:** anyone not arrived 15 min before their slot (adjustable) who isn't sharing
  live location, one follow-up if they're 10+ min past the time they gave, and on demand from the
  queue. The signed-in patient answers on the patient phone. **Live AI:** each turn goes to
  Claude through `/api/ai-call/turn`, which gets the appointment and queue facts and returns the next
  line plus a running verdict (coming yes / no / unsure, ETA, travel mode, note for the doctor,
  one-line summary for reception). Cancels only after a clear yes. The line is spoken with the
  browser's speech synthesis. The patient replies by mic (browser speech recognition), a
  suggestion or typing, in English or Tamil. If the AI call fails it carries on scripted.
  **ElevenLabs + Claude:** ElevenLabs runs the voice (speech-to-text, text-to-speech, turn-taking)
  with Claude (`ELEVENLABS_LLM`, default `claude-opus-5-5`) as the agent's LLM, using the same
  script. The appointment facts go in as dynamic variables. The verdict comes from ElevenLabs'
  post-call data collection (coming, eta_min, travel_mode, at_clinic, cancel_confirmed,
  note_for_doctor, summary_for_clinic), with the call's duration and real cost. Two ways to deliver
  it: **in the patient app** (browser microphone through `@elevenlabs/client`; no phone line), or
  **a real phone call**. For real calls the clinic app places the call and polls for the result
  (production: server-side, with the webhook as the source of truth). Real calls go to Settings →
  "Demo: send real calls to", because demo patients have made-up numbers. If ElevenLabs isn't
  configured, in-app calls fall back to Claude, then the script, with a notice.
  **Scripted:** fixed questions (minutes away, travel mode, note). **IVR:** keypad. Unanswered after
  2 min → No answer. The verdict feeds the expected arrival, and so the queue. No telephony
  provider is wired: production places the call through one (e.g. Exotel / Twilio) with streaming
  STT/TTS around the same turns, builds the context server-side, and rate-limits the endpoint.
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
- Telephony and the patient's movement are simulated; geolocation uses the real permission
  prompt. Routes and fares are a model, not the Google Routes API.
- `/api/ai-call/turn` is public and spends API credit: it caps sizes but has no auth or rate
  limit. Fine for a demo link, not for production.
