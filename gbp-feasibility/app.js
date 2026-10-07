/**
 * NINTO-550 -- real, working Google Business Profile app (not a mockup):
 * connect via a real browser OAuth popup (account picker included), find the
 * account's real listings, edit one with Ninto onboarding data, search for an
 * existing/unclaimed listing, claim or create one, run Google's real
 * verification, and manage the listing afterwards. No backend anywhere -- the
 * OAuth token model (google.accounts.oauth2.initTokenClient) needs only a
 * public Client ID, and every Business Profile API call runs directly from
 * this tab with the access token it returns.
 *
 * Screens follow ../audit/design/Ninto GBP Setup Flow.dc.html (1 home prompt,
 * 2 profile prompt, 3 benefits sheet, 4 Google's own consent popup, 5a select
 * / edit, 5b claim, 5c create, 6 verification, 7 manage, 7c remove access),
 * with the design changes ../audit/gbp-feasibility-plan.md calls for: no
 * "questions" in the benefits copy (Q&A API discontinued), a "managed by
 * someone else" state on 5b, a Step 2 of 2 on 5c, and screen 6 as a picker
 * over the methods Google actually offers rather than "Google picks".
 *
 * Writes are dry-run by default (setup panel): edits and creates go out with
 * validateOnly=true, and writes with no dry-run form are skipped and logged.
 */

import { NINTO_SPECIALTIES } from "./specialties.js";

const CLIENT_ID_STORAGE_KEY = "gbp-feasibility-client-id";
const SESSION_STORAGE_KEY = "gbp-feasibility-session";
const LISTING_STORAGE_KEY = "gbp-feasibility-listing";
const ONBOARDING_STORAGE_KEY = "gbp-feasibility-onboarding";
const SETTINGS_STORAGE_KEY = "gbp-feasibility-settings";
// The same OAuth Web Client ID as youtube-feasibility -- not a secret. Its
// Cloud project must also be approved for the Business Profile APIs (quota
// 300 QPM, not 0), have them enabled, and list business.manage on its
// consent screen. Override it in the setup panel to test another client.
const DEFAULT_CLIENT_ID = "285005867182-9aon12ipiclrv4leh51g1ja7gdt3os8u.apps.googleusercontent.com";
const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/userinfo.email"
].join(" ");

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const VERIFY_API = "https://mybusinessverifications.googleapis.com/v1";
const V4_API = "https://mybusiness.googleapis.com/v4";
const QPM_LIMIT = 300;
const READ_MASK = "name,title,storefrontAddress,phoneNumbers,categories,websiteUri,regularHours,latlng,metadata";
const EDIT_UPDATE_MASK = "title,categories,storefrontAddress,phoneNumbers,regularHours,websiteUri";

const DAY_SETS = {
  "MON-FRI": ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  "MON-SAT": ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"],
  "MON-SUN": ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
};
const STAR_COUNT = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const DAY_SHORT = { MONDAY: "Mon", TUESDAY: "Tue", WEDNESDAY: "Wed", THURSDAY: "Thu", FRIDAY: "Fri", SATURDAY: "Sat", SUNDAY: "Sun" };

// The design's sample HWP -- editable in the setup panel.
const DEFAULT_ONBOARDING = {
  doctorName: "Dr. Meera Nair",
  practiceName: "Nair Endocrine Clinic",
  specialty: "Endocrinology",
  addressLine1: "12 Greams Road",
  addressLine2: "Thousand Lights",
  city: "Chennai",
  state: "Tamil Nadu",
  postalCode: "600006",
  phone: "+91 98407 22110",
  profileUrl: "https://ninto.in/dr-meera-nair",
  lat: "13.0604",
  lng: "80.2496",
  opens: "09:00",
  closes: "17:00",
  days: "MON-SAT"
};

const clientIdInput = document.getElementById("client-id");
const dryRunInput = document.getElementById("dry-run");
const modePill = document.getElementById("mode-pill");
const managerEmailInput = document.getElementById("manager-email");
const frameEl = document.getElementById("frame");
const diagnosticsEl = document.getElementById("diagnostics");

const diagnosticLines = [];
const callTimes = []; // ms epochs of GBP calls in the last minute, for the QPM readout

