// Ways to reach the clinic, with time, an itemised cost breakup and a
// recommendation.
//
// Times and distances come from the Google Maps Routes API when the server has
// a key (see ../../netlify/functions/routes.mjs): drive and two-wheeler with
// live traffic, walk, and transit with its fare and lines. Without a key they
// fall back to a built-in estimate: straight-line distance x a detour factor,
// city speeds scaled by time-of-day traffic.
//
// Google doesn't price autos, cabs or fuel, so those always come from FARES
// below (Chennai rates; edit per city). Every option carries a Google Maps
// directions link so the patient can navigate for real.

import { MIN, minOfDay, tms } from "./util.js";

export const CLINIC_LL = { lat: 13.0604, lng: 80.2496 };

// Demo starting points for when the browser's location is off or far away.
export const DEMO_ORIGINS = {
  anna_nagar: { label: "Anna Nagar", lat: 13.085, lng: 80.2101 },
  t_nagar: { label: "T. Nagar", lat: 13.0418, lng: 80.2341 },
  mylapore: { label: "Mylapore", lat: 13.0339, lng: 80.2619 },
  adyar: { label: "Adyar", lat: 13.0012, lng: 80.2565 },
  velachery: { label: "Velachery", lat: 12.9815, lng: 80.218 },
  tambaram: { label: "Tambaram", lat: 12.9249, lng: 80.1 }
};

// Fare rules behind the cost breakup. Rupees.
export const FARES = {
  petrolPerLitre: 102,
  twoWheelerKmpl: 45,
  carKmpl: 14,
  parking: { two_wheeler: 10, car: 40 },
  // Government auto meter (Chennai): minimum fare covers the first stretch.
  auto: { minimum: 30, minimumKm: 1.8, perKm: 15, waitingPerMin: 1, appAbovePct: 25 },
  // App cab, mini category; sedan is a percentage above.
  cab: { base: 55, perKm: 15, perMin: 1.5, bookingFee: 20, peakSurge: 1.3, sedanAbovePct: 30 },
  // Used only when Google has no transit fare.
  transitBands: [[3, 10], [8, 20], [15, 30], [Infinity, 45]],
  metroAbove: 10
};

const ROAD_FACTOR = 1.35;
const WALK_FACTOR = 1.2;
const r5 = n => Math.round(n / 5) * 5;

// speed: km/h in light traffic (estimate only). wait: minutes before you're
// moving. traffic: how much road traffic slows it (estimate only). google:
// which Routes API result gives its time and distance; googleFactor scales it
// (autos run a little slower than cars).
export const MODES = {
  walk: { label: "Walk", icon: "🚶", gmaps: "walking", speed: 4.8, wait: 0, traffic: 0, maxKm: 2.5, google: "walk" },
  two_wheeler: { label: "Own two-wheeler", icon: "🛵", gmaps: "driving", speed: 26, wait: 2, traffic: 0.6, google: "two_wheeler" },
  auto: { label: "Auto-rickshaw", icon: "🛺", gmaps: "driving", speed: 20, wait: 5, traffic: 0.8, google: "drive", googleFactor: 1.1 },
  cab: { label: "Cab", icon: "🚕", gmaps: "driving", speed: 21, wait: 7, traffic: 1, google: "drive" },
  car: { label: "Own car", icon: "🚗", gmaps: "driving", speed: 21, wait: 2, traffic: 1, google: "drive" },
  transit: { label: "Bus or metro", icon: "🚌", gmaps: "transit", speed: 17, wait: 10, traffic: 0.4, minKm: 1.5, google: "transit" }
};

export const MODE_LABELS = Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, m.label]));

// Road traffic multiplier for a time of day (Chennai peaks).
export function trafficAt(ms) {
  const m = minOfDay(ms);
  if ((m >= 8 * 60 + 30 && m < 10 * 60 + 30) || (m >= 17 * 60 && m < 20 * 60 + 30)) return { factor: 1.45, label: "Heavy traffic" };
  if (m >= 10 * 60 + 30 && m < 17 * 60) return { factor: 1.2, label: "Moderate traffic" };
  return { factor: 1, label: "Light traffic" };
}

