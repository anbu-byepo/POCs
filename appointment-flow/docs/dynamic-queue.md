# Dynamic queue: scenarios and how the POC handles them

How the Ninto appointment-flow POC decides who sees the doctor next, and what
happens when patients are early, late, missing or cancel. Everything here is in
`shared/flow.js` unless another file is named.

## The idea in one line

A late patient loses only the time they were late. They are never sent to the
back of the line, and the doctor never waits for someone who isn't there.

## Defaults (clinic Settings, `shared/seed.js`)

| Setting | Default | Used for |
|---|---|---|
| `graceMin` | 10 min | How long a slot is held after its time |
| `callBeforeMin` | 15 min | When the automatic IVR arrival call goes out (before the slot) |
| `noShowCutoffMin` | 30 min | Automatic no-show when location shows they never left |
| `holdMin` | 10 min | How long an unpaid booking holds its slot |
| Consult length | average of the doctor's last 6 consults (seed: 9 min Dr. Meera Nair, 12 min Dr. Karthik Raman) | Projected start times |
| `LATE_IVR_EXTRA_MIN` | 10 min | "Running late" on the IVR = slot + grace + this |

## Building blocks

### 1. Patient status

```
pending_payment -> booked -> reserved -> late -> checked_in -> in_consult -> completed
                                   \-> no_show / cancelled / expired
```

| Status | Meaning |
|---|---|
| `booked` | Slot time not reached, not checked in |
| `reserved` | Slot time passed, inside the grace period: the slot is held |
| `late` | Grace is over, still not here |
| `checked_in` | At the clinic, in the waiting line |
| `in_consult` | With the doctor |

### 2. Expected arrival (`arrivalOf`)

For everyone not yet checked in, the best available source wins:

| Priority | Source | Where it comes from |
|---|---|---|
| 1 | Live ETA from the phone | Location sharing. Google live traffic blended with their real pace (`shared/eta.js`). The clinic sees only the ETA, never the location or travel mode. |
| 2 | Newest thing they told us | Trip planner "set off", IVR call answer, or "I'll be ~N min late" in the patient app |
| 3 | Their slot time | `booked` and the slot is still ahead: assumed on time |
| 4 | End of grace | `reserved`: slot held until then |
| 5 | Unknown | Placed at the end of the projection, flagged unknown |

If a promised time has passed and they still aren't here, the app assumes
about 3 more minutes, so they don't vanish from the plan.

What each IVR answer means for arrival:

| IVR answer | Arrival used |
|---|---|
| Coming, on time | Slot time (same as "assumed on time") |
| Coming, running late | Slot + grace + 10 min (no minutes are asked on the call) |
| Can't come, reschedule | Not coming. Reception rebooks. The appointment is not cancelled automatically. |
| Can't come, cancel | Appointment cancelled, refund rules apply |
| No answer | No new information, falls back to slot / grace |

### 3. Place in line (`queueKey`)

```
arrives by slot + grace   -> keeps the booked slot
arrives later             -> treated as booked for (arrival - grace)
```

Example, 10:00 slot and 10 min grace: arriving at 10:08 counts as 10:00;
arriving at 10:30 counts as 10:20.

### 4. The projection (`projection`)

The "Up next (live projection)" list on the clinic Schedule. It replays the rest
of the day:

1. Start now, or when the current consult is expected to end.
2. Ready patients are those checked in, or expected to have arrived by that time.
3. The ready patient with the lowest queue key goes next. A tie goes to whoever was ready first.
4. If nobody is ready, the doctor is free until the next expected arrival.
5. Add one average consult and repeat.

It is recomputed on every change, so it always reflects the latest calls, ETAs
and check-ins.

### 5. The real line (`line`, `callNext`)

Only checked-in patients are in the real waiting line, ordered by the queue key
they got at check-in (`seq`). "Call next patient" ends the current consult and
takes the first checked-in patient. Anyone who isn't physically here is skipped
automatically.

## Scenarios

The examples assume Dr. Meera Nair, about 10 min consults, 10 min grace, and
bookings at 10:00 (Lakshmi), 10:15 (Rahul) and 10:45 (Priya).

### S1. Everyone on time

Each patient checks in before their slot and keeps their slot as queue key.
The line is the booking order. The reminders (a day before and 2 hours
before) give only the slot time. The app never tells a patient to "be there
by" any other time: the slot is the only time it gives, and anyone who comes
later is fitted in by when they arrive.

### S2. Arrives early

Priya (10:45) checks in at 10:20 while Lakshmi and Rahul are already done.
Her queue key is still 10:45, but she is the only one waiting, so "Call next"
takes her. The app tells her "The doctor is ready for you a bit early"
(`startConsult`). Early patients never jump ahead of someone with an earlier
slot who is also waiting.

### S3. A few minutes late, inside grace

