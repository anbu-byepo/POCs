# NINTO-550 — Google Business Profile feasibility spike (plan)

## What this is

A plan for a standalone, disposable feasibility spike for NINTO-550 ("Tech Feasibiility - Google
Business Profile for HWPs"), parent NINTO-548, in the same `Social Media Engagement` module and
`v0.1.0i` cycle (2026-09-25 → 2026-10-01) as the already-spiked NINTO-547 (see
`audit/youtube-feasibility-plan.md` and `youtube-feasibility/`). Same pattern intended: no backend,
a static page authenticated with Google Identity Services' browser token-client flow, run against
Google's real APIs rather than estimated on paper.

Design reference: `audit/design/Ninto GBP Setup Flow.dc.html` (pulled in from the ticket's
Claude Design link, "1A — Google Business Profile — setup & management"). It shows 11 screens in 3
steps, walked through screen-by-screen below.

## What was built: `gbp-feasibility/` (2026-10-06)

Phase 1 below is implemented as a working app, served at `/gbp-feasibility/` on the shared POCs
Netlify site (the repo root's `index.html` is now a hub that links every POC). Every screen calls
the real Business Profile APIs; nothing is mocked in the app.

```
gbp-feasibility/
  package.json
  index.html      -- frame + setup panel (Client ID, dry-run, Ninto manager, onboarding) + dev tools
  app.js          -- OAuth (business.manage), every API call, all screens, diagnostics
  specialties.js  -- Ninto's 259 specialties, copied from the ninto repo's postVocabulary.js
  server.mjs      -- static file server, local dev only
```

What each screen does:

- **1–2:** the home-feed and profile prompts. The profile card reflects the stored listing state:
  not set up, unverified, awaiting Google, live, or removed.
- **3:** the benefits sheet, with "and questions" removed from the copy. **4** is Google's real
  popup with `select_account`. If the tester unticks `business.manage`, the app stops and says so.
- **5a:** `accounts.list` → `locations.list` → `getVoiceOfMerchantState` + `admins.list` for the
  Verified/Unverified and owner badges. The edit screen is prefilled from the onboarding fields in
  the setup panel. Wherever Google's current value differs, the field shows it ("On Google now:
  …"). The category comes from `categories.list` using the HWP's specialty, and can also be
  searched by hand. Submitting calls `locations.patch`, then `getGoogleUpdated`.
- **5b:** `googleLocations.search` using the onboarding name, address and phone, stepping through
  each match. A claimable match leads to claim (`locations.create` with the match's location). A
  match someone else manages gets the new "Request access on Google" state, which opens
  `requestAdminRightsUri`.
- **5c:** step 1 (name, category, address, coordinates in place of the Maps pin, website) → step 2
  (phone, hours) → `locations.create`.
- **6:** `getVoiceOfMerchantState` first. A listing that's already verified, or already pending,
  goes straight to Manage. Otherwise `fetchVerificationOptions` drives a **method picker** (only the
  methods Google offers) → `verify` → "Sent to Google".
- **7:** `locations.get`, a timeline built from `verifications.list` (the expected date is our own
  estimate), PIN entry via `verifications.complete`, any pending Google review from
  `getGoogleUpdated`, a v4 `reviews.list` smoke test, the admin roster, and "Invite Ninto as
  manager" (`admins.create`, role `MANAGER`).
- **7c:** `admins.delete` on the Ninto manager seat, if there is one, then token revoke.

**Dry run is on by default.** `locations.patch` and `locations.create` (claim and new) are sent
with `validateOnly=true`. Writes that have no validate-only form (`verify`, `verifications.complete`,
`admins.create`, `admins.delete`) are skipped and logged. Turn dry run off in the setup panel only
against the test listings in the credentials checklist.

**Dev tools:** "Build specialty → category mapping" runs `categories.list` for all 259 Ninto
specialties at about 240 QPM and logs the mapping table as JSON. This is plan step 7's
deliverable. Diagnostics show latency per call, a rolling per-minute call count against 300 QPM,
and a plain explanation for a 0-QPM project, a disabled API, or a missing scope.

**Checked before handoff:** a headless Chrome run through every screen and both branches (5a →
edit → verify → sent → manage → code entry → remove, and 5b claimable → managed elsewhere → 5c
step 1 → step 2 → dry-run result). Google Identity Services and the Google APIs were stubbed. There
were no page errors, and in dry-run mode no write went out without `validateOnly`. Nothing in this
run touched Google: proving the API behaviour live still needs the approved project and an OAuth
client (see the credentials checklist).

**Known limit found while building:** once a manager invite is accepted, `admins.list` returns the
manager's name rather than their email. The spike matches the Ninto manager by email, so it only
recognises that manager while the invite is pending. The real integration should match on the
`account` field of Ninto's own GBP account instead.

### Running it

1. Fill in the credentials checklist below. You need the Web Client ID, the consent screen with
   `business.manage` and `userinfo.email`, and test users.
2. Local: `cd gbp-feasibility && pnpm install && pnpm run serve`, then open
   `http://localhost:8000`. Or serve the whole repo (`python3 -m http.server 8000` from the root)
   and open `/gbp-feasibility/` to get the hub too.
3. Paste the Client ID in the setup panel (saved to that browser), check the onboarding fields, and
   tap **Set up → Continue with Google**.
4. Deployed: the OAuth client's Authorized JavaScript origins must also list the Netlify site's
   origin, with no path.

## Status: API access granted (2026-09-29)

Google has approved the project for the Business Profile APIs. Before relying on that, open Cloud
Console → APIs & Services → Quotas and check that each GBP API shows **300 QPM** (not 0). With
access granted, every screen below can be proven live this cycle. The limits that are left come
from Google's own timelines (postcard verification takes about 14 days, and edits can sit in
Google review) and from backend work that's out of scope, not from access. The section below is
kept as background on why the gate existed.

## Background: every Business Profile API was gated, not just some of them

**Correction to the earlier draft of this plan.** The earlier draft assumed a "Basic tier" was
open (list/edit owned locations) and only search/claim/create/verify needed elevated access.
Google's current prerequisites page
([developers.google.com/my-business/content/prereqs](https://developers.google.com/my-business/content/prereqs),
checked 2026-09-29) says otherwise:

- **All** Business Profile APIs start at **0 QPM** for a new Cloud project: *"If your quota is 0
  QPM, your project has not yet been approved."* That includes `accounts.list` and
  `locations.list`. Approval raises the quota to 300 QPM for every GBP API at once. There is no
  separate aggregator tier.
- To be allowed to apply, the applicant must *"manage a Google Business Profile that is verified
  and active for 60+ days"* and *"have a website representing the business listed on the GBP"*.
- You apply through the **GBP API contact form**, giving the Cloud project number. Google doesn't
  publish a review time. You check status by looking at the quota in Cloud Console.

What this means:

1. **Nothing that calls a GBP API can be proven live until approval.** "Existing listing" is gated
   just as much as "claim/create".
2. **Eligibility has to be checked first.** Does Byepo/Ninto (or a teammate) already manage a
   verified GBP listing that is 60+ days old and has a website? If yes, file the form **today**
   using this spike's Cloud project number. If no, a 60-day clock has to start (create and verify a
   Byepo listing) before we can even apply. That would push any live GBP proof about two months
   past this cycle.
3. Before approval, this cycle can prove the OAuth consent, the UI flow, the mapping from
   onboarding data to GBP fields, and token revoke. It can also confirm the 0-QPM rejection shows
   up as a clear error in diagnostics. It can't prove any listing reads or writes.

## Screen-by-screen: design vs. what the APIs support

APIs referenced: **Account Management** (`mybusinessaccountmanagement.googleapis.com/v1`),
**Business Information** (`mybusinessbusinessinformation.googleapis.com/v1`), **Verifications**
(`mybusinessverifications.googleapis.com/v1`), **Reviews** (legacy `mybusiness.googleapis.com/v4`,
still active). One OAuth scope covers all of them: `https://www.googleapis.com/auth/business.manage`.

| # | Screen | API mechanics | Supported? | Notes / design changes |
|---|---|---|---|---|
| 1 | Home feed prompt ("Verification complete → Get your practice on Google Maps") | None, Ninto-side trigger after HWP verification | Yes | Pure Ninto UI. |
| 2 | Profile prompt ("Google Business Profile · Not set up") | None, Ninto-side state | Yes | This card's state (Not set up / Awaiting Google / Live) has to come from stored listing state, which is a backend concern in the real product. |
| 3 | Benefits & consent sheet | None | Yes, with copy fixes | **"Reviews **and questions** surface in your Ninto inbox"**: the Q&A API was **discontinued 2025-11-03**. Reviews work (v4 `reviews.list` / `updateReply`). Questions can't be done. Drop "and questions". "Hours, address, phone stay in sync" needs a backend (see "Sync & manager model"). |
| 4 | Google sign-in handoff | GIS token client, `business.manage` scope | Yes | This screen belongs to Google and Ninto can't set its copy. Google shows its own scope description for `business.manage`, not "See and manage… / Read and reply to reviews". Treat the mock as illustrative only. Unverified-app testing mode with test users, same as NINTO-547. |
| 5a | Select your listing (listings already on the account, Verified/Unverified, "You are owner") | `accounts.list` → `accounts.locations.list` (readMask incl. `title,storefrontAddress,metadata`) → `locations.getVoiceOfMerchantState` for verified/unverified | Yes | Owner/manager badge comes from `locations.admins.list` (role). "Verified" vs "Unverified" can be derived from VoiceOfMerchant state / `metadata`. "None of these → create" goes to 5b search first, not straight to 5c. |
| 5a | Add / edit details (prefilled) → "Submit to Google" | `locations.patch` with `updateMask` (`title`, `categories`, `storefrontAddress`, `phoneNumbers`, `regularHours`, `websiteUri`) | Yes | CATEGORY dropdown needs `categories.list` (regionCode `IN`, filter e.g. "endocrinologist") to map Ninto specialties to GBP category IDs. That mapping table is a real deliverable. Google may send edits for review or reject them (`locations.getGoogleUpdated` shows pending changes). The UI should allow for "edit submitted, not yet live". The "Keep in sync" toggle needs a backend. |
| 5b | Unclaimed listing found → "Claim this listing" | `googleLocations.search` (by `location` built from onboarding name + address, or by `query`) → results with `location.metadata.placeId` → **claim = `accounts.locations.create` with that placeId** in the user's account → verify | Yes | There's no separate claim endpoint. If a result is already owned by someone else it comes back with `requestAdminRightsUri`, which sends the user to Google's own UI to request access. The design needs a 4th state for this: "Someone else manages this listing → Request access on Google". Screen 5b "Not my practice" → 5c. The map preview needs Maps JS / Static Maps API (separate key and billing). The spike can show raw lat/lng as the design's placeholder does. |
| 5c | Create a new listing (Step 1 of 2, drag pin) | `accounts.locations.create` (empty placeId, `validateOnly=true` first for a dry run) | Yes | `validateOnly` lets the spike prove create-payload validity **without making a real listing**. That's the safe first test. "Drag the pin" → `latlng` field, needs Maps JS. "Step 2 of 2" isn't in the design yet. Presumably it's hours/phone. |
| 6 | Sent to Google (SMS / email / voice / postcard) | `locations.fetchVerificationOptions` → `locations.verify` (chosen method) | Yes, subject to Google's per-listing options | **Design mismatch:** the copy says "Google picks the method", but the API returns a list of *eligible* options and the merchant **chooses** one. `verify` then triggers the send. Screen 6 should become a picker (only the returned options, e.g. SMS to the listing's phone), then a "Sent" confirmation. Check `getVoiceOfMerchantState` first, because Google may AUTO-verify with no user steps. A listing that's already verified (the 5a Verified path) should skip this and go straight to Manage "Live". Postcard is ~14 days on Google's side, so it can't be proven end-to-end inside one cycle. |
| 7 | Manage listing (timeline, Enter verification code, details, Ninto's access) | Timeline: `locations.verifications.list` (state, method, createTime) + VoiceOfMerchant. Code entry: `verifications.complete` (PIN). Details: `locations.get`. | Yes | The "expect by 11 Apr" date is a client-side estimate from createTime + method. Google doesn't return an ETA. "Live on Search and Maps" = VoiceOfMerchant `hasVoiceOfMerchant` + `metadata.mapsUri` present. |
| 7c | Remove Ninto's access | Token revoke (`google.accounts.oauth2.revoke`) **and**, if Ninto was added as manager, `locations.admins.delete` | Yes | The design's "listing stays, you remain owner" matches the manager model below. The warning about pending verification is correct: once access is removed, the user finishes in Google's UI. |

## Sync & manager model (the design's core promise, not provable without a backend)

The design says **"Ninto becomes a manager on the listing. You stay the owner"** and promises
ongoing sync and a reviews inbox. There are two ways to build that, and the product has to pick
one:

- **(A) Act as the user:** store the HWP's OAuth refresh token server-side and call APIs as them.
  This is simple, but Ninto doesn't actually show up as a "manager". Removing access = revoke the
  token.
- **(B) Real manager seat (matches the design copy):** with the user's token, call
  `locations.admins.create` (role `MANAGER`) inviting a Ninto-owned Google account/organization.
  Ninto accepts via `accounts.invitations.accept` using its own credentials. From then on Ninto
  syncs with **its own** credentials and doesn't need the user's token. Remove access =
  `admins.delete`. Needs a Ninto service identity with a GBP account and its own approved API
  project (can reuse the project that was just approved).

A no-backend spike can demonstrate the *invite* call (B's first half) with the user's token, now that
access is granted. Accepting, background sync, and reviews-to-inbox are backend work for the real
integration and are out of this spike's scope.

## HWP-specific policy check (non-API, still a feasibility risk)

Google's Business Profile guidelines have specific rules for **individual practitioners**
(doctors) vs. **practices**. For example, a solo practitioner may be folded into the practice
listing, and practitioners at a hospital (the mock profile's "Apollo Hospitals · Greams Road")
generally get their own listing rather than the hospital's. The design assumes one practice
listing per HWP ("Nair Endocrine Clinic"). Before build, confirm how the flow handles an HWP who
practises inside a hospital or a multi-doctor clinic. A wrong listing type can get suspended.

## Credentials checklist (what to request from management)

No secret key and no access token is handed over. Like `youtube-feasibility/`, the spike uses
Google Identity Services' browser token-client flow, which needs only a **public OAuth Client ID**.
The access token is minted in the tester's browser by the "Continue with Google" popup. The GBP
APIs take no API key; they are OAuth-only (`business.manage`).

**Required (blocks Phase 1):**

- [ ] **Approved Google Cloud project**, with its project number. Confirm the quotas page shows
      **300 QPM**, not 0, for Account Management, Business Information and Verifications. At 0 QPM
      every listing call fails.
- [ ] **APIs enabled** in that project: Account Management, Business Information, Verifications,
      and My Business v4 (reviews).
- [ ] **OAuth Client ID, type "Web application"**, in the same project. Authorised JavaScript
      origins: `http://localhost:8000` (plus the Netlify origin if deployed). Only the Client ID is
      needed (it is public, pasted into the setup panel). Do **not** request the client secret.
      **Decided 2026-10-06:** reuse the YouTube spike's client
      (`356302635116-hi082afmbhpg92ahaau3dj9fq385n41e`), hardcoded as the default in `app.js`. So
      the approval, the enabled APIs and the `business.manage` scope all have to be on that same
      Cloud project, `356302635116`.
- [ ] **OAuth consent screen**: `https://www.googleapis.com/auth/business.manage` and
      `https://www.googleapis.com/auth/userinfo.email` added as scopes, and every tester's Google
      account added as a test user (Testing status is fine).
- [ ] **Google account that owns a verified test listing**: for 5a select/edit, reviews read, and
      7c remove access. Never a real HWP's live listing.

**Needed for specific steps:**

- [ ] **An unclaimed public listing of a genuine test practice** (5b real claim). Without one, 5b
      runs as `validateOnly` only.
- [ ] **A Ninto-owned Google account** to invite as `MANAGER` (step 11, the first half of model B).

**Optional:**

- [ ] **Maps JavaScript API key**, HTTP-referrer-restricted to the spike's origins, billing on.
      Only for the 5b map preview and 5c pin drag; without it the spike shows raw lat/lng.

## Proposed spike structure

Mirrors `youtube-feasibility/`:
```
gbp-feasibility/
  package.json
  index.html      -- the 11 screens from audit/design/Ninto GBP Setup Flow.dc.html
  app.js          -- OAuth (business.manage), API calls, screen logic, diagnostics panel
  server.mjs      -- static file server, local dev only
```

**Phase 0 (done / confirm):** tick off the "Required" items in the credentials checklist above first.
1. ~~Eligibility + GBP API contact form~~: **approved 2026-09-29.** Check that the quotas page
   shows 300 QPM for Account Management, Business Information and Verifications.
2. In the same approved project, make sure these are enabled: Account Management, Business
   Information, Verifications, and My Business v4 (reviews). Enabling another GBP API later can
   need its own quota request, so enable them all now.
3. Web-application OAuth client: add `http://localhost:8000` as an authorised origin, add
   `business.manage` to the consent screen, and add testers as test users (same setup as
   NINTO-547).
4. Choose the test listings **before** writing code:
   - one verified listing the tester owns (5a edit path, and the first half of 7c);
   - one practice that has an **unclaimed** public listing (5b), if we can find one;
   - no listing needed for 5c, which runs with `validateOnly=true` so nothing real is created.
   **Don't** run edits, claims or verifications against a real HWP's live listing.

**Phase 1 (this cycle, all live, no mock layer):**
5. GIS OAuth with `business.manage`: consent popup and account picker (screen 4), and token
   revoke (7c).
6. 5a: `accounts.list` → `accounts.locations.list` → `getVoiceOfMerchantState` +
   `admins.list` for Verified/Unverified and owner badges → `locations.patch` with the
   onboarding-prefilled fields. Then `getGoogleUpdated` to show whether Google holds the edit for
   review.
7. Specialty → category: `categories.list` (regionCode `IN`) to build the real mapping for Ninto's
   specialties, saved as a table in the spike.
8. 5b: `googleLocations.search` using onboarding name + address. Show a claimable result (placeId,
   no `requestAdminRightsUri`) or an owned-by-someone-else result (link out to
   `requestAdminRightsUri`). Claim = `accounts.locations.create` with that placeId, **`validateOnly`
   first**. Only do a real claim if a genuine test practice is available.
9. 5c: `accounts.locations.create` with **`validateOnly=true`** to prove the payload. Only make a
   real create on a throwaway test listing, and delete it afterwards.
10. 6/7: `getVoiceOfMerchantState` → `fetchVerificationOptions` → verification-method picker →
    `verify` → Manage timeline from `verifications.list` → PIN entry via `verifications.complete`.
    Prove it end-to-end with SMS or email where Google offers it. Postcard can only be started
    inside a cycle.
11. 7c: `locations.admins.create` to invite a Ninto manager account (the first half of model B),
    then `admins.delete` + token revoke for "Remove access".
12. Reviews smoke test: v4 `accounts.locations.reviews.list` on the verified test listing, to
    confirm the inbox claim holds up (read only, no replies).
13. Diagnostics panel, like `youtube-feasibility`: latency per call and a running count per API
    against the 300 QPM limit. Also record which listing edits Google held for review.

## Feature support summary

| Feature in design | Status |
|---|---|
| Prompts & benefits sheet (1–3) | Supported (Ninto UI). Drop "and questions" from copy. |
| Google consent (4) | Supported, provable this cycle. Google controls the copy. |
| Pick existing listing (5a) | Supported, provable this cycle. |
| Prefill & edit (5a) | Supported, provable this cycle. Needs the specialty→category mapping. Edits may go to Google review. |
| Find & claim unclaimed (5b) | Supported via search + create-with-placeId. Provable only if a real unclaimed test practice exists, otherwise via `validateOnly`. Add a "managed by someone else" state. |
| Create new (5c) | Supported, provable via `validateOnly`. Pin drag needs the Maps JS API. |
| Verification (6) | Supported. SMS/email provable end-to-end this cycle, postcard only started. Must be a **user choice** from the returned options, not "Google picks". |
| Manage + enter code (7) | Supported, provable this cycle. ETA is our own estimate. |
| Remove access (7c) | Supported, provable this cycle (revoke + `admins.delete`). |
| Ninto as manager / ongoing sync | Invite provable this cycle. Accepting, and background sync, need a backend and a Ninto GBP identity. Not in this spike. |
| Reviews in Ninto inbox | Reading reviews provable this cycle. The inbox itself is backend work. |
| Questions in Ninto inbox | **Not supported.** Q&A API discontinued 2025-11-03. |

## Open questions for product

- Which test listings (verified owned, unclaimed, throwaway) can the spike use safely?
- Manager model A or B? (B matches the design copy but needs a Ninto GBP identity.)
- Copy for screen 3 without "questions", and screen 6 as a method picker.
- Flow for HWPs who practise inside a hospital or multi-doctor clinic.
- What's on "Step 2 of 2" of 5c?
