# NINTO-547 -- YouTube Data API v3: per-user monthly costing & free-quota mechanics

## Bottom line

**Monetary cost: $0/user/month, at any realistic Ninto scale.** The YouTube Data API v3 has no
paid tier -- Google does not sell quota. The only real constraint is a *quota-unit* budget, not a
dollar budget, and Google significantly loosened that budget mid-2026 (details below). The only
place actual dollars appear is Ninto's own Firebase/GCP infra running the daily sync job, which at
plausible user counts rounds to a fraction of a cent per user per month (estimated at the bottom).

## How YouTube Data API v3 quota actually works (confirmed against Google's current docs, 2026-09-25)

Unlike most Google Cloud APIs, YouTube Data API v3 is **not billed per call**. Every Google Cloud
project that enables the API gets a **free daily quota**, reset at **midnight Pacific Time**, with
no monetary option to buy more of it. There used to be one shared pool; as of a policy change that
took effect **June 1, 2026**, it's split into three independent buckets:

| Bucket | Default daily allocation | Covers |
|---|---|---|
| General/shared bucket | **10,000 units/day** | `channels.list`, `playlistItems.list`, `videos.list`, and everything else not called out below |
| `videos.insert` (uploads) | **100 calls/day**, 1 unit each, own bucket | Uploading a video |
| `search.list` | **100 calls/day**, 1 unit each, own bucket | Keyword/channel search (not used by this POC -- see below) |

**This is a big, recent change and matters a lot for costing an upload feature:**

| Period | Cost of one `videos.insert` (upload) |
|---|---|
| Before Dec 4, 2025 | ~1,600 units -- a single upload ate 16% of the *entire* old 10,000-unit shared pool |
| Dec 4, 2025 -- May 31, 2026 | ~100 units |
| **June 1, 2026 -- today** | **1 unit, in its own separate 100-calls/day bucket** -- no longer competes with reads at all |

Practical effect: the default free tier now supports **100 uploads/day project-wide**, up from an
effective ceiling of ~6/day under the old pricing (10,000 ÷ 1,600). Uploads and reads no longer
compete for the same budget.

Requesting a quota increase beyond the defaults is also free -- there's no fee -- but it goes
through a Google compliance/API-audit review (can take time, not guaranteed). Until an app is
audited, YouTube also restricts every video it uploads to **Private** visibility regardless of what
the app requests -- already reflected as a note in this POC's upload panel (`app.js`). Note also
that `youtube.readonly` / `youtube.upload` are "sensitive" scopes requiring only Google's standard
OAuth verification (free) -- not "restricted" scopes, which would additionally require a paid
third-party security assessment (CASA, commonly $15k-$75k+). Nothing in this ticket touches a
restricted scope, so that cost class doesn't apply here.

## Per-call costs actually exercised by this POC

Measured live by `check.mjs` / `app.js` (see `youtube-feasibility-plan.md`) and cross-checked
against Google's quota-cost table:

| Call | Unit cost | Bucket | Used for |
|---|---|---|---|
| `channels.list` (mine=true) | 1 | General | Auto-detect the connected channel |
| `playlistItems.list` | 1 | General | Walk the uploads playlist |
| `videos.list` | 1 | General | Check embeddable/public status, get stats |
| `videos.insert` | 1 (own bucket) | Uploads | Publish a video from Ninto |

`search.list` (100/day bucket, 1 unit each as of June 2026) is deliberately **not used** -- the POC
walks the channel's uploads playlist instead, which is both cheaper and doesn't need the separate
search bucket at all.

**Detecting videos that disappeared costs nothing extra.** The "Manage YouTube" screen's "Check for
updates" link now diffs a fresh `fetchPlayableVideos()` call (the same `playlistItems.list` +
`videos.list` pair above) against the last-known set of video ids (persisted per-channel in
`localStorage`). A video that dropped out of the fresh result -- deleted, made private, or made
non-embeddable, indistinguishable from outside -- is inferred from the diff, not from any separate
API call. So "new video arrived" and "video went away" detection ride on the exact same 2-unit
fetch; there's no per-feature quota surcharge for adding the removal-detection UI.

## Login persistence: what it does and doesn't change about cost

The app now keeps the OAuth access token in `localStorage` (`saveSession()` / `loadSession()` /
`clearSession()` in `app.js`), tagged with its own real expiry from the token response's
`expires_in` (Google issues these for ~1 hour). A returning visitor resumes straight in --
`restoreSession()` runs on page load, and if a saved token hasn't expired yet it re-uses it and
calls the same `onConnected()` flow instead of showing Google's consent popup. On expiry (~hourly)
or on any `401` from a YouTube API call, the saved session is dropped and a real reconnect (a new
popup) is required -- this deliberately doesn't attempt GIS's silent `prompt: ""` re-auth, which is
unreliable now that third-party cookies are widely blocked by browsers.

