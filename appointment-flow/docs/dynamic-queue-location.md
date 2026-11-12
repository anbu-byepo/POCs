# Dynamic queue when patients share their location

The same scenarios as `dynamic-queue.md`, for the case where the patient has
turned on **"Keep the clinic updated on when I'll arrive"** in the patient app.
All code is in `shared/flow.js` unless another file is named.

## Short version

| | Patient shares location | Patient does not share |
|---|---|---|
| Where the arrival time comes from | Their phone: Google live traffic blended with their real pace, recomputed every few minutes (`shared/eta.js`) | Trip planner, IVR call answer, "I'll be late" button, else the slot |
| IVR arrival call (slot − 15 min) | **Never placed** | Placed automatically |
| Follow-up call | **Never placed** | One, if they said a time and are 10+ min past it |
| How exact the arrival is | Exact, and updates on the way | IVR "running late" is a guess: slot + grace + 10 min |
| When the clinic learns they're late | As soon as the ETA passes slot + grace, often before the slot | At the call, 15 min before the slot |
| What the clinic sees | Only the arrival time ("live ETA from their phone"). Never the location, distance or travel mode. | Arrival time and the call result |

The rule in code (`runEngine`):

```js
const quiet = notArrived(a) && !loc?.sharing;   // only these patients get IVR calls
```

Sharing stops on its own at check-in, cancellation, no-show or when the doctor
cancels. If the patient turns it off, they become a "no location" patient
straight away. If it's past slot − 15 min and they haven't been called, the
IVR call goes out on the next tick.

## How the queue uses the live ETA

Nothing else changes. The same three building blocks run, fed by the phone:

1. **Expected arrival (`arrivalOf`)**: a fresh live ETA (an update in the last 15 min) is priority 1 and always "firm".
2. **Place in line (`queueKey`)**: arriving by slot + grace keeps the slot. Arriving later counts as booked for (arrival − grace). The live ETA moves the key as they travel.
3. **Projection (`projection`)**: replays the day with each patient arriving at their live ETA. The doctor takes whoever is ready with the lowest key and never waits for someone still on the road.

Because the ETA is exact and arrives early, the projection is usually right
before anyone reaches the clinic. That's what lets the app tell each patient
when to come so they don't wait.

## Scenarios

Same setup as `dynamic-queue.md`: Dr. Meera Nair, about 10 min consults,
10 min grace, bookings at 10:00 (Lakshmi), 10:15 (Rahul) and 10:45 (Priya).
All three share their location.

### L1. Everyone on time

- Each phone shows an ETA before the slot, so each keeps their slot as queue key. The line is the booking order.
- No IVR calls go out.
- At 300 m from the clinic: "You're near the clinic. Scan the QR at the counter to check in." Sharing stops at check-in.
- Clinic row: "Arrives 9:56 (live ETA from their phone, updated 9:41)" and "⏱ Live ETA from their phone · no automatic call needed".

### L2. Arrives early

Priya (10:45) sets off early, and her ETA is 10:20. The projection already
knows she'll be there at 10:20, but her key is still 10:45, so she doesn't
jump ahead of Lakshmi or Rahul. If both are done, the doctor takes her early
("The doctor is ready for you a bit early").

### L3. A few minutes late, inside grace

Lakshmi's ETA is 10:07.
- From the moment her phone shows 10:07 (say 9:40), the projection plans her for 10:07 with key 10:00.
- If the doctor becomes free at 10:00 and Rahul is checked in, Rahul goes. The doctor doesn't wait. Lakshmi goes next, as soon as she checks in, because her key (10:00) beats everyone else's.
- 10:00: status `reserved`, "Your slot is held".
- No call. With IVR, she'd have been called at 9:45 only to say "on time".

### L4. Late beyond grace

At 9:40 Lakshmi's phone shows ETA 10:24.
- Her key becomes 10:14 (10:24 − 10). The projection lets Rahul (10:15, but already here) in only if he's ready before her. Otherwise she keeps her place ahead of him.
- At once (not at a 9:45 call): "Running late? Your place moves with you. Expected to go in around …, after N patients."
- Rahul is told: "You may be seen a bit early. The patient before you is running late."
- Compared with IVR: the call would have assumed 10:20 (slot + grace + 10). The phone knows 10:24, so nobody is planned around a wrong time.

