# Instagram & Threads consumer social research (#46)

Parent: #38 (verticals). Issue: #46. Status: research complete, integration decision recorded, read-only proof defined but not yet implemented.

## What the capability needs

Issue #46 asks for saved content, DMs, and consumer social actions on Instagram and Threads, for the operator's normal **personal consumer accounts**. The requested outcome is three things before any implementation: (1) a capability matrix and integration decision, (2) one high-value read-only proof defined, and (3) write scopes and approval behaviour made explicit before any write exists.

Instagram media **queuing already exists** in the operator's OpenClaw workflow (per issue #46's own framing). This research therefore does not propose replicating any media-publishing/queuing workflow; authoring is assessed for feasibility only. The scoped surfaces are saved items, search/read, conversations/DMs, and authoring feasibility.

Everything here is analysed against personal (non-Business, non-Creator) accounts. Where a capability exists only for professional accounts, that is recorded as a boundary, not worked around.

## Capability matrix

Access-bar ratings are about solo-operator friction, not money. "Access bar" is the cost of reaching the sanctioned path at all; "Read/Write feasibility" is what that path actually returns for a personal account.

| Surface | Sanctioned path | Access bar | Read feasibility | Write feasibility | Verdict |
|---|---|---|---|---|---|
| Instagram — saved items/collections | none | — | no API; only point-in-time export | n/a | **No-go** |
| Instagram — search/read (own media, comments, mentions, insights) | Graph API / API with Instagram Login (professional only) | ★★★ professional account; App Review + Business Verification for accounts you do not own | professional accounts only; excludes personal accounts | publishing exists for professional only | **No-go for personal account** |
| Instagram — conversations/DMs | Messaging / Instagram Direct API (professional only) | ★★★ professional + messaging permissions | professional inbox only, 24h reply window; never a personal inbox | send in professional inbox only | **No-go for personal account** |
| Instagram — authoring | Graph API content publishing (professional only) | ★★★ professional | n/a | exists (100 API-published posts/24h) but out of scope | **No-go for personal; do not replicate queuing** |
| Threads — saved items/collections | none | — | no endpoint exists | n/a | **No-go** |
| Threads — search/read (own posts, replies, conversation, mentions) | official Threads API (`threads_basic` + `threads_read_replies`, optionally `threads_manage_mentions`) | ★ low: Meta app with Threads Use Case + user OAuth; testers need no App Review | own posts, own replies, public reply trees, own mentions | n/a | **Go (read-only)** |
| Threads — search/read (keyword search, external profile discovery) | official Threads API (advanced-access search/discovery scopes; exact scope names **UNVERIFIED**) | ★★ advanced access / App Review | documented as available but gated and rate-limited; gating to confirm | n/a | **Follow-up, not in proof** |
| Threads — conversations/DMs | none | — | no DM endpoint; "conversation" is a public reply tree only | n/a | **No-go** |
| Threads — authoring (posts/replies) | official Threads API (`threads_content_publish`, `threads_manage_replies`) | ★ low technically, but write-class | n/a | yes (250 posts/24h, 1000 replies/24h) | **Out of scope; write-gated** |

## The load-bearing facts

The decision turns on one asymmetry: **Instagram's sanctioned API is professional-only, Threads' is not.**

- On Instagram, the only sanctioned API reads and writes **Instagram PROFESSIONAL (Business/Creator) accounts**. The Facebook-Login variant explicitly cannot access consumer accounts. There is no sanctioned API for a personal account's Saved tab or personal DMs. The only sanctioned route to a personal account's own data is the manual, delayed, point-in-time export.
- On Threads, the standard API is available to personal profiles. Since 2025-09-23 profiles without a linked Instagram account are supported (a metric carve-out reported at that time was later relaxed — confirm the current state); no business/creator requirement is stated for the standard API. Getting started needs only a Meta app using the "Threads Use Case" plus user OAuth consent.
- **Neither provider exposes saved posts.** Instagram has no API for user saved posts/collections; `IG Media.saved_count` is a count of saves *of your own media* (owner-only), **not** the user's Saved tab — a common ambiguity trap. Threads' full endpoint enumeration has no saved/bookmarks resource.
- **Neither provider exposes personal DMs through a sanctioned connector.** Instagram Messaging serves the professional inbox only. Threads has no direct-message endpoints at all; its "conversation" endpoint is the public reply tree.
- **Browser fallback is prohibited.** Meta, Instagram, and Threads terms each ban automated collection; the Instagram and Meta terms state the ban applies "regardless of whether such automated access or collection is undertaken while logged-in," so a logged-in browser/Playwright session does not escape it.

