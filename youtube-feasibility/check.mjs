#!/usr/bin/env node
/**
 * NINTO-547 feasibility check -- connect + channel auto-detect + video
 * import preview, run as a one-shot script against Application Default
 * Credentials instead of a browser OAuth popup. See
 * ../audit/youtube-feasibility-plan.md for the one-time
 * `gcloud auth application-default login` setup this depends on.
 *
 * This proves the YouTube Data API mechanics (channel auto-detection, the
 * uploads-playlist walk, the embeddable/public filter, real quota cost) but
 * NOT the actual consumer-facing OAuth popup UX the ticket describes -- ADC
 * authenticates as the developer's own gcloud identity, not through the
 * in-app "tap Connect -> Google's consent screen -> tap Allow" flow a real
 * HP would see.
 */
import { google } from "googleapis";
import fs from "node:fs/promises";

const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

let totalQuotaUnits = 0;

/**
 * @param {string} label
 * @param {number} quotaCost Published cost from
 *   https://developers.google.com/youtube/v3/determine_quota_cost
 * @param {() => Promise<object>} fn
 * @returns {Promise<object>}
 */
async function timeCall(label, quotaCost, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - start);
    totalQuotaUnits += quotaCost;
    console.log(`[${label}] ${ms}ms -- +${quotaCost} quota unit(s), running total ${totalQuotaUnits}`);
    return result;
  } catch (error) {
    const ms = Math.round(performance.now() - start);
    const reason = error?.errors?.[0]?.reason ?? error?.response?.data?.error?.errors?.[0]?.reason ?? "unknown";
    console.error(`[${label}] FAILED after ${ms}ms -- reason="${reason}" message="${error.message}"`);
    throw error;
  }
}

async function main() {
  const auth = new google.auth.GoogleAuth({ scopes: [SCOPE] });
  const authClient = await auth.getClient();
  const youtube = google.youtube({ version: "v3", auth: authClient });

  const channelsResponse = await timeCall("channels.list (mine=true)", 1, () =>
    youtube.channels.list({ part: ["snippet", "contentDetails", "statistics"], mine: true })
  );

  const channel = channelsResponse.data.items?.[0];
  if (!channel) {
    console.log("No YouTube channel exists on this Google account -- distinct from the 0-video fallback below.");
    return;
  }
  console.log(
    `Channel: "${channel.snippet.title}" -- ${channel.statistics.subscriberCount ?? "?"} subscribers, ${channel.statistics.videoCount ?? "?"} videos`
  );

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    console.log("Channel has no uploads playlist -- treating as 0 videos.");
    return;
  }

  const playlistResponse = await timeCall("playlistItems.list (uploads)", 1, () =>
    youtube.playlistItems.list({ part: ["snippet"], playlistId: uploadsPlaylistId, maxResults: 50 })
  );

  const videoIds = (playlistResponse.data.items ?? []).map((item) => item.snippet.resourceId.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    console.log("0 videos in the uploads playlist -- this is the ticket's 0-video fallback case.");
    return;
  }

  const videosResponse = await timeCall("videos.list (status check)", 1, () =>
    youtube.videos.list({ part: ["snippet", "status", "contentDetails"], id: videoIds })
  );

  const videos = videosResponse.data.items ?? [];
  const playable = videos.filter((video) => video.status?.privacyStatus === "public" && video.status?.embeddable);

  console.log(`${videoIds.length} video(s) in uploads playlist, ${playable.length} public+embeddable:`);
  for (const video of playable) {
    console.log(`  - ${video.snippet.title}  (https://www.youtube.com/watch?v=${video.id})`);
  }

  if (playable.length === 0) {
    console.log("All videos were filtered out (private/unlisted/non-embeddable) -- 0-video fallback for what a visitor would actually see.");
    return;
  }

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>YouTube feasibility check results</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem;">
  <h1>${channel.snippet.title}</h1>
  <p>${channel.statistics.subscriberCount ?? "?"} subscribers -- ${channel.statistics.videoCount ?? "?"} videos -- ${playable.length} public+embeddable shown below</p>
  <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem;">
    ${playable
      .map(
        (video) =>
          `<iframe src="https://www.youtube-nocookie.com/embed/${video.id}" title="${video.snippet.title}" style="width:100%; aspect-ratio:16/9; border:0;" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`
      )
      .join("\n    ")}
  </div>
</body>
</html>`;
  await fs.writeFile(new URL("./results.html", import.meta.url), html);
  console.log("\nWrote results.html -- open it directly in a browser to check real playback.");
}

main().catch((error) => {
  console.error("Stopped:", error.message);
  process.exitCode = 1;
});
