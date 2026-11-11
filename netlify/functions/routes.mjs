/**
 * Appointment-flow POC -- getting to the clinic, through the Google Maps
 * Routes API (computeRoutes) so the key stays on the server. One call per
 * travel mode (drive with live traffic, two-wheeler with live traffic, walk,
 * transit with fare), in parallel. Served by Netlify at /api/routes/* and, for
 * local dev, by appointment-flow/server.mjs (which imports this same handler).
 *
 *   GET  /api/routes/config   -> { live, reason }
 *   POST /api/routes/eta      { origin, destination, mode: "drive" | "walk" }
 *        -> { minutes, staticMinutes, km }: one live-traffic ETA for a patient on
 *           the way. The phone works out pace and mode (shared/eta.js) and asks
 *           this every few minutes. Only duration and distance are requested, so
 *           drive is billed as Pro (traffic) and walk as Essentials.
 *   POST /api/routes/compute  { origin: { lat, lng }, destination: { lat, lng } }
 *        -> { drive, two_wheeler, walk, transit }, each null if Google had no route:
 *           { minutes, staticMinutes, km, tolls (rupees | null), fare (rupees | null),
 *             fareText, lines: ["Bus 23C", "Metro Blue"], walkMinutes }
 *
 * Auth: OAuth 2.0 through Application Default Credentials (google-auth-library),
 * as the dev service account development@ninto-dev-502310.iam.gserviceaccount.com.
 * Usage is billed to the "Maps Provision" project (radiant-psyche-413003, Routes
 * API enabled) via X-Goog-User-Project. ADC finds credentials in this order:
 *   GOOGLE_SERVICE_ACCOUNT_JSON     key JSON (or base64), checked first by this file -- Netlify
 *   GOOGLE_APPLICATION_CREDENTIALS  path to a credentials file
 *   gcloud's ADC file               local dev, no key needed:
 *       gcloud auth application-default login \
 *         --impersonate-service-account=development@ninto-dev-502310.iam.gserviceaccount.com
 *   GCP metadata server             when running on Cloud Run / GCE / Cloud Functions
 *   GOOGLE_CLOUD_PROJECT            quota/billing project, default radiant-psyche-413003
 * GOOGLE_MAPS_API_KEY is a fallback when ADC finds nothing. With neither, /config
 * says so and the patient app uses built-in estimates. Credentials are looked
 * up once per process: restart the server after changing them.
 *
 * Google gives time, distance, tolls and transit fares. It doesn't price autos,
 * cabs or fuel; the patient app computes those from the distance (see
 * shared/trip.js FARES).
 */

import { GoogleAuth } from "google-auth-library";

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

const PROJECT = () => process.env.GOOGLE_CLOUD_PROJECT || "radiant-psyche-413003";
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
const apiKey = () => process.env.GOOGLE_MAPS_API_KEY ?? "";

// ADC, plus GOOGLE_SERVICE_ACCOUNT_JSON for hosts like Netlify that can only
// hold credentials in an env var. The library caches and refreshes tokens.
let googleAuth;
function getAuth() {
  if (googleAuth) return googleAuth;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (raw && !raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
  return (googleAuth = new GoogleAuth({ scopes: SCOPES, ...(raw ? { credentials: JSON.parse(raw) } : {}) }));
}

// Which auth the server will use, resolved once: { live, auth, account? } or
// { live: false, reason }. `account` is for the server log, not the client.
let modePromise;
export function authMode() {
  return (modePromise ??= (async () => {
    try {
      const client = await getAuth().getClient();
      const account = client.email ?? client.targetPrincipal ?? (await getAuth().getCredentials().catch(() => ({}))).client_email ?? "user credentials";
      return { live: true, auth: "adc", account };
    } catch (err) {
      if (apiKey()) return { live: true, auth: "api_key" };
      return { live: false, reason: `No Google credentials (ADC: ${err.message.split("\n")[0]}) and no GOOGLE_MAPS_API_KEY` };
    }
  })());
}

async function authHeaders() {
  if ((await authMode()).auth !== "adc") return { "X-Goog-Api-Key": apiKey() };
  const client = await getAuth().getClient();
  const { token } = await client.getAccessToken().catch(err => {
    throw Object.assign(new Error(`Google OAuth: ${err.message}`), { status: 502 });
  });
  return { Authorization: `Bearer ${token}`, "X-Goog-User-Project": PROJECT() };
}
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
    headers: { "content-type": "application/json", ...(await authHeaders()), "X-Goog-FieldMask": FIELDS },
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

// Live ETA for one mode, cached 2 min on a ~100 m grid.
const ETA_FIELDS = "routes.duration,routes.staticDuration,routes.distanceMeters";
const ETA_MODES = { drive: "DRIVE", walk: "WALK" };
const etaCache = new Map();
async function eta(body) {
  const mode = ETA_MODES[body?.mode] ? body.mode : "drive";
  const origin = point(body?.origin);
  const destination = point(body?.destination);
  const cacheKey = [mode, body.origin.lat, body.origin.lng, body.destination.lat, body.destination.lng].map(v => (typeof v === "number" ? v.toFixed(3) : v)).join(",");
  const hit = etaCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return { ...hit.data, cached: true };
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()), "X-Goog-FieldMask": ETA_FIELDS },
    body: JSON.stringify({ origin, destination, travelMode: ETA_MODES[mode], ...(mode === "drive" ? { routingPreference: "TRAFFIC_AWARE" } : {}) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Routes API ${res.status}`), { status: 502 });
  const r = data.routes?.[0];
  if (!r) throw Object.assign(new Error("No route found"), { status: 404 });
  const out = { mode, minutes: Math.max(1, Math.ceil(seconds(r.duration) / 60)), staticMinutes: Math.ceil(seconds(r.staticDuration) / 60), km: (r.distanceMeters ?? 0) / 1000 };
  etaCache.set(cacheKey, { at: Date.now(), data: out });
  return out;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/api\/routes\/?/, "");
  try {
    if (req.method === "GET" && path === "config") {
      const { live, auth, reason } = await authMode();
      return json(live ? { live, auth } : { live, reason });
    }
    if (req.method === "POST" && path === "eta") {
      const mode = await authMode();
      if (!mode.live) return json({ error: mode.reason }, 503);
      return json(await eta(await req.json().catch(() => null)));
    }
    if (req.method === "POST" && path === "compute") {
      const mode = await authMode();
      if (!mode.live) return json({ error: mode.reason }, 503);
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