Lakshmi (10:00) arrives at 10:07.
- 10:00: status becomes `reserved`. She gets "Your slot is held. Please arrive within 10 minutes."
- 10:07: check-in. 10:07 is inside grace, so her key stays 10:00 and she goes next.

### S4. Late beyond grace, and we know her ETA

On the 9:45 IVR call Lakshmi presses "running late". The app expects her at
10:20 (slot + grace + 10).
- Her expected arrival gives her key 10:20 − 10 = 10:10. At 10:10 she isn't expected yet, so the projection lets Rahul (key 10:15, already here) go first and fits her in when she's due.
- She gets "Running late? Your place moves with you. Expected to go in around …, after N patients." (`LATE_MSG_DYNAMIC`)
- The next patient (Rahul) gets "You may be seen a bit early. The patient before you is running late."
- 10:10: grace ends, status becomes `late`, and she gets "fitted in by when you arrive, not sent to the end".
- If Rahul is checked in at 10:10 and the doctor is free, "Call next" takes Rahul. The doctor doesn't wait.
- She arrives at 10:24, so her key is 10:14. She goes in right after the patient currently with the doctor, ahead of Priya (10:45).

### S5. Late, sharing live location

Lakshmi turns on "Keep the clinic updated on when I'll arrive". The phone works
out her ETA (Google live traffic plus her real pace) every few minutes. The
projection moves with it. Patients who share are never called automatically
(no arrival call, no follow-up), even if their phone goes quiet. Only patients
without location get the IVR call. All scenarios with location are in
`dynamic-queue-location.md`.

### S6. Silent: no ETA, no answer

Rahul isn't sharing location and hasn't said anything.
- 10:00 (slot − 15 min): automatic IVR arrival call (only because he isn't sharing).
- No answer: the call is marked "No answer". The projection keeps him at his slot, then at the end of his grace.
- 10:25 (after grace): he becomes `late` with no known arrival, so the projection lists him at the end, flagged unknown.
- If he turns up, check-in fits him by his actual arrival, not at the end.

### S7. Promised a time and still not here

If he said he'd arrive at a time on the call and is 10+ minutes past it, one
follow-up call goes out. There is only one follow-up per appointment. In the
projection he is kept about 3 minutes away rather than dropped.

### S8. Never left home (no-show)

Location sharing is on, but the distance hasn't dropped. At slot + 30 min he is
marked `no_show` automatically and the refund rules apply. If he does arrive,
reception uses "Arrived: reinsert after next 1".

### S9. Cancels or reschedules on the call

- Q3 "cancel": the appointment is cancelled and the slot is released. Refund rules for a paid booking: full refund 24 h+ before the slot, 50% after that, 0% for a no-show, and full if the doctor cancels (`refundQuote`).
- Q3 "reschedule": marked "Not coming, wants another day (call to rebook)". The slot is kept until reception acts, and the projection skips them because they're not expected.

### S10. Doctor runs slow or fast

Projected times use the average of the doctor's last 6 consults. If the
average grows, everyone's expected start moves. A patient gets "Your wait has
changed" only when their expected start shifts by 15 minutes or more, to
avoid spamming them.

### S11. Unpaid booking

A booking waiting for online payment holds its slot for 10 minutes, then expires
and frees the slot (`pending_payment` to `expired`).

### S12. Doctor cancels

Reception presses "Doctor cancels" on a patient who hasn't arrived. The patient
gets "Dr. … had to cancel" and a full refund, and the projection drops them.

### S13. Reception overrides

Reception can always override the automatic order:
- "Reinsert after next 1 / 2": puts a checked-in patient after the next one or two waiting patients.
- "Swap with next": swaps two adjacent patients in line.

## Times the patient is given

Only their booked slot. The app shows the live queue (patients ahead,
expected wait) as information, but never turns it into a "be there by",
"check in by" or "leave at" instruction. The trip planner plans the journey
to the slot, or to the end of grace while the slot is held.

## What the clinic sees

On each row:
- Arrival line: "Arrives 10:24 (said on the call)" / "(live ETA from their phone)" / "(assumed on time)".
- Call line: "📞 Coming: but running late (IVR phone call, Exotel, Tamil, automatic, 9:45)", plus a "From the keypad" line with the extras: video consult, companion, reports, "asked to talk to the team".
- Up next: the live projection with each patient's expected start.

Never shown to the clinic: the patient's location, distance or travel mode.

## Known gaps in the POC

- The IVR asks "running late? yes/no" without minutes. The 20-minute assumption can be wrong either way.
- "Reschedule" is only flagged. There's no rebooking flow yet.
- Pressing 9 ("talk to the team") is recorded, but the call isn't connected to reception yet.
- There are no walk-ins. Every patient comes from a booking.
- The demo clock runs one shared store for both apps. In production only the ETA would leave the patient's phone.