function logDiagnostic(line) {
  diagnosticLines.push(line);
  diagnosticsEl.textContent = diagnosticLines.join("\n");
  diagnosticsEl.scrollTop = diagnosticsEl.scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatDate(isoOrDate) {
  return new Date(isoOrDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function addDays(isoOrDate, days) {
  const d = new Date(isoOrDate);
  d.setDate(d.getDate() + days);
  return d;
}

// ---------------------------------------------------------------------------
// Local persistence -- every accessor is wrapped, since localStorage can be
// unavailable (private mode, blocked storage) and the spike must still run.

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore -- this just won't survive a reload
  }
}

function saveSession() {
  writeJson(SESSION_STORAGE_KEY, { accessToken: state.accessToken, expiresAt: state.tokenExpiresAt });
}

function loadSession() {
  const session = readJson(SESSION_STORAGE_KEY);
  if (!session?.accessToken || !session?.expiresAt || session.expiresAt <= Date.now()) return null;
  return session;
}

function clearSession() {
  writeJson(SESSION_STORAGE_KEY, null);
}

/** The listing Ninto is working with: {account, locationName, title, status}. */
function saveListingRef() {
  if (!state.listing) return writeJson(LISTING_STORAGE_KEY, null);
  writeJson(LISTING_STORAGE_KEY, {
    account: state.listing.account,
    locationName: state.listing.location.name,
    title: state.listing.location.title,
    status: state.profileStatus
  });
}

function onboarding() {
  return { ...DEFAULT_ONBOARDING, ...(readJson(ONBOARDING_STORAGE_KEY) ?? {}) };
}

function isDryRun() {
  return dryRunInput.checked;
}

// ---------------------------------------------------------------------------
// Business Profile API calls -- one wrapper so every call gets the same
// latency + rolling per-minute diagnostics, and a 0-QPM project is named as
// such instead of surfacing as a bare 429.

function describeApiError(error) {
  const details = error?.details ?? [];
  const reasons = details.map((d) => d.reason).filter(Boolean);
  const quotaZero =
    details.some((d) => d.metadata?.quota_limit_value === "0") ||
    (error?.status === "RESOURCE_EXHAUSTED" && /quota/i.test(error?.message ?? ""));
  let hint = "";
  if (quotaZero) hint = "quota is 0 QPM -- this Cloud project is not approved for the Business Profile APIs yet.";
  else if (reasons.includes("SERVICE_DISABLED")) hint = "this API is not enabled in the Cloud project.";
  else if (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) hint = "the token is missing the business.manage scope -- reconnect.";
  return { quotaZero, hint };
}

/**
 * @param {string} label shown in diagnostics
 * @param {"GET"|"POST"|"PATCH"|"DELETE"} method
 * @param {string} url
 * @param {object} [body]
 * @returns {Promise<object>}
 */
async function callGbp(label, method, url, body) {
  const now = Date.now();
  callTimes.push(now);
  while (callTimes.length && callTimes[0] < now - 60_000) callTimes.shift();

  const start = performance.now();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (networkError) {
    logDiagnostic(`${label}: NETWORK ERROR -- ${networkError.message}`);
    throw networkError;
  }
  const latencyMs = Math.round(performance.now() - start);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const apiError = json?.error ?? {};
    const { quotaZero, hint } = describeApiError(apiError);
    logDiagnostic(
      `${label}: HTTP ${response.status} in ${latencyMs}ms -- ${apiError.status ?? ""} "${apiError.message ?? text.slice(0, 200)}"` +
        (hint ? `\n  -> ${hint}` : "")
    );
    if (response.status === 401) clearSession(); // token's dead -- don't resume with it on reload
    const error = new Error(hint ? `${apiError.message ?? `HTTP ${response.status}`} (${hint})` : apiError.message ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.quotaZero = quotaZero;
    throw error;
  }

  logDiagnostic(`${label}: HTTP ${response.status} in ${latencyMs}ms -- ${callTimes.length}/${QPM_LIMIT} calls in the last minute (this tab)`);
  return json;
}

/** Runs `fn` unless dry-run is on, in which case the write is logged and skipped. */
async function liveWriteOnly(label, fn) {
  if (isDryRun()) {
    logDiagnostic(`${label}: SKIPPED (dry run -- this write has no validateOnly form)`);
    return null;
  }
  return fn();
}

// ---------------------------------------------------------------------------
// Mapping Ninto onboarding -> Business Profile fields

function storefrontAddress(form) {
  return {
    regionCode: "IN",
    languageCode: "en",
    postalCode: form.postalCode,
    administrativeArea: form.state,
    locality: form.city,
    addressLines: [form.addressLine1, form.addressLine2].filter(Boolean)
  };
}

function timeOfDay(hhmm) {
  const [hours, minutes] = String(hhmm || "00:00").split(":").map(Number);
  return minutes ? { hours, minutes } : { hours };
}

function regularHours(form) {
  return {
    periods: (DAY_SETS[form.days] ?? DAY_SETS["MON-SAT"]).map((day) => ({
      openDay: day,
      openTime: timeOfDay(form.opens),
      closeDay: day,
      closeTime: timeOfDay(form.closes)
    }))
  };
}

/** The editable fields of a Location, built from the edit/create form. */
function locationFromForm(form, existingCategories) {
  const location = {
    title: form.title,
    storefrontAddress: storefrontAddress(form),
    phoneNumbers: { primaryPhone: form.phone },
    regularHours: regularHours(form),
    websiteUri: form.website
  };
  if (form.categoryName) {
    location.categories = {
      primaryCategory: { name: form.categoryName },
      // Keep any secondary categories already on the listing -- the
      // "categories" mask replaces the whole field.
      ...(existingCategories?.additionalCategories ? { additionalCategories: existingCategories.additionalCategories } : {})
    };
  }
  return location;
}

function formFromOnboarding() {
  const ob = onboarding();
  return {
    title: ob.practiceName,
    categoryName: "",
    addressLine1: ob.addressLine1,
    addressLine2: ob.addressLine2,
    city: ob.city,
    state: ob.state,
    postalCode: ob.postalCode,
    phone: ob.phone,
    website: ob.profileUrl,
    lat: ob.lat,
    lng: ob.lng,
    opens: ob.opens,
    closes: ob.closes,
    days: ob.days
  };
}

function formatAddress(address) {
  if (!address) return "";
  return [...(address.addressLines ?? []), address.locality, address.administrativeArea, address.postalCode].filter(Boolean).join(", ");
}

function formatTime(t) {
  if (!t) return "";
  return `${String(t.hours ?? 0).padStart(2, "0")}:${String(t.minutes ?? 0).padStart(2, "0")}`;
}

function summarizeHours(hours) {
  const periods = hours?.periods ?? [];
  if (!periods.length) return "Not set";
  const days = [...new Set(periods.map((p) => DAY_SHORT[p.openDay] ?? p.openDay))];
  const span = days.length > 2 ? `${days[0]}–${days[days.length - 1]}` : days.join(", ");
  return `${span}, ${formatTime(periods[0].openTime)}–${formatTime(periods[0].closeTime)}`;
}

/** The search term for categories.list, from a Ninto specialty like "ENT (Ear, Nose & Throat)". */
function categoryTerm(specialty) {
  return String(specialty).replace(/\(.*?\)/g, "").split(/[&/,]/)[0].trim();
}

/** Strips a suffix so "Endocrinology" also matches "Endocrinologist". */
function categoryStem(term) {
  const stem = term.replace(/(ology|ologist|ics|istry|y)$/i, (m) => (/^olog/i.test(m) ? m.slice(0, 4) : ""));
  return stem.length >= 5 && stem !== term ? stem : null;
}

const categoryCache = new Map();

/** @returns {Promise<{name: string, displayName: string}[]>} */
async function searchCategories(term) {
  if (!term) return [];
  if (categoryCache.has(term)) return categoryCache.get(term);
  const url = `${INFO_API}/categories?regionCode=IN&languageCode=en&view=BASIC&pageSize=10&filter=${encodeURIComponent(`displayName=${term}`)}`;
  const data = await callGbp(`categories.list ("${term}")`, "GET", url);
  const categories = (data.categories ?? []).map((c) => ({ name: c.name, displayName: c.displayName }));
  categoryCache.set(term, categories);
  return categories;
}

async function categoriesForSpecialty(specialty) {
  const term = categoryTerm(specialty);
  let results = await searchCategories(term);
  const stem = categoryStem(term);
  if (!results.length && stem) results = await searchCategories(stem);
  return results;
}

// ---------------------------------------------------------------------------
// State

const state = {
  // home | profile | benefits | busy | select | edit | claim | create-1 | create-2
  // | dry-run-done | verify | sent | manage
  step: "home",
  previousStep: "home", // where "Maybe later" / "Not now" returns to
  accessToken: null,
  tokenExpiresAt: null,
  email: "",
  connecting: false,
  restoringSession: false,
  afterConnect: "discover", // "discover" | "manage"
  busyLabel: "",
  error: null, // message shown at the top of the current screen
  homeDismissed: false,

  accounts: [],
  candidates: [], // [{account, location, voice, role}] for 5a
  selectedIndex: null,
  listing: null, // {account, location} -- the listing Ninto is working with
  profileStatus: "none", // none | unverified | pending | live | removed

  form: null,
  editReturn: "select", // where the edit screen's back arrow goes
  googleValues: null, // the listing's current values, to flag fields onboarding would change
  categoryChoices: [],
  categoryQuery: "",

  searchResults: [],
  searchIndex: 0,

  voice: null,
  verifyOptions: [],
  methodIndex: 0,
  lastVerification: null,
  sentWasDryRun: false,

  verifications: [],
  admins: [],
  reviews: null, // {totalReviewCount, averageRating, reviews} | {error}
  googleUpdated: null,
  showCodeEntry: false,
  showRemoveSheet: false,
  dryRunPayload: null
};

function personalAccount() {
  return state.accounts.find((a) => a.type === "PERSONAL") ?? state.accounts[0] ?? null;
}

function pendingVerification() {
  return state.verifications.find((v) => v.state === "PENDING") ?? null;
}

function deriveStatus() {
  if (state.voice?.hasVoiceOfMerchant) return "live";
  if (pendingVerification() || state.voice?.verify?.hasPendingVerification || state.voice?.waitForVoiceOfMerchant) return "pending";
  return "unverified";
}

function goTo(step) {
  state.error = null;
  state.step = step;
  render();
}

function showBusy(label) {
  state.error = null;
  state.busyLabel = label;
  state.step = "busy";
  render();
}

function fail(error, step = state.step) {
  state.error = error.message ?? String(error);
  state.step = step;
  render();
}

// ---------------------------------------------------------------------------
// Screen templates

function topbar({ back = null, title, step = "" }) {
  return `<div class="topbar">
    ${back ? `<span class="back" data-action="${back}">&#8592;</span>` : ""}
    <span class="title">${escapeHtml(title)}</span>
    ${step ? `<span class="step">${escapeHtml(step)}</span>` : ""}
  </div>`;
}

function errorBox() {
  return state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : "";
}

function bottomNav(active) {
  const items = [["Home", "nav-home"], ["Inbox", ""], ["Schedule", ""], ["Practice", ""], ["Profile", "nav-profile"]];
  return `<div class="bottomnav">${items
    .map(([label, action]) => `<div class="${label === active ? "on" : ""}" ${action ? `data-action="${action}"` : ""}><i></i>${label}</div>`)
    .join("")}</div>`;
}

// 1 -- home feed prompt
function renderHome() {
  const showPrompt = !state.homeDismissed && (state.profileStatus === "none" || state.profileStatus === "removed");
  return `
    <div class="appbar"><span style="color:#fff;font-size:18px">&#9776;</span><div class="search">Search clinics...</div></div>
    <div class="tabs"><div class="on">For you</div><div>Following</div></div>
    <div style="flex:1;overflow-y:auto">
      ${
        showPrompt
          ? `<div style="padding:16px;border-bottom:1px solid var(--divider)">
              <div class="card-tint" style="gap:12px">
                <div style="display:flex;align-items:center;gap:8px"><span class="tick solid">&#10003;</span>
                  <span style="font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--accent-dark)">VERIFICATION COMPLETE</span></div>
                <div style="font-size:18px;font-weight:700;line-height:1.3">Get your practice on Google Maps</div>
                <div style="font-size:14px;line-height:1.5;color:var(--text-2)">Ninto can set up and manage your Google Business Profile, so care seekers nearby find you on Search and Maps.</div>
                <div style="display:flex;gap:10px;align-items:center">
                  <button class="btn-small" data-action="open-benefits" style="font-size:14px;padding:11px 20px">Set up</button>
                  <span class="link-muted" data-action="dismiss-home" style="padding:11px 8px">Not now</span>
                </div>
              </div>
            </div>`
          : ""
      }
      <div class="post">
        <div style="font-size:12px;color:var(--faint)">PCOS · PCOD ›</div>
        <div style="display:flex;gap:10px;align-items:center">
          <div style="width:34px;height:34px;border-radius:50%;background:#E7EDE9;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center">AS</div>
          <div><div style="font-size:14px;font-weight:700">Dr. Anjali Shah <span class="badge ok">Doctor</span></div>
          <div style="font-size:12px;color:var(--faint)">Gynecologist · Mumbai · 2h ago</div></div>
        </div>
        <div style="font-size:14px;line-height:1.55;color:var(--body-text)">Three things I wish care seekers knew about PCOS before their first appointment:</div>
      </div>
    </div>
    ${bottomNav("Home")}`;
}

// 2 -- profile prompt
function renderProfile() {
  const ob = onboarding();
  const saved = readJson(LISTING_STORAGE_KEY);
  const cards = {
    none: { text: "Not set up. Add your practice to Google Search and Maps.", button: "Set up", action: "open-benefits" },
    removed: { text: "Ninto's access was removed. Your listing stays on Google.", button: "Set up again", action: "open-benefits" },
    unverified: { text: `${escapeHtml(saved?.title ?? "Your listing")} isn't verified with Google yet.`, button: "Manage", action: "open-manage" },
    pending: { text: `${escapeHtml(saved?.title ?? "Your listing")} is awaiting Google verification.`, button: "Manage", action: "open-manage" },
    live: { text: `${escapeHtml(saved?.title ?? "Your listing")} is live on Search and Maps.`, button: "Manage", action: "open-manage" }
  };
  const card = cards[state.profileStatus] ?? cards.none;
  return `
    ${topbar({ back: "nav-home", title: "Profile" })}
    <div class="body" style="align-items:center">
      <div style="width:96px;height:96px;border-radius:50%;background:#E7EDE9;box-shadow:0 0 0 1px var(--border)"></div>
      <div style="display:flex;align-items:center;gap:7px"><span style="font-size:22px;font-weight:700">${escapeHtml(ob.doctorName)}</span><span class="tick solid">&#10003;</span></div>
      <div style="font-size:13px;color:var(--muted);margin-top:-8px">${escapeHtml(ob.specialty)} · ${escapeHtml(ob.city)}</div>
      <div style="width:100%" class="card-tint">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="width:34px;height:34px;border-radius:8px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;color:var(--accent-dark);font-weight:700;flex:none">&#9678;</div>
          <div style="flex:1;display:flex;flex-direction:column;gap:4px">
            <div style="font-size:15px;font-weight:700">Google Business Profile</div>
            <div style="font-size:13px;line-height:1.45;color:var(--text-2)">${card.text}</div>
            <button class="btn-small" style="margin-top:8px" data-action="${card.action}">${card.button}</button>
          </div>
        </div>
      </div>
      <div style="width:100%;display:flex;flex-direction:column;gap:8px">
        <div class="section-label">ABOUT</div>
        <div style="font-size:14px;line-height:1.55;color:var(--body-text)">I help care seekers understand the patterns driving their PCOS, thyroid, and diabetes — so they can make decisions that hold.</div>
      </div>
    </div>
    ${bottomNav("Profile")}`;
}