## Access paths evaluated

Researched against official developer documentation and primary terms as of October 2026, some via archived captures where live pages blocked fetch (see Sources).

**Instagram**

| Path | Verdict | Basis |
|---|---|---|
| Graph API / Instagram API with Instagram Login or Facebook Login | **Professional only** | Requires Business or Creator account; reads own media, insights, comments, @mentions, hashtag search (FB login), business discovery of other professional accounts, and publish. FB-Login docs explicitly exclude consumer accounts. |
| Instagram Basic Display API | **Dead** | Deprecated: announced 2024-09-04; from 2024-12-04 all requests return an error. Previously allowed reading a personal/private account's profile/media/albums via `instagram_graph_user_profile` / `instagram_graph_user_media`. |
| Instagram Messaging / Instagram Direct API | **Professional inbox only** | Permissions `instagram_business_manage_messages` (IG Login) or `instagram_manage_messages` + `instagram_basic` + `pages_*` (FB Login); 24h reply window, Human Agent tag extends to 7 days; cannot read a personal account's DMs. |
| Browser / logged-in session fallback | **ToS-prohibited** | Explicitly banned while logged in; carries real account risk (see below). |
| Official data export | **Manual, delayed, point-in-time** | Accounts Center → "Your information and permissions" → "Export your information"; messages and data logs selectable; password-protected; link ready within ~30 days, valid 4 days. Cannot author, cannot return other users' private data, not live. |

**Threads**

| Path | Verdict | Basis |
|---|---|---|
| Official Threads API | **Selected** | Standard read of own posts/replies; no business requirement stated; OAuth consent, no browser, no ToS exposure. |
| Keyword search / external profile discovery | **Deferred** | Requires advanced-access search/discovery scopes or App Review (exact scope names `UNVERIFIED`); the follower-threshold and standard-access limitations reported during research are `ASSUMED`, not confirmed. |
| Saved posts | **Does not exist** | No endpoint. |
| DMs | **Does not exist** | No direct-message endpoints. |
| Official data export | **Manual, delayed** | Threads has its own export page (page exists; body not renderable during research), same point-in-time limits as Instagram. |

Third-party connectors are evaluated under "Third-party connectors and official export."

## Integration decision

- **Instagram, personal consumer account: NO-GO for a sanctioned connector.** No API for Saved or personal DMs; the only sanctioned API excludes consumer accounts and covers professional accounts only; the only sanctioned route to a personal account's own data is the manual, delayed, point-in-time export. Any browser fallback is explicitly prohibited by Meta/Instagram terms even while logged in and carries real account risk. A sanctioned Instagram path becomes possible **only** if the operator adopts or holds a Professional (Business/Creator) account — and even then it exposes the professional inbox plus own media/insights, never the personal Saved tab.
- **Threads, personal account: GO for a read-only official-API connector.** Standard Threads API is available to personal accounts, and `threads_basic` (+ `threads_read_replies`) reads the operator's own posts and replies with no browser and no ToS violation. No saved-posts endpoint and no DM endpoint exist — set those expectations explicitly. Publishing exists but is out of scope: media queuing already exists in the operator's workflow, and writes are gated.
- Instagram media queuing is unchanged by this decision; no new publishing path is proposed for either provider.

## The one high-value read-only proof

**Read the operator's own Threads posts and their reply/conversation threads via the official Threads API.**

- Smallest defensible scope: `threads_basic` (required) plus `threads_read_replies`. Optionally include own mentions via `threads_manage_mentions`. Read own posts with `GET /{threads-user-id}/threads`, own replies with `GET /{threads-user-id}/replies`, reply/conversation trees with `GET /{media-id}/replies` and `GET /{media-id}/conversation`, and (if included) mentions with `GET /{threads-user-id}/mentions`. The proof will live under a Threads scope `(threads, default, social)`, risk class `read`.
- **Do not include** keyword search or external profile discovery in the proof — they require advanced access / App Review. Name them as documented follow-ups. Other documented scopes (`threads_manage_insights`, `threads_delete`, `threads_location_tagging`, `threads_share_to_instagram`) exist but are out of scope for a read-only proof.
- **Fixture-first bar.** The connector is built against recorded fixture HTTP responses first; live calls happen only with the operator's OAuth token in the environment. Missing token fails closed with a typed `ProviderError` while the tool stays listed and documented. This proves the "inspect social content" capability for a personal account with zero browser automation and zero ToS exposure.
- Provider-visible side effects: reading a Threads reply tree is a public read of already-public content and is not expected to signal the author, but a provider-visible read side effect analogous to Messenger "Seen"/presence is `ASSUMED` for Instagram and must be declared if such a tool ever ships.

