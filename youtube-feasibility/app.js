/**
 * NINTO-547 -- real, working YouTube-only app (not a mockup): connect via a
 * real browser OAuth popup (account picker included), read the connected
 * channel's real videos, and upload a real video file straight to that
 * channel. No backend anywhere -- the OAuth token model
 * (google.accounts.oauth2.initTokenClient) needs only a public Client ID,
 * and every YouTube Data API call runs directly from this tab with the
 * access token it returns.
 *
 * Screens are ported to match, screen for screen, the connect/read set in
 * ../audit/design/Ninto Connect Publish Measure.dc.html (ids 1c-1h): intro
 * -> Google's own consent popup -> channel found -> review videos -> import
 * -> done. See ../audit/youtube-feasibility-plan.md.
 *
 * The access token itself is kept in localStorage (see "Session persistence"
 * below) so a returning visitor resumes without the popup, until the token's
 * own ~1hr expiry forces a real reconnect.
 */

const CLIENT_ID_STORAGE_KEY = "yt-feasibility-client-id";
const SESSION_STORAGE_KEY = "yt-feasibility-session";
// This project's own OAuth Web Client ID -- not a secret (unlike a client
// secret, a Client ID is meant to be public; it's visible in every request
// this app makes anyway). Its Authorized JavaScript origins must list every
// origin this app is actually reachable from. Override it in the setup
// panel for local testing with a different client.
const DEFAULT_CLIENT_ID = "356302635116-hi082afmbhpg92ahaau3dj9fq385n41e.apps.googleusercontent.com";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/userinfo.email"
].join(" ");
const VIDEOS_PREVIEW_COUNT = 5;

const clientIdInput = document.getElementById("client-id");
const frameEl = document.getElementById("frame");
const diagnosticsEl = document.getElementById("diagnostics");

let totalQuotaUnits = 0;
const diagnosticLines = [];

function logDiagnostic(line) {
  diagnosticLines.push(line);
  diagnosticsEl.textContent = diagnosticLines.join("\n");
  diagnosticsEl.scrollTop = diagnosticsEl.scrollHeight;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatCount(n) {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** @param {string} iso ISO 8601 duration, e.g. "PT3M24S" @returns {string} */
function formatDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return "";
  const h = Number(m[1] ?? 0), min = Number(m[2] ?? 0), s = Number(m[3] ?? 0);
  const mm = h > 0 ? String(min).padStart(2, "0") : String(min);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * @param {string} label
 * @param {string} url
 * @param {number} quotaCost Published cost, see
 *   https://developers.google.com/youtube/v3/determine_quota_cost
 * @returns {Promise<object>}
 */
async function callYouTubeApi(label, url, quotaCost) {
  const start = performance.now();
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${state.accessToken}` } });
  } catch (networkError) {
    logDiagnostic(`${label}: NETWORK ERROR -- ${networkError.message}`);
    throw networkError;
  }
  const latencyMs = Math.round(performance.now() - start);
  const body = await response.json();

  if (!response.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? "unknown";
    logDiagnostic(`${label}: HTTP ${response.status} in ${latencyMs}ms -- reason="${reason}" message="${body?.error?.message ?? ""}"`);
    if (response.status === 401) clearSession(); // token's dead -- don't let a reload keep trying to resume with it
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`);
    error.reason = reason;
    throw error;
  }

  totalQuotaUnits += quotaCost;
  logDiagnostic(`${label}: HTTP 200 in ${latencyMs}ms -- +${quotaCost} quota unit(s), running total ${totalQuotaUnits}`);
  return body;
}

// ---------------------------------------------------------------------------
// State

const state = {
  step: "intro", // intro | channel-found | review | no-videos | no-channel | importing | done | manage | disconnected-kept
  accessToken: null,
  email: null,
  channel: null,
  videos: [], // playable videos, full resource objects
  showAllVideos: false,
  importProgress: 0,
  emptyKept: false,
  connecting: false,
  loadingVideos: false,
  connectedAt: null,
  hiddenVideoIds: new Set(), // client-only -- "hide" has no Ninto backend to persist against
  manageShowAll: false,
  showDisconnectSheet: false,
  disconnectChoice: "keep", // "keep" | "remove"
  syncing: false,
  newVideoIds: new Set(), // ids added since the last sync check
  unavailableVideos: [], // videos that were on the profile, then disappeared: {id, title, wentAwayAt}
  lastSyncResult: null, // {newCount, goneCount, checkedAt} | null
  tokenExpiresAt: null, // ms epoch -- when the current access token stops working
  restoringSession: false, // true while re-using a saved token on page load, before the popup would otherwise show
  analyticsPeriod: "all", // "all" | "90d" | "30d"
  topVideosSort: "views" // "views" | "likes" | "recent"
};

function resetToIntro() {
  state.step = "intro";
  state.accessToken = null;
  state.email = null;
  state.channel = null;
  state.videos = [];
  state.showAllVideos = false;
  state.importProgress = 0;
  state.emptyKept = false;
  state.connecting = false;
  state.loadingVideos = false;
  state.connectedAt = null;
  state.hiddenVideoIds = new Set();
  state.manageShowAll = false;
  state.showDisconnectSheet = false;
  state.disconnectChoice = "keep";
  state.syncing = false;
  state.newVideoIds = new Set();
  state.unavailableVideos = [];
  state.lastSyncResult = null;
  state.tokenExpiresAt = null;
  state.restoringSession = false;
  state.analyticsPeriod = "all";
  state.topVideosSort = "views";
  clearSession();
  diagnosticLines.length = 0;
  totalQuotaUnits = 0;
  diagnosticsEl.textContent = "(nothing yet)";
  render();
}

// ---------------------------------------------------------------------------
// Session persistence -- keep the real Google-issued access token (and its
// real expiry, from the token response's expires_in) across page reloads, so
// a returning visitor resumes straight into the app instead of hitting
// Google's consent popup again every time. This is not a refresh token or a
// new OAuth handshake -- it's the exact same short-lived token GIS already
// handed us, just kept alive in localStorage until it naturally expires
// (~1 hour). Once it expires, a real reconnect (and popup) is unavoidable --
// GIS's silent `prompt: ""` re-auth is unreliable across browsers now that
// third-party cookies are widely blocked, so this deliberately doesn't
// attempt it.

