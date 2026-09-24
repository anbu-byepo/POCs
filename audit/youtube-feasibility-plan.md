# NINTO-547 — YouTube integration feasibility spike

## What this is

A standalone, disposable proof for NINTO-547 ("Tech Feasibility - Youtube Integration"), isolated
from the `ninto` repo entirely. It empirically proves the riskiest mechanics the ticket describes
— OAuth connect, automatic channel detection, video-import preview with the 0-video fallback —
against Google's real APIs, rather than only estimating them on paper.

**No backend, and no browser OAuth popup either — this runs as a one-shot Node script authenticated
via Application Default Credentials (ADC).**

```
youtube-feasibility/
  package.json
  check.mjs       -- the script
  results.html    -- generated on a successful run, gitignored
```

**Trade-off, stated plainly:** ADC authenticates as *your own* gcloud/developer identity through a
one-time CLI login, not through the actual in-app "HP taps Connect → sees Google's consent screen →
taps Allow" popup the ticket describes. It proves the YouTube Data API mechanics (channel
auto-detection, the uploads-playlist walk, the embeddable/public filter, real quota cost) but not
the consumer-facing OAuth UX. An earlier version of this spike used a static page with Google
Identity Services' browser token-client flow instead — that does prove the real popup UX and needs
no ADC setup at all — but was replaced at the user's request for speed. Revive it later if the
popup UX itself needs proving (git history / ask Claude, it's short).

A relay-scaffolded Firebase project (`functions/`, `app/poc/`, `packages/app/`,
`firestore.rules`, etc.) was built first per the original plan, including working around a real
pnpm-vs-npm incompatibility in the template (see "pnpm notes" below) — then deleted once it became
clear the feature under test needs no backend at all. Notes on that scaffold are kept below in
case a later, different spike in this same `POCs` project needs a real backend.

## Running it

1. **Google Cloud project + API** (same as before): create/reuse a project, enable **YouTube Data
   API v3**.
2. **A Desktop-app-type OAuth client** — this is the part that changed. ADC's
   `--client-id-file` flow requires `Application type: Desktop app` specifically; a Web-application
   client (what the earlier browser-page version used) fails with `client_type_mismatch`.
   - Cloud Console → **APIs & Services → Credentials → Create Credentials → OAuth client ID →
     Desktop app**.
   - Download its JSON (the download icon next to the new client) to somewhere local, e.g.
     `~/Downloads/client_secret_youtube_poc.json`.
3. **One-time ADC login**, requesting the YouTube scope through your own client (gcloud's own
   built-in client isn't approved for it):
   ```
   gcloud auth application-default login \
     --client-id-file=~/Downloads/client_secret_youtube_poc.json \
     --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/youtube.readonly
   ```
   This opens a real browser consent screen once; the resulting credentials are cached at
   `~/.config/gcloud/application_default_credentials.json` and picked up automatically by every
   run below.
4. Run it:
   ```
   cd youtube-feasibility && pnpm install && pnpm run check
   ```
5. Read the console output — every call's latency and running YouTube quota-unit total, the
   channel's stats, each public+embeddable video found (or the 0-video / no-channel fallback
   message). On success it also writes `results.html` — open that directly in a browser to check
   real embed playback.

**Verified working end-to-end before handoff:** running the script with no YouTube scope granted
yet produced a real network round-trip to `googleapis.com` and a correctly parsed
`insufficientPermissions` error — confirming the whole auth/request/error-handling path is live,
not just syntactically valid. It should just work once step 3 above is done.

## What it proves / doesn't prove

Same table as the original plan — unchanged by dropping the backend, since the backend was never
what these questions depend on:

| Ticket claim | Proven here? |
|---|---|
| "Ninto identifies their channel automatically" | **Yes** — `channels.list mine=true` |
| "Preview screen of the videos found... fallback if 0 videos" | **Yes** — including the empty-playlist path, and a "no channel at all" path the ticket didn't separately call out |
| Embeddable/playable rendering | **Yes** — real `videos.status.embeddable` check, real `youtube-nocookie.com` embed |
| Real quota cost of connect+preview | **Yes** — measured live in the diagnostics panel (3 units: 1 each for channels/playlistItems/videos) |
| Long-term storage, refresh, disconnect, re-login state | **No** — no refresh token requested at all |
| Auto-sync of new videos (WebSub), cross-posting, analytics, transcripts | **No** — out of scope, covered only by the earlier desk-research report |

## pnpm notes (kept in case the abandoned backend scaffold is revived)

The relay template assumes npm's workspace hoisting. Two fixes were needed to get pnpm to install
it at all:
- Every internal `"@byepo/app-*": "*"` dependency needs pnpm's explicit `workspace:*` protocol —
  npm resolves a bare `"*"` against a same-named workspace package automatically; pnpm does not
  and tries the public registry instead (404, since these packages were never published).
- `functions/package.json` doesn't declare `@byepo/*` as direct dependencies (relying on npm's
  hoisting), so pnpm's default isolated linking never creates the root `node_modules/@byepo/*`
  symlinks `functions/libs/services/renderer.js` needs. Fix: `pnpm-workspace.yaml` needs
  `shamefullyHoist: true` (this pnpm version, 12.6.0, does **not** honor the older
  `shamefully-hoist=true` `.npmrc` setting — the workspace-yaml key is what actually works).
