/**
 * NINTO-547 feasibility spike -- connect + channel auto-detect + video
 * import preview, entirely client-side, with each visitor picking their own
 * Google account via a real browser consent popup. No backend: the OAuth
 * token model (google.accounts.oauth2.initTokenClient) needs only a public
 * Client ID, never a client secret, and Google's own docs say explicitly
 * "there is no need to store per-user refresh tokens on your backend
 * server" -- so nothing here is written anywhere but this tab's memory. See
 * ../audit/youtube-feasibility-plan.md.
 *
 * This is the per-account-picker counterpart to check.mjs/server.mjs's ADC
 * flow, which is faster to run repeatedly but locked to one Google identity
 * per gcloud login. Use this page instead whenever a different account
 * needs testing without re-running gcloud auth application-default login.
 */

const CLIENT_ID_STORAGE_KEY = "yt-feasibility-client-id";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const clientIdInput = document.getElementById("client-id");
const connectButton = document.getElementById("connect-button");
const channelInfoEl = document.getElementById("channel-info");
const fallbackEl = document.getElementById("fallback");
const videoGridEl = document.getElementById("video-grid");
const diagnosticsEl = document.getElementById("diagnostics");

let totalQuotaUnits = 0;
const diagnosticLines = [];

function logDiagnostic(line) {
  diagnosticLines.push(line);
  diagnosticsEl.textContent = diagnosticLines.join("\n");
  diagnosticsEl.scrollTop = diagnosticsEl.scrollHeight;
}

/**
 * Every real call this spike makes, with its published quota cost (see
 * https://developers.google.com/youtube/v3/determine_quota_cost) -- logged
 * per-call and summed, so the running total can be checked against the
 * desk-research estimate in the feasibility report.
 * @param {string} label
 * @param {string} url
 * @param {string} accessToken
 * @param {number} quotaCost
 * @returns {Promise<object>}
 */