function saveSession() {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: state.accessToken, expiresAt: state.tokenExpiresAt }));
  } catch {
    // localStorage unavailable (private mode / storage full) -- the session just won't survive a reload.
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.accessToken || !session?.expiresAt || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Ongoing sync -- last-known video ids persisted per channel, so a manual
// "Check for updates" can diff against them (real daily sync is out of
// scope for a browser-tab feasibility spike, but the diff mechanic itself
// is real and runs against live API data).

function lastKnownKey(channelId) {
  return `yt-feasibility-lastknown-${channelId}`;
}

function loadLastKnownVideoIds(channelId) {
  try {
    const raw = localStorage.getItem(lastKnownKey(channelId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLastKnownVideoIds(channelId, ids) {
  try {
    localStorage.setItem(lastKnownKey(channelId), JSON.stringify(ids));
  } catch {
    // localStorage unavailable (private mode / storage full) -- next check
    // just treats everything fetched as a fresh baseline again.
  }
}

// ---------------------------------------------------------------------------
// Screen templates -- ported from opt 1c-1h in the design doc

function statusBar() {
  return `<div class="statusbar"><span>9:41</span><span>5G &#9646;</span></div>`;
}

function screenHeader({ back = false, backAction = "back-to-channel", title, step = "" } = {}) {
  return `<div class="screen-header">
    ${back ? `<span class="back" data-action="${backAction}">&#8592;</span>` : ""}
    <span class="title">${escapeHtml(title)}</span>
    ${step ? `<span class="step">${escapeHtml(step)}</span>` : ""}
  </div>`;
}

function renderIntro() {
  const ready = window.google?.accounts?.oauth2;
  const label = state.restoringSession ? "Resuming your sign-in..." : state.connecting ? "Connecting..." : "Continue with Google";
  return `
    ${statusBar()}
    <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--divider)">
      <span style="font:700 15px/1 'DM Sans',system-ui;color:var(--accent-dark)">&#10005;</span>
      <span style="font:700 15px/1 'DM Sans',system-ui">Connect YouTube</span>
    </div>
    <div style="flex:1;padding:20px 18px;display:flex;flex-direction:column">
      <div style="font:700 21px/1.3 'DM Sans',system-ui">Your videos, on your Ninto profile</div>
      <div style="margin-top:18px;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;gap:12px"><div style="width:26px;height:26px;border-radius:8px;background:var(--accent-soft);color:var(--accent-icon);display:flex;align-items:center;justify-content:center;font:700 12px/1 'DM Sans',system-ui;flex:none">&#9654;</div><div><div style="font:700 13.5px/1.3 'DM Sans',system-ui">Everything you've published, in one place</div><div style="font:400 12.5px/1.5 'DM Sans',system-ui;color:var(--muted);margin-top:3px">Your full video history is added to Posts &amp; Activity.</div></div></div>
        <div style="display:flex;gap:12px"><div style="width:26px;height:26px;border-radius:8px;background:var(--accent-soft);color:var(--accent-icon);display:flex;align-items:center;justify-content:center;font:700 12px/1 'DM Sans',system-ui;flex:none">&#8635;</div><div><div style="font:700 13.5px/1.3 'DM Sans',system-ui">New uploads arrive on their own</div><div style="font:400 12.5px/1.5 'DM Sans',system-ui;color:var(--muted);margin-top:3px">Checked once a day. Nothing for you to do again.</div></div></div>
        <div style="display:flex;gap:12px"><div style="width:26px;height:26px;border-radius:8px;background:var(--accent-soft);color:var(--accent-icon);display:flex;align-items:center;justify-content:center;font:700 12px/1 'DM Sans',system-ui;flex:none">&#9825;</div><div><div style="font:700 13.5px/1.3 'DM Sans',system-ui">Care seekers can save and share them</div><div style="font:400 12.5px/1.5 'DM Sans',system-ui;color:var(--muted);margin-top:3px">Videos behave like your other posts on Ninto.</div></div></div>
      </div>
      <div style="margin-top:22px;background:var(--panel);border-radius:14px;padding:16px">
        <div style="font:700 11px/1 'DM Sans',system-ui;letter-spacing:.07em;color:#4C554E;margin-bottom:12px">WHAT HAPPENS NEXT</div>
        <div style="display:flex;flex-direction:column;gap:10px;font:400 12.5px/1.5 'DM Sans',system-ui;color:var(--body-text)">
          <div style="display:flex;gap:10px"><span style="font:700 11px/1.5 'DM Sans',system-ui;color:var(--faintest)">1</span><span>You sign in on Google's own screen and tap Allow.</span></div>
          <div style="display:flex;gap:10px"><span style="font:700 11px/1.5 'DM Sans',system-ui;color:var(--faintest)">2</span><span>We identify your channel from that sign-in.</span></div>
          <div style="display:flex;gap:10px"><span style="font:700 11px/1.5 'DM Sans',system-ui;color:var(--faintest)">3</span><span>You see the videos we found and confirm.</span></div>
          <div style="display:flex;gap:10px"><span style="font:700 11px/1.5 'DM Sans',system-ui;color:var(--faintest)">4</span><span>Only then do they appear on your profile.</span></div>
        </div>
      </div>
      <p style="font:400 11.5px/1.5 'DM Sans',system-ui;color:var(--faint);margin:16px 0 0">Read-only access. Ninto never posts, edits or deletes anything on your YouTube channel, and never sees your Gmail.</p>
      <div style="flex:1"></div>
      <button class="btn-primary" data-action="connect" ${ready && !state.restoringSession ? "" : "disabled"}>${label}</button>
      <div class="link-muted" style="cursor:default">${ready ? "" : "Loading Google Identity Services&hellip;"}</div>
    </div>
  `;
}

function renderChannelFound() {
  const c = state.channel;
  const thumb = c.snippet.thumbnails?.default?.url ?? "";
  const handle = c.snippet.customUrl ? (c.snippet.customUrl.startsWith("@") ? c.snippet.customUrl : `@${c.snippet.customUrl}`) : "";
  return `
    ${statusBar()}
    ${screenHeader({ back: true, backAction: "back-to-intro", title: "Connect YouTube", step: "Step 2 of 3" })}
    <div style="flex:1;padding:24px 18px;display:flex;flex-direction:column">
      <div style="display:inline-flex;align-self:flex-start;align-items:center;gap:6px;font:700 10px/1 'DM Sans',system-ui;letter-spacing:.06em;color:var(--accent-icon);background:var(--accent-soft);padding:6px 9px;border-radius:6px">&#10003; SIGNED IN AS ${escapeHtml((state.email ?? "").toUpperCase())}</div>
      <div style="font:700 21px/1.3 'DM Sans',system-ui;margin-top:16px">We found your channel</div>
      <div style="margin-top:18px;border:1px solid var(--border);border-radius:16px;padding:18px;display:flex;flex-direction:column;align-items:center;text-align:center">
        ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" style="width:72px;height:72px;border-radius:50%;border:1px solid var(--frame-border);object-fit:cover" />` : `<div style="width:72px;height:72px;border-radius:50%;background:#E6EDE7;border:1px solid var(--frame-border)"></div>`}
        <div style="font:700 16.5px/1.3 'DM Sans',system-ui;margin-top:12px">${escapeHtml(c.snippet.title)}</div>
        ${handle ? `<div style="font:400 12.5px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:4px">${escapeHtml(handle)}</div>` : ""}
        <div style="display:flex;gap:18px;margin-top:14px;font:500 12px/1 'DM Sans',system-ui;color:#4C554E"><span>${formatCount(Number(c.statistics.subscriberCount))} subscribers</span><span style="color:var(--frame-border)">|</span><span>${formatCount(Number(c.statistics.videoCount))} videos</span></div>
      </div>
      <div style="margin-top:14px;background:var(--panel);border-radius:12px;padding:13px 14px;font:400 12.5px/1.55 'DM Sans',system-ui;color:var(--muted)">Nothing is published to your profile yet. You'll see the videos and confirm on the next screen.</div>
      <div style="flex:1"></div>
      <button class="btn-primary" data-action="continue-to-review" ${state.loadingVideos ? "disabled" : ""}>${state.loadingVideos ? "Loading videos..." : "Continue"}</button>
      <div class="link-accent" data-action="reconnect">Not your channel? Use a different account</div>
    </div>
  `;
}

function renderVideoRow(video) {
  const thumb = video.snippet.thumbnails?.medium?.url ?? video.snippet.thumbnails?.default?.url ?? "";
  const duration = formatDuration(video.contentDetails?.duration);
  return `
    <div style="display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--divider)">
      <div style="width:104px;height:60px;border-radius:8px;background:#2A322C center/cover no-repeat;background-image:url('${escapeHtml(thumb)}');position:relative;flex:none">
        ${duration ? `<span style="position:absolute;right:5px;bottom:5px;background:rgba(0,0,0,.75);color:#fff;font:600 9.5px/1 'DM Sans',system-ui;padding:3px 4px;border-radius:3px">${duration}</span>` : ""}
      </div>
      <div><div style="font:600 13px/1.35 'DM Sans',system-ui">${escapeHtml(video.snippet.title)}</div><div style="font:400 11.5px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:5px">${formatDate(video.snippet.publishedAt)} &middot; ${formatCount(Number(video.statistics?.viewCount))} views</div></div>
    </div>
  `;
}

function renderReview() {
  const videos = state.videos;
  const handle = state.channel.snippet.customUrl ? (state.channel.snippet.customUrl.startsWith("@") ? state.channel.snippet.customUrl : `@${state.channel.snippet.customUrl}`) : state.channel.snippet.title;
  const dates = videos.map((v) => new Date(v.snippet.publishedAt).getTime());
  const oldest = dates.length ? formatDate(new Date(Math.min(...dates)).toISOString()) : "";
  const newest = dates.length ? formatDate(new Date(Math.max(...dates)).toISOString()) : "";
  const visible = state.showAllVideos ? videos : videos.slice(0, VIDEOS_PREVIEW_COUNT);
  const showAllRow = !state.showAllVideos && videos.length > VIDEOS_PREVIEW_COUNT
    ? `<div data-action="show-all" style="border-top:1px solid var(--divider);padding:12px 0;font:500 12.5px/1 'DM Sans',system-ui;color:var(--accent-dark)">Show all ${videos.length} &rsaquo;</div>`
    : "";
  return `
    ${statusBar()}
    ${screenHeader({ back: true, title: "Review videos", step: "Step 3 of 3" })}
    <div style="flex:1;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:16px 16px 12px">
        <div style="font:700 17px/1.35 'DM Sans',system-ui">${videos.length} video${videos.length === 1 ? "" : "s"} from ${escapeHtml(handle)}</div>
        <div style="font:400 12.5px/1.5 'DM Sans',system-ui;color:#7C857E;margin-top:5px">Oldest ${oldest} &middot; newest ${newest}. You can hide any of them later.</div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:0 16px">
        ${visible.map(renderVideoRow).join("")}
        ${showAllRow}
      </div>
      <div style="padding:14px 16px 18px;border-top:1px solid var(--divider);box-shadow:0 -6px 14px rgba(0,0,0,.03)">
        <button class="btn-primary" data-action="import">Add ${videos.length} video${videos.length === 1 ? "" : "s"} to my profile</button>
        <div class="link-muted" data-action="back-to-channel" style="padding-top:14px">Back</div>
      </div>
    </div>
  `;
}

function renderNoVideos() {
  const isNoChannel = state.step === "no-channel";
  return `
    ${statusBar()}
    ${screenHeader({ back: !isNoChannel, title: "Review videos", step: "Step 3 of 3" })}
    <div style="flex:1;padding:26px 18px;display:flex;flex-direction:column">
      <div style="width:56px;height:56px;border-radius:16px;background:var(--panel);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font:400 20px/1 'DM Sans',system-ui;color:var(--faintest)">&#9654;</div>
      <div style="font:700 21px/1.3 'DM Sans',system-ui;margin-top:18px">${isNoChannel ? "No YouTube channel on this account" : "No public videos on this channel yet"}</div>
      <p style="font:400 13.5px/1.6 'DM Sans',system-ui;color:var(--body-text);margin:10px 0 0">${
        isNoChannel
          ? "This Google account doesn't have a YouTube channel. Sign in with the account that owns the channel you want to connect."
          : "This channel is connected, but there's nothing to pull in right now. Private and unlisted videos are never shown on Ninto."
      }</p>
      ${
        isNoChannel
          ? ""
          : `<div style="margin-top:20px;background:var(--panel-green);border:1px solid var(--panel-green-border);border-radius:14px;padding:16px">
              <div style="font:700 13px/1.3 'DM Sans',system-ui">We'll keep watching</div>
              <div style="font:400 12.5px/1.55 'DM Sans',system-ui;color:var(--muted);margin-top:6px">Anything you publish from now on appears on your profile within a day. You'll get an inbox note the first time it happens.</div>
            </div>`
      }
      <div style="flex:1"></div>
      ${isNoChannel ? "" : `<button class="btn-primary" data-action="keep-connection">Keep the connection</button>`}
      <button class="${isNoChannel ? "btn-primary" : "btn-secondary"}" data-action="reconnect" style="margin-top:${isNoChannel ? "0" : "10px"}">Try a different ${isNoChannel ? "account" : "channel"}</button>
    </div>
  `;
}

function renderImporting() {
  return `
    ${statusBar()}
    <div style="flex:1;padding:26px 18px;display:flex;flex-direction:column">
      <div style="border:1px solid var(--border);border-radius:16px;padding:18px">
        <div style="font:700 14px/1.3 'DM Sans',system-ui">Adding your videos&hellip;</div>
        <div style="font:400 12.5px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:5px">${Math.round((state.importProgress / 100) * state.videos.length)} of ${state.videos.length} &middot; you can leave this screen</div>
        <div style="height:6px;border-radius:3px;background:var(--divider);margin-top:14px;overflow:hidden"><div style="width:${state.importProgress}%;height:6px;background:var(--accent);border-radius:3px;transition:width .2s"></div></div>
      </div>
    </div>
  `;
}

function renderDone() {
  const kept = state.emptyKept;
  return `
    ${statusBar()}
    <div style="flex:1;padding:26px 18px;display:flex;flex-direction:column">
      <div style="border:1px solid var(--panel-green-border);border-radius:16px;background:var(--panel-green);padding:20px;text-align:center">
        <div style="width:46px;height:46px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font:700 20px/1 'DM Sans',system-ui;margin:0 auto">&#10003;</div>
        <div style="font:700 18px/1.3 'DM Sans',system-ui;margin-top:14px">${kept ? "Connection kept" : `${state.videos.length} video${state.videos.length === 1 ? "" : "s"} are on your profile`}</div>
        <p style="font:400 12.5px/1.55 'DM Sans',system-ui;color:var(--muted);margin:8px 0 16px">New uploads will be added automatically, once a day.</p>
        <button class="btn-primary" data-action="view-profile">View my profile</button>
        <div class="link-accent" data-action="open-manage">Manage YouTube</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Manage YouTube -- ported from opt 1k (status + per-video hide), 1n
// (disconnect sheet) and 1m (disconnected, videos kept) in the design doc.

function formatConnectedAt() {
  if (!state.connectedAt) return "";
  const time = state.connectedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `Last synced today, ${time} &middot; checked daily`;
}

function renderManageVideoRow(video) {
  const hidden = state.hiddenVideoIds.has(video.id);
  const isNew = !hidden && state.newVideoIds.has(video.id);
  const thumb = video.snippet.thumbnails?.default?.url ?? "";
  const subtitle = hidden
    ? "Hidden from your profile"
    : `${formatDate(video.snippet.publishedAt)} &middot; ${formatCount(Number(video.statistics?.viewCount))} views`;
  return `
    <div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--divider);${hidden ? "background:#FAFBFA" : ""}">
      <div style="width:78px;height:46px;border-radius:7px;background:#2A322C center/cover no-repeat;background-image:url('${escapeHtml(thumb)}');position:relative;flex:none;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.8);font:400 13px/1 'DM Sans',system-ui;opacity:${hidden ? ".55" : "1"}">
        &#9654;
        ${isNew ? `<span style="position:absolute;left:4px;top:4px;background:var(--accent);color:#fff;font:700 8px/1 'DM Sans',system-ui;letter-spacing:.06em;padding:3px 4px;border-radius:3px">NEW</span>` : ""}
      </div>
      <div style="flex:1;${hidden ? "opacity:.6" : ""}"><div style="font:600 12.5px/1.35 'DM Sans',system-ui">${escapeHtml(video.snippet.title)}</div><div style="font:400 11px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:4px">${subtitle}</div></div>
      <div data-action="toggle-hide" data-id="${escapeHtml(video.id)}" style="width:42px;height:24px;border-radius:12px;background:${hidden ? "var(--frame-border)" : "var(--accent)"};flex:none;display:flex;align-items:center;${hidden ? "" : "justify-content:flex-end;"}padding:0 3px">
        <span style="width:18px;height:18px;border-radius:50%;background:#fff"></span>
      </div>
    </div>
  `;
}

function renderUnavailableVideoRow(entry) {
  return `
    <div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--divider);opacity:.7">
      <div style="width:78px;height:46px;border-radius:7px;background:var(--divider);flex:none;display:flex;align-items:center;justify-content:center;color:var(--faintest);font:400 13px/1 'DM Sans',system-ui">&#9647;</div>
      <div style="flex:1"><div style="font:600 12.5px/1.35 'DM Sans',system-ui;color:var(--muted)">${escapeHtml(entry.title)}</div><div style="font:400 11px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:4px">Came down ${formatDate(entry.wentAwayAt)} &middot; no longer public on YouTube</div></div>
      <span data-action="dismiss-unavailable" data-id="${escapeHtml(entry.id)}" style="font:600 11.5px/1 'DM Sans',system-ui;color:var(--faint)">Dismiss</span>
    </div>
  `;
}

function renderSyncBanner() {
  const r = state.lastSyncResult;
  if (!r || (r.newCount === 0 && r.goneCount === 0)) return "";
  const parts = [];
  if (r.newCount > 0) parts.push(`${r.newCount} new video${r.newCount === 1 ? "" : "s"} synced from YouTube`);
  if (r.goneCount > 0) parts.push(`${r.goneCount} no longer available`);
  return `
    <div style="margin:0 16px 16px;background:var(--panel-green);border:1px solid var(--panel-green-border);border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:10px">
      <span style="font:400 13px/1 'DM Sans',system-ui;color:var(--accent-icon)">&#8635;</span>
      <div style="font:400 12px/1.5 'DM Sans',system-ui;color:var(--accent-icon)">${parts.join(" &middot; ")}.</div>
    </div>
  `;
}

function renderUnavailableSection() {
  if (state.unavailableVideos.length === 0) return "";
  return `
    <div style="padding:15px 16px 8px;font:700 11px/1 'DM Sans',system-ui;letter-spacing:.07em;color:#4C554E">NO LONGER AVAILABLE</div>
    <div style="padding:0 16px">${state.unavailableVideos.map(renderUnavailableVideoRow).join("")}</div>
  `;
}

function renderManage() {
  const c = state.channel;
  const videos = state.videos;
  const visibleCount = videos.length - state.hiddenVideoIds.size;
  const hiddenCount = state.hiddenVideoIds.size;
  const shown = state.manageShowAll ? videos : videos.slice(0, VIDEOS_PREVIEW_COUNT);
  const showAllRow = !state.manageShowAll && videos.length > VIDEOS_PREVIEW_COUNT
    ? `<div data-action="manage-show-all" style="border-top:1px solid var(--divider);padding:12px 0;font:500 12.5px/1 'DM Sans',system-ui;color:var(--accent-dark)">Show all ${videos.length} &rsaquo;</div>`
    : "";
  return `
    ${statusBar()}
    ${screenHeader({ back: true, backAction: "back-to-done", title: "Manage YouTube" })}
    <div style="flex:1;overflow-y:auto;position:relative">
      <div style="margin:16px;border:1px solid var(--panel-green-border);background:var(--panel-green);border-radius:16px;padding:16px">
        <div style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:var(--accent)"></span><span style="font:700 13px/1 'DM Sans',system-ui;color:var(--accent-icon)">Connected</span><span data-action="reconnect" style="margin-left:auto;font:600 11.5px/1 'DM Sans',system-ui;color:var(--accent-dark)">Change account</span></div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:14px">
          ${c?.snippet?.thumbnails?.default?.url ? `<img src="${escapeHtml(c.snippet.thumbnails.default.url)}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:1px solid var(--frame-border)" />` : `<div style="width:40px;height:40px;border-radius:50%;background:#E6EDE7;border:1px solid var(--frame-border)"></div>`}
          <div><div style="font:700 13.5px/1.2 'DM Sans',system-ui">${c?.snippet?.customUrl ? escapeHtml(c.snippet.customUrl.startsWith("@") ? c.snippet.customUrl : `@${c.snippet.customUrl}`) : escapeHtml(c?.snippet?.title ?? "")}</div><div style="font:400 11.5px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:3px">${formatConnectedAt()}</div></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px"><span style="font:600 11px/1 'DM Sans',system-ui;color:var(--accent-icon);background:var(--accent-soft);padding:6px 8px;border-radius:5px">${visibleCount} on profile</span><span style="font:600 11px/1 'DM Sans',system-ui;color:var(--muted);background:var(--divider);padding:6px 8px;border-radius:5px">${hiddenCount} hidden</span></div>
      </div>
      ${renderSyncBanner()}
      <div data-action="open-analytics" style="margin:0 16px 16px;border:1px solid var(--border);border-radius:14px;padding:13px 14px;display:flex;align-items:center;gap:12px">
        <div style="width:34px;height:34px;border-radius:9px;background:var(--panel);display:flex;align-items:center;justify-content:center;font-size:14px">&#128202;</div>
        <div style="flex:1"><div style="font:700 13.5px/1.2 'DM Sans',system-ui">Analytics</div><div style="font:400 11.5px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:2px">Real view/like totals for this channel, and a ranked top-videos list</div></div>
        <span style="font-size:13px;color:var(--faintest)">&#8250;</span>
      </div>
      <div style="padding:0 16px 8px;display:flex;align-items:baseline;justify-content:space-between"><div style="font:700 11px/1 'DM Sans',system-ui;letter-spacing:.07em;color:#4C554E">VIDEOS ON YOUR PROFILE</div><div style="font:500 11.5px/1 'DM Sans',system-ui;color:var(--faint)">Newest first</div></div>
      <div style="padding:0 16px">
        ${shown.map(renderManageVideoRow).join("")}
        ${showAllRow}
      </div>
      <div style="padding:6px 16px 0;font:400 11.5px/1.5 'DM Sans',system-ui;color:var(--faintest)">Hiding a video only affects Ninto. It stays on YouTube.</div>
      <div style="padding:12px 16px 0"><span data-action="check-for-updates" style="font:600 11.5px/1 'DM Sans',system-ui;color:var(--accent-dark)">${state.syncing ? "Checking&hellip;" : "&#8635; Check for updates"}</span></div>
      ${renderUnavailableSection()}
      <div style="padding:16px;margin-top:6px;border-top:1px solid var(--divider)"><span data-action="open-disconnect-sheet" style="font:700 13px/1 'DM Sans',system-ui;color:#C0392B">Disconnect YouTube</span></div>

      <div style="margin:0 16px 16px;border:1px solid var(--border);border-radius:14px;padding:16px">
        <div style="font:700 12px/1.3 'DM Sans',system-ui;margin-bottom:4px">Feasibility spike extra (not part of the design)</div>
        <div style="font:400 11px/1.4 'DM Sans',system-ui;color:var(--faint);margin-bottom:12px">Upload a video to this channel, to prove the write-scope/quota mechanics.</div>
        <fieldset id="upload-fields" style="border:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px">
          <div><label style="display:block;font:600 11px/1 'DM Sans',system-ui;color:var(--muted);margin-bottom:5px">Video file</label>
            <input id="upload-file" type="file" accept="video/*" style="font:inherit;font-size:12px;width:100%;box-sizing:border-box" /></div>
          <div><label style="display:block;font:600 11px/1 'DM Sans',system-ui;color:var(--muted);margin-bottom:5px">Title</label>
            <input id="upload-title" type="text" placeholder="Uploaded from Ninto POC" style="font:inherit;font-size:12.5px;padding:8px 9px;width:100%;box-sizing:border-box;border:1px solid #DDE0DC;border-radius:7px" /></div>
          <div><label style="display:block;font:600 11px/1 'DM Sans',system-ui;color:var(--muted);margin-bottom:5px">Description</label>
            <textarea id="upload-description" rows="2" placeholder="Optional" style="font:inherit;font-size:12.5px;padding:8px 9px;width:100%;box-sizing:border-box;border:1px solid #DDE0DC;border-radius:7px"></textarea></div>
          <div><label style="display:block;font:600 11px/1 'DM Sans',system-ui;color:var(--muted);margin-bottom:5px">Visibility</label>
            <select id="upload-visibility" style="font:inherit;font-size:12.5px;padding:8px 9px;width:100%;box-sizing:border-box;border:1px solid #DDE0DC;border-radius:7px;background:#fff">
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select></div>
          <button class="btn-secondary" id="upload-button" type="button" style="position:relative;overflow:hidden">
            <span id="upload-button-base" hidden style="position:absolute;inset:0;background:var(--ink);z-index:0"></span>
            <span id="upload-button-fill" hidden style="position:absolute;inset:0 100% 0 0;background:var(--accent);transition:right .15s;z-index:1"></span>
            <span id="upload-button-label" style="position:relative;z-index:2">Upload to YouTube</span>
          </button>
          <div id="upload-result"></div>
        </fieldset>
        <p style="font:400 11px/1.5 'DM Sans',system-ui;color:var(--faint);margin-top:8px">Sent as whichever visibility you pick above -- but YouTube silently forces every upload from an unaudited API project to <strong>private</strong> regardless of what's requested, until this project passes Google's audit.</p>
      </div>

      ${state.showDisconnectSheet ? renderDisconnectSheet() : ""}
    </div>
  `;
}

function renderDisconnectSheet() {
  const count = state.videos.length;
  const keepSelected = state.disconnectChoice === "keep";
  return `
    <div style="position:absolute;inset:0;background:rgba(18,26,21,.5)"></div>
    <div style="position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:22px 22px 0 0;padding:22px 20px 24px">
      <div style="width:38px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 18px"></div>
      <div style="font:700 19px/1.35 'DM Sans',system-ui">Disconnect YouTube?</div>
      <p style="font:400 13px/1.6 'DM Sans',system-ui;color:#4C554E;margin:10px 0 0">New uploads will stop appearing on your profile. What should happen to the ${count} video${count === 1 ? "" : "s"} already there?</p>
      <div data-action="select-keep" style="margin-top:18px;border:1.5px solid var(--accent);background:${keepSelected ? "var(--panel-green)" : "#fff"};border-radius:14px;padding:14px;display:flex;gap:12px">
        <span style="width:18px;height:18px;border-radius:50%;border:${keepSelected ? "5px solid var(--accent)" : "1.5px solid #C9CFC9"};background:#fff;flex:none;margin-top:2px"></span>
        <div><div style="font:700 13.5px/1.3 'DM Sans',system-ui">Keep them on my profile</div><div style="font:400 12px/1.5 'DM Sans',system-ui;color:var(--muted);margin-top:4px">Videos, likes and comments stay. Recommended.</div></div>
      </div>
      <div data-action="select-remove" style="margin-top:10px;border:1px solid ${keepSelected ? "var(--border)" : "1.5px solid var(--accent)"};background:${keepSelected ? "#fff" : "var(--panel-green)"};border-radius:14px;padding:14px;display:flex;gap:12px">
        <span style="width:18px;height:18px;border-radius:50%;border:${keepSelected ? "1.5px solid #C9CFC9" : "5px solid var(--accent)"};background:#fff;flex:none;margin-top:2px"></span>
        <div><div style="font:700 13.5px/1.3 'DM Sans',system-ui">Remove them from my profile</div><div style="font:400 12px/1.5 'DM Sans',system-ui;color:var(--muted);margin-top:4px">Takes all ${count} out of Posts &amp; Activity.</div></div>
      </div>
      <button class="btn-primary" data-action="confirm-disconnect" style="margin-top:18px">Continue</button>
      <div class="link-muted" data-action="close-disconnect-sheet" style="padding-top:16px">Cancel</div>
    </div>
  `;
}

function renderKeptVideoRow(video) {
  const thumb = video.snippet.thumbnails?.default?.url ?? "";
  const stat = `${formatCount(Number(video.statistics?.viewCount))} views`;
  return `
    <div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--divider)">
      <div style="width:78px;height:46px;border-radius:7px;background:#2A322C center/cover no-repeat;background-image:url('${escapeHtml(thumb)}');flex:none;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.8);font:400 13px/1 'DM Sans',system-ui">&#9654;</div>
      <div style="flex:1"><div style="font:600 12.5px/1.35 'DM Sans',system-ui">${escapeHtml(video.snippet.title)}</div><div style="font:400 11px/1.4 'DM Sans',system-ui;color:var(--faint);margin-top:4px">Not syncing &middot; ${stat}</div></div>
      <span data-action="hide-kept-video" data-id="${escapeHtml(video.id)}" style="font:600 11.5px/1 'DM Sans',system-ui;color:var(--faint)">Hide</span>
    </div>
  `;
}

function renderDisconnectedKept() {
  const videos = state.videos;
  const shown = state.manageShowAll ? videos : videos.slice(0, VIDEOS_PREVIEW_COUNT);
  const showAllRow = !state.manageShowAll && videos.length > VIDEOS_PREVIEW_COUNT
    ? `<div data-action="manage-show-all" style="border-top:1px solid var(--divider);padding:12px 0;font:500 12.5px/1 'DM Sans',system-ui;color:var(--accent-dark)">Show all ${videos.length} &rsaquo;</div>`
    : "";
  return `
    ${statusBar()}
    ${screenHeader({ back: true, backAction: "back-to-done", title: "Manage YouTube" })}
    <div style="flex:1;overflow-y:auto">
      <div style="margin:16px;border:1px solid var(--border);background:var(--panel);border-radius:16px;padding:16px">
        <div style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:var(--faintest)"></span><span style="font:700 13px/1 'DM Sans',system-ui;color:var(--muted)">Disconnected</span></div>
        <p style="font:400 12.5px/1.55 'DM Sans',system-ui;color:var(--muted);margin:10px 0 0">No channel is linked. You chose to keep the ${videos.length} video${videos.length === 1 ? "" : "s"} already on your profile -- they stay until you remove them.</p>
        <button class="btn-primary" data-action="connect-another-channel" style="margin-top:16px;height:44px">Connect a channel</button>
      </div>
      <div style="padding:0 16px 8px;font:700 11px/1 'DM Sans',system-ui;letter-spacing:.07em;color:#4C554E">VIDEOS KEPT ON YOUR PROFILE</div>
      <div style="padding:0 16px">
        ${shown.map(renderKeptVideoRow).join("")}
        ${showAllRow}
      </div>
      <div style="padding:16px;border-top:1px solid var(--divider);margin-top:6px"><span data-action="remove-all-kept" style="font:700 13px/1 'DM Sans',system-ui;color:#C0392B">Remove all ${videos.length} video${videos.length === 1 ? "" : "s"} from my profile</span></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Measure -- analytics hub. Ported from opt 3a (roll-up) and 3h (top
// performing) in the design doc, which use their own treatment (Figtree,
// deep-green chrome) per the doc's own note that nothing was unified across
// sets. The design's mock data covers cross-platform, Ninto-side metrics
// (saves/replies, conversions, revenue, traffic Ninto sent out) that this
// single-platform, backend-less spike has no way to produce honestly -- so
// only the metrics real YouTube Data API responses actually support are
// shown; everything else is replaced with a plain note about the gap,
// rather than invented numbers.

const PERIOD_TABS = [
  { key: "all", label: "All time" },
  { key: "90d", label: "Last 90 days" },
  { key: "30d", label: "Last 30 days" }
];
const SORT_TABS = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "recent", label: "Recent" }
];

function visibleVideos() {
  return state.videos.filter((v) => !state.hiddenVideoIds.has(v.id));
}

function videosInPeriod(period) {
  const videos = visibleVideos();
  if (period === "all") return videos;
  const days = period === "90d" ? 90 : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return videos.filter((v) => new Date(v.snippet.publishedAt).getTime() >= cutoff);
}

function analyticsRollup(period) {
  const videos = videosInPeriod(period);
  const reach = videos.reduce((sum, v) => sum + Number(v.statistics?.viewCount ?? 0), 0);
  const engagement = videos.reduce(
    (sum, v) => sum + Number(v.statistics?.likeCount ?? 0) + Number(v.statistics?.commentCount ?? 0),
    0
  );
  const avgViews = videos.length ? Math.round(reach / videos.length) : 0;
  return { videos, reach, engagement, avgViews };
}

function analyticsBars(videos) {
  const sorted = [...videos].sort(
    (a, b) => new Date(a.snippet.publishedAt).getTime() - new Date(b.snippet.publishedAt).getTime()
  );
  const recent = sorted.slice(-14);
  const max = Math.max(1, ...recent.map((v) => Number(v.statistics?.viewCount ?? 0)));
  return recent.map(
    (v, i) =>
      `<div title="${escapeHtml(v.snippet.title)}: ${formatCount(Number(v.statistics?.viewCount ?? 0))} views" style="flex:1;border-radius:2px 2px 0 0;height:${Math.max(6, Math.round((Number(v.statistics?.viewCount ?? 0) / max) * 100))}%;background:${i === recent.length - 1 ? "var(--m-accent)" : "var(--m-track)"}"></div>`
  );
}

function renderAnalytics() {
  const period = state.analyticsPeriod;
  const { videos, reach, engagement, avgViews } = analyticsRollup(period);
  const bars = analyticsBars(videos);
  const periodLabel = PERIOD_TABS.find((t) => t.key === period)?.label ?? "All time";

  return `
    <div style="height:100%;display:flex;flex-direction:column;font-family:Figtree,system-ui,sans-serif;color:var(--m-ink)">
      <div style="background:var(--m-chrome);color:#fff;padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px;flex:none">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:10px" data-action="back-to-manage"><span style="font-size:17px;cursor:pointer">&#8592;</span><span style="font-size:17px;font-weight:600">Analytics</span></div>
        </div>
        <div style="display:flex;gap:6px">
          ${PERIOD_TABS.map(
            (tab) =>
              `<button type="button" data-action="set-period" data-id="${tab.key}" style="padding:7px 15px;border-radius:999px;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;${tab.key === period ? "background:#fff;color:var(--m-chrome)" : "background:rgba(255,255,255,.14);color:rgba(255,255,255,.8)"}">${tab.label}</button>`
          ).join("")}
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column">
        <div style="padding:16px 16px 14px;border-bottom:1px solid var(--m-divider)">
          <div style="font-size:10.5px;font-weight:600;letter-spacing:.08em;color:var(--m-muted)">TOTAL VIEWS &middot; ${escapeHtml(periodLabel)}</div>
          <div style="display:flex;align-items:baseline;gap:10px;margin-top:6px"><span style="font-size:38px;font-weight:700;color:var(--m-ink);letter-spacing:-.02em">${formatCount(reach)}</span></div>
          ${
            bars.length > 0
              ? `<div style="display:flex;align-items:flex-end;gap:4px;height:36px;margin-top:12px">${bars.join("")}</div><div style="font-size:10.5px;color:var(--m-faint);margin-top:6px">Real per-video views, oldest to newest (up to last 14) -- not a daily history, which needs the separate YouTube Analytics API scope.</div>`
              : `<div style="font-size:11.5px;color:var(--m-faint);margin-top:12px">No videos published in this period.</div>`
          }
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--m-divider)">
          <div style="padding:16px;border-right:1px solid var(--m-divider)"><div style="font-size:26px;font-weight:700;color:var(--m-ink)">${formatCount(engagement)}</div><div style="font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--m-muted);margin-top:3px">ENGAGEMENT</div><div style="font-size:11.5px;color:var(--m-faint);margin-top:5px">likes + comments</div></div>
          <div style="padding:16px"><div style="font-size:26px;font-weight:700;color:var(--m-accent)">${formatCount(avgViews)}</div><div style="font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--m-muted);margin-top:3px">AVG VIEWS</div><div style="font-size:11.5px;color:var(--m-faint);margin-top:5px">per video, this period</div></div>
        </div>
        <div style="padding:13px 16px;background:var(--m-panel-tint);border-bottom:1px solid var(--m-divider)">
          <div style="font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--m-tag-ink)">NOT SHOWN HERE</div>
          <div style="font-size:11.5px;color:#4B5563;margin-top:4px">Traffic Ninto sends to your posts, conversions (follows + bookings) and revenue attribution are Ninto-side metrics -- there's no YouTube API equivalent, so this feasibility spike doesn't fabricate them.</div>
        </div>
        <div style="height:1px;background:var(--m-divider)"></div>
        <div data-action="open-top-videos" style="padding:11px 16px;display:flex;flex:none;align-items:center;gap:12px;border-bottom:1px solid #F3F4F6;cursor:pointer">
          <div style="width:34px;height:34px;border-radius:9px;background:#ECEDE7;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--m-chrome)">&#9650;</div>
          <div style="flex:1"><div style="font-size:13.5px;font-weight:600;color:var(--m-ink)">Top performing</div><div style="font-size:11.5px;color:var(--m-muted);margin-top:2px">Ranked by views, likes or most recent</div></div>
          <span style="font-size:13px;color:var(--m-faint)">&#8250;</span>
        </div>
      </div>
    </div>
  `;
}

function renderTopVideoRow(video, index, sort) {
  const primary =
    sort === "likes" ? Number(video.statistics?.likeCount ?? 0) : Number(video.statistics?.viewCount ?? 0);
  const primaryLabel = sort === "likes" ? "LIKES" : "VIEWS";
  const secondary =
    sort === "likes"
      ? `${formatCount(Number(video.statistics?.viewCount ?? 0))} views`
      : `${formatCount(Number(video.statistics?.likeCount ?? 0))} likes`;
  return `
    <div style="padding:14px 16px;border-bottom:1px solid #F3F4F6;display:flex;gap:12px;align-items:flex-start">
      <div style="width:22px;font-size:15px;font-weight:700;color:var(--m-track-off);padding-top:2px">${index + 1}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:var(--m-ink);line-height:1.4">${escapeHtml(video.snippet.title)}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:7px">
          <span style="font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:999px;background:#FDECEA;color:#C0392B;white-space:nowrap;flex:none">YouTube</span>
          <span style="font-size:11px;color:var(--m-faint)">${formatDate(video.snippet.publishedAt)}</span>
        </div>
      </div>
      <div style="text-align:right;flex:none">
        <div style="font-size:17px;font-weight:700;color:var(--m-accent)">${formatCount(primary)}</div>
        <div style="font-size:9.5px;font-weight:600;letter-spacing:.05em;color:var(--m-faint)">${primaryLabel}</div>
        <div style="font-size:11px;color:var(--m-faint);margin-top:7px">${secondary}</div>
      </div>
    </div>
  `;
}

function renderTopVideos() {
  const sort = state.topVideosSort;
  const videos = [...visibleVideos()].sort((a, b) => {
    if (sort === "likes") return Number(b.statistics?.likeCount ?? 0) - Number(a.statistics?.likeCount ?? 0);
    if (sort === "recent") return new Date(b.snippet.publishedAt).getTime() - new Date(a.snippet.publishedAt).getTime();
    return Number(b.statistics?.viewCount ?? 0) - Number(a.statistics?.viewCount ?? 0);
  });
  const sortNote =
    sort === "likes"
      ? "Ranked by real like counts."
      : sort === "recent"
        ? "Most recently published first."
        : "Ranked by real view counts.";

  return `
    <div style="height:100%;display:flex;flex-direction:column;font-family:Figtree,system-ui,sans-serif;color:var(--m-ink)">
      <div style="padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--m-divider);flex:none">
        <span data-action="back-to-analytics" style="font-size:17px;color:var(--m-accent);cursor:pointer">&#8592;</span>
        <span style="font-size:16px;font-weight:600;color:var(--m-ink)">Top performing</span>
      </div>
      <div style="padding:12px 16px;border-bottom:1px solid var(--m-divider);flex:none">
        <div style="display:flex;gap:6px;background:#F1F2EE;padding:3px;border-radius:999px">
          ${SORT_TABS.map(
            (tab) =>
              `<button type="button" data-action="set-sort" data-id="${tab.key}" style="flex:1;padding:8px 6px;border-radius:999px;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;${tab.key === sort ? "background:#fff;color:var(--m-chrome);box-shadow:0 1px 2px rgba(0,0,0,.12)" : "background:transparent;color:var(--m-muted)"}">${tab.label}</button>`
          ).join("")}
        </div>
        <div style="font-size:11.5px;color:var(--m-faint);margin-top:9px">${sortNote}</div>
      </div>
      <div style="flex:1;overflow-y:auto">
        ${
          videos.length > 0
            ? videos.map((v, i) => renderTopVideoRow(v, i, sort)).join("")
            : `<div style="padding:24px 16px;font-size:12.5px;color:var(--m-faint)">No videos on your profile yet.</div>`
        }
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Render dispatch + event wiring

function render() {
  const templates = {
    intro: renderIntro,
    "channel-found": renderChannelFound,
    review: renderReview,
    "no-videos": renderNoVideos,
    "no-channel": renderNoVideos,
    importing: renderImporting,
    done: renderDone,
    manage: renderManage,
    "disconnected-kept": renderDisconnectedKept,
    analytics: renderAnalytics,
    "top-videos": renderTopVideos
  };
  frameEl.innerHTML = templates[state.step]();
  wireFrameEvents();
}

function wireFrameEvents() {
  frameEl.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", () => handleAction(el.getAttribute("data-action"), el.getAttribute("data-id")));
  });

  const uploadButton = document.getElementById("upload-button");
  if (uploadButton) uploadButton.addEventListener("click", onUploadClick);
}

async function handleAction(action, id) {
  switch (action) {
    case "connect":
      startConnect();
      break;
    case "reconnect":
      startConnect({ prompt: "select_account" });
      break;
    case "continue-to-review":
      await continueToReview();
      break;
    case "show-all":
      state.showAllVideos = true;
      render();
      break;
    case "import":
      startImport();
      break;
    case "back-to-channel":
      state.step = "channel-found";
      render();
      break;
    case "back-to-intro":
      resetToIntro();
      break;
    case "keep-connection":
      state.emptyKept = true;
      state.step = "done";
      render();
      break;
    case "view-profile":
      if (state.channel) window.open(`https://www.youtube.com/channel/${state.channel.id}`, "_blank", "noopener");
      break;
    case "open-manage":
      state.step = "manage";
      state.manageShowAll = false;
      render();
      break;
    case "back-to-done":
      state.step = "done";
      state.showDisconnectSheet = false;
      render();
      break;
    case "manage-show-all":
      state.manageShowAll = true;
      render();
      break;
    case "toggle-hide":
      if (state.hiddenVideoIds.has(id)) state.hiddenVideoIds.delete(id);
      else state.hiddenVideoIds.add(id);
      render();
      break;
    case "open-disconnect-sheet":
      state.showDisconnectSheet = true;
      state.disconnectChoice = "keep";
      render();
      break;
    case "close-disconnect-sheet":
      state.showDisconnectSheet = false;
      render();
      break;
    case "select-keep":
      state.disconnectChoice = "keep";
      render();
      break;
    case "select-remove":
      state.disconnectChoice = "remove";
      render();
      break;
    case "confirm-disconnect":
      performDisconnect();
      break;
    case "connect-another-channel":
      startConnect();
      break;
    case "hide-kept-video":
      state.videos = state.videos.filter((v) => v.id !== id);
      render();
      break;
    case "remove-all-kept":
      resetToIntro();
      break;
    case "check-for-updates":
      if (!state.syncing) await checkForUpdates();
      break;
    case "dismiss-unavailable":
      state.unavailableVideos = state.unavailableVideos.filter((v) => v.id !== id);
      render();
      break;
    case "open-analytics":
      state.step = "analytics";
      render();
      break;
    case "back-to-manage":
      state.step = "manage";
      render();
      break;
    case "set-period":
      state.analyticsPeriod = id;
      render();
      break;
    case "open-top-videos":
      state.step = "top-videos";
      render();
      break;
    case "back-to-analytics":
      state.step = "analytics";
      render();
      break;
    case "set-sort":
      state.topVideosSort = id;
      render();
      break;
    default:
      break;
  }
}

function performDisconnect() {
  const token = state.accessToken;
  if (token && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(token, () => {});
  }
  clearSession();
  state.showDisconnectSheet = false;

  if (state.disconnectChoice === "remove") {
    resetToIntro();
    return;
  }

  state.accessToken = null;
  state.step = "disconnected-kept";
  render();
}

// ---------------------------------------------------------------------------
// OAuth + API flow

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
        render();
        return;
      }
      state.accessToken = tokenResponse.access_token;
      state.tokenExpiresAt = Date.now() + Number(tokenResponse.expires_in ?? 3600) * 1000;
      saveSession();
      await onConnected();
    }
  });
  tokenClient.__clientId = clientId;
  return tokenClient;
}