## Write scopes and approval behaviour

Mapped to `provider-action-boundaries.md`; this is the contract, not a suggestion.

| Action | Risk class | Enforcement |
|---|---|---|
| Authoring any Threads post or reply (`threads_content_publish`, `threads_manage_replies`) | `send` | Valid session scope **and** a single-use, issuance-authenticated approval grant bound to the exact payload (`subject_digest` of the validated input), verified and consumed atomically before execution |
| Instagram DM send (professional only, even if adopted) | `send` | Same as above; never autonomous |
| Purchases, payments, sharing private data, hard commitments | `high_consequence` | Refused unconditionally; no grant can enable it |
| Threads read of own posts/replies/conversation/mentions | `read` | Declared scope, no grant; fail closed on `session_unknown` |
| Instagram saved-item or DM read | `read` (were a path to exist) | No sanctioned path exists; out of scope |

**No write is in scope for the proof wave.** Production authorization for `send` is deny-all until #43 ships a provenance-verifying authorizer; the service installs `DenyAllAuthorizer` and every send fails closed with `APPROVAL_REQUIRED`. Never automate 2FA or an interactive challenge; challenge states surface as typed provider errors and manual recovery. Reading a thread may carry a provider-visible side effect (declared `ASSUMED` for Instagram); if such a tool ships it must be declared as a named read-class exception, exactly as the Messenger thread reads are.

## Rate limits and anti-automation constraints

Recorded from official docs; treat the undisclosed values as unknown, not as a budget.

**Instagram** — app-token Platform limit: 200 × daily active users calls/hour; user-token limits are per user and the values are undisclosed; subject to Business Use Case (BUC) limits. Content publishing: 100 API-published posts per 24h (carousel = 1). Hashtag search: max 30 unique hashtags per rolling 7 days. Relevant error codes: 4/17/32/613. Tokens: auth code 1h → short-lived token 1h → long-lived token 60 days refreshable; permissions unused for 90 days must be regranted. Advanced Access requires Meta App Review + Business Verification to serve accounts you do not own; private apps may request only `instagram_basic` + `instagram_manage_comments`.

**Threads** — app call count: 4800 × number of impressions per rolling 24h (minimum 10 impressions). CPU: `total_cputime` 720000 × impressions, `total_time` 2880000 × impressions. Publishing: 250 API-published posts/24h; 1000 replies/24h; 100 deletions/24h. Location search: 500/24h. Keyword search: 2200 queries/24h per user across all apps. Profile discovery: 1000 requests/24h. Container status polling: at most once per minute for at most 5 minutes. Quota introspection: `GET /{user}/threads_publishing_limit`. Publishing is two-step `POST /{user}/threads` then `POST /{user}/threads_publish` (carousel three-step, ~30s processing wait). Tokens: short-lived 1h, long-lived 60 days refreshable; public-profile permission grants last 90 days, private-profile grants cannot be extended. Since 2025-12-22 posts with more than 5 links fail with `THREADS_API__LINK_LIMIT_EXCEEDED`.

**Anti-automation.** Community reports (`ASSUMED`, `instagrapi` best-practices) describe browser automation of a personal Instagram account triggering challenges, rate limits, forced logouts, and occasional bans; no primary Meta statistic exists. This is risk context, not a reason to attempt it — the sanctioned path is the API or nothing.

## Media metadata

**Instagram** (`IG Media`) — `id`, `caption`, `comments_count`, `like_count`, `media_type`, `media_product_type`, `media_url`, `permalink`, `shortcode`, `thumbnail_url`, `timestamp`, `username`, `owner`, `alt_text`, `view_count`, `saved_count`, `shares_count`, gated by permission. The API returns only data for media owned by Instagram **PROFESSIONAL** accounts — not personal accounts.

**Threads** — `media_type` (`TEXT_POST` / `IMAGE` / `VIDEO` / `CAROUSEL_ALBUM` / `AUDIO` / `REPOST_FACADE`), `media_url`, `permalink`, `thumbnail_url`, `children`, `alt_text`, `link_attachment_url`, `gif_url`, `poll_attachment`, `topic_tag`, `text_entities`, `text_attachment`, `is_quote_post` / `quoted_post` / `reposted_post`, `is_verified`, `profile_picture_url`, `location_id`, timestamps, `shortcode`.

Threads publishing constraints: text ≤ 500 chars; image ≤ 8 MB JPEG/PNG; video ≤ 1 GB and ≤ 300 s.

## Third-party connectors and official export