export function routeKm(mode, straightKm) {
  return straightKm * (mode === "walk" ? WALK_FACTOR : ROAD_FACTOR);
}

// Estimated minutes on the move (no Google) at a time of day; also drives the
// demo's simulated movement. trafficFree ignores the time of day.
export function travelMin(mode, straightKm, atMs, trafficFree = false) {
  const m = MODES[mode] ?? MODES.car;
  const f = trafficFree ? 1 : 1 + (trafficAt(atMs).factor - 1) * m.traffic;
  return Math.max(1, Math.ceil((routeKm(mode, straightKm) / m.speed) * 60 * f));
}

export function distanceKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export function mapsUrl(mode, origin) {
  const p = new URLSearchParams({ api: "1", destination: `${CLINIC_LL.lat},${CLINIC_LL.lng}`, travelmode: MODES[mode]?.gmaps ?? "driving" });
  if (origin) p.set("origin", `${origin.lat},${origin.lng}`);
  return `https://www.google.com/maps/dir/?${p}`;
}

export function costText([lo, hi]) {
  if (!hi) return "Free";
  return lo === hi ? `₹${lo}` : `₹${lo}–${hi}`;
}

// Itemised cost for one way of travelling. km: route distance. delayMin:
// minutes lost to traffic (auto waiting charge). heavy: peak traffic (cab
// surge). google: the Routes API result for this mode, if any.
export function costBreakup(mode, { km, minutes, delayMin = 0, heavy = false, google = null }) {
  const F = FARES;
  const lines = [];
  const add = (label, amount, detail = "") => lines.push({ label, detail, amount: Math.round(amount) });
  const total = () => lines.reduce((t, l) => t + l.amount, 0);
  let range = [0, 0];
  let note = "";
  if (mode === "walk") {
    note = "No cost.";
  } else if (mode === "two_wheeler" || mode === "car") {
    const kmpl = mode === "car" ? F.carKmpl : F.twoWheelerKmpl;
    add("Petrol", (km / kmpl) * F.petrolPerLitre, `${km.toFixed(1)} km ÷ ${kmpl} km/l × ₹${F.petrolPerLitre}/l`);
    add("Parking", F.parking[mode], "Near the clinic");
    if (mode === "car" && google?.tolls) add("Tolls", google.tolls, "From Google Maps");
    range = [total(), total()];
    note = "One way, at average mileage.";
  } else if (mode === "auto") {
    const A = F.auto;
    add("Minimum fare", A.minimum, `First ${A.minimumKm} km`);
    if (km > A.minimumKm) add("Distance", (km - A.minimumKm) * A.perKm, `${(km - A.minimumKm).toFixed(1)} km × ₹${A.perKm}/km`);
    if (delayMin > 2) add("Waiting in traffic", delayMin * A.waitingPerMin, `~${delayMin} min × ₹${A.waitingPerMin}/min`);
    const meter = total();
    range = [r5(meter), r5(meter * (1 + A.appAbovePct / 100))];
    note = `Meter fare ₹${r5(meter)}. Booked on an app, expect up to ${A.appAbovePct}% more.`;
  } else if (mode === "cab") {
    const C = F.cab;
    add("Base fare", C.base);
    add("Distance", km * C.perKm, `${km.toFixed(1)} km × ₹${C.perKm}/km`);
    add("Ride time", minutes * C.perMin, `${minutes} min × ₹${C.perMin}/min`);
    add("Booking fee", C.bookingFee);
    if (heavy) add("Peak-hour surge", total() * (C.peakSurge - 1), `×${C.peakSurge}`);
    const mini = total();
    range = [r5(mini), r5(mini * (1 + C.sedanAbovePct / 100))];
    note = `Mini ₹${r5(mini)}; sedan about ${C.sedanAbovePct}% more.`;
  } else if (mode === "transit") {
    if (google?.fare != null) {
      add("Ticket", google.fare, google.lines?.length ? google.lines.join(" → ") : "From Google Maps");
      range = [total(), total()];
      note = "Fare from Google Maps.";
    } else {
      const band = F.transitBands.find(([upTo]) => km <= upTo)[1];
      add("Bus ticket", band, `${km.toFixed(1)} km fare band`);
      range = [band, band + F.metroAbove];
      note = `Estimate: bus ₹${band}; by metro about ₹${F.metroAbove} more.`;
    }
  }
  return { lines, range, note };
}