async function callYouTubeApi(label, url, accessToken, quotaCost) {
  const start = performance.now();
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (networkError) {
    logDiagnostic(`${label}: NETWORK ERROR -- ${networkError.message}`);
    throw networkError;
  }
  const latencyMs = Math.round(performance.now() - start);
  const body = await response.json();

  if (!response.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? "unknown";
    logDiagnostic(`${label}: HTTP ${response.status} in ${latencyMs}ms -- reason="${reason}" message="${body?.error?.message ?? ""}"`);
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`);
    error.reason = reason;
    throw error;
  }

  totalQuotaUnits += quotaCost;
  logDiagnostic(`${label}: HTTP 200 in ${latencyMs}ms -- +${quotaCost} quota unit(s), running total ${totalQuotaUnits}`);
  return body;
}

function renderChannel(channel) {
  const thumb = channel.snippet.thumbnails?.default?.url ?? "";
  channelInfoEl.innerHTML = `
    <img src="${thumb}" alt="" />
    <div>
      <strong>${channel.snippet.title}</strong><br />
      ${channel.statistics.subscriberCount ?? "?"} subscribers -- ${channel.statistics.videoCount ?? "?"} videos
    </div>
  `;
}

function renderVideos(videos) {
  if (videos.length === 0) {
    fallbackEl.hidden = false;
    videoGridEl.innerHTML = "";
    return;
  }
  fallbackEl.hidden = true;
  videoGridEl.innerHTML = videos
    .map(
      (video) => `
        <iframe
          src="https://www.youtube-nocookie.com/embed/${video.id}"
          title="${video.snippet.title}"
          allow="encrypted-media; picture-in-picture"
          allowfullscreen
        ></iframe>
      `
    )
    .join("");
}

/**
 * The whole preview flow: auto-detect the channel, list its uploads, filter
 * to what would actually play for a Ninto visitor, render. Runs entirely
 * after the OAuth popup -- this project's own server (if it had one) never
 * sees any of it.
 * @param {string} accessToken
 * @returns {Promise<void>}
 */
async function runPreview(accessToken) {
  diagnosticLines.length = 0;
  totalQuotaUnits = 0;
  channelInfoEl.innerHTML = "";
  fallbackEl.hidden = true;
  videoGridEl.innerHTML = "";
  logDiagnostic("Access token received. Starting preview...");

  let channelData;
  try {
    channelData = await callYouTubeApi(
      "channels.list (mine=true)",
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&mine=true",
      accessToken,
      1
    );
  } catch (error) {
    logDiagnostic(`Stopped: could not read the channel (${error.reason ?? error.message}).`);
    return;
  }

  const channel = channelData.items?.[0];
  if (!channel) {
    logDiagnostic("No YouTube channel exists on this Google account -- this is the 'no channel' case, distinct from the 0-video fallback.");
    return;
  }
  renderChannel(channel);

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    logDiagnostic("Channel has no uploads playlist at all -- treating as 0 videos.");
    renderVideos([]);
    return;
  }

  let playlistData;
  try {
    playlistData = await callYouTubeApi(
      "playlistItems.list (uploads)",
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50`,
      accessToken,
      1
    );
  } catch (error) {
    logDiagnostic(`Stopped: could not list uploads (${error.reason ?? error.message}).`);
    return;
  }

  const videoIds = (playlistData.items ?? []).map((item) => item.snippet.resourceId.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    logDiagnostic("0 videos in the uploads playlist -- rendering the 0-video fallback.");
    renderVideos([]);
    return;
  }

  let videosData;
  try {
    videosData = await callYouTubeApi(
      "videos.list (status check)",
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails&id=${videoIds.join(",")}`,
      accessToken,
      1
    );
  } catch (error) {
    logDiagnostic(`Stopped: could not check video status (${error.reason ?? error.message}).`);
    return;
  }

  const playable = (videosData.items ?? []).filter(
    (video) => video.status?.privacyStatus === "public" && video.status?.embeddable
  );
  logDiagnostic(
    `${videoIds.length} video(s) in uploads playlist, ${playable.length} public+embeddable -- rendering those.`
  );
  renderVideos(playable);

  if (playable.length === 0) {
    logDiagnostic("All videos were filtered out (private/unlisted/non-embeddable) -- rendering the 0-video fallback for what a visitor would actually see.");
    fallbackEl.hidden = false;
    fallbackEl.textContent = "This channel's videos exist but none are public and embeddable.";
  }
}

let tokenClient = null;

function initTokenClientIfNeeded() {
  const clientId = clientIdInput.value.trim();
  if (!clientId) return null;
  if (tokenClient && tokenClient.__clientId === clientId) return tokenClient;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (tokenResponse) => {
      if (tokenResponse.error) {
        logDiagnostic(`OAuth error: ${tokenResponse.error} -- ${tokenResponse.error_description ?? ""}`);
        return;
      }
      runPreview(tokenResponse.access_token);
    }
  });
  tokenClient.__clientId = clientId;
  return tokenClient;
}

clientIdInput.addEventListener("input", () => {
  localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientIdInput.value.trim());
});

connectButton.addEventListener("click", () => {
  const client = initTokenClientIfNeeded();
  if (!client) {
    logDiagnostic("Paste your OAuth Web Client ID above first.");
    return;
  }
  // prompt: "select_account" -- lets each visitor pick which Google account
  // to connect with, rather than silently reusing whichever account is
  // already signed in to this browser profile.
  client.requestAccessToken({ prompt: "select_account" });
});

(function restoreClientId() {
  try {
    const saved = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (saved) clientIdInput.value = saved;
  } catch {
    // localStorage unavailable (private mode) -- the input just starts empty.
  }
})();

(function waitForGis(attempt = 0) {
  if (window.google?.accounts?.oauth2) {
    connectButton.disabled = false;
    logDiagnostic("Google Identity Services loaded. Ready to connect.");
    return;
  }
  if (attempt > 100) {
    logDiagnostic("Google Identity Services script never loaded -- check your network/adblock.");
    return;
  }
  setTimeout(() => waitForGis(attempt + 1), 100);
})();