### L5. ETA changes on the way

Traffic clears and Lakshmi's ETA drops from 10:24 to 10:09.
- 10:09 is inside grace, so her key goes back to 10:00 and she's fitted in first again.
- If traffic gets worse (10:24 → 10:40), her key moves to 10:30 and Priya (10:45) stays behind her.
- Each patient whose expected start moves by 15+ min gets "Your wait has changed". Small moves don't trigger a push.
- No call is placed at any point.

### L6. Phone goes quiet (no ETA update for 15+ min)

Rahul's phone loses signal or is switched off.
- The live ETA is dropped. The projection falls back to what else it knows: his trip planner time, else his slot while it's ahead, else the end of grace, else "unknown" (listed at the end).
- Clinic row: "⏱ No ETA update for 18 min, treated as unknown · no automatic call (sharing is on)".
- **No IVR call**, because sharing is still on. Reception can still press "Call patient" by hand.
- When the phone comes back, the live ETA takes over again.
- If he turns sharing off, he's a normal "no location" patient, and the IVR call goes out at slot − 15 min (or at once if that time has passed).

### L7. Should be here by now

The live ETA always moves with the patient, so it can't fall into the past the
way a promised time can. The "assume 3 more minutes" rule and the follow-up
call don't apply. If they stop moving, the ETA keeps getting later and their key
moves with it.

### L8. Never left home (no-show)

The location shows the distance hasn't dropped (by less than 200 m since they
started sharing). At slot + 30 min (`noShowCutoffMin`) they are marked
`no_show` automatically and the refund rules apply. With no location, the
clinic can't tell this apart from "on the way, not answering", so this
automatic no-show only exists for sharing patients.

### L9. Can't come: cancel or reschedule

No IVR call means they don't get asked. They use the patient app instead:
- "Cancel" on the appointment or the reminder: cancelled, the slot is freed, refund rules apply (`refundQuote`). Sharing stops.
- Reschedule: not in the app yet. They call reception.

### L10. Doctor runs slow or fast

Same as without location: projected starts use the average of the last 6
consults, and "Your wait has changed" goes out on a 15+ min shift. Since the
arrival times are exact, a slow doctor is the main remaining source of waiting.

### L11. Unpaid booking

Not affected by location. The slot is held 10 min for payment, then expires.

### L12. Doctor cancels

Reception presses "Doctor cancels". The patient gets "Dr. … had to cancel" and
a full refund. Sharing stops and they drop out of the projection.

### L13. Reception overrides

Unchanged: "Reinsert after next 1 / 2" and "Swap with next" work on
checked-in patients whatever their arrival source. "Call patient" by hand
works even for sharing patients. Only the automatic calls are skipped.

## A mixed day

Most days some patients share and some don't. The projection treats them the
same way. Only the source of the arrival time differs:

| Patient | Source | Arrival used | Calls |
|---|---|---|---|
| Lakshmi, sharing | Phone | 10:24 live | none |
| Rahul, not sharing, pressed "running late" on the call | IVR | 10:35 (10:15 + 10 + 10) | auto call at 10:00 |
| Priya, not sharing, no answer | Slot | 10:45 assumed | auto call at 10:30, "No answer" |
| Arjun, sharing, phone quiet 20 min | Fallback | slot / grace / unknown | none (reception can call) |

## Edge cases specific to location

| Case | What happens |
|---|---|
| Sharing on, but a long trip (40 km) means the ETA is far past the slot | Treated like L4: key = ETA − grace, told at once, no call |
| Sharing turned on after the IVR call already happened | The live ETA takes over from the call answer. No follow-up call. |
| Sharing turned off on the way | Falls back to trip / call / slot. IVR call at slot − 15 min if none was placed yet. |
| Patient shares but goes to the wrong place | The ETA keeps getting later. Their key moves, and at slot + 30 the no-show rule applies only if the distance never dropped. |
| GPS jitter while waiting outside | Within 300 m they get the "scan the QR" prompt. Check-in, not location, puts them in the real line. |

## Tested

Simulated morning, 9:30 to 10:40, with the real `runEngine`:

| Patient | Calls |
|---|---|
| A, sharing, fresh ETA | none |
| B, sharing, phone quiet | none |
| C, no location | auto call at slot − 15 |
