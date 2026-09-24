#!/usr/bin/env node
/**
 * NINTO-547 feasibility check -- htmx front end, Application Default
 * Credentials on the server. No browser OAuth popup, no Web-application
 * client to register/maintain. Trade-off, same as check.mjs: the account is
 * fixed to whichever identity `gcloud auth application-default login`
 * authenticated as -- there is no per-visitor account picker here. See
 * ../audit/youtube-feasibility-plan.md.
 */
import express from "express";
import { google } from "googleapis";

const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const PORT = process.env.PORT || 8000;

const app = express();

/** @param {unknown} value @returns {string} */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

app.get("/", (request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>YouTube integration feasibility spike (htmx + ADC)</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.25rem; }
    button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
    #diagnostics { background: #f5f5f5; border: 1px solid #ddd; padding: 0.75rem; font-family: ui-monospace, monospace; font-size: 0.8rem; white-space: pre-wrap; margin-top: 1rem; }
    #channel-info { display: flex; gap: 0.75rem; align-items: center; margin-top: 0.75rem; }
    #channel-info img { border-radius: 50%; width: 48px; height: 48px; }
    .video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .video-grid iframe { width: 100%; aspect-ratio: 16 / 9; border: 0; }
    .fallback { color: #666; font-style: italic; }
    .htmx-indicator { display: none; margin-left: 0.5rem; color: #666; }
    .htmx-request .htmx-indicator { display: inline; }
  </style>
</head>
<body>
  <h1>YouTube integration feasibility spike (htmx + ADC)</h1>
  <p>Server-rendered, authenticated with Application Default Credentials -- fixed to whichever Google
    account you last ran <code>gcloud auth application-default login</code> as. No browser OAuth popup,
    no Web-application client. For per-visitor account picking instead, a browser-popup version existed
    earlier in this project's history -- ask if you want it rebuilt (needs a fresh Web-application client,
    since the old one was deleted).</p>
  <button hx-get="/check" hx-target="#result" hx-swap="innerHTML" hx-indicator="#spinner">
    Check channel
  </button>
  <span id="spinner" class="htmx-indicator">Checking...</span>
  <div id="result"></div>
</body>
</html>`);
});

app.get("/check", async (request, response) => {
  const diagnostics = [];
  let totalQuotaUnits = 0;

  /**
   * @param {string} label
   * @param {number} quotaCost
   * @param {() => Promise<object>} fn
   */
  async function timeCall(label, quotaCost, fn) {
    const start = performance.now();
    try {
      const result = await fn();
      const ms = Math.round(performance.now() - start);
      totalQuotaUnits += quotaCost;
      diagnostics.push(`[${label}] ${ms}ms -- +${quotaCost} quota unit(s), running total ${totalQuotaUnits}`);
      return result;
    } catch (error) {
      const ms = Math.round(performance.now() - start);
      const reason = error?.errors?.[0]?.reason ?? error?.response?.data?.error?.errors?.[0]?.reason ?? "unknown";
      diagnostics.push(`[${label}] FAILED after ${ms}ms -- reason="${reason}" message="${error.message}"`);
      throw error;
    }
  }

  try {
    const auth = new google.auth.GoogleAuth({ scopes: [SCOPE] });
    const authClient = await auth.getClient();
    const youtube = google.youtube({ version: "v3", auth: authClient });

    const channelsResponse = await timeCall("channels.list (mine=true)", 1, () =>
      youtube.channels.list({ part: ["snippet", "contentDetails", "statistics"], mine: true })
    );

    const channel = channelsResponse.data.items?.[0];
    if (!channel) {
      return response.type("html").send(renderFragment({ diagnostics, channel: null }));
    }

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      return response.type("html").send(renderFragment({ diagnostics, channel, videos: [] }));
    }

    const playlistResponse = await timeCall("playlistItems.list (uploads)", 1, () =>
      youtube.playlistItems.list({ part: ["snippet"], playlistId: uploadsPlaylistId, maxResults: 50 })
    );
    const videoIds = (playlistResponse.data.items ?? []).map((item) => item.snippet.resourceId.videoId).filter(Boolean);

    if (videoIds.length === 0) {
      return response.type("html").send(renderFragment({ diagnostics, channel, videos: [] }));
    }

    const videosResponse = await timeCall("videos.list (status check)", 1, () =>
      youtube.videos.list({ part: ["snippet", "status", "contentDetails"], id: videoIds })
    );

    const playable = (videosResponse.data.items ?? []).filter(
      (video) => video.status?.privacyStatus === "public" && video.status?.embeddable
    );

    return response.type("html").send(renderFragment({ diagnostics, channel, videos: playable }));
  } catch (error) {
    diagnostics.push(`Stopped: ${error.message}`);
    return response.type("html").send(renderFragment({ diagnostics, failed: true }));
  }
});

/**
 * @param {{diagnostics: string[], channel?: object|null, videos?: object[], failed?: boolean}} args
 * @returns {string}
 */
function renderFragment({ diagnostics, channel, videos, failed }) {
  const diagnosticsHtml = `<div id="diagnostics">${diagnostics.map(escapeHtml).join("\n")}</div>`;

  if (failed) {
    return `${diagnosticsHtml}<p class="fallback">Stopped -- see diagnostics above.</p>`;
  }
  if (channel === null) {
    return `${diagnosticsHtml}<p class="fallback">No YouTube channel exists on this Google account.</p>`;
  }

  const channelHtml = `
    <div id="channel-info">
      <img src="${escapeHtml(channel.snippet.thumbnails?.default?.url ?? "")}" alt="" />
      <div>
        <strong>${escapeHtml(channel.snippet.title)}</strong><br />
        ${escapeHtml(channel.statistics.subscriberCount ?? "?")} subscribers --
        ${escapeHtml(channel.statistics.videoCount ?? "?")} videos
      </div>
    </div>`;

  if (!videos || videos.length === 0) {
    return `${diagnosticsHtml}${channelHtml}<p class="fallback">No public, embeddable videos found on this channel.</p>`;
  }

  const gridHtml = `<div class="video-grid">${videos
    .map(
      (video) =>
        `<iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(video.id)}" title="${escapeHtml(video.snippet.title)}" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`
    )
    .join("")}</div>`;

  return `${diagnosticsHtml}${channelHtml}${gridHtml}`;
}

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
