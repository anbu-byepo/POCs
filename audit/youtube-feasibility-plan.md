# NINTO-547 — YouTube integration feasibility spike

## What this is

A standalone, disposable proof for NINTO-547 ("Tech Feasibility - Youtube Integration"), isolated
from the `ninto` repo entirely. It empirically proves the riskiest mechanics the ticket describes
— OAuth connect (with a real per-visitor account picker), automatic channel detection, and
video-import preview with the 0-video fallback — against Google's real APIs, rather than only
estimating them on paper.

**No backend at all.** The whole app is a static page (`index.html` + `app.js`) authenticated with
Google Identity Services' browser token-client flow (`google.accounts.oauth2.initTokenClient`) —
a real "tap Connect → Google's consent screen, pick any account → tap Allow" popup, exactly the
in-app UX the ticket describes. Every YouTube Data API call runs directly from the browser tab
with the access token that popup returns.

```
youtube-feasibility/
  package.json
  index.html      -- the app's screens (matches the connect/manage/measure design doc)
  app.js          -- OAuth, API calls, all screen logic
  server.mjs      -- static file server, local dev only (Netlify serves the same files directly)
```

**Trade-off, stated plainly:** this only proves the mechanics for whichever Google account a
tester picks in the popup — there's no server-side refresh-token storage, so a returning visitor
without a cached (still-valid) access token in their own browser sees the popup again rather than
silently staying signed in.

An earlier version of this spike instead used a one-shot Node script (`check.mjs`) authenticated
via Application Default Credentials (ADC) — the developer's own `gcloud` identity, no browser
popup, no Web-application OAuth client to register. It proved the same YouTube Data API mechanics
but not the actual consumer-facing OAuth UX, and was removed once the browser-popup version above
replaced it as the sole approach (git history has it, if a script-only proof is ever needed again).

A relay-scaffolded Firebase project (`functions/`, `app/poc/`, `packages/app/`,
`firestore.rules`, etc.) was built first per the original plan, including working around a real
pnpm-vs-npm incompatibility in the template (see "pnpm notes" below) — then deleted once it became
clear the feature under test needs no backend at all. Notes on that scaffold are kept below in
case a later, different spike in this same `POCs` project needs a real backend.

## Running it

1. **Google Cloud project + API**: create/reuse a project, enable **YouTube Data API v3**.
2. **A Web-application-type OAuth client**:
   - Cloud Console → **APIs & Services → Credentials → Create Credentials → OAuth client ID →
     Web application**.
   - Add `http://localhost:8000` (and/or `http://127.0.0.1:8000`, or the deployed origin if not
     running locally) under **Authorized JavaScript origins**.
   - Its OAuth consent screen must list `.../auth/youtube.readonly`, `.../auth/youtube.upload` and
     `.../auth/userinfo.email` as scopes (Testing status is fine as long as your account is added
     as a test user).
3. Run it:
   ```
   cd youtube-feasibility && pnpm install && pnpm run serve
   ```
   Open `http://localhost:8000`, paste the OAuth Client ID into the setup panel (saved to that
   browser's localStorage), and tap **Continue with Google**.
4. Watch the diagnostics panel — every call's latency and running YouTube quota-unit total, the
   channel's stats, each public+embeddable video found (or the 0-video / no-channel fallback
   message).

## What it proves / doesn't prove

| Ticket claim | Proven here? |
|---|---|
| "Ninto identifies their channel automatically" | **Yes** — `channels.list mine=true` |
| "Preview screen of the videos found... fallback if 0 videos" | **Yes** — including the empty-playlist path, and a "no channel at all" path the ticket didn't separately call out |
| Embeddable/playable rendering | **Yes** — real `videos.status.embeddable` check, real `youtube-nocookie.com` embed |
| Real quota cost of connect+preview | **Yes** — measured live in the diagnostics panel |
| Manage: per-video hide, disconnect (keep or remove), reconnect a different account | **Yes** — client-only state (no real Ninto backend to persist against), stated as such in the UI |
| Ongoing sync: new videos, videos that become unavailable | **Partial** — a manual "Check for updates" re-fetches and diffs against a stored snapshot, proving the mechanic against live data; an unattended daily job needs a stored refresh token and a real server, neither of which exist here |
| Measure: reach, engagement, top content | **Partial** — real view/like/comment totals and a live-sortable ranked list; cross-platform traffic, conversions and revenue are Ninto-side metrics with no YouTube API equivalent, so they're not shown rather than faked |
| Long-term server-side token storage/refresh | **No** — the access token is cached in the visitor's own browser localStorage until its ~1hr expiry; no refresh token requested |
| Cross-posting, transcripts | **No** — out of scope, covered only by the earlier desk-research report |

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