function startConnect({ prompt = "select_account" } = {}) {
  const client = initTokenClientIfNeeded();
  if (!client) {
    logDiagnostic("Paste your OAuth Web Client ID in the setup panel above first.");
    return;
  }
  state.connecting = true;
  render();
  // prompt: "select_account" -- lets each visitor pick which Google account
  // to connect with, rather than silently reusing whichever account is
  // already signed in to this browser profile.
  client.requestAccessToken({ prompt });
}

async function onConnected(source = "popup") {
  diagnosticLines.length = 0;
  totalQuotaUnits = 0;
  logDiagnostic(
    source === "restore"
      ? "Resuming a saved sign-in (no Google popup this time). Fetching account + channel..."
      : "Access token received. Fetching account + channel..."
  );

  try {
    const userinfo = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${state.accessToken}` }
    }).then((r) => r.json());
    state.email = userinfo?.email ?? "";
    logDiagnostic(`userinfo: signed in as ${state.email || "(unknown)"}`);
  } catch {
    state.email = "";
  }

  let channelData;
  try {
    channelData = await callYouTubeApi(
      "channels.list (mine=true)",
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&mine=true",
      1
    );
  } catch (error) {
    logDiagnostic(`Stopped: could not read the channel (${error.reason ?? error.message}).`);
    render();
    return;
  }

  const channel = channelData.items?.[0];
  if (!channel) {
    state.step = "no-channel";
    render();
    return;
  }

  state.channel = channel;
  state.connectedAt = new Date();
  state.step = "channel-found";
  render();
}

/**
 * Fetches the channel's current uploads, filtered to what would actually
 * play for a visitor. Shared by the initial connect flow and the manual
 * "Check for updates" resync. Logs each API call's own diagnostics; throws
 * on a failed call so the caller decides how to handle it.
 * @returns {Promise<object[]>}
 */
async function fetchPlayableVideos() {
  const uploadsPlaylistId = state.channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    logDiagnostic("Channel has no uploads playlist at all -- treating as 0 videos.");
    return [];
  }

  const playlistData = await callYouTubeApi(
    "playlistItems.list (uploads)",
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50`,
    1
  );
  const videoIds = (playlistData.items ?? []).map((item) => item.snippet.resourceId.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    logDiagnostic("0 videos in the uploads playlist.");
    return [];
  }

  const videosData = await callYouTubeApi(
    "videos.list (status check)",
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails,statistics&id=${videoIds.join(",")}`,
    1
  );
  const playable = (videosData.items ?? []).filter(
    (video) => video.status?.privacyStatus === "public" && video.status?.embeddable
  );
  logDiagnostic(`${videoIds.length} video(s) in uploads playlist, ${playable.length} public+embeddable.`);
  return playable;
}

async function continueToReview() {
  if (state.videos.length > 0 || state.loadingVideos) {
    state.step = "review";
    render();
    return;
  }

  state.loadingVideos = true;
  render();

  let playable;
  try {
    playable = await fetchPlayableVideos();
  } catch (error) {
    logDiagnostic(`Stopped: could not list videos (${error.reason ?? error.message}).`);
    state.loadingVideos = false;
    render();
    return;
  }

  state.videos = playable;
  saveLastKnownVideoIds(state.channel.id, playable.map((v) => v.id));
  state.loadingVideos = false;
  state.showAllVideos = false;
  state.step = playable.length === 0 ? "no-videos" : "review";
  render();
}

/**
 * Manual stand-in for the daily sync: re-fetches, diffs against the
 * last-known video-id snapshot, and surfaces both new arrivals and videos
 * that disappeared (deleted, made private, or made non-embeddable -- all
 * look the same from here: missing from the fresh fetch).
 */
async function checkForUpdates() {
  state.syncing = true;
  render();

  const previousIds = new Set(loadLastKnownVideoIds(state.channel.id) ?? state.videos.map((v) => v.id));
  const previousById = new Map(state.videos.map((v) => [v.id, v]));

  let fresh;
  try {
    fresh = await fetchPlayableVideos();
  } catch (error) {
    logDiagnostic(`Check for updates failed: ${error.reason ?? error.message}`);
    state.syncing = false;
    render();
    return;
  }

  const freshIds = new Set(fresh.map((v) => v.id));
  const newOnes = fresh.filter((v) => !previousIds.has(v.id));
  const goneIds = [...previousIds].filter((id) => !freshIds.has(id));
  const alreadyTrackedGoneIds = new Set(state.unavailableVideos.map((v) => v.id));
  const newlyGone = goneIds
    .filter((id) => !alreadyTrackedGoneIds.has(id))
    .map((id) => ({ id, title: previousById.get(id)?.snippet?.title ?? "(untitled video)", wentAwayAt: new Date() }));

  state.unavailableVideos = [...state.unavailableVideos, ...newlyGone];
  state.videos = fresh;
  state.newVideoIds = new Set(newOnes.map((v) => v.id));
  state.hiddenVideoIds = new Set([...state.hiddenVideoIds].filter((id) => freshIds.has(id)));
  state.lastSyncResult = { newCount: newOnes.length, goneCount: newlyGone.length, checkedAt: new Date() };
  saveLastKnownVideoIds(state.channel.id, fresh.map((v) => v.id));

  logDiagnostic(`Check for updates: ${newOnes.length} new, ${newlyGone.length} newly unavailable.`);
  state.syncing = false;
  render();
}

function startImport() {
  state.step = "importing";
  state.importProgress = 0;
  render();

  const timer = setInterval(() => {
    state.importProgress = Math.min(100, state.importProgress + 12);
    if (state.importProgress >= 100) {
      clearInterval(timer);
      state.step = "done";
      render();
      return;
    }
    render();
  }, 140);
}

// ---------------------------------------------------------------------------
// Upload (unchanged mechanics, re-wired each time the Manage panel renders)

async function uploadVideo(file, title, description, privacyStatus) {
  const metadata = {
    snippet: { title: title || file.name, description: description || "" },
    status: { privacyStatus: privacyStatus || "private" }
  };

  const initStart = performance.now();
  const initResponse = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.type || "video/*",
        "X-Upload-Content-Length": String(file.size)
      },
      body: JSON.stringify(metadata)
    }
  );
  const initLatency = Math.round(performance.now() - initStart);

  if (!initResponse.ok) {
    const errorBody = await initResponse.json().catch(() => ({}));
    const reason = errorBody?.error?.errors?.[0]?.reason ?? "unknown";
    logDiagnostic(`videos.insert (resumable init): HTTP ${initResponse.status} in ${initLatency}ms -- reason="${reason}" message="${errorBody?.error?.message ?? ""}"`);
    throw new Error(errorBody?.error?.message ?? `HTTP ${initResponse.status}`);
  }

  const uploadUrl = initResponse.headers.get("Location");
  logDiagnostic(`videos.insert (resumable init): HTTP 200 in ${initLatency}ms -- got upload session URL`);
  if (!uploadUrl) throw new Error("No upload session URL returned (Location header missing -- check CORS).");

  // XHR, not fetch, because only XHR exposes upload progress events.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "video/*");

    const start = performance.now();
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.round((event.loaded / event.total) * 100);
      setUploadButtonProgress(pct);
    });

    xhr.addEventListener("load", () => {
      const latency = Math.round(performance.now() - start);
      if (xhr.status >= 200 && xhr.status < 300) {
        const video = JSON.parse(xhr.responseText);
        logDiagnostic(`videos.insert (upload): HTTP ${xhr.status} in ${latency}ms -- video id ${video.id}`);
        resolve(video);
      } else {
        let message = xhr.responseText;
        try {
          message = JSON.parse(xhr.responseText)?.error?.message ?? message;
        } catch {
          // response wasn't JSON -- fall back to the raw text already assigned above.
        }
        logDiagnostic(`videos.insert (upload): HTTP ${xhr.status} in ${latency}ms -- ${message}`);
        reject(new Error(message));
      }
    });

    xhr.addEventListener("error", () => {
      logDiagnostic("videos.insert (upload): NETWORK ERROR during upload.");
      reject(new Error("Network error during upload"));
    });

    xhr.send(file);
  });
}

/**
 * Turns the upload button itself into the progress bar: a dark base plus a
 * green fill growing left-to-right, both readable with the white label text
 * this switches to -- avoids the usual "text over a partial fill" contrast
 * problem a plain overlay would have against the button's normal white
 * background.
 * @param {number} pct
 */
function setUploadButtonProgress(pct) {
  const base = document.getElementById("upload-button-base");
  const fill = document.getElementById("upload-button-fill");
  const label = document.getElementById("upload-button-label");
  if (!base || !fill || !label) return;
  base.hidden = false;
  fill.hidden = false;
  fill.style.right = `${100 - pct}%`;
  label.style.color = "#fff";
  label.textContent = `Uploading... ${pct}%`;
}

function resetUploadButton() {
  const base = document.getElementById("upload-button-base");
  const fill = document.getElementById("upload-button-fill");
  const label = document.getElementById("upload-button-label");
  if (!base || !fill || !label) return;
  base.hidden = true;
  fill.hidden = true;
  fill.style.right = "100%";
  label.style.color = "";
  label.textContent = "Upload to YouTube";
}

async function onUploadClick() {
  const uploadButton = document.getElementById("upload-button");
  const uploadFileInput = document.getElementById("upload-file");
  const uploadTitleInput = document.getElementById("upload-title");
  const uploadDescriptionInput = document.getElementById("upload-description");
  const uploadVisibilityInput = document.getElementById("upload-visibility");
  const uploadResultEl = document.getElementById("upload-result");

  const file = uploadFileInput?.files?.[0];
  if (!file) {
    logDiagnostic("Pick a video file first.");
    return;
  }
  if (!state.accessToken) {
    logDiagnostic("Connect first -- no access token yet.");
    return;
  }

  const requestedVisibility = uploadVisibilityInput.value;
  uploadButton.disabled = true;
  uploadResultEl.innerHTML = "";
  setUploadButtonProgress(0);
  logDiagnostic(`Uploading "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB), requested visibility: ${requestedVisibility}...`);

  try {
    const video = await uploadVideo(file, uploadTitleInput.value.trim(), uploadDescriptionInput.value.trim(), requestedVisibility);
    const actual = video.status?.privacyStatus ?? "private";
    const note = actual === requestedVisibility ? "" : ` (requested ${requestedVisibility}, YouTube forced it to ${actual})`;
    uploadResultEl.innerHTML = `
      <a href="https://studio.youtube.com/video/${video.id}/edit" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;font-size:12px;color:var(--accent-dark);font-weight:600">
        Uploaded as ${escapeHtml(actual)}${escapeHtml(note)} -- open in YouTube Studio &#8599;
      </a>
    `;
  } catch (error) {
    uploadResultEl.innerHTML = `<p style="font-size:11.5px;color:#C0392B;margin-top:8px">Upload failed: ${escapeHtml(error.message)}</p>`;
  } finally {
    uploadButton.disabled = false;
    resetUploadButton();
  }
}

// ---------------------------------------------------------------------------
// Boot

(function restoreClientId() {
  try {
    const saved = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    clientIdInput.value = saved || DEFAULT_CLIENT_ID;
  } catch {
    // localStorage unavailable (private mode) -- fall back to the default directly.
    clientIdInput.value = DEFAULT_CLIENT_ID;
  }
})();

clientIdInput.addEventListener("input", () => {
  try {
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientIdInput.value.trim());
  } catch {
    // ignore
  }
});

render();

(function restoreSession() {
  const session = loadSession();
  if (!session) return;
  state.accessToken = session.accessToken;
  state.tokenExpiresAt = session.expiresAt;
  state.restoringSession = true;
  render();
  onConnected("restore").finally(() => {
    state.restoringSession = false;
    render();
  });
})();

(function waitForGis(attempt = 0) {
  if (window.google?.accounts?.oauth2) {
    if (state.step === "intro") render();
    return;
  }
  if (attempt > 100) {
    logDiagnostic("Google Identity Services script never loaded -- check your network/adblock.");
    return;
  }
  setTimeout(() => waitForGis(attempt + 1), 100);
})();
