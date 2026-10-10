# Messenger ordinary personal inbox discovery (#78)

Parent: #45 (consumer Messenger). Related Marketplace-only recovery: #64. Design record: PR #74 (`docs/messenger-consumer-research.md`, pending corrections). Status: research complete — verdict is **NO-GO** for building a consumer listing tool now. The ordinary `/messages/` discovery contract is **unverified and cannot be established from this repository**; this document specifies the conditional contract and the read-only operator validation protocol that would gate a future ticket. It complements `provider-action-boundaries.md` (normative enforcement) and `conversation-surface-research.md` (#43 step 1, authoritative for the Marketplace surface).

## What #78 asks

Issue #78 asks whether the **ordinary personal Messenger inbox** at `www.facebook.com/messages/` can expose an authoritative, per-conversation key through a normal authenticated load, so that a future `consumer_threads_list`-shaped tool could list personal chats separately from the Marketplace inbox.

The problem the issue names:

- `messenger_threads_list` currently navigates the **Marketplace** `/marketplace/inbox/` view; ordinary personal chats under `/messages/` are not exposed by that tool.
- The October 8 research (#64) disproved anchor-only extraction in the Marketplace view; it does **not** establish what the ordinary inbox looks like.
- The existing broken selector contract must not be copied.

What the issue requires:

- Read-only authenticated inspection of `www.facebook.com/messages/` **without opening individual conversations**; if navigation auto-opens a thread, stop and obtain operator approval before any receipt-generating action.
- A decision on whether the ordinary inbox surfaces authoritative conversation keys in normal loaded GraphQL responses, accessible DOM attributes, or another verified **passive** channel — never inferred from names, order, previews, or timestamps, and never via replaying authenticated requests.
- A separate, bounded `consumer_threads_list` (name tentative) or a justified shared implementation without silently broadening `messenger_threads_list`, preserving session isolation and privacy boundaries.
- Observable errors, fixtures, and an operator validation protocol. Draft/send work stays in #62/#63.

## What exists / what does not

**Exists (Marketplace-scoped, not consumer-inbox):**

- `messenger_threads_list` and `messenger_thread_read` are `read`-class under scope `(facebook, default, messenger)` (`services/marketplace/src/tools.ts:36-38,76-89`).
- `messenger_threads_list` reads the Marketplace inbox `/marketplace/inbox/` (`services/marketplace/src/facebook-messenger-backend.ts:85`; `MESSENGER_INBOX_PATH` in `services/marketplace/src/facebook-messenger-url.ts:5`).
- `messenger_thread_read` uses `/messages/t/{id}/` (`MESSENGER_THREAD_PATH`, `facebook-messenger-url.ts:4`).
- Input is `limit` 1..20 default 10; list output is `{ ok, backend, threads[] }` (`services/marketplace/src/domain.ts:151-153,236-243`).

**Does not exist:**

- Any ordinary-inbox listing logic. `/messages/` appears in the codebase only as the messenger session-probe target (`FACEBOOK_MESSENGER_PATH = '/messages/'`, `services/marketplace/src/facebook.ts:8`; the probe path is selected per surface, `facebook.ts:64-70`).
- The extractor only recognizes `/messages/t/{id}/` anchors with the id grammar `^[A-Za-z0-9][A-Za-z0-9._-]*$` bounded to 128 (`services/marketplace/src/facebook-messenger-extract.ts:70,102-142`), thread message rows `[role="row"]` with `You said/sent/replied:` / `{Name} said:` markers (`facebook-messenger-extract.ts:172-201`), and the empty marker `no conversations|no messages yet|nothing here yet` (`facebook-messenger-extract.ts:101`).
- An unrecognized layout is a typed `UPSTREAM_ERROR`, never an empty success (`services/marketplace/src/facebook-messenger-parse.ts`).

## Critical finding (auto-open probe risk)

The messenger probe **already navigates `/messages/` on every messenger tool call**:

1. `messenger_threads_list` and `messenger_thread_read` both call `ensureUsableSession` (`facebook-messenger-backend.ts:104,157`).
2. `ensureUsableSession` calls `probeSession` (`facebook-messenger-backend.ts:205-208`).
3. The messenger-surface probe navigates its probe URL, which is `/messages/` (`facebook.ts:8,64-70,79`).

**Open risk:** if `/messages/` auto-opens a conversation on load, the existing probe may already be emitting a provider-visible "Seen" receipt for that conversation — before any consumer tool exists. This is unverified. **No new `/messages/` navigation may be added until non-auto-open behavior is verified** by the operator protocol below. This risk is a reason the verdict is NO-GO rather than "proceed carefully."

## Access paths evaluated

Cross-reference PR #74 `docs/messenger-consumer-research.md` for the full consumer Messenger access-path decision record; this table only covers the ordinary-inbox discovery question.

| Path | What it could yield | Status | Basis |
|---|---|---|---|
| DOM anchor scan of `/messages/` | Thread hrefs/keys from rendered links | **Unverified / likely insufficient** | Marketplace precedent: 24 conversation buttons, zero `/messages/t/` anchors (#64); do not copy the broken selector contract |
| Passively observed GraphQL/JSON responses | An authoritative key in a normal loaded response | **Unverified for `/messages/`** | #64's Marketplace connection (`marketplaceInboxBuyerMessageThreads`) is Marketplace-scope ONLY and must not be assumed for `/messages/` |
| Embedded hydration/bootstrap state | A key in initial page state | **Unverified** | No evidence gathered; no replay or endpoint calls permitted |
| `messenger.com` standalone | Same ordinary inbox on another origin | **Rejected for now** | Adds an origin/login for no discovery gain; `conversation-surface-research.md` |
| Official API | Personal inbox listing | **Does not exist** | Messenger Platform is Page/business-scoped; no personal-consumer-inbox API (`conversation-surface-research.md`) |

**Load-bearing fact:** the Marketplace result is a scoped observation, not a reusable contract. #64 proved a passive GraphQL connection exists for the **Marketplace** inbox only; nothing about it transfers to `/messages/` without its own live investigation.

## The discovery question

Define the **authoritative key** before any implementation: a single stable per-conversation identifier that the provider supplies in a normal authenticated load, maps 1:1 to one conversation, and is independent of presentation order, display name, preview snippet, or timestamp. A Marketplace-shaped `thread_key.thread_fbid`-like value is a candidate *shape*, not a verified contract for `/messages/`.

Candidate **passive channels** — all **unverified** for the ordinary inbox:

- DOM attributes on the loaded `/messages/` page.
- Passively observed same-origin GraphQL/JSON responses (listener attached before navigation, as in #64).
- Embedded hydration/bootstrap state present in the initial load.

No mapping may be inferred from names, order, previews, or timestamps, and authenticated requests must never be replayed.

## Auto-open / receipt risk

Two distinct risks must be separated:

1. **Probe navigation (present today):** the messenger probe visits `/messages/`; if that auto-opens a thread, a receipt may already fire. Unknown, and the first thing the operator protocol must settle.
2. **Listing navigation (future):** any `consumer_threads_list` that navigates `/messages/` inherits the same auto-open question. Per `provider-action-boundaries.md:39,86`, the named "Seen" exception is scoped to **thread opens only**; a listing operation is expected to open **no** threads and emit **no** receipts. If ordinary-inbox listing cannot be done without opening a thread, it is not `read`-eligible as specified and the tool must not ship.

## State classification

Classification must reuse the existing fail-closed discipline:

- Login, checkpoint, and captcha states surface as typed provider errors.
- An authenticated page with no recognizable threads and no recognized empty state is `UPSTREAM_ERROR`, never empty success.
- A positively verified empty inbox is the only path to `[]`.
- Ordinary-inbox virtualization/pagination is unverified and must not be assumed complete from one page.
- The personal-vs-Marketplace distinction must be established from the page/response itself, not from the URL alone.

## Proposed `consumer_threads_list` contract (conditional)

If, and only if, the operator protocol below positively verifies a passive authoritative key and non-auto-open behavior, the following contract is proposed — **separate tool, not a broadening of `messenger_threads_list`**:

- **Name:** `consumer_threads_list` (tentative).
- **Scope/profile:** same `(facebook, default, messenger)` scope and same `MESSENGER_PROFILE_DIR` (`~/.marketplace/browser-profile-messenger`), enabled only by `MARKETPLACE_MESSENGER=1` (`services/marketplace/src/service.ts:126,127-137,398-400`). No new scope or profile.
- **Risk class:** `read`, under the thread-opens-only Seen exception — and only if listing opens no threads.
- **Input:** bounded `limit`, mirroring the existing 1..20 default 10 (`domain.ts:151-153`).
- **Output:** `{ ok, backend, threads[] }` with an opaque, grammar-bounded key (`MAX_THREAD_ID_LENGTH = 128`, `domain.ts:9,36`) and no inferred preview/participant fields.
- **Fail-closed:** unrecognized layout or absent/unsupported key source → typed error, never empty success; ids never synthesized; read URLs (if ever added) rebuilt from the configured origin with the redirect guard.

## Observable errors

Reuse the existing typed sets:

- Provider codes: `AUTH_EXPIRED, LOGIN_REQUIRED, CAPTCHA_REQUIRED, SESSION_INVALID, RATE_LIMITED, UPSTREAM_ERROR, TIMEOUT` (`domain.ts:14-22`).
- Runtime adds `NOT_FOUND, INTERNAL_ERROR, APPROVAL_REQUIRED, ACTION_FORBIDDEN` (`domain.ts:162-168`).
- `UPSTREAM_ERROR` covers "layout/response not recognized"; `LOGIN_REQUIRED`/`CAPTCHA_REQUIRED`/`SESSION_INVALID` cover auth and challenge states; `TIMEOUT` covers a page/response that never settles.

## Fixtures and bounded tests (specified, not built)

Any future implementation must ship fixture-first, against synthetic sanitized pages/responses only, with the fixture backend remaining the integration reference:

- Populated ordinary inbox yields deduplicated validated keys.
- Positively verified empty connection yields `[]`.
- Absent/unknown/malformed source fails with a typed error (never a false empty).
- Duplicate/invalid keys are dropped.
- Late/out-of-order/unrelated responses are bounded and never fabricate completeness.
- Response listeners are attached before navigation and removed in `finally`.
- Abort and handler cleanup are covered.
- No content, keys, cookies, headers, or bodies appear in logs or tool output (counts/booleans only).
- Browser tests must make zero Facebook requests.

## Operator validation protocol (read-only)

Run manually in an authenticated Chrome session; record **counts and booleans only**, never identifiers, names, previews, or message text.

1. Confirm the operator risk acknowledgment is recorded before starting (open item in PR #74).
2. Open `/messages/` once and record whether a conversation auto-opens (boolean) and whether any receipt/Seen indicator appears — do not send anything.
3. Record booleans for login/checkpoint/captcha/empty markers and whether an authenticated marker is present.
4. With a response listener attached **before** navigation, record whether any normal loaded same-origin GraphQL/JSON response carries a per-conversation connection (boolean + operation name only); do **not** replay requests or call endpoints.
5. Record whether DOM anchors expose a per-conversation key, and whether that key is stable across two loads (boolean).
6. Record whether the page virtualizes/paginates and whether a completeness claim is possible from one load (boolean).
7. If a candidate key is found, record only its **shape** (grammar class and length bound), never a value.
8. Classify personal-vs-Marketplace from the page/response (boolean), not from the URL.
9. If step 2 shows auto-open, **stop** — no listing tool is viable without a non-auto-open path and explicit operator approval.

## Verified vs assumed

**Verified (this repository / live #64 evidence):**

- The Marketplace scoping and tool declarations; the `/marketplace/inbox/` list path and `/messages/t/{id}/` read path; the probe targeting `/messages/`.
- The extractor's anchor/row/empty-marker rules and fail-closed parse; thread-id grammar and bounds; provider/runtime error codes; input limits and output shape.
- The `MARKETPLACE_MESSENGER=1` gate and messenger profile default.
- #64's live finding (2026-10-08): the Marketplace inbox had 24 conversation buttons and zero `/messages/t/` anchors, with GraphQL `CometMarketplaceInboxBuyerTabViewContainerQuery`/`PaginationQuery` carrying `data.viewer.marketplaceInboxBuyerMessageThreads.edges[].node` (`__typename: "MessageThread"`, `thread_key.thread_fbid`) — **Marketplace-scope ONLY**.

**Assumed / unverified (do not treat as fact):**

- That `/messages/` renders any usable key in DOM, responses, or hydration state.
- That the ordinary inbox does not auto-open a thread.
- That Marketplace's GraphQL connection shape recurs on `/messages/`.
- That ordinary-inbox pagination/virtualization is bounded like Marketplace's.
- That any key can be mapped to a conversation without opening it.

## Safety, privacy, and boundaries

Mapped to `provider-action-boundaries.md`:

- **Risk class.** Any consumer listing is at most `read`. The named Seen exception (`provider-action-boundaries.md:39,86`) covers **thread opens only**; `messenger_threads_list` opens no threads and has no receipt side effect, and `consumer_threads_list` must meet the same bar.
- **No new scope.** Same `(facebook, default, messenger)` scope and profile; no shared state change.
- **Never log or persist content.** No message text, keys, cookies, headers, or response bodies in logs or output; diagnostics are counts/booleans only.
- **Never automate 2FA or challenges.** Challenge states surface as typed errors requiring manual recovery.
- **No replay / no endpoint calls.** Only passively observed normal loads; no hardcoded tokens or undocumented calls.
- **Untrusted content.** Any extracted text remains other-participant-controlled and bounded; interpretation belongs to Miso.

## Deliberate gaps / recommendation

- **Recommendation:** close #78 with **NO-GO** for building a consumer listing tool now. The ordinary `/messages/` discovery contract cannot be established from this repository, and the probe's existing `/messages/` navigation may already carry an unverified receipt risk.
- **#78 acceptance criteria mapped:** (1) verified structural contract *or* evidence-based no-go → **this document is the evidence-based no-go**; (2) no threads opened / no receipts without approval → **enforced by the protocol's step 2/9 stop rule**; (3) privacy-safe evidence, known failure modes, bounded tests → **specified above, not built**; (4) focused implementation child **only** when verified → **none created here**.
- **No implementation child is proposed.** A future ticket may be opened only after the operator protocol positively verifies a passive authoritative key and non-auto-open behavior.
- **Cross-links:** `provider-action-boundaries.md` (normative enforcement), `conversation-surface-research.md` (#43 step 1 Marketplace surface), PR #74 `docs/messenger-consumer-research.md` (consumer Messenger design record), #64 (Marketplace-only listing recovery), and `services/marketplace/AGENTS.md` (scope, credential, privacy invariants).
- **Reopen condition:** only when a read-only operator validation run establishes a passive authoritative key for the ordinary `/messages/` inbox **and** confirms the surface does not auto-open a conversation. Until both hold, the verdict stands as final.