// 3 -- benefits & consent sheet (4 is Google's own popup)
function renderBenefits() {
  const label = state.restoringSession ? "Resuming your sign-in..." : state.connecting ? "Waiting for Google..." : "Continue with Google";
  const benefits = [
    "Appear on Google Search and Maps for your practice location",
    "Clinic hours, address, and phone stay in sync with Ninto",
    "Your Ninto profile becomes the listing's website link",
    "Reviews surface in your Ninto inbox"
  ];
  return `
    <div style="flex:1;background:var(--ink);display:flex;flex-direction:column;justify-content:flex-end">
      <div class="sheet">
        <div class="grabber"></div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div class="h1">Your practice on Google, managed by Ninto</div>
          <div class="lede">A Google Business Profile is the panel people see when they search your clinic's name or look for a nearby specialist.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${benefits.map((b) => `<div class="benefit"><span class="tick">&#10003;</span><span>${b}</span></div>`).join("")}
        </div>
        <div class="note">Ninto becomes a manager on the listing. You stay the owner, and you can remove our access at any time from Manage listing.</div>
        ${errorBox()}
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn-primary" data-action="connect" ${state.connecting || state.restoringSession ? "disabled" : ""}>${label}</button>
          <div class="link-muted" data-action="maybe-later">Maybe later</div>
        </div>
        <div class="fineprint">You'll sign in to your Google account to continue.</div>
      </div>
    </div>`;
}

function renderBusy() {
  return `
    ${topbar({ back: state.error ? "back-to-profile" : null, title: "Google Business Profile" })}
    <div class="body">
      ${
        state.error
          ? `${errorBox()}
             <button class="btn-outline" data-action="retry">Try again</button>`
          : `<div style="margin:auto;text-align:center;color:var(--muted);font-size:14px">${escapeHtml(state.busyLabel)}</div>`
      }
    </div>`;
}

function statusBadge(voice) {
  if (!voice) return `<span class="badge grey">Status unknown</span>`;
  if (voice.hasVoiceOfMerchant) return `<span class="badge ok">Verified</span>`;
  if (voice.verify?.hasPendingVerification || voice.waitForVoiceOfMerchant) return `<span class="badge pending">Verification pending</span>`;
  if (voice.resolveOwnershipConflict) return `<span class="badge red">Ownership conflict</span>`;
  return `<span class="badge grey">Unverified</span>`;
}

function roleBadge(role) {
  if (!role) return "";
  const label = { PRIMARY_OWNER: "You are primary owner", OWNER: "You are owner", MANAGER: "You are manager", SITE_MANAGER: "You are site manager" }[role] ?? role;
  return `<span class="badge grey">${escapeHtml(label)}</span>`;
}

// 5a -- listings already on the account
function renderSelect() {
  return `
    ${topbar({ back: "back-to-profile", title: "Select your listing" })}
    <div class="body">
      <div class="lede">We found ${state.candidates.length} listing${state.candidates.length === 1 ? "" : "s"} on ${escapeHtml(state.email || "your account")}. Pick the one for your practice.</div>
      ${errorBox()}
      ${state.candidates
        .map(
          (c, i) => `<div class="listing ${state.selectedIndex === i ? "selected" : ""}" data-action="select-listing" data-id="${i}">
            <div class="name">${escapeHtml(c.location.title)}</div>
            <div class="addr">${escapeHtml(formatAddress(c.location.storefrontAddress) || "No storefront address")}</div>
            <div class="badges">${statusBadge(c.voice)}${roleBadge(c.role)}</div>
          </div>`
        )
        .join("")}
      <div class="link-accent" data-action="none-of-these">None of these — create a new listing</div>
      <div style="margin-top:auto"><button class="btn-primary" data-action="upgrade" ${state.selectedIndex == null ? "disabled" : ""}>Upgrade with Ninto</button></div>
    </div>`;
}

function categorySelect() {
  const choices = state.categoryChoices;
  const options = choices.length
    ? choices.map((c) => `<option value="${escapeHtml(c.name)}" ${c.name === state.form.categoryName ? "selected" : ""}>${escapeHtml(c.displayName)}</option>`).join("")
    : `<option value="">No match -- search below</option>`;
  return `<div class="field">
      <label>CATEGORY</label>
      <select data-form="categoryName">${options}</select>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input data-category-query placeholder="Search Google categories" value="${escapeHtml(state.categoryQuery)}" style="font-size:13px;padding:8px 10px" />
        <button class="btn-small" data-action="search-categories" style="padding:8px 12px">Search</button>
      </div>
      ${state.googleValues?.category && state.googleValues.category.name !== state.form.categoryName ? `<div class="google-has">On Google now: ${escapeHtml(state.googleValues.category.displayName)}</div>` : ""}
      <div class="hint">Mapped from your Ninto specialty (${escapeHtml(onboarding().specialty)}) via Google's category list.</div>
    </div>`;
}

function textField(label, key, { hint = "", googleKey = null } = {}) {
  const googleValue = googleKey && state.googleValues ? state.googleValues[googleKey] : null;
  const differs = googleValue != null && googleValue !== "" && googleValue !== state.form[key];
  return `<div class="field">
    <label>${label}</label>
    <input data-form="${key}" value="${escapeHtml(state.form[key])}" />
    ${differs ? `<div class="google-has">On Google now: ${escapeHtml(googleValue)}</div>` : ""}
    ${hint ? `<div class="hint">${hint}</div>` : ""}
  </div>`;
}

function hoursField() {
  return `<div class="field">
    <label>HOURS</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <select data-form="days" style="flex:1 1 100%">
        ${Object.keys(DAY_SETS).map((k) => `<option value="${k}" ${state.form.days === k ? "selected" : ""}>${{ "MON-FRI": "Mon–Fri", "MON-SAT": "Mon–Sat", "MON-SUN": "Every day" }[k]}</option>`).join("")}
      </select>
      <input type="time" data-form="opens" value="${escapeHtml(state.form.opens)}" style="flex:1;min-width:0" />
      <input type="time" data-form="closes" value="${escapeHtml(state.form.closes)}" style="flex:1;min-width:0" />
    </div>
    ${state.googleValues?.hours ? `<div class="google-has">On Google now: ${escapeHtml(state.googleValues.hours)}</div>` : ""}
  </div>`;
}

function addressFields() {
  return `
    ${textField("ADDRESS", "addressLine1", { googleKey: "address" })}
    ${textField("AREA", "addressLine2")}
    <div style="display:flex;gap:8px">
      <div style="flex:1">${textField("CITY", "city")}</div>
      <div style="flex:1">${textField("PIN CODE", "postalCode")}</div>
    </div>`;
}

// 5a -- add / edit details (prefilled from onboarding)
function renderEdit() {
  return `
    ${topbar({ back: "back-from-edit", title: state.listing.location.title })}
    <div class="body">
      <div class="lede">Filled from your Ninto onboarding. Edit anything that's changed.</div>
      ${errorBox()}
      ${textField("PRACTICE NAME", "title", { googleKey: "title" })}
      ${categorySelect()}
      ${addressFields()}
      ${textField("PHONE", "phone", { googleKey: "phone" })}
      ${hoursField()}
      ${textField("WEBSITE", "website", { googleKey: "website", hint: "Your Ninto profile. Replace it if you have a clinic site." })}
      <label class="toggle-row"><input type="checkbox" disabled /> Keep this listing in sync with my Ninto profile</label>
      <div class="hint" style="font-size:11px;color:var(--faint);margin-top:-8px">Ongoing sync needs a Ninto backend -- not part of this spike.</div>
      <button class="btn-primary" data-action="submit-edit">${isDryRun() ? "Validate with Google (dry run)" : "Submit to Google"}</button>
    </div>`;
}

// 5b -- unclaimed listing found (or one someone else manages)
function renderClaim() {
  const result = state.searchResults[state.searchIndex];
  const loc = result.location ?? {};
  const managedElsewhere = Boolean(result.requestAdminRightsUri);
  const ob = onboarding();
  const sameAddress = loc.storefrontAddress?.postalCode && loc.storefrontAddress.postalCode === ob.postalCode;
  const latlng = loc.latlng ? `${loc.latlng.latitude?.toFixed(4)}, ${loc.latlng.longitude?.toFixed(4)}` : "no coordinates";
  return `
    ${topbar({ back: "back-to-profile", title: managedElsewhere ? "Someone manages this listing" : "Claim your listing", step: state.searchResults.length > 1 ? `${state.searchIndex + 1} of ${state.searchResults.length}` : "" })}
    <div class="body">
      <div class="lede">${
        managedElsewhere
          ? "This place is already on Google and someone else manages it. Ask them for access on Google — Ninto can't claim it for you."
          : "This place already exists on Google but nobody has claimed it. Claim it to control the details."
      }</div>
      ${errorBox()}
      <div class="map">Map preview · ${escapeHtml(latlng)}<br/>(Maps JS needs its own key -- not in this spike)</div>
      <div class="listing">
        <div class="name">${escapeHtml(loc.title)}</div>
        <div class="addr">${escapeHtml(formatAddress(loc.storefrontAddress))}</div>
        <div class="addr">${escapeHtml([loc.categories?.primaryCategory?.displayName, loc.phoneNumbers?.primaryPhone].filter(Boolean).join(" · "))}</div>
        <div class="badges">
          ${managedElsewhere ? `<span class="badge grey">Managed by someone else</span>` : `<span class="badge ok">Unclaimed</span>`}
          ${sameAddress ? `<span class="badge grey">Matches your onboarding address</span>` : ""}
        </div>
      </div>
      ${
        managedElsewhere
          ? `<div class="note">Google sends the request to the current owner. If they don't reply, Google may let you take over after a waiting period.</div>
             <button class="btn-primary" data-action="request-access">Request access on Google</button>`
          : `<div class="note">Claiming asks Google to confirm you represent this practice. Existing reviews and photos stay on the listing.</div>
             <button class="btn-primary" data-action="claim">${isDryRun() ? "Validate claim (dry run)" : "Claim this listing"}</button>`
      }
      <div class="link-muted" data-action="not-my-practice">Not my practice</div>
    </div>`;
}

// 5c -- create a new listing, step 1 of 2
function renderCreate1() {
  return `
    ${topbar({ back: "back-to-profile", title: "New listing", step: "Step 1 of 2" })}
    <div class="body">
      <div class="lede">No listing found for your practice. Ninto will create one and manage it for you.</div>
      ${errorBox()}
      ${textField("PRACTICE NAME", "title")}
      ${categorySelect()}
      ${addressFields()}
      <div class="map">Drag the pin to your entrance<br/>(Maps JS needs its own key -- enter coordinates below)</div>
      <div style="display:flex;gap:8px">
        <div style="flex:1">${textField("LATITUDE", "lat")}</div>
        <div style="flex:1">${textField("LONGITUDE", "lng")}</div>
      </div>
      ${textField("WEBSITE", "website", { hint: "From your Ninto profile." })}
      <button class="btn-primary" data-action="create-continue">Continue</button>
    </div>`;
}

// 5c -- step 2 of 2 (not in the design yet; the plan assumes phone + hours)
function renderCreate2() {
  return `
    ${topbar({ back: "back-to-create-1", title: "New listing", step: "Step 2 of 2" })}
    <div class="body">
      <div class="lede">How care seekers reach you. Google shows these on the listing.</div>
      ${errorBox()}
      ${textField("PHONE", "phone", { hint: "Google may verify by SMS or a call to this number." })}
      ${hoursField()}
      <button class="btn-primary" data-action="create-submit">${isDryRun() ? "Validate with Google (dry run)" : "Create listing"}</button>
    </div>`;
}

function renderDryRunDone() {
  return `
    ${topbar({ back: "back-to-profile", title: "Dry run passed" })}
    <div class="body">
      <div style="display:flex;align-items:center;gap:10px"><span class="tick solid">&#10003;</span><span class="h1" style="font-size:18px">Google accepted the payload</span></div>
      <div class="lede">Sent with <code>validateOnly=true</code>, so nothing was created on Google. Turn off dry run in the setup panel to create it for real (test listings only).</div>
      <pre class="note" style="white-space:pre-wrap;word-break:break-word;font-size:11px;margin:0">${escapeHtml(JSON.stringify(state.dryRunPayload, null, 2))}</pre>
      <button class="btn-outline" data-action="back-to-profile">Back to profile</button>
    </div>`;
}

function methodLabel(option) {
  switch (option.verificationMethod) {
    case "SMS":
      return `SMS to ${option.phoneNumber}`;
    case "PHONE_CALL":
      return `Automated voice call to ${option.phoneNumber}`;
    case "EMAIL":
      return `Email to ${option.emailData?.user ?? ""}@${option.emailData?.domain ?? ""}`;
    case "ADDRESS":
      return `Postcard to ${option.addressData?.address ? formatAddress(option.addressData.address) : "your clinic address"}${option.addressData?.expectedDeliveryDaysRegion ? ` (~${option.addressData.expectedDeliveryDaysRegion} days)` : ""}`;
    case "AUTO":
      return "Google can verify this listing automatically";
    case "VETTED_PARTNER":
      return "Vetted partner (not available to Ninto)";
    default:
      return option.verificationMethod;
  }
}

// 6 -- verification method picker (the design's "Google picks" is really "you pick from Google's options")
function renderVerify() {
  const options = state.verifyOptions;
  return `
    ${topbar({ back: "back-to-profile", title: "Verify with Google" })}
    <div class="body">
      <div class="h1" style="font-size:18px">How should Google reach you?</div>
      <div class="lede">Google offers these methods for ${escapeHtml(state.listing.location.title)}. Pick one and Google sends you a code.</div>
      ${errorBox()}
      ${
        options.length
          ? options
              .map(
                (o, i) => `<label class="method ${state.methodIndex === i ? "selected" : ""}" data-action="pick-method" data-id="${i}">
                  <input type="radio" name="method" ${state.methodIndex === i ? "checked" : ""} ${o.verificationMethod === "VETTED_PARTNER" ? "disabled" : ""} />
                  <span>${escapeHtml(methodLabel(o))}</span></label>`
              )
              .join("")
          : `<div class="warn">Google returned no verification options for this listing. Finish verification in Google Business Profile itself.</div>`
      }
      <div class="note">SMS, email, and calls usually arrive within minutes. A postcard can take up to 14 days. Enter the code in Manage listing when it arrives.</div>
      ${options.length ? `<button class="btn-primary" data-action="send-verification">${isDryRun() ? "Send code (skipped in dry run)" : options[state.methodIndex]?.verificationMethod === "AUTO" ? "Verify automatically" : "Send code"}</button>` : ""}
      <div class="link-accent" data-action="open-manage">Go to Manage listing</div>
    </div>`;
}

// 6 -- submitted
function renderSent() {
  const option = state.verifyOptions[state.methodIndex];
  return `
    <div class="body" style="padding-top:40px">
      <span class="tick solid" style="width:44px;height:44px;font-size:22px;align-self:center">&#10003;</span>
      <div class="h1" style="text-align:center">${state.sentWasDryRun ? "Nothing sent (dry run)" : "Sent to Google"}</div>
      <div class="lede" style="text-align:center">${escapeHtml(state.listing.location.title)} is submitted. Google now needs to confirm you represent this practice.</div>
      ${option ? `<div class="note"><strong>${escapeHtml(methodLabel(option))}</strong><br/>${state.lastVerification ? `Verification ${escapeHtml(state.lastVerification.state ?? "")} · started ${formatDate(state.lastVerification.createTime ?? Date.now())}` : "No verification was started."}</div>` : ""}
      <div class="note">SMS, email, and calls usually arrive within minutes. A postcard can take up to 14 days. Enter the code in Manage listing when it arrives.</div>
      <button class="btn-primary" data-action="open-manage">Go to Manage listing</button>
      <div class="link-muted" data-action="back-to-profile">Back to profile</div>
    </div>`;
}

function expectedArrival(verification) {
  if (!verification?.createTime) return "";
  if (verification.method === "ADDRESS") return `Postcard sent · expect by ${formatDate(addDays(verification.createTime, 14))}`;
  const label = { SMS: "SMS", EMAIL: "Email", PHONE_CALL: "Voice call", AUTO: "Automatic" }[verification.method] ?? verification.method;
  return `${label} sent ${formatDate(verification.createTime)} · usually arrives within minutes`;
}

function managerAdmin() {
  const email = managerEmailInput.value.trim().toLowerCase();
  if (!email) return null;
  return state.admins.find((a) => String(a.admin ?? "").toLowerCase() === email) ?? null;
}

// 7 -- manage listing
function renderManage() {
  const loc = state.listing.location;
  const status = deriveStatus();
  const pending = pendingVerification();
  const latest = state.verifications[0] ?? null;
  const badge = { live: `<span class="badge ok">Live</span>`, pending: `<span class="badge pending">Awaiting Google</span>`, unverified: `<span class="badge grey">Not verified</span>` }[status];
  const submittedAt = latest?.createTime ?? null;
  const manager = managerAdmin();
  const reviews = state.reviews;

  return `
    ${topbar({ back: "back-to-profile", title: "Manage listing" })}
    <div class="body">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div class="h1" style="font-size:18px">${escapeHtml(loc.title)}</div>${badge}
      </div>
      ${errorBox()}
      <div class="timeline">
        <div class="tl-item"><div class="tl-rail"><div class="tl-dot done"></div><div class="tl-line"></div></div>
          <div class="tl-text"><div class="t">Submitted</div><div class="s">${submittedAt ? formatDate(submittedAt) : "Listing on your Google account"}</div></div></div>
        <div class="tl-item"><div class="tl-rail"><div class="tl-dot ${status === "live" ? "done" : status === "pending" ? "now" : ""}"></div><div class="tl-line"></div></div>
          <div class="tl-text"><div class="t">Google verification ${status === "live" ? "complete" : status === "pending" ? "in progress" : "not started"}</div>
          <div class="s">${escapeHtml(pending ? expectedArrival(pending) : latest ? `${latest.method} · ${latest.state}` : "")}</div></div></div>
        <div class="tl-item"><div class="tl-rail"><div class="tl-dot ${status === "live" ? "done" : ""}"></div></div>
          <div class="tl-text"><div class="t">Live on Search and Maps</div>
          <div class="s">${loc.metadata?.mapsUri ? `<a href="${escapeHtml(loc.metadata.mapsUri)}" target="_blank" rel="noopener">Open in Google Maps</a>` : ""}</div></div></div>
      </div>
      ${
        pending
          ? state.showCodeEntry
            ? `<div class="field"><label>VERIFICATION CODE</label><input data-pin inputmode="numeric" placeholder="Code from Google" /></div>
               <button class="btn-primary" data-action="complete-code">${isDryRun() ? "Confirm code (skipped in dry run)" : "Confirm code"}</button>`
            : `<button class="btn-primary" data-action="show-code-entry">Enter verification code</button>`
          : status === "unverified"
            ? `<button class="btn-primary" data-action="go-verify">Verify with Google</button>`
            : ""
      }
      ${
        state.googleUpdated?.pendingMask
          ? `<div class="warn">Google is reviewing changes to: ${escapeHtml(state.googleUpdated.pendingMask)}. They go live once Google approves them.</div>`
          : ""
      }

      <div class="section-label" style="margin-top:6px">LISTING DETAILS</div>
      <div>
        <div class="kv"><span class="k">Address</span><span class="v">${escapeHtml(formatAddress(loc.storefrontAddress) || "—")}</span></div>
        <div class="kv"><span class="k">Category</span><span class="v">${escapeHtml(loc.categories?.primaryCategory?.displayName ?? "—")}</span></div>
        <div class="kv"><span class="k">Phone</span><span class="v">${escapeHtml(loc.phoneNumbers?.primaryPhone ?? "—")}</span></div>
        <div class="kv"><span class="k">Website</span><span class="v">${escapeHtml(loc.websiteUri ?? "—")}</span></div>
        <div class="kv"><span class="k">Hours</span><span class="v">${escapeHtml(summarizeHours(loc.regularHours))}</span></div>
      </div>
      <button class="btn-outline" data-action="edit-details">Edit details</button>

      <div class="section-label" style="margin-top:6px">REVIEWS</div>
      ${
        !reviews
          ? `<div class="lede">Loading…</div>`
          : reviews.error
            ? `<div class="warn">Reviews API: ${escapeHtml(reviews.error)}</div>`
            : `<div class="lede">${reviews.totalReviewCount ?? 0} review${reviews.totalReviewCount === 1 ? "" : "s"}${reviews.averageRating ? ` · ${Number(reviews.averageRating).toFixed(1)} ★` : ""}</div>
               ${(reviews.reviews ?? [])
                 .slice(0, 3)
                 .map((r) => `<div class="review"><strong>${escapeHtml(r.reviewer?.displayName ?? "Someone")}</strong> · ${"★".repeat(STAR_COUNT[r.starRating] ?? 0)}<br/>${escapeHtml(r.comment ?? "(no text)")}</div>`)
                 .join("")}`
      }

      <div class="section-label" style="margin-top:6px">NINTO'S ACCESS</div>
      <div class="lede">${
        manager
          ? `Ninto is a manager on this listing${manager.pendingInvitation ? " (invitation pending)" : ""} and keeps it in sync with your profile.`
          : managerEmailInput.value.trim()
            ? "Ninto isn't a manager on this listing yet. It works with your Google sign-in instead."
            : "Ninto works with your Google sign-in. (Set a Ninto manager account in the setup panel to test the manager invite.)"
      }</div>
      ${state.admins.length ? `<div>${state.admins.map((a) => `<div class="kv"><span class="k">${escapeHtml(a.admin ?? a.account ?? a.name)}</span><span class="v">${escapeHtml(a.role)}${a.pendingInvitation ? " · invited" : ""}</span></div>`).join("")}</div>` : ""}
      ${!manager && managerEmailInput.value.trim() ? `<button class="btn-outline" data-action="invite-manager">${isDryRun() ? "Invite Ninto as manager (skipped in dry run)" : "Invite Ninto as manager"}</button>` : ""}
      <div class="link-muted" data-action="open-remove" style="color:var(--danger)">Remove Ninto's access</div>
    </div>
    ${state.showRemoveSheet ? renderRemoveSheet() : ""}`;
}

// 7c -- remove access confirmation
function renderRemoveSheet() {
  const pending = deriveStatus() === "pending";
  return `
    <div class="sheet-backdrop">
      <div class="sheet">
        <div class="grabber"></div>
        <div class="h1" style="font-size:18px">Remove Ninto's access?</div>
        <div class="lede">Your listing stays on Google and you remain the owner. Ninto will stop syncing details, and reviews will no longer appear in your inbox.</div>
        ${pending ? `<div class="warn">Verification is still pending. If you remove access now, you'll need to finish verification in Google Business Profile yourself.</div>` : ""}
        <button class="btn-danger" data-action="remove-access">Remove access</button>
        <div class="link-muted" data-action="close-remove">Keep Ninto as manager</div>
      </div>
    </div>`;
}

function render() {
  const templates = {
    home: renderHome,
    profile: renderProfile,
    benefits: renderBenefits,
    busy: renderBusy,
    select: renderSelect,
    edit: renderEdit,
    claim: renderClaim,
    "create-1": renderCreate1,
    "create-2": renderCreate2,
    "dry-run-done": renderDryRunDone,
    verify: renderVerify,
    sent: renderSent,
    manage: renderManage
  };
  frameEl.innerHTML = templates[state.step]();
  wireFrameEvents();
}

function wireFrameEvents() {
  frameEl.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (el.tagName === "LABEL") event.preventDefault(); // avoid a second click via the radio inside
      handleAction(el.getAttribute("data-action"), el.getAttribute("data-id"));
    });
  });
  // Form fields write straight into state without a re-render, so typing keeps focus.
  frameEl.querySelectorAll("[data-form]").forEach((el) => {
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      state.form[el.getAttribute("data-form")] = el.value;
    });
  });
  const categoryQuery = frameEl.querySelector("[data-category-query]");
  if (categoryQuery) {
    categoryQuery.addEventListener("input", () => (state.categoryQuery = categoryQuery.value));
    categoryQuery.addEventListener("keydown", (e) => e.key === "Enter" && handleAction("search-categories"));
  }
}

// ---------------------------------------------------------------------------
// Actions

let retryAction = null;

async function handleAction(action, id) {
  switch (action) {
    case "nav-home":
      goTo("home");
      break;
    case "nav-profile":
    case "back-to-profile":
      state.showRemoveSheet = false;
      goTo("profile");
      break;
    case "dismiss-home":
      state.homeDismissed = true;
      goTo("profile");
      break;
    case "open-benefits":
      state.previousStep = state.step;
      state.afterConnect = "discover";
      goTo("benefits");
      break;
    case "maybe-later":
      goTo(state.previousStep === "benefits" ? "home" : state.previousStep);
      break;
    case "connect":
      connectThen();
      break;
    case "open-manage":
      state.afterConnect = "manage";
      connectThen();
      break;
    case "retry":
      if (retryAction) retryAction();
      break;
    case "select-listing":
      state.selectedIndex = Number(id);
      render();
      break;
    case "upgrade":
      state.editReturn = "select";
      openEdit(state.candidates[state.selectedIndex]);
      break;
    case "none-of-these":
      runSearch();
      break;
    case "back-from-edit":
      goTo(state.editReturn);
      break;
    case "search-categories":
      await runCategorySearch(state.categoryQuery);
      break;
    case "submit-edit":
      submitEdit();
      break;
    case "claim":
      claimListing();
      break;
    case "request-access":
      window.open(state.searchResults[state.searchIndex].requestAdminRightsUri, "_blank", "noopener");
      logDiagnostic("Opened Google's request-admin-rights page in a new tab.");
      break;
    case "not-my-practice":
      if (state.searchIndex + 1 < state.searchResults.length) {
        state.searchIndex += 1;
        render();
      } else {
        openCreate();
      }
      break;
    case "create-continue":
      goTo("create-2");
      break;
    case "back-to-create-1":
      goTo("create-1");
      break;
    case "create-submit":
      createListing();
      break;
    case "pick-method":
      if (state.verifyOptions[Number(id)]?.verificationMethod === "VETTED_PARTNER") break;
      state.methodIndex = Number(id);
      render();
      break;
    case "send-verification":
      sendVerification();
      break;
    case "go-verify":
      goVerify();
      break;
    case "show-code-entry":
      state.showCodeEntry = true;
      render();
      break;
    case "complete-code":
      completeCode(frameEl.querySelector("[data-pin]")?.value.trim());
      break;
    case "edit-details":
      state.editReturn = "manage";
      openEdit({ account: state.listing.account, location: state.listing.location });
      break;
    case "invite-manager":
      inviteManager();
      break;
    case "open-remove":
      state.showRemoveSheet = true;
      render();
      break;
    case "close-remove":
      state.showRemoveSheet = false;
      render();
      break;
    case "remove-access":
      removeAccess();
      break;
  }
}

/** Signs in if needed (step 4, Google's popup), then continues to discovery or manage. */
function connectThen() {
  if (state.accessToken && state.tokenExpiresAt > Date.now()) {
    afterSignIn();
    return;
  }
  startConnect();
}

async function afterSignIn() {
  if (state.afterConnect === "manage") {
    const saved = readJson(LISTING_STORAGE_KEY);
    if (saved) {
      await openManage(saved.account, saved.locationName);
      return;
    }
  }
  await discoverListings();
}

// 5a -- what's already on the signed-in account
async function discoverListings() {
  retryAction = discoverListings;
  showBusy(`Looking for listings on ${state.email || "your Google account"}…`);
  try {
    const accounts = [];
    let pageToken = "";
    do {
      const data = await callGbp("accounts.list", "GET", `${ACCOUNTS_API}/accounts?pageSize=20${pageToken ? `&pageToken=${pageToken}` : ""}`);
      accounts.push(...(data.accounts ?? []));
      pageToken = data.nextPageToken ?? "";
    } while (pageToken && accounts.length < 100);
    state.accounts = accounts;
    logDiagnostic(`  ${accounts.length} account(s): ${accounts.map((a) => `${a.accountName ?? a.name} [${a.type}, ${a.role ?? "?"}]`).join("; ")}`);

    const candidates = [];
    for (const account of accounts) {
      const data = await callGbp(`locations.list (${account.name})`, "GET", `${INFO_API}/${account.name}/locations?readMask=${READ_MASK}&pageSize=100`);
      for (const location of data.locations ?? []) candidates.push({ account: account.name, accountRole: account.role, location });
    }

    for (const c of candidates) {
      c.voice = await callGbp(`getVoiceOfMerchantState (${c.location.name})`, "GET", `${VERIFY_API}/${c.location.name}/VoiceOfMerchantState`).catch(() => null);
      const admins = await callGbp(`admins.list (${c.location.name})`, "GET", `${ACCOUNTS_API}/${c.location.name}/admins`).catch(() => null);
      c.role = admins?.admins?.find((a) => a.account === c.account)?.role ?? c.accountRole ?? null;
    }

    state.candidates = candidates;
    state.selectedIndex = candidates.length === 1 ? 0 : null;
    if (candidates.length) goTo("select");
    else {
      logDiagnostic("  No listings on this account -- searching Google for the practice.");
      await runSearch();
    }
  } catch (error) {
    fail(error, "busy");
  }
}

// 5b -- is the practice already on Google?
async function runSearch() {
  retryAction = runSearch;
  if (!state.accounts.length) {
    // Reached from a resumed session without discovery -- accounts are needed to claim/create into.
    await discoverAccountsOnly().catch((e) => fail(e, "busy"));
    if (state.error) return;
  }
  showBusy("Checking Google for your practice…");
  const ob = onboarding();
  const body = {
    pageSize: 5,
    location: {
      title: ob.practiceName,
      storefrontAddress: storefrontAddress({ ...ob }),
      phoneNumbers: { primaryPhone: ob.phone }
    }
  };
  try {
    const data = await callGbp("googleLocations.search", "POST", `${INFO_API}/googleLocations:search`, body);
    const results = data.googleLocations ?? [];
    logDiagnostic(`  ${results.length} match(es): ${results.map((r) => `${r.location?.title} [${r.requestAdminRightsUri ? "managed elsewhere" : "claimable"}]`).join("; ") || "none"}`);
    state.searchResults = results;
    state.searchIndex = 0;
    if (results.length) goTo("claim");
    else openCreate();
  } catch (error) {
    fail(error, "busy");
  }
}

async function discoverAccountsOnly() {
  const data = await callGbp("accounts.list", "GET", `${ACCOUNTS_API}/accounts?pageSize=20`);
  state.accounts = data.accounts ?? [];
}

async function runCategorySearch(term) {
  if (!term?.trim()) return;
  try {
    const results = await searchCategories(term.trim());
    state.categoryChoices = results;
    if (results.length && !results.some((c) => c.name === state.form.categoryName)) state.form.categoryName = results[0].name;
    state.error = results.length ? null : `No Google category matches "${term}".`;
  } catch (error) {
    state.error = error.message;
  }
  render();
}

/** Loads category choices for the HWP's specialty, keeping the listing's current category in the list. */
async function prepareCategories(currentCategory) {
  state.categoryQuery = categoryTerm(onboarding().specialty);
  let choices = [];
  try {
    choices = await categoriesForSpecialty(onboarding().specialty);
  } catch {
    // logged by callGbp -- the user can still search by hand
  }
  const fromSpecialty = choices[0]?.name ?? currentCategory?.name ?? "";
  if (currentCategory && !choices.some((c) => c.name === currentCategory.name)) choices = [...choices, currentCategory];
  state.categoryChoices = choices;
  state.form.categoryName = fromSpecialty;
}

async function openEdit(candidate) {
  state.listing = { account: candidate.account, location: candidate.location };
  state.form = formFromOnboarding();
  const loc = candidate.location;
  state.googleValues = {
    title: loc.title ?? "",
    address: formatAddress(loc.storefrontAddress),
    phone: loc.phoneNumbers?.primaryPhone ?? "",
    website: loc.websiteUri ?? "",
    hours: loc.regularHours ? summarizeHours(loc.regularHours) : "",
    category: loc.categories?.primaryCategory ?? null
  };
  // address is compared as one formatted string -- point the hint at line 1 only when it differs.
  if (state.googleValues.address === formatAddress(storefrontAddress(state.form))) state.googleValues.address = "";
  if (state.googleValues.hours === summarizeHours(regularHours(state.form))) state.googleValues.hours = "";
  showBusy("Preparing your details…");
  const current = loc.categories?.primaryCategory;
  await prepareCategories(current ? { name: current.name, displayName: current.displayName } : null);
  goTo("edit");
}

async function openCreate() {
  state.form = formFromOnboarding();
  state.googleValues = null;
  showBusy("Preparing a new listing…");
  await prepareCategories(null);
  goTo("create-1");
}

async function submitEdit() {
  const loc = state.listing.location;
  const payload = locationFromForm(state.form, loc.categories);
  const mask = state.form.categoryName ? EDIT_UPDATE_MASK : EDIT_UPDATE_MASK.replace("categories,", "");
  const dry = isDryRun();
  showBusy(dry ? "Validating with Google…" : "Submitting to Google…");
  retryAction = submitEdit;
  try {
    const updated = await callGbp(
      `locations.patch${dry ? " (validateOnly)" : ""}`,
      "PATCH",
      `${INFO_API}/${loc.name}?updateMask=${mask}${dry ? "&validateOnly=true" : ""}`,
      payload
    );
    if (dry) {
      logDiagnostic("  validateOnly passed -- Google would accept this edit. Nothing changed.");
    } else {
      state.listing.location = { ...loc, ...updated };
      state.googleUpdated = await callGbp("getGoogleUpdated", "GET", `${INFO_API}/${loc.name}:getGoogleUpdated?readMask=${READ_MASK}`).catch(() => null);
      if (state.googleUpdated?.pendingMask) logDiagnostic(`  Google is holding these fields for review: ${state.googleUpdated.pendingMask}`);
    }
    await goVerify();
  } catch (error) {
    fail(error, "edit");
  }
}

function newLocationBody(form) {
  const body = { ...locationFromForm(form, null), languageCode: "en" };
  const lat = Number(form.lat), lng = Number(form.lng);
  if (form.lat && form.lng && !Number.isNaN(lat) && !Number.isNaN(lng)) body.latlng = { latitude: lat, longitude: lng };
  return body;
}

async function createInto(label, body) {
  const account = personalAccount();
  if (!account) throw new Error("No Business Profile account on this Google sign-in to create the listing in.");
  const dry = isDryRun();
  const url = `${INFO_API}/${account.name}/locations?requestId=${crypto.randomUUID()}${dry ? "&validateOnly=true" : ""}`;
  const created = await callGbp(`${label}${dry ? " (validateOnly)" : ""}`, "POST", url, body);
  if (dry) {
    logDiagnostic("  validateOnly passed -- nothing was created.");
    state.dryRunPayload = body;
    goTo("dry-run-done");
    return;
  }
  state.listing = { account: account.name, location: created };
  logDiagnostic(`  created ${created.name} in ${account.name}`);
  await goVerify();
}

// 5b -- claim = create the search result's location in the user's account
async function claimListing() {
  const result = state.searchResults[state.searchIndex];
  const { name: _ignored, ...location } = result.location ?? {};
  const body = { ...location, websiteUri: onboarding().profileUrl, languageCode: "en" };
  showBusy(isDryRun() ? "Validating the claim with Google…" : "Claiming your listing…");
  retryAction = claimListing;
  try {
    await createInto("locations.create (claim)", body);
  } catch (error) {
    fail(error, "claim");
  }
}

// 5c
async function createListing() {
  showBusy(isDryRun() ? "Validating with Google…" : "Creating your listing…");
  retryAction = createListing;
  try {
    await createInto("locations.create (new)", newLocationBody(state.form));
  } catch (error) {
    fail(error, "create-2");
  }
}

// 6 -- check whether verification is needed at all, then fetch Google's options
async function goVerify() {
  const loc = state.listing.location;
  retryAction = goVerify;
  showBusy("Checking how Google can verify your listing…");
  try {
    state.voice = await callGbp("getVoiceOfMerchantState", "GET", `${VERIFY_API}/${loc.name}/VoiceOfMerchantState`);
    logDiagnostic(`  voice of merchant: ${JSON.stringify(state.voice)}`);
    if (state.voice.hasVoiceOfMerchant) {
      logDiagnostic("  Already verified -- skipping verification.");
      await openManage(state.listing.account, loc.name);
      return;
    }
    if (state.voice.verify?.hasPendingVerification || state.voice.waitForVoiceOfMerchant) {
      logDiagnostic("  A verification is already pending -- going to Manage listing.");
      await openManage(state.listing.account, loc.name);
      return;
    }
    const data = await callGbp("fetchVerificationOptions", "POST", `${VERIFY_API}/${loc.name}:fetchVerificationOptions`, { languageCode: "en" });
    state.verifyOptions = data.options ?? [];
    logDiagnostic(`  options: ${state.verifyOptions.map((o) => o.verificationMethod).join(", ") || "none"}`);
    state.methodIndex = Math.max(0, state.verifyOptions.findIndex((o) => o.verificationMethod !== "VETTED_PARTNER"));
    state.profileStatus = "unverified";
    saveListingRef();
    goTo("verify");
  } catch (error) {
    fail(error, "busy");
  }
}

async function sendVerification() {
  const option = state.verifyOptions[state.methodIndex];
  const loc = state.listing.location;
  const body = { method: option.verificationMethod, languageCode: "en" };
  if (option.verificationMethod === "SMS" || option.verificationMethod === "PHONE_CALL") body.phoneNumber = option.phoneNumber;
  if (option.verificationMethod === "EMAIL") body.emailAddress = `${option.emailData.user}@${option.emailData.domain}`;
  if (option.verificationMethod === "ADDRESS") body.mailerContact = onboarding().doctorName;
  showBusy("Asking Google to send your code…");
  retryAction = sendVerification;
  try {
    const result = await liveWriteOnly(`locations.verify (${option.verificationMethod})`, () =>
      callGbp(`locations.verify (${option.verificationMethod})`, "POST", `${VERIFY_API}/${loc.name}:verify`, body)
    );
    state.sentWasDryRun = result == null;
    state.lastVerification = result?.verification ?? null;
    if (state.lastVerification) {
      state.profileStatus = state.lastVerification.state === "COMPLETED" ? "live" : "pending";
      saveListingRef();
    }
    goTo("sent");
  } catch (error) {
    fail(error, "verify");
  }
}

// 7 -- load everything the Manage screen shows
async function openManage(accountName, locationName) {
  retryAction = () => openManage(accountName, locationName);
  showBusy("Loading your listing…");
  try {
    const location = await callGbp("locations.get", "GET", `${INFO_API}/${locationName}?readMask=${READ_MASK}`);
    state.listing = { account: accountName, location };
    state.voice = await callGbp("getVoiceOfMerchantState", "GET", `${VERIFY_API}/${locationName}/VoiceOfMerchantState`).catch(() => null);
    const verifications = await callGbp("verifications.list", "GET", `${VERIFY_API}/${locationName}/verifications`).catch(() => null);
    state.verifications = (verifications?.verifications ?? []).sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
    const admins = await callGbp("admins.list", "GET", `${ACCOUNTS_API}/${locationName}/admins`).catch(() => null);
    state.admins = admins?.admins ?? [];
    state.googleUpdated = await callGbp("getGoogleUpdated", "GET", `${INFO_API}/${locationName}:getGoogleUpdated?readMask=${READ_MASK}`).catch(() => null);
    state.profileStatus = deriveStatus();
    state.showCodeEntry = false;
    state.reviews = null;
    saveListingRef();
    goTo("manage");
    loadReviews(accountName, locationName);
  } catch (error) {
    fail(error, "busy");
  }
}

// Reviews smoke test -- v4, parent is accounts/{a}/locations/{l}
async function loadReviews(accountName, locationName) {
  try {
    const data = await callGbp("reviews.list (v4)", "GET", `${V4_API}/${accountName}/${locationName}/reviews?pageSize=5`);
    state.reviews = { totalReviewCount: data.totalReviewCount ?? 0, averageRating: data.averageRating, reviews: data.reviews ?? [] };
  } catch (error) {
    state.reviews = { error: error.message };
  }
  if (state.step === "manage") render();
}

async function completeCode(pin) {
  const pending = pendingVerification();
  if (!pin) {
    state.error = "Enter the code Google sent you.";
    render();
    return;
  }
  try {
    const result = await liveWriteOnly("verifications.complete", () =>
      callGbp("verifications.complete", "POST", `${VERIFY_API}/${pending.name}:complete`, { pin })
    );
    if (result) await openManage(state.listing.account, state.listing.location.name);
    else render();
  } catch (error) {
    fail(error, "manage");
  }
}

// Model B, first half: invite a Ninto-owned Google account as MANAGER.
async function inviteManager() {
  const email = managerEmailInput.value.trim();
  const loc = state.listing.location;
  try {
    const result = await liveWriteOnly("admins.create (MANAGER)", () =>
      callGbp("admins.create (MANAGER)", "POST", `${ACCOUNTS_API}/${loc.name}/admins`, { admin: email, role: "MANAGER" })
    );
    if (result) await openManage(state.listing.account, loc.name);
  } catch (error) {
    fail(error, "manage");
  }
}

// 7c -- drop the Ninto manager seat (if any) and revoke the token
async function removeAccess() {
  const manager = managerAdmin();
  state.showRemoveSheet = false;
  if (manager) {
    try {
      await liveWriteOnly(`admins.delete (${manager.name})`, () => callGbp("admins.delete", "DELETE", `${ACCOUNTS_API}/${manager.name}`));
    } catch (error) {
      fail(error, "manage");
      return;
    }
  }
  if (state.accessToken && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(state.accessToken, () => logDiagnostic("Token revoked -- Ninto no longer has access to this Google account."));
  }
  state.accessToken = null;
  state.tokenExpiresAt = null;
  clearSession();
  state.listing = null;
  writeJson(LISTING_STORAGE_KEY, null);
  state.profileStatus = "removed";
  state.homeDismissed = false;
  goTo("profile");
}

// ---------------------------------------------------------------------------
// OAuth (step 4 is Google's own popup)

let tokenClient = null;

function initTokenClientIfNeeded() {
  const clientId = clientIdInput.value.trim();
  if (!clientId) return null;
  if (tokenClient && tokenClient.__clientId === clientId) return tokenClient;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: async (tokenResponse) => {
      state.connecting = false;
      if (tokenResponse.error) {
        logDiagnostic(`OAuth error: ${tokenResponse.error} -- ${tokenResponse.error_description ?? ""}`);
        state.error = `Google sign-in failed: ${tokenResponse.error}`;
        render();
        return;
      }
      if (!window.google.accounts.oauth2.hasGrantedAllScopes(tokenResponse, "https://www.googleapis.com/auth/business.manage")) {
        logDiagnostic("OAuth: business.manage was not granted (the user unticked it on the consent screen).");
        state.error = "Ninto needs permission to manage your Business Profile to continue.";
        render();
        return;
      }
      state.accessToken = tokenResponse.access_token;
      state.tokenExpiresAt = Date.now() + Number(tokenResponse.expires_in ?? 3600) * 1000;
      saveSession();
      await onConnected();
    },
    error_callback: (err) => {
      state.connecting = false;
      logDiagnostic(`OAuth popup: ${err.type}${err.message ? ` -- ${err.message}` : ""}`);
      render();
    }
  });
  tokenClient.__clientId = clientId;
  return tokenClient;
}

function startConnect() {
  if (!window.google?.accounts?.oauth2) {
    logDiagnostic("Google Identity Services hasn't loaded yet -- try again in a moment.");
    return;
  }
  const client = initTokenClientIfNeeded();
  if (!client) {
    document.getElementById("setup").open = true;
    state.error = "Paste the OAuth Web Client ID in the setup panel above first.";
    if (state.step !== "benefits") state.step = "benefits";
    render();
    return;
  }
  state.connecting = true;
  state.error = null;
  render();
  // prompt: "select_account" -- every tester picks which Google account to use.
  client.requestAccessToken({ prompt: "select_account" });
}

async function onConnected(source = "popup") {
  logDiagnostic(source === "restore" ? "Resuming a saved sign-in (no Google popup this time)." : "Access token received.");
  try {
    const userinfo = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${state.accessToken}` }
    }).then((r) => r.json());
    state.email = userinfo?.email ?? "";
    logDiagnostic(`userinfo: signed in as ${state.email || "(unknown)"}`);
  } catch {
    state.email = "";
  }
  if (source === "popup") await afterSignIn();
}