- **Composio Instagram toolkit** wraps the **official** Instagram API via "Instagram API with Business Login," and explicitly requires Business/Creator accounts plus managed OAuth. It is **not** browser automation. Its DM tools are the official Messaging API subject to the 24h window. `Composio` has **no Threads toolkit found** (negative evidence — `ASSUMED`). No connector shortcut exists for personal-account Instagram saved items or DMs. A third-party wrapper of the same professional-only API does not change the no-go.
- **Official export** (Accounts Center → "Your information and permissions" → "Export your information") offers "Available information" and "Specific types," explicitly including messages and data logs; password-protected; link ready within ~30 days, valid 4 days. It is a point-in-time archive, not a live API: it cannot author and cannot return other users' private data. Instagram's export appears to also include saved posts/collections (`ASSUMED` — "Saved" not directly quoted); Threads has its own export page (VERIFIED page exists, body not renderable). For a personal Instagram account this export is the only sanctioned access to the operator's own saved content and message history — a manual, out-of-band retrieval, not a connector.

## Verified vs assumed

**Verified** against official Meta docs and primary terms (Oct 2026):

- Instagram Platform API enumerates only IG Comment, IG Container, IG Hashtag, IG Media, IG User, Page, and edge `ig_hashtag_search`; no saved-posts node.
- `IG Media.saved_count` is saves of your own media, not the user's Saved tab.
- Basic Display deprecation dates (announced 2024-09-04; error from 2024-12-04) and its former personal/private read capability (confirmed via an archived capture; the original doc page now returns 404).
- Graph API / IG Login / FB Login require a professional account; FB Login cannot access consumer accounts.
- Instagram Messaging permissions and the 24h / Human Agent 7-day windows.
- Instagram Standard vs Advanced Access, App Review + Business Verification, token lifetimes, 90-day unused-permission regrant, rate limits, publishing limit, hashtag limit, error codes.
- Threads API opened to all developers 2024-06-18; no-linked-Instagram profiles supported since 2025-09-23; standard scope list; threads business scope prohibited in consumer apps.
- Threads read endpoints, publishing capabilities and limits, no saved endpoint, no DM endpoint, "conversation" = public reply tree, Share to Instagram Stories is an IG Story not a DM.
- Threads rate limits, token lifetimes, quota introspection endpoint, `THREADS_API__LINK_LIMIT_EXCEEDED`.
- Meta ToS §3.2(3), Instagram Terms §4.2, Threads Terms §3(a)(iv) automated-collection bans, including the logged-in qualifier (operative wording verified; exact section numbering unverified).
- Export page existence and options for Instagram; Threads export page exists.
- Composio Instagram toolkit is the official API requiring Business/Creator, not browser automation.

**Assumed / to verify during implementation** (checked at key-acquisition and first-live-call time, not trusted blindly):

1. Instagram export includes saved posts/collections — `ASSUMED` ("Saved" not directly quoted).
2. Composio has no Threads toolkit — `ASSUMED` (negative evidence).
3. Browser automation risk profile for personal Instagram (challenges/logouts/bans) — `ASSUMED`, community reports only, no primary statistic.
4. Instagram read side effects analogous to Messenger "Seen"/presence — `ASSUMED`, declare if a tool ships.
5. Exact Threads endpoint paths and response field spellings — to be confirmed against the official reference when the client is written.
6. Whether the operator's own Threads account has a linked Instagram account and therefore which optional scopes behave as documented.
7. Exact advanced-access scope names for Threads keyword search / profile discovery (`threads_keyword_search`, `threads_profile_discovery`) and their gating — `ASSUMED`; these were not confirmable in the Get Started permission table and must be checked against the current permissions reference before any such tool is scoped.
8. The current status of the no-linked-Instagram metric carve-out for Threads — `ASSUMED`; the 2025-09-23 carve-out was reported relaxed later, so confirm the live state.
9. Exact section numbering of the Meta / Instagram / Threads terms clauses — `ASSUMED`; the operative automated-collection wording is verified, the numbering is not.

## Safety, privacy, and boundaries

Mapped to `provider-action-boundaries.md` and `services/marketplace/AGENTS.md`:

