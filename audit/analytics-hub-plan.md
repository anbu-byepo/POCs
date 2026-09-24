# Analytics Hub UI prototype -- what was built, what's next

## What this is

`Ninto Analytics Hub Design.zip` (dropped in Downloads) is an export of the claude.ai/design
project already linked from NINTO-547's description. It contains **six separate design
documents**, only some of which belong to this ticket:

| File | Screens | In scope for NINTO-547? |
|---|---|---|
| `Ninto Analytics Hub.dc.html` | 8 (1a-1g, 1i) | **Yes** -- ticket capability #11, "Flow of Analytics" |
| `Ninto Connect Publish Measure.dc.html` | 38 (1a-1r, 2a-2m, 3a-3h) | **Yes** -- the connect/import/sync flow (track 1-2, capabilities #1-7) already partly proven by this project's `youtube-feasibility/` spike, plus a **publish/measure track (3) we haven't touched at all** |
| `uploads/.../Ninto Cross-Post Flow.dc.html` | 13 (1a-1n) | **Yes** -- "Compass -- post to external platforms," capabilities #8-9 |
| `Ninto Delegate Access.dc.html` | 18 | **No** -- separate feature (social-media-manager access), not in this ticket |
| `Ninto Discovery.dc.html` | ~15 | **No** -- profile redesign, unrelated |
| `Ninto Paid Following.dc.html` | 25 | **No** -- monetization/paid-tier feature, unrelated |

The three in-scope files alone cover ~59 screens. Only the Analytics Hub (8 screens) has been
prototyped so far -- see below for what's proposed next.

**A note on the design files themselves:** each `.dc.html` is exported from claude.ai/design's own
"DC" canvas format, which depends on a runtime (`support.js`, ~1900 lines, requires `window.React`/
`window.ReactDOM` loaded from elsewhere) that **is not included in this export** and won't render
standalone. Copies are kept at `audit/design/*.dc.html` for reference (read the inline styles/mock
data directly, per screen id) -- they are not meant to be opened in a browser as-is.

## What was built: `analytics-hub/index.html`

**Revised from an initial side-by-side gallery** (all 8 screens shown at once, design-canvas style)
**to a real single-screen app**: one phone frame, one screen visible at a time, real navigation --
tapping a drill-down row on the landing screen (1a) goes to that screen, Back returns, matching how
an HP would actually move through it. A "Jump to" strip above the frame is kept for QA (direct
access to any of the 8 screens without walking the real navigation), but the phone frame itself only
ever shows one screen and only exposes the taps a real user would have.

Same layout/colors/mock-data fidelity as before (deep-green Ninto chrome `#114F3C`/`#159A4B`,
Figtree font) -- no backend, no build step. Interactive parts are real: the 7d/30d/90d period tabs
on **1a** recompute the roll-up numbers and sparkline, the platform filter chips on **1c** re-filter
the post list, and the Conversions/Views/Revenue sort tabs on **1g** re-rank the list. Navigation
wired: 1a's six drill-down rows go to 1c/1b/1e/1e/1f/1g respectively, 1c's post rows go to 1d, 1e's
YouTube platform chip goes to 1i, every screen's back arrow returns correctly.

**Run it** -- served from one shared static server alongside `cross-post-flow/` (not a separate
server per prototype):
```
cd .. && python3 -m http.server 8000
```
Open `http://localhost:8000/analytics-hub/`.

**Verified before handoff:** the embedded script's syntax checked clean, every `getElementById`
call in the JS matches an id that actually exists in the HTML (13/13), and `<div>` open/close tags
balance (287/287) -- a structural sanity check for a hand-written file this size. Not yet checked
in an actual browser (no Chrome extension connected this session) -- open it yourself and confirm
the three interactive controls behave before treating this as fully verified.

## What each screen would need to be real (not mock)

| Screen | Real data source | Status per the earlier feasibility report |
|---|---|---|
| 1a Overall roll-up | Aggregation across every connected platform + Ninto's own post/engagement counters | **Blocked**: YouTube Developer Policy III.E.4.h/III.E.2.a forbids merging YouTube metrics into a combined "reach" number -- the report's §4F already flagged this. Ninto-only rows are real; the YouTube-mixed rows in "WHERE IT CAME FROM" would need separate, clearly-labelled bars per policy, not one blended total. |
| 1b Connected platforms | Per-platform OAuth connection status + last-sync timestamp | **Feasible** -- this is exactly what `youtube-feasibility/`'s connect flow (both the ADC and browser-popup versions) already proves for YouTube; same shape needed for Instagram/LinkedIn/Spotify, each its own OAuth integration (separate epics per the original report). |
| 1c All posts | Ninto's own posts collection + one row per synced video/post from each platform | **Feasible for YouTube** -- `check.mjs`/`server.mjs` already prove listing a channel's videos; needs the actual import-as-post pipeline from Phase 1 of the report (no collection model built yet -- see that report's §3A). |
| 1d Post detail (both tracks + link bridge) | Ninto counters (real) + YouTube `videos.list` stats (proven feasible, ~1 quota unit) + a unique-link click/visit/conversion record (not built anywhere yet) | **Partially feasible** -- the YouTube half is proven; the unique-link half needs the `/l/<code>` redirect + click-log store the original report's §4F sketched but never built. |
| 1e / 1i Link performance | Same unique-link store as 1d, aggregated per platform/per link | **Not built** -- no short-link or click-tracking mechanism exists anywhere in `ninto` today (confirmed by the backend-precedent research during the original report). |
| 1f Revenue | Booking records with a referral/link field, tied to a real payment amount | **Not feasible yet** -- `ninto/functions/libs/features/payment.js` is a hard-coded stub (`amount: "100.0"`), and `nintoAppointments` has no referrer field. Flagged as blocked in the original report's §3F/§4F. |
| 1g Top performing | Same data as 1c/1d/1f, just re-sorted | Inherits whichever of the above are real. |

## Proposed next feature to prototype: Cross-Post Flow

Given the "other feature" you mentioned, the most likely candidate already sitting in this same
design export is **`Ninto Cross-Post Flow.dc.html`** (13 screens, "Compass -- post to external
platforms · steps 1-9 + platform management") -- it's the direct next capability after Analytics in
the ticket (#8-9, "Flow of posting content to external platform"), and the earlier feasibility
report already flagged its hard blocker (unaudited YouTube API projects can only upload videos as
private, capped at 100/day project-wide) as something to design around rather than ignore.

**Not started yet -- confirm before I build it**, since it's another ~13-screen prototype and I'd
rather not guess wrong on scope a second time:
- Cross-Post Flow (13 screens) as described above, or
- The rest of Connect Publish Measure's untouched **track 3** ("publish" -- 8 screens, 3a-3h) from
  the *same* design file already partly covered, or
- Something else entirely.

## Files this session added

```
POCs/
  analytics-hub/index.html          -- the working prototype
  audit/analytics-hub-plan.md       -- this file
  audit/design/Ninto Analytics Hub.dc.html   -- source design, for reference only (won't render standalone)
```