**This costs the same 3 general-bucket units as any other connect, once per hour at most per
active user** -- `restoreSession()` re-runs `onConnected()`, which re-fetches
`channels.list` (1 unit). It does **not** re-fetch videos (`playlistItems.list` +
`videos.list`) on resume; that only happens if the user proceeds to Review or clicks "Check for
updates," same as today. So persistence trades "one popup per visit" for "up to one silent
`channels.list` call per hour of continued use" -- at 1 unit/hour, even a user with the tab open all
day (24 resumes) costs 24 units, still trivial against the 10,000/day general bucket, and far
cheaper than it sounds because most sessions won't span 24 token-expiry cycles in a day.

**No monetary cost, and no new quota bucket** -- this is the same `channels.list` call already
counted in the "connect" line item above, just triggered by a page load instead of a click. It
doesn't touch the OAuth *token* endpoint's own request budget either (Google doesn't quota-limit
token issuance/reuse the way it quotas Data API calls).

## Per-user-per-month quota estimate

Two flows, matching what's built vs. what's designed but not yet running:

**1. Connect + preview (measured, real):** `channels.list` + `playlistItems.list` + `videos.list`
= **3 units**, one-time per connect (or reconnect).

**2. Daily "checked once a day" auto-sync:** the diff/check mechanic itself is now real and proven
live -- the Manage screen's "Check for updates" link runs the same `playlistItems.list` +
`videos.list` pair (2 units), diffs the result against the last-known video-id snapshot, and
correctly surfaces both new arrivals (green "NEW" badge) and vanished videos ("no longer
available"). What's *not* real yet is the "once a day, nothing for you to do" part of the UI copy
in `index.html` -- there's no backend in this POC, so today it only runs when a user clicks the
link by hand. Production still needs something (a cron or a push trigger) to fire that same
2-unit call automatically; costed as a once-daily poll per connected user, that's 2 units/day ->
**60 units/month/user** -- see "Reducing cost further" below for why a push trigger beats a blind
daily poll on both quota and infra cost, and why this manual link's own behavior is the useful
proof point for that argument.

| Scenario | Units/month/user | Bucket |
|---|---|---|
| Connect once, no re-sync, no upload | 3 | General |
| Connect once + daily auto-sync, no upload | ~63 (3 + 60) | General |
| Above + 1 video uploaded that month | ~63 general + 1 upload call | General + Uploads |
| Above + 4 uploads/month (weekly) | ~63 general + 4 upload calls | General + Uploads |

Uploads no longer meaningfully move the "cost" number now that they're 1 unit in their own bucket
-- the dominant line item is the daily sync poll, and even that is small.

## How many users the default free quota supports

**General bucket (10,000 units/day, project-wide, not per-user):**
- Daily auto-sync at 2 units/user/day -> **~5,000 actively-syncing users/day** before the general
  bucket is exhausted, with the remainder still free for that day's new connects (3 units each).
- At Ninto's likely near-term scale (tens to low hundreds of connected creators), this bucket is
  not a real constraint.

**Uploads bucket (100 calls/day, project-wide, independent of the above):**
- Flat ceiling of **100 uploads/day across every Ninto user combined**, resetting at midnight
  Pacific. A user base where uploads are spread through the day/week (e.g. hundreds of users
  uploading a few times a month each) stays comfortably under this. It would only bind if usage
  clusters heavily on one calendar day (e.g. a marketing push where everyone uploads at once) --
  worth a monitoring alert on `videos.insert` 403 `quotaExceeded` responses if that pattern is
  expected.
- If this becomes the binding constraint later, the fix is Google's free quota-extension request,
  not a paid tier.

## The only place real dollars show up: Ninto's own infra, not the YouTube API

Running the daily sync as an actual scheduled job (Cloud Scheduler + Cloud Function per the relay
stack, per `youtube-feasibility-plan.md`) costs normal Firebase/GCP money, independent of YouTube
quota:

| Line item | Free tier | Cost beyond free tier |
|---|---|---|
| Cloud Functions (2nd gen) invocations | 2M/month | ~$0.40/million |
| Cloud Scheduler jobs | 3 jobs/month | ~$0.10/job/month |
| Firestore reads/writes (caching video metadata per sync) | 50K reads + 20K writes/day | ~$0.036/100K reads, ~$0.108/100K writes |

At 2 API calls + a handful of Firestore ops per user per day, this stays inside Firebase's free
tier until Ninto reaches roughly the thousands-of-connected-users range -- i.e. effectively
**$0.00/user/month** at any scale this ticket is realistically sized for today. This is the number
to revisit if/when connected-user count is large enough to matter; it will still be single-digit
cents per user per month, not dollars.

## Reducing cost further, without losing any feature

Given uploads are already essentially free (1 unit, separate 100/day bucket) and the connect flow
is already minimal (3 calls, 1 unit each -- no cheaper way to get channel + uploads-playlist +
video status in fewer round trips), **the one line item worth optimizing is the daily auto-sync
poll** (~60 units/user/month, `playlistItems.list` + `videos.list` once a day per connected user).
The POC now proves the *diff mechanic* itself live -- the "Check for updates" link in Manage
YouTube (`app.js` `checkForUpdates()`) re-fetches via the shared `fetchPlayableVideos()` helper and
correctly detects both new and vanished videos against a persisted last-known snapshot. What it
deliberately doesn't build is *what triggers that fetch in production* -- right now a human has to
click it, which proves the mechanic but isn't the "arrives on its own" feature. That's still an
open design choice, and it's the one worth optimizing before committing to a naive daily cron.

**Switch the daily poll to a push model (WebSub/PubSubHubbub) instead of polling every user every
day.** YouTube offers a free PubSubHubbub feed per channel that pings a callback URL the moment a
new video is actually published:

- Most connected creators don't publish daily, so a guaranteed once-a-day poll spends 2 units on
  *every* user *every* day regardless of whether anything changed. A push model only spends
  anything (still ~2 units, to fetch the new video's details once notified) on the days a user
  actually uploads -- for a creator posting a few times a month, this cuts sync-related quota by
  90%+ compared to daily polling, with zero feature loss.
- It also strengthens the feature rather than trading it away: "new uploads arrive on their own"
  becomes near-real-time instead of "checked once a day" (the UI copy at `app.js:201` and
  `app.js:337` could legitimately be updated to something faster).
- Same win on the real dollar cost: a Cloud Function invoked only on actual push events costs far
  less, in invocation count, than one invoked once daily for every connected user regardless of
  activity.
- This was already flagged as explicitly out of scope for this spike (see the "What it proves /
  doesn't prove" table in `youtube-feasibility-plan.md`) -- worth reviving as the production design
  rather than building the naive daily-poll cron job first.

**Two smaller, complementary optimizations, both compatible with either polling or push:**
- **Move the last-known-snapshot cache from `localStorage` to Firestore.** The POC already caches
  the exact right thing -- `saveLastKnownVideoIds()` / `loadLastKnownVideoIds()` persist each
  channel's last-known video ids so `checkForUpdates()` has something to diff against, and
  `continueToReview()` also skips re-fetching within a session if `state.videos` is already
  populated. Both are currently client-only (`localStorage`, in-memory `state`), which works for a
  single browser tab but not across devices or a real backend. Carrying the same cache-then-diff
  pattern server-side (Firestore) is what makes a real "Check for updates" -- run by a cron/push
  trigger instead of a click -- avoid re-spending quota on a schedule when nothing changed.
- **Trim response payloads with `fields=`** on `videos.list` (e.g.
  `fields=items(id,snippet(title,thumbnails,publishedAt),statistics(viewCount),contentDetails(duration))`).
  This doesn't reduce quota units -- Google prices calls, not payload size -- but it cuts bandwidth
  and response-parsing time, which is where a small amount of genuine infra cost and latency
  actually lives.

**Not worth doing:** batching further within the connect flow, or trying to shrink the upload path
-- both are already at or near the API's floor cost, and the June 2026 bucket split already removed
uploads as a cost concern entirely.

## Sources

- [YouTube Data API v3: Determine Quota Cost](https://developers.google.com/youtube/v3/determine_quota_cost)
- [YouTube Data API v3: Revision History](https://developers.google.com/youtube/v3/revision_history) -- Dec 4, 2025 entry (videos.insert cut ~1600 -> ~100 units) and June 1, 2026 entry (separate per-method quota buckets for `videos.insert` and `search.list`, 100 calls/day each)
- Cross-referenced against third-party trackers reporting the same two dates/changes (Blotato, GetPhyllo, SocialCrawl, ChannelCrawler, OutlierKit YouTube API pricing write-ups, 2026)
- `youtube-feasibility-plan.md` (this directory) -- this POC's measured connect/preview quota cost (3 units) and upload mechanics
