/**
 * Appointment-flow POC -- getting to the clinic, through the Google Maps
 * Routes API (computeRoutes) so the key stays on the server. One call per
 * travel mode (drive with live traffic, two-wheeler with live traffic, walk,
 * transit with fare), in parallel. Served by Netlify at /api/routes/* and, for
 * local dev, by appointment-flow/server.mjs (which imports this same handler).
 *
 *   GET  /api/routes/config   -> { live, reason }
 *   POST /api/routes/compute  { origin: { lat, lng }, destination: { lat, lng } }
 *        -> { drive, two_wheeler, walk, transit }, each null if Google had no route:
 *           { minutes, staticMinutes, km, tolls (rupees | null), fare (rupees | null),
 *             fareText, lines: ["Bus 23C", "Metro Blue"], walkMinutes }
 *
 * Env: GOOGLE_MAPS_API_KEY (Routes API enabled). Without it, /config says so
 * and the patient app falls back to its built-in route estimates.
 *
 * Google gives time, distance, tolls and transit fares. It doesn't price autos,
 * cabs or fuel; the patient app computes those from the distance (see
 * shared/trip.js FARES).
 */

export const config = { path: "/api/routes/*" };

const API = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MODES = { drive: "DRIVE", two_wheeler: "TWO_WHEELER", walk: "WALK", transit: "TRANSIT" };
const FIELDS = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters",
  "routes.travelAdvisory.tollInfo",
  "routes.travelAdvisory.transitFare",
  "routes.localizedValues.transitFare",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.transitDetails.transitLine.nameShort",
  "routes.legs.steps.transitDetails.transitLine.name",
  "routes.legs.steps.transitDetails.transitLine.vehicle.type"
].join(",");

// Caching keeps a demo from re-billing the same trip on every re-render.
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const key = () => process.env.GOOGLE_MAPS_API_KEY ?? "";
const seconds = d => (d ? parseFloat(d) : 0);
const money = m => (m ? Number(m.units ?? 0) + (m.nanos ?? 0) / 1e9 : null);

function point(p) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw Object.assign(new Error("Bad coordinates"), { status: 400 });
  return { location: { latLng: { latitude: lat, longitude: lng } } };
}

async function route(mode, origin, destination) {
  const body = {
    origin, destination,
    travelMode: MODES[mode],
    languageCode: "en-IN",
    units: "METRIC",
    ...(mode === "drive" || mode === "two_wheeler" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
    ...(mode === "drive" ? { extraComputations: ["TOLLS"], routeModifiers: { vehicleInfo: { emissionType: "GASOLINE" } } } : {}),
    ...(mode === "transit" ? { departureTime: new Date(Date.now() + 60000).toISOString() } : {})
  };
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": FIELDS },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Routes API ${res.status}`), { status: 502 });
  const r = data.routes?.[0];
  if (!r) return null;
  const steps = (r.legs ?? []).flatMap(l => l.steps ?? []);
  const tolls = r.travelAdvisory?.tollInfo?.estimatedPrice?.find(p => p.currencyCode === "INR");
  return {
    minutes: Math.ceil(seconds(r.duration) / 60),
    staticMinutes: Math.ceil(seconds(r.staticDuration) / 60),
    km: (r.distanceMeters ?? 0) / 1000,
    tolls: r.travelAdvisory?.tollInfo ? money(tolls) ?? 0 : null,
    fare: money(r.travelAdvisory?.transitFare),
    fareText: r.localizedValues?.transitFare?.text ?? null,
    lines: mode === "transit" ? steps.filter(s => s.transitDetails).map(s => {
      const l = s.transitDetails.transitLine ?? {};
      const kind = { BUS: "Bus", SUBWAY: "Metro", METRO_RAIL: "Metro", HEAVY_RAIL: "Train", COMMUTER_TRAIN: "Train", RAIL: "Train" }[l.vehicle?.type] ?? "";
      return `${kind} ${l.nameShort ?? l.name ?? ""}`.trim();
    }) : [],
    walkMinutes: mode === "transit" ? Math.round(steps.filter(s => s.travelMode === "WALK").reduce((t, s) => t + seconds(s.staticDuration), 0) / 60) : null
  };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/api\/routes\/?/, "");
  try {
    if (req.method === "GET" && path === "config") {
      return json(key() ? { live: true } : { live: false, reason: "GOOGLE_MAPS_API_KEY not set" });
    }
    if (req.method === "POST" && path === "compute") {
      if (!key()) return json({ error: "GOOGLE_MAPS_API_KEY not set" }, 503);
      const body = await req.json().catch(() => null);
      const origin = point(body?.origin);
      const destination = point(body?.destination);
      // ~100 m grid so small GPS jitter reuses the same answer.
      const cacheKey = [body.origin.lat, body.origin.lng, body.destination.lat, body.destination.lng].map(n => Number(n).toFixed(3)).join(",");
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_MS) return json({ ...hit.data, cached: true });
      const entries = await Promise.all(Object.keys(MODES).map(async m => [m, await route(m, origin, destination).catch(err => ({ error: err.message }))]));
      const data = Object.fromEntries(entries);
      if (Object.values(data).every(v => v?.error)) return json({ error: data.drive.error }, 502);
      cache.set(cacheKey, { at: Date.now(), data });
      return json(data);
    }
    return json({ error: `No route for ${req.method} /api/routes/${path}` }, 404);
  } catch (err) {
    return json({ error: err.message }, err.status ?? 500);
  }
}