// ---------------------------------------------------------------------------
// Dev tool: the specialty -> category mapping table (plan step 7)

async function buildCategoryMapping() {
  if (!state.accessToken || state.tokenExpiresAt <= Date.now()) {
    logDiagnostic("Sign in first (Continue with Google), then run the mapping.");
    return;
  }
  const button = document.getElementById("build-mapping");
  button.disabled = true;
  const mapping = {};
  logDiagnostic(`Mapping ${NINTO_SPECIALTIES.length} Ninto specialties to Google categories (regionCode IN)…`);
  for (const [i, specialty] of NINTO_SPECIALTIES.entries()) {
    try {
      const results = await categoriesForSpecialty(specialty);
      mapping[specialty] = results.slice(0, 3).map((c) => `${c.name} (${c.displayName})`);
    } catch (error) {
      mapping[specialty] = { error: error.message };
      if (error.quotaZero || error.status === 401) break;
    }
    button.textContent = `Mapping… ${i + 1}/${NINTO_SPECIALTIES.length}`;
    await new Promise((r) => setTimeout(r, 250)); // ~240 QPM, under the 300 QPM project limit
  }
  const unmatched = Object.entries(mapping).filter(([, v]) => Array.isArray(v) && !v.length).map(([k]) => k);
  logDiagnostic(`\nSPECIALTY -> CATEGORY MAPPING (top 3 per specialty)\n${JSON.stringify(mapping, null, 2)}`);
  logDiagnostic(`\n${unmatched.length} specialt${unmatched.length === 1 ? "y" : "ies"} with no match: ${unmatched.join("; ") || "none"}`);
  button.disabled = false;
  button.textContent = "Build specialty → category mapping";
}