// Every sensible way to get there, scored against `arriveBy` (when the patient
// needs to be at the clinic to keep their place). `departMs` is when they'd set
// off. `google` is the /api/routes/compute result (or null for estimates).
// The best pick is the cheapest option that arrives in time, with time worth
// ₹2 a minute as the tie-breaker; if nothing arrives in time, the fastest.
export function planTrip({ straightKm, departMs, arriveBy, origin = null, google = null }) {
  const traffic = trafficAt(departMs);
  const heavy = traffic.factor > 1.3;
  const options = [];
  for (const [key, m] of Object.entries(MODES)) {
    const g = google?.[m.google];
    let km, rideMin, wait, delayMin, source;
    if (google) {
      if (!g || g.error) continue; // Google has no such route (e.g. no transit nearby)
      km = g.km;
      rideMin = Math.max(1, Math.ceil(g.minutes * (m.googleFactor ?? 1)));
      delayMin = Math.max(0, g.minutes - g.staticMinutes);
      wait = key === "transit" ? 0 : m.wait; // Google's transit time already includes waiting and walking
      source = "google";
    } else {
      km = routeKm(key, straightKm);
      rideMin = travelMin(key, straightKm, departMs);
      delayMin = Math.max(0, rideMin - travelMin(key, straightKm, departMs, true));
      wait = m.wait;
      source = "estimate";
    }
    if ((m.maxKm != null && km > m.maxKm * WALK_FACTOR) || (m.minKm != null && km < m.minKm * ROAD_FACTOR)) continue;
    const totalMin = wait + rideMin;
    const breakup = costBreakup(key, { km, minutes: rideMin, delayMin, heavy, google: g });
    const arriveMs = departMs + totalMin * MIN;
    const spareMin = Math.round((arriveBy - arriveMs) / MIN);
    options.push({
      key, ...m, km, rideMin, wait, totalMin, cost: breakup.range, breakup, arriveMs, spareMin, source,
      transitLines: g?.lines ?? [], walkMin: g?.walkMinutes ?? null,
      onTime: spareMin >= 0, leaveBy: arriveBy - totalMin * MIN, url: mapsUrl(key, origin)
    });
  }
  const source = google ? "google" : "estimate";
  if (!options.length) return { traffic, options, best: null, arriveBy, source };
  const onTime = options.filter(o => o.onTime);
  const mid = o => (o.cost[0] + o.cost[1]) / 2;
  const score = o => mid(o) + o.totalMin * 2;
  const best = onTime.length ? onTime.reduce((x, y) => (score(y) < score(x) ? y : x)) : options.reduce((x, y) => (y.totalMin < x.totalMin ? y : x));
  const fastest = options.reduce((x, y) => (y.totalMin < x.totalMin ? y : x));
  const cheapest = options.reduce((x, y) => (mid(y) < mid(x) || (mid(y) === mid(x) && y.totalMin < x.totalMin) ? y : x));
  for (const o of options) {
    o.tags = [o === best && "Best pick", o === fastest && "Fastest", o === cheapest && "Cheapest"].filter(Boolean);
    o.why = o === best ? whyBest(o, onTime.length > 0, arriveBy) : "";
  }
  options.sort((x, y) => (x === best ? -1 : y === best ? 1 : x.totalMin - y.totalMin));
  return { traffic, options, best, arriveBy, source };
}

function whyBest(o, anyOnTime, arriveBy) {
  if (!anyOnTime) return `Nothing gets you there by ${tms(arriveBy)}; this is the quickest. Your place in the queue moves to when you arrive, not to the end.`;
  if (o.key === "walk") return "Close enough to walk, free, and no traffic risk.";
  if (o.spareMin < 5) return "Gets you there just in time for the lowest cost.";
  return `Arrives with ${o.spareMin} min to spare for the lowest cost${o.wait ? `, including about ${o.wait} min to get going` : ""}.`;
}
