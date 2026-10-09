# Productivity, media, finance, health, and device integration research (#51)

Parent: #38 (verticals). Issue: #51. Status: decision record — evidence gathered, no account access authorized.

Musebridge exposes narrow provider capabilities behind typed contracts; Miso — via OpenClaw — owns reasoning, scheduling, ranking, and approvals. This document decides, per high-value user action, whether the right route is native OpenClaw tooling, an existing provider API/connector, a hosted connector, a Musebridge browser-backed provider, a local device/OS capability, or nothing at all. It complements [`provider-action-boundaries.md`](provider-action-boundaries.md) (the normative enforcement contract) and the sibling [`shopping-provider-research.md`](shopping-provider-research.md) and [`conversation-surface-research.md`](conversation-surface-research.md). It is a decision record, not authorization to access any account, and it deliberately does **not** centralize personal data in Musebridge for symmetry: sensitive sources stay opt-in and, where possible, local to the consumer.

## How to read this record

Every external claim carries one of exactly three evidence levels, used consistently below:

- **Verified** — stated by primary vendor API/program documentation or terms (the stable documentation root is cited in [Sources](#sources)).
- **Reported** — third-party connector inventories / community claims; not confirmed for this operator's account.
- **Assumed** — written from general knowledge and must be validated before any tool is treated as reliable.

Access-bar and coverage statements are capability-level on purpose. No specific endpoint path, scope string, rate-limit number, or package name is asserted as fact unless it is Verified; otherwise it is omitted or explicitly marked Assumed.

## Integration route decision tree

Evaluated in order; take the first route that fits, and record why later routes were not needed.

1. **Native OpenClaw tooling** — the capability already exists in the reasoning layer (local files, local reasoning, ranking, scheduling, summarization). No provider bridge.
2. **Official provider API / OAuth, or a self-hosted connector** — a first-party API exists and the operator can authorize it. Preferred over any third party.
3. **Composio / hosted connector** — only for replaceable, low/moderate-sensitivity actions where a first-party path is unavailable or disproportionately costly. Treated as swappable, never as a source of truth.
4. **Musebridge browser-backed provider** — only for a missing consumer surface that has a repeatable session, structured extraction, a stable contract, and classified failures. This is the expensive, last-resort bridge, not a default.
5. **Generic browser / computer workaround** — a manual, operator-visible fallback, not a product capability.
6. **No reliable / permitted route** — record the action as blocked. Never invent APIs or evade provider controls.

## Decision table

`Class`: **R** read, **W** external write, **X** high-consequence/sensitive. `Decision`: **Native** (OpenClaw/native tooling), **Integrate** (provider API/OAuth or existing connector), **Connector** (Composio/hosted, replaceable low/moderate sensitivity), **Musebridge** (missing consumer capability), **Outside bridge** (local device/OS).

| Category | User-visible action | Likely access path | Class | Decision | Unmet behavior worth engineering? | Sensitivity / permissions |
|---|---|---|---|---|---|---|
| Productivity | Search/read Gmail messages and threads | Gmail API, OAuth user consent (Verified root) | R | Integrate | Content summarization/triage is OpenClaw's job | Mail content; restricted scopes; opt-in |
| Productivity | Draft and send Gmail | Gmail API, OAuth | W/X | Integrate | Draft is `prepare`; send needs operator approval | Sends as the user; high trust |
| Productivity | Read Google Calendar events/free-busy | Calendar API, OAuth (Verified root) | R | Integrate | Ranking/agenda is OpenClaw's job | Calendar contents; opt-in |
| Productivity | Create/modify Google Calendar events | Calendar API, OAuth | W | Integrate | Proposal/diff is `prepare`; commit is `send`-like | Alters shared calendars |
| Productivity | List/read Google Drive files and metadata | Drive API, OAuth (Verified root) | R | Integrate | Search/ranking is OpenClaw's job | File metadata/content; restricted scopes |
| Productivity | Open a Google Doc's text | Docs API, OAuth (Verified root) | R | Integrate | Summarize/edit-plan is OpenClaw's job | Document content |
| Productivity | Read Outlook mail / Microsoft 365 | Microsoft Graph, OAuth (Verified root) | R | Integrate | Triage logic stays consumer-side | Mail/tenant content; admin consent possible |
| Productivity | Send Outlook mail, manage Microsoft calendar | Microsoft Graph, OAuth | W/X | Integrate | `prepare`/`send` split as with Gmail | Sends as the user; tenant policy |
| Productivity | Read Slack channels/threads/DMs | Slack Web API, OAuth (Verified root) | R | Integrate | Summarization stays consumer-side | Workspace content; admin install may gate |
| Productivity | Post a Slack message | Slack Web API, OAuth | W | Integrate | Approval owned by OpenClaw | Posts as the user/bot |
| Productivity | Read GitHub notifications, issues, PRs | GitHub REST API / native tooling (Verified root) | R | Native | Mostly already a native developer surface | Repo visibility; token scope |
| Productivity | Create GitHub issue/comment/PR | GitHub REST API | W | Integrate | Review before write is `prepare` | Writes to public/private repos |
| Productivity | Read/append Notion pages and databases | Notion API, OAuth (Verified root) | R/W | Integrate | Ranking stays consumer-side | Page content; integration grants |
| Productivity | Read/upload Box or Drive-style work files | Vendor APIs (Box/Drive), OAuth | R/W | Integrate | Heavy transfer stays outside the bridge | File content; DLP policy |
| Media | Read Spotify library/playlists/recent | Spotify Web API, OAuth (Verified root) | R | Integrate | Taste modeling stays consumer-side | Listening history; opt-in |
| Media | Control Spotify playback (play/pause/skip/queue) | Spotify Web API, user OAuth; playback control may require a premium account (Assumed detail) | W | Integrate | Preference/ranking owned by OpenClaw | Device control; low sensitivity |
| Media | Ask for media recommendations/dedup | Local reasoning over library metadata | R | Native | Core consumer-side value | None beyond library already read |
| Media | Control smart-home devices (lights, thermostat, plugs) | Vendor clouds and/or a Matter/local hub | W | Connector | Vendor-agnostic control is a hosted-connector fit | Home presence/occupancy; moderate |
| Media | Remote car commands (lock, climate, charge) | Manufacturer app API, if any | X | Outside bridge | Safety-critical; not a reasoning-layer action | Physical consequences; do not automate |
| Finances | Read balances and transactions | Plaid-class aggregation, OAuth (Verified root) | R/X | Integrate | Spending analysis stays in OpenClaw | Financial data; strongly opt-in, never centralized |
| Finances | Categorize and analyze spending | Local reasoning over already-read transactions | R | Native | Core consumer-side value; no new data store | Derived from opt-in source only |
| Finances | Initiate payment/transfer or move money | No sanctioned consumer route for this operator | X | Outside bridge | None: `high_consequence` is refused unconditionally | Irreversible; never automated |
| Health | Read Apple Health data (steps, heart, sleep) | HealthKit, on-device (Verified root) | X | Outside bridge | Belongs in OpenClaw's local layer, not a provider bridge | Device-local health data; opt-in |
| Health | Read Android Health Connect data | Health Connect, on-device (Verified root) | X | Outside bridge | Same local-layer reasoning as HealthKit | Device-local health data; opt-in |
| Health | Read Fitbit/Google health and activity | Fitbit Web API, OAuth (Verified root) | X | Integrate | Trend summarization stays consumer-side | Health data; opt-in |
| Health | Read Oura ring sleep/readiness | Oura API, OAuth (Verified root) | X | Integrate | Correlation across sources stays consumer-side | Health data; opt-in |
| Health | Read Withings scale/BP | Withings API, OAuth (Verified root) | X | Integrate | Same posture as Oura | Health data; opt-in |
| Health | Read Garmin activities/health | Garmin Health API (partner program, gated) (Verified root) | X | Integrate | Only if operator qualifies; else blocked | Health data; program approval |
| Messaging | Read/send Android SMS and personal messages | No public third-party SMS API; default-SMS-app role | X | Outside bridge | Belongs in OpenClaw's local device layer | Intimate content; never centralized |
| Desktop | Read/write local files (macOS/Windows/Linux) | OS filesystem via local agent | R/W | Outside bridge | Native to the local OpenClaw layer | Local files; operator-owned |
| Desktop | Clipboard / open or drive a local app | OS automation locally | R/W | Outside bridge | Local computer-use, not a provider | Local; operator-owned |

Honest result: the high-value actions resolve to **Integrate**, **Native**, or **Outside bridge**; a **Connector** fits only vendor-agnostic smart-home control, and **no row requires a new Musebridge browser-backed provider**. See [Truly missing capabilities](#truly-missing-capabilities).

## Category findings

### Productivity

Access paths evaluated: first-party APIs with OAuth for Google (Gmail, Calendar, Drive, Docs — Verified roots) and Microsoft 365 (Graph — Verified root); first-party APIs for Slack, GitHub, Notion, and Box (Verified roots). A hosted connector is a fallback only and is not needed where a first-party API exists. The work-app set is a natural case for the existing OpenClaw/MCP tool ecosystem (Reported connector inventories exist; not confirmed for this operator's account).

What is Verified/Reported/Assumed: the existence and OAuth consent model of these APIs is Verified at capability level. Whether Google "restricted" scopes require a formal app-verification/security review before the operator can use them in production, and whether the operator's tenant/admin will consent to Microsoft Graph mail/calendar scopes, are **Assumed** constraints to confirm at registration. Exact scope strings and endpoints are Assumed and deliberately unstated.

Permissions/scopes that matter: mail read vs. send is the sharp split; calendar write alters shared state; Drive/Docs reach content. Workspace apps (Slack) may require admin installation, and GitHub access depends on token scope and repo visibility.

Data-sensitivity posture: mail, files, and workspace content are sensitive. They stay opt-in and are read into the reasoning layer as needed, not mirrored into Musebridge storage. Sends remain `prepare` + approved `send` under the boundary contract.

Verdict: **Integrate** for every productivity action; **Native** for GitHub reading where tooling already exists. No Musebridge browser bridge. Reuse OpenClaw's provider/MCP tooling rather than building a parallel one.

### Media

Access paths evaluated: Spotify Web API with OAuth (Verified root) for library reads and playback control; vendor clouds plus Matter/local hubs for smart-home control; manufacturer app APIs (if any) for cars. Media recommendation/ranking is native reasoning.

What is Verified/Reported/Assumed: Spotify's API and OAuth are Verified; that playback *control* (not just metadata) requires the account to have a premium subscription is **Assumed** and must be confirmed against the operator's account and current docs. Smart-home vendor coverage is fragmented and **Reported**; a vendor-agnostic hosted connector is the pragmatic route but is replaceable and moderate-sensitivity. Car command APIs are **Assumed** and often closed.

Permissions/scopes that matter: user-authorized playback control, device targeting, and home-hub account linking. Car commands are safety-critical and carry physical consequences.

Data-sensitivity posture: listening history and home occupancy are personal but moderate; car control is high-consequence and should not run autonomously.

Verdict: **Integrate** Spotify (read + control); **Connector** for vendor-agnostic smart-home control with an explicit replaceability note; **Outside bridge** for car commands, which are not a reasoning-layer action.

### Finances

Access paths evaluated: Plaid-class aggregation with OAuth (Verified root) for balances/transactions; local reasoning for categorization and analysis; no sanctioned route for money movement.

What is Verified/Reported/Assumed: the aggregation model (institution linking, OAuth, read of balances/transactions) is Verified at capability level. Institution coverage, per-institution MFA/refresh behavior, and pricing are **Reported/Assumed** and must be confirmed for the operator. Money movement through this class is not available to a personal read-only agent.

Permissions/scopes that matter: read of balances and transactions is `read`-class data but **X**-sensitive; it must never be centralized or logged. Payment initiation is `high_consequence`.

Data-sensitivity posture: the most sensitive consumer category here. Opt-in, minimized, never stored in Musebridge, and analysis happens where the data already is (OpenClaw's local layer).

Verdict: **Integrate** read-only aggregation behind strict opt-in; **Native** for analysis; **Outside bridge** (blocked) for transfers, which `provider-action-boundaries.md` refuses unconditionally.

### Health

Access paths evaluated: Apple HealthKit and Android Health Connect are on-device stores with no server-side consumer read API (Verified roots); Fitbit, Oura, and Withings expose cloud APIs with OAuth (Verified roots); Garmin Health is a gated partner program (Verified root).

What is Verified/Reported/Assumed: the on-device nature of HealthKit/Health Connect and the cloud nature of Fitbit/Oura/Withings/Garmin are Verified at capability level. Per-source data fields, refresh cadence, and whether the operator qualifies for Garmin are **Assumed** and must be validated.

Permissions/scopes that matter: health data is the most sensitive category; every source is opt-in, and on-device stores should be read by the local OpenClaw layer rather than bridged. Cloud APIs require explicit OAuth grants and possibly app review.

Data-sensitivity posture: X across the board. Do not centralize; read locally where possible, and treat cloud reads as opt-in, minimized, and unlogged.

Verdict: **Outside bridge** for Apple/Android on-device data; **Integrate** (opt-in) for Fitbit, Oura, and Withings; Garmin only if the operator qualifies, otherwise blocked.

### Android SMS and personal messaging

Access paths evaluated: there is no public third-party API to read/send a user's SMS/MMS; a third party must hold the default-SMS-app role (Verified: Android restricts SMS access to the default handler). The personal-message surfaces of other apps are likewise private.

What is Verified/Reported/Assumed: the absence of a sanctioned third-party SMS read/send API is Verified at capability level. Any community claim of an SMS connector is **Reported** and usually depends on the device being the default SMS app or on root.

Permissions/scopes that matter: intimate content; device-local. This is a local-device capability, not a cloud provider surface.

Data-sensitivity posture: X. Never centralized in Musebridge.

Verdict: **Outside bridge** — belongs in OpenClaw's local device layer, not this provider bridge.

### Desktop/local app and file access

Access paths evaluated: OS filesystem and local computer-use on macOS/Windows/Linux; no external provider is involved.

What is Verified/Reported/Assumed: local filesystem access via a local agent is a native capability, not a provider API. Cross-platform permission prompts (macOS TCC, Windows/Linux equivalents) are **Assumed** operator-managed.

Permissions/scopes that matter: local files and app control are operator-owned; no OAuth.

Data-sensitivity posture: local and operator-owned; keep it local rather than round-tripping through a cloud bridge.

Verdict: **Outside bridge** — native to the local OpenClaw layer.

## Truly missing capabilities

No action in this wave is a genuinely missing **consumer-specific Musebridge capability**. By design, the actions either (a) already have a first-party API that OpenClaw's MCP/provider layer can call (**Integrate**), (b) are already native reasoning/tooling (**Native**), or (c) are local-device or OS capabilities that belong in OpenClaw's local layer and must not be centralized in a cloud provider bridge (**Outside bridge**). In particular, Android SMS and Apple/Android health data are device-local and sensitive; bridging them through Musebridge would add a copy of intimate data for no capability gain. Money movement is refused by policy, not shipped as a bridge. Smart-home control is a hosted-connector concern, not a Musebridge surface.

Candidate follow-ups (scope only; no GitHub issue created here):

- **Operator-authorization checklist for productivity/provider access** — confirm restricted-scope Google review, Microsoft tenant consent, Slack admin install, and GitHub token scope at registration time.
- **Consumer sensitivity classification note** — extend `provider-action-boundaries.md` guidance with finance/health as explicit opt-in, non-centralized categories.

Neither is a bridge deliverable; both are documentation/authorization hygiene. If the operator later wants a missing surface that fits the browser-backed criteria (repeatable session, structured extraction, stable contract, classified failures), that should be a new, separately justified issue — not assumed here.

## Safety, privacy, and boundaries

Mapped to [`provider-action-boundaries.md`](provider-action-boundaries.md):

- **Risk classes.** Reads are `read`; drafts are `prepare` (never authorization to send); external delivery is `send` and never autonomous; payments, financial transfers, car commands, and similar are `high_consequence` and refused unconditionally.
- **Sensitive sources opt-in.** Finance and health are opt-in, minimized, and never centralized in Musebridge for symmetry.
- **Credentials.** Environment-only, never stored, logged, or returned; tokens live in env at call time. Never log token material, page content, or form values.
- **No centralization.** Musebridge returns narrow facts to the reasoning layer; it is not a personal-data store.
- **Challenges and 2FA.** Never automated; challenge/checkpoint states surface as typed provider errors and require manual recovery.
- **Untrusted content.** Provider text (mail bodies, file names, message text) is untrusted input returned verbatim and bounded; prompt-injection handling is the consumer's responsibility for reads and is bound to the approved payload digest at `send`.

## Verified vs assumed

**Verified (capability-level, primary roots cited in [Sources](#sources)):**

- First-party OAuth APIs exist for Google Gmail/Calendar/Drive/Docs, Microsoft Graph, Slack, GitHub, Notion, Box, Spotify, Plaid-class aggregation, Fitbit, Oura, and Withings.
- Apple HealthKit and Android Health Connect are on-device stores without a server-side consumer read API.
- Garmin Health is a gated partner program.
- Android restricts SMS read/send to the default SMS app; no public third-party API exists.
- Local filesystem/app access is a native OS capability, not a provider API.

**Assumed / to verify before any tool is treated as reliable:**

1. Google restricted-scope verification/security-review requirement for this operator's production use.
2. Microsoft Graph mail/calendar consent feasibility for the operator's tenant.
3. Slack/GitHub/Notion/Box workspace admin/installation and token-scope realities.
4. Spotify playback control requiring a premium account.
5. Smart-home vendor coverage and whether a vendor-agnostic connector suffices.
6. Institution coverage, MFA/refresh behavior, and pricing for Plaid-class aggregation.
7. Per-source health data fields, cadence, and Garmin partner eligibility.
8. All exact endpoint paths and scope strings — intentionally unstated until confirmed against vendor docs.

**Validation plan.** For each intended source, an operator (a) confirms the vendor's program/consent requirements and obtains credentials or OAuth out-of-band, (b) reads the live documentation root to pin actual scopes/endpoints, and (c) exercises one real read (or a fixture-only check where access is unavailable), recording findings back into this record. Synthetic fixtures alone do **not** prove a live connector; a source stays Assumed until a real authorized call succeeds and its output matches the contract.

## Sources

1. Gmail API — https://developers.google.com/gmail/api
2. Google Calendar API — https://developers.google.com/calendar
3. Google Drive API — https://developers.google.com/drive
4. Google Docs API — https://developers.google.com/docs
5. Microsoft Graph — https://learn.microsoft.com/graph
6. Spotify Web API — https://developer.spotify.com/documentation/web-api
7. Plaid documentation — https://plaid.com/docs
8. Apple HealthKit — https://developer.apple.com/documentation/healthkit
9. Android Health Connect — https://developer.android.com/health-and-fitness/guides/health-connect
10. Oura API — https://developer.ouraring.com
11. Withings API — https://developer.withings.com
12. Fitbit Web API — https://dev.fitbit.com
13. Garmin Health API — https://developer.garmin.com

GitHub, Slack, Notion, and Box first-party developer documentation roots exist and are Stable/Verified, but are not enumerated here to keep the registry to roots this record relies on most directly. Third-party connector inventories (Composio and the community MCP ecosystem) are **Reported leads only**; no package name or version is asserted.

## Deliberate gaps

- **No account access.** This wave authorizes nothing; it only decides routes.
- **No Musebridge bridge build.** Everything resolves to Integrate/Native/Outside/Connector; the browser-backed route is unused.
- **No centralized personal-data store.** Finance and health are explicitly not mirrored into Musebridge.
- **No money movement, no car commands.** Both are `high_consequence` and out of scope.
- **No exact scopes/endpoints/rate limits.** Capability-level only until operator validation.
- **No Composio-specific commitment.** Hosted connectors are described as replaceable, not selected by name.
- **No new GitHub issues.** Candidate follow-ups are listed as scope lines only.