// ---------------------------------------------------------------------------
// Boot

function bindSetupPanel() {
  try {
    clientIdInput.value = localStorage.getItem(CLIENT_ID_STORAGE_KEY) || DEFAULT_CLIENT_ID;
  } catch {
    clientIdInput.value = DEFAULT_CLIENT_ID;
  }
  clientIdInput.addEventListener("input", () => {
    try {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientIdInput.value.trim());
    } catch {
      // ignore
    }
  });

  const settings = readJson(SETTINGS_STORAGE_KEY) ?? {};
  dryRunInput.checked = settings.dryRun !== false;
  managerEmailInput.value = settings.managerEmail ?? "";
  const syncMode = () => {
    modePill.textContent = dryRunInput.checked ? "DRY RUN" : "LIVE WRITES";
    modePill.className = `mode-pill ${dryRunInput.checked ? "dry" : "live"}`;
  };
  syncMode();
  const saveSettings = () => writeJson(SETTINGS_STORAGE_KEY, { dryRun: dryRunInput.checked, managerEmail: managerEmailInput.value.trim() });
  dryRunInput.addEventListener("change", () => {
    syncMode();
    saveSettings();
    logDiagnostic(dryRunInput.checked ? "Dry run ON." : "Dry run OFF -- writes now change real listings.");
    render();
  });
  managerEmailInput.addEventListener("input", saveSettings);

  const specialtySelect = document.getElementById("ob-specialty");
  specialtySelect.innerHTML = NINTO_SPECIALTIES.map((s) => `<option>${escapeHtml(s)}</option>`).join("");
  const ob = onboarding();
  document.querySelectorAll("[data-ob]").forEach((el) => {
    el.value = ob[el.getAttribute("data-ob")] ?? "";
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      writeJson(ONBOARDING_STORAGE_KEY, { ...onboarding(), [el.getAttribute("data-ob")]: el.value });
      if (state.step === "home" || state.step === "profile") render();
    });
  });

  document.getElementById("build-mapping").addEventListener("click", buildCategoryMapping);
  document.getElementById("reset").addEventListener("click", () => {
    if (state.accessToken && window.google?.accounts?.oauth2?.revoke) window.google.accounts.oauth2.revoke(state.accessToken, () => {});
    clearSession();
    writeJson(LISTING_STORAGE_KEY, null);
    Object.assign(state, { accessToken: null, tokenExpiresAt: null, email: "", listing: null, candidates: [], accounts: [], profileStatus: "none", homeDismissed: false });
    diagnosticLines.length = 0;
    diagnosticsEl.textContent = "(nothing yet)";
    goTo("home");
  });
}

bindSetupPanel();
state.profileStatus = readJson(LISTING_STORAGE_KEY)?.status ?? "none";
render();

(function restoreSession() {
  const session = loadSession();
  if (!session) return;
  state.accessToken = session.accessToken;
  state.tokenExpiresAt = session.expiresAt;
  onConnected("restore");
})();
