/**
 * NINTO-547 -- real, working YouTube-only app (not a mockup): connect via a
 * real browser OAuth popup, read the connected channel's real videos, and
 * upload a real video file straight to that channel. No backend anywhere --
 * the OAuth token model (google.accounts.oauth2.initTokenClient) needs only
 * a public Client ID, and every YouTube Data API call (including the
 * resumable upload) runs directly from this tab with the access token it
 * returns. See ../audit/youtube-feasibility-plan.md.
 */

const CLIENT_ID_STORAGE_KEY = "yt-feasibility-client-id";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload"
].join(" ");

const clientIdInput = document.getElementById("client-id");
const connectButton = document.getElementById("connect-button");
const channelInfoEl = document.getElementById("channel-info");
const fallbackEl = document.getElementById("fallback");
const videoGridEl = document.getElementById("video-grid");
const diagnosticsEl = document.getElementById("diagnostics");

const uploadFieldset = document.getElementById("upload-fields");
const uploadFileInput = document.getElementById("upload-file");
const uploadTitleInput = document.getElementById("upload-title");
const uploadDescriptionInput = document.getElementById("upload-description");
const uploadButton = document.getElementById("upload-button");
const uploadProgressWrap = document.getElementById("upload-progress-wrap");
const uploadProgressFill = document.getElementById("upload-progress-fill");
const uploadProgressPct = document.getElementById("upload-progress-pct");
const uploadResultEl = document.getElementById("upload-result");

let currentAccessToken = null;
let totalQuotaUnits = 0;
const diagnosticLines = [];

function logDiagnostic(line) {
  diagnosticLines.push(line);
  diagnosticsEl.textContent = diagnosticLines.join("\n");
  diagnosticsEl.scrollTop = diagnosticsEl.scrollHeight;
}

/**
 * @param {string} label
 * @param {string} url
 * @param {string} accessToken
 * @param {number} quotaCost Published cost, see
 *   https://developers.google.com/youtube/v3/determine_quota_cost
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
  channelInfoEl.classList.remove("fallback");
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
 * Connect + read: auto-detect the channel, list its uploads, filter to what
 * would actually play for a Ninto visitor, render. Also unlocks the upload
 * form once a channel is confirmed.
 * @param {string} accessToken
 * @returns {Promise<void>}
 */
async function runConnect(accessToken) {
  diagnosticLines.length = 0;
  totalQuotaUnits = 0;
  channelInfoEl.innerHTML = "";
  fallbackEl.hidden = true;
  videoGridEl.innerHTML = "";
  logDiagnostic("Access token received (scopes: youtube.readonly, youtube.upload). Fetching channel...");

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
    channelInfoEl.classList.add("fallback");
    channelInfoEl.textContent = "No YouTube channel exists on this Google account.";
    return;
  }
  renderChannel(channel);
  currentAccessToken = accessToken;
  uploadFieldset.disabled = false;

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
    logDiagnostic("0 videos in the uploads playlist.");
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
  logDiagnostic(`${videoIds.length} video(s) in uploads playlist, ${playable.length} public+embeddable -- rendering those.`);
  renderVideos(playable);
}

/**
 * Real upload: YouTube's resumable upload protocol, called directly from
 * the browser. Step 1 (POST, JSON metadata) opens an upload session and
 * returns its URL in the Location header. Step 2 (PUT, raw file bytes, via
 * XMLHttpRequest so real upload-progress events are available) sends the
 * video. See https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol.
 * @param {File} file
 * @param {string} title
 * @param {string} description
 * @returns {Promise<object>} The created video resource.
 */
async function uploadVideo(file, title, description) {
  const metadata = {
    snippet: { title: title || file.name, description: description || "" },
    status: { privacyStatus: "private" }
  };

  const initStart = performance.now();
  const initResponse = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
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
      uploadProgressFill.style.width = `${pct}%`;
      uploadProgressPct.textContent = `${pct}%`;
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

uploadButton.addEventListener("click", async () => {
  const file = uploadFileInput.files?.[0];
  if (!file) {
    logDiagnostic("Pick a video file first.");
    return;
  }
  if (!currentAccessToken) {
    logDiagnostic("Connect first -- no access token yet.");
    return;
  }

  uploadButton.disabled = true;
  uploadProgressWrap.hidden = false;
  uploadProgressFill.style.width = "0%";
  uploadProgressPct.textContent = "0%";
  uploadResultEl.innerHTML = "";
  logDiagnostic(`Uploading "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

  try {
    const video = await uploadVideo(file, uploadTitleInput.value.trim(), uploadDescriptionInput.value.trim());
    uploadResultEl.innerHTML = `
      <a class="result-link" href="https://studio.youtube.com/video/${video.id}/edit" target="_blank" rel="noopener">
        Uploaded -- open in YouTube Studio (private) &#8599;
      </a>
    `;
  } catch (error) {
    uploadResultEl.innerHTML = `<p class="note" style="color:#C0392B;">Upload failed: ${error.message}</p>`;
  } finally {
    uploadButton.disabled = false;
  }
});

let tokenClient = null;

function initTokenClientIfNeeded() {
  const clientId = clientIdInput.value.trim();
  if (!clientId) return null;
  if (tokenClient && tokenClient.__clientId === clientId) return tokenClient;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (tokenResponse) => {
      if (tokenResponse.error) {
        logDiagnostic(`OAuth error: ${tokenResponse.error} -- ${tokenResponse.error_description ?? ""}`);
        return;
      }
      runConnect(tokenResponse.access_token);
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
