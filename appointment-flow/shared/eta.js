/**
 * Live ETA, worked out in the browser (the patient's phone) while they share
 * their location. No travel-mode question needed:
 *
 *  1. Pace: from the last few location samples, how fast they're actually
 *     closing in on the clinic (km/h). Free, on the phone.
 *  2. Mode guess from that pace: under ~7 km/h is walking, anything faster is
 *     a road vehicle. Car, auto, cab and two-wheeler all use Google's drive
 *     time, so we never need to know which one it is.
 *  3. Google ETA: the phone calls /api/routes/eta (our server holds the OAuth
 *     service account and calls the Routes API with live traffic) at most
 *     every 5 minutes, or sooner if they've moved 1 km or switched walk/drive.
 *  4. Blend: Google's time, aged since it was asked, is the main number.
 *     If their real pace says they're much slower (a bus stopping, a jam
 *     Google hasn't caught), the pace wins.
 *
 * The result is saved on the appointment (a.location.eta), so the clinic app
 * reads the same ETA through arrivalOf() without calling Google itself.
 */
import { MIN } from "./util.js";

export const WALK_MAX_KMH = 7;
export const REFRESH_MIN = 5; // demo-clock minutes between Google calls
const REAL_MIN_GAP_MS = 20000; // and never more than one call per 20 real seconds (demo clock can run fast)
const MIN_TRACK_MIN = 3; // need this much movement history before trusting pace

// Speed towards the clinic over the samples in loc.track ({ at, km }).
export function observedPace(loc) {
  const t = loc?.track ?? [];
  if (t.length < 2) return null;
  const first = t[0];
  const last = t.at(-1);
  const mins = (last.at - first.at) / MIN;
  if (mins < MIN_TRACK_MIN) return null;
  const km = first.km - last.km;
  return Math.max(0, (km / mins) * 60);
}

// Walk or drive, from how fast they're actually moving. null = not sure yet.
export function guessMode(loc) {
  const kmh = observedPace(loc);
  if (kmh == null) return null;
  return kmh < WALK_MAX_KMH ? "walk" : "drive";
}

// Minutes still to go: Google's live-traffic time corrected by real pace.
// Returns { minutes, source, label } or null if there's nothing to go on.
export function liveEta(loc, now) {
  if (!loc?.sharing) return null;
  const kmh = observedPace(loc);
  const paceMin = kmh && kmh > 0.5 ? (loc.distanceKm / kmh) * 60 : null;
  const g = loc.eta && !loc.eta.error ? loc.eta : null;
  // Google answered for where they were then; take off the time since.
  const gMin = g ? Math.max(1, g.minutes - (now - g.at) / MIN) : null;
  const mode = guessMode(loc);
  const how = mode === "walk" ? "walking" : mode === "drive" ? "by road" : "";
  if (gMin != null && paceMin != null) {
    if (paceMin > gMin * 1.5) return { minutes: Math.round(paceMin), source: "pace", label: `slower than traffic suggests, going by their pace${how ? `, ${how}` : ""}` };
    return { minutes: Math.round(0.7 * gMin + 0.3 * paceMin), source: "google+pace", label: `Google live traffic + their pace${how ? `, ${how}` : ""}` };
  }
  if (gMin != null) return { minutes: Math.round(gMin), source: "google", label: `Google live traffic, ${g.mode === "walk" ? "walking" : "by road"}` };
  if (paceMin != null) return { minutes: Math.round(paceMin), source: "pace", label: `their pace${how ? `, ${how}` : ""}` };
  return null;
}

// Should the phone ask Google again? (Called often; cheap.)
export function etaDue(loc, now, realNow = Date.now()) {
  if (!loc?.sharing || loc.lat == null) return false;
  const g = loc.eta;
  if (!g) return true;
  if (realNow - (g.realAt ?? 0) < REAL_MIN_GAP_MS) return false;
  const mode = guessMode(loc) ?? "drive";
  return now - g.at >= REFRESH_MIN * MIN || Math.abs(g.km - loc.distanceKm) >= 1 || mode !== g.mode;
}

// The phone's call to our server (which calls Google with OAuth).
export async function fetchEta(loc, destination) {
  const mode = guessMode(loc) ?? "drive";
  const res = await fetch("/api/routes/eta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin: { lat: loc.lat, lng: loc.lng }, destination, mode })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `ETA ${res.status}`);
  return { mode, minutes: data.minutes, trafficMin: data.minutes - data.staticMinutes, cached: !!data.cached };
}