- **Scopes and sessions.** The Threads proof is scope `(threads, default, social)` — provider `threads`, account `default`, surface `social` — with its own session assessment and profile needs. No browser and no browser profile are involved: the "session" dimension is the OAuth token being configured or not. This keeps the no-browser discipline of the shopping surface (see `shopping-provider-research.md`).
- **Fail closed.** Ambiguous probes stay `session_unknown`; reads and any future send fail closed on it. A missing or expired token is a typed `ProviderError`, never a silent empty success.
- **Credentials.** OAuth token material is environment-only, never persisted, logged, or returned in tool output. Log redaction is unchanged: no page content, cookies, storage, headers, credentials, or form values; never log grant ids or subject digests alongside user content.
- **Fixtures and synthetic identities.** Build against synthetic fixture responses first; no real tokens, passwords, or accounts are retrieved to build or test these interfaces. Live calls use only the operator's own token in the environment.
- **Untrusted content.** Post text, reply text, and mentions are other-user or operator-controlled content returned bounded and verbatim; Miso owns interpretation, and prompt-injection handling is a consumer-side responsibility for reads.
- **No unautomated challenges.** Never automate 2FA, captchas, or checkpoints; those surface as typed errors for manual recovery.
- **Writes are gated.** Any Threads/Instagram authoring is `send`-class, requiring scope plus an issuance-authenticated single-use grant bound to the exact payload; production is deny-all until #43. `high_consequence` actions are refused unconditionally.
- **No saved-item or DM read scope is registered**, because no sanctioned path exists; nothing is built to "work around" the professional-only boundary.

## Deliberate gaps this wave

- **No Instagram connector at all.** Personal saved items and DMs have no sanctioned path; the single sanctioned route to own data is the manual export, which is out of band and not a connector.
- **No Instagram media publishing/queuing.** It already exists in the operator's OpenClaw workflow and is not replicated here.
- **No Threads publishing.** Out of scope and write-gated.
- **No Threads keyword search or external profile discovery.** Requires advanced access / App Review; named as a follow-up, not part of the proof.
- **No saved-posts or DM endpoints exist on Threads**, and none is planned; the matrix records this so expectations are not read as missing work.
- **No comparison or scoring logic in Musebridge.** Reading facts only, mirroring the shopping surface.

**Recommendation.** Implement the Threads read-only proof (own posts + replies/conversation, optionally mentions), fixture-first, under scope `(threads, default, social)`. Hold Instagram at no-go; keep the export as the operator's manual path for personal saved content and DMs. Revisit only if one of these changes: the operator adopts or holds a Professional Instagram account; Meta opens a consumer saved/DM API; or Threads advanced-access scopes are approved and keyword search / profile discovery become worth a second wave.

Cross-links: [`provider-action-boundaries.md`](provider-action-boundaries.md) (normative enforcement), [`conversation-surface-research.md`](conversation-surface-research.md) (browser-session extraction discipline — not used here), [`shopping-provider-research.md`](shopping-provider-research.md) (capability-matrix and API-only precedent), [`services/marketplace/AGENTS.md`](../services/marketplace/AGENTS.md) (session/credential/fail-closed invariants).

## Sources

Meta developer documentation:

1. Instagram Platform API reference — https://developers.facebook.com/documentation/instagram-platform
2. Instagram API with Instagram Login — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
3. Instagram API with Facebook Login — https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login
4. Instagram Basic Display API (deprecation) — https://developers.facebook.com/documentation/instagram-basic-display-api (page now retired/404; archived capture relied on)
5. Instagram Messaging API — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
6. Threads API — https://developers.facebook.com/docs/threads
7. Threads API get started — https://developers.facebook.com/docs/threads/get-started
8. Threads posts (publishing) — https://developers.facebook.com/docs/threads/posts
9. Threads keyword search — https://developers.facebook.com/documentation/threads/keyword-search
10. Threads profile posts / lookup — https://developers.facebook.com/documentation/threads/threads-profiles
11. Threads permissions reference — https://developers.facebook.com/docs/permissions
12. Threads changelog — https://developers.facebook.com/documentation/threads/changelog

Terms and export:

13. Meta Terms of Service §3.2(3), eff. 2025-01-01 — https://www.facebook.com/legal/terms (archived capture relied on; live terms page blocked fetch)
14. Instagram Terms of Use §4.2 — https://help.instagram.com/581066165581870 (archived capture relied on)
15. Threads Terms of Use §3(a)(iv) — https://help.instagram.com/769983657850450 (archived capture relied on)
16. Accounts Center — Export your information — https://accountscenter.instagram.com/ (export option labels confirmed on the Accounts Center help surface; Instagram saved-items inclusion `ASSUMED`)

Connectors and community:

17. Composio Instagram toolkit docs — https://docs.composio.dev/toolkits/instagram (official API with Business Login; professional accounts only)
18. instagrapi best-practices — https://github.com/subzeroid/instagrapi (community evidence for personal-account automation risk; `ASSUMED`, no primary Meta statistic)
