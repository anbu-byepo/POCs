# Cross-Post Flow UI prototype -- what was built

## Correction to the earlier analytics-hub plan

That doc guessed the "other feature" might be `Connect Publish Measure.dc.html`'s **track 3
("Measure — analytics hub," ids 3a-3h)** -- that guess was wrong once actually inspected: track 3
is a *second*, alternate mockup of the same Analytics Hub already prototyped, not a distinct
feature. The real second track in that file, **"Publish — cross-platform posting" (chapter s2, ids
2a-2m, 13 screens)**, turned out to be near-verbatim identical to the standalone
`Ninto Cross-Post Flow.dc.html` file already flagged as a candidate -- steps 1-9 in both are
word-for-word the same design (composer -> "also post to" -> connect-first -> per-platform
customization -> preview -> publish -> per-platform result -> cross-posted list -> manage one
post), differing only in the last few platform-management screens' naming (`2j/2k/2l/2m` vs.
`1k/1l/1m/1n`).

**One prototype was built to cover both**, based on the standalone Cross-Post Flow file (the more
recent, refined iteration). Building a second, near-duplicate prototype for the Connect Publish
Measure version of the same 9 steps would have added no signal.

## What was built: `cross-post-flow/index.html`

**Revised from an initial side-by-side gallery to a real single-screen app**, same change made to
the Analytics Hub prototype: one phone frame, real navigation following the actual flow (compose ->
also-post-to -> connect-first when you toggle an unconnected platform -> customize per platform ->
preview -> publish (auto-advances after ~1.4s, matching a transient "posting..." screen) -> results
-> cross-posted list -> manage one post; separately, a platform-management branch: manage platforms
hub -> add a platform / manage one platform -> disconnect confirm). A "Jump to" strip (13 screens,
plus two explicit start points -- "Compose" and "Manage platforms") is kept for QA only.

Matches the design's exact colors (`#0C5C3D` header, `#17A34A` accent, `#EFEDE8` background,
system-ui font -- a deliberately different pairing from the Analytics Hub's
`#114F3C`/`#159A4B`/Figtree, since matching each source design was the actual ask). Real
interactivity, now triggered by actually navigating rather than by a gallery of static states:

- **1b** -- the Instagram/LinkedIn toggles flip in place; toggling the not-yet-connected
  Facebook/X switches instead navigates to **1c** (connect-first), matching the design's own note.
- **1e** -- the Ninto/Instagram/LinkedIn/YouTube tabs swap the caption/media/title copy per
  platform (YouTube's extra Title field only appears on that tab).
- **1m** -- the three access/posting-default toggles flip on click.
- **1n** -- the "remove account only" vs. "remove account and posts" choice is a real selectable
  pair; either button then navigates back out (Disconnect -> 1k, Keep connected -> 1m).

**Run it** -- served from one shared static server alongside `analytics-hub/` (not a separate server
per prototype):
```
cd .. && python3 -m http.server 8000
```
Open `http://localhost:8000/cross-post-flow/`.

**Verified before handoff:** embedded script syntax checked clean, `<div>` tags balanced (335/335),
every navigation target (`data-nav`) resolves to one of the 13 real screen ids. A real bug from the
gallery-era first draft (re-rendering all four platform toggles on every single click, which would
have duplicated the other three) was caught and fixed before this rewrite. Not yet opened in an
actual browser (no Chrome extension connected this session).

## What each screen would need to be real

This flow sits squarely on top of the earlier feasibility report's hardest-blocked capability
(#8, cross-posting) -- worth re-reading that section before scoping real work:

| Screen(s) | Real mechanism needed | Status per the original report |
|---|---|---|
| 1a-1c composer + eligibility | Client-side rule: which platforms accept what's been composed (video->YouTube, etc.) | Trivial once cross-posting exists at all -- no new backend, just composer logic. |
| 1e per-platform customization | A per-destination override of caption/media/title, applied at publish time | Feasible, needs a `crossPostTargets[]`-shaped sub-document on the post (shape-bearing -- needs the data-shape gate before building for real). |
| 1f preview | Pure rendering, no new data | Trivial. |
| 1g-1h publish + per-platform result | One upload call per platform, independently, with per-platform retry | **YouTube side is blocked**: unaudited API projects restrict `videos.insert` uploads to private-only, and the default quota caps uploads at 100/day *project-wide* (not per-HP) -- see the original report's §4E/§3, "Cross-posting (capabilities 8, 9)." Instagram needs its own Business-account + Meta app review, capped at 100 posts/24h. |
| 1i-1j manage cross-posted content | A per-(post, platform) delivery record + status | Not built anywhere -- same finding as the Analytics Hub's link-tracking gap; these two features would likely share one new collection. |
| 1k-1n platform management (connect/add/manage/disconnect) | Same OAuth connect/disconnect machinery already proven for YouTube-readonly in `youtube-feasibility/`, but requesting the **upload** scope (`youtube.upload`) instead of `youtube.readonly` -- a materially bigger consent ask | The report's §4E flagged the scope difference explicitly: this is not the same grant as the read-only connect flow already tested. |

## Files this session added

```
POCs/
  cross-post-flow/index.html                    -- the working prototype (13 screens)
  audit/cross-post-flow-plan.md                  -- this file
  audit/design/Ninto Cross-Post Flow.dc.html     -- source design, for reference only
```
