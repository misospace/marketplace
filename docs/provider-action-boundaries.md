# Provider action boundaries

The enforceable contract for account/session isolation and action authorization, defined before any write-capable MCP tool ships. Scope: Musebridge (this repository) enforces the boundary; Miso — via OpenClaw — owns the decisions and approvals that produce it. This document is the reference for #43 (seller messaging) and every capability after it.

Non-goals: this is not a generic policy framework, there is no rule engine, no config-driven permissions, and no shared package extraction. The enforcement surface is one gate at the tool-dispatch choke point and one grant verifier. If a future capability needs more, extend this document and the gate deliberately — do not grow a framework opportunistically.

## Actors and trust boundaries

| Actor | Owns | Must never do |
|---|---|---|
| Miso / OpenClaw | Reasoning, negotiation strategy, approval decisions, issuing approval grants | Assume Musebridge grants implicit permissions |
| Musebridge | Provider connectors, sessions, verification and single-use consumption of grants | Issue, extend, or self-approve grants; interpret grant semantics beyond scope matching |
| Operator (Miso) | Final human approval for external side effects | — |

Musebridge treats every inbound tool call as untrusted until the gate accepts it, and treats every approval grant as an opaque, single-use capability token — it verifies the fields below and nothing more.

## Account and session isolation

A **session scope** is the triple `(provider, account, surface)`:

- **provider** — the external service identity (e.g. `facebook`).
- **account** — one login identity on that provider (today: `default`; multiple accounts require distinct scope values, not shared state).
- **surface** — one product area on the provider (e.g. `marketplace`, `messenger`). **Never assume one Facebook session is safe for every Meta surface.** A Marketplace session grants nothing on Messenger; each surface gets its own session assessment, its own reauth flow, and its own browser profile directory. Each scope maps to its own profile directory — the existing default directory (`BROWSER_PROFILE_DIR`, default `$HOME/.marketplace/browser-profile`) belongs to the marketplace scope, and the messenger scope has its own (`MESSENGER_PROFILE_DIR`, default `$HOME/.marketplace/browser-profile-messenger`). The messenger surface is opt-in (`MARKETPLACE_MESSENGER=1`) and does not yet have an interactive reauth flow; a captcha or checkpoint on that profile surfaces as a typed provider error and requires manual profile recovery until the send step wires per-scope reauth.

Invariants carried over from the existing service and preserved per scope:

- Session state is classified (`session_usable`, `session_needs_reauth`, `session_unknown`) and ambiguous probes stay `session_unknown`; provider actions fail closed on it.
- A reauth lease owns its scope's profile exclusively; no action may run against a profile under an active lease.
- Logout/revocation/cancellation degrade the scope's assessment to `session_unknown` — never to usable automatically.
- Credentials are environment-only, never persisted, logged, or returned; sessions live only in the profile directory of their scope.
- Operator recovery is the existing loopback reauth console, per scope.

## Action risk classes

Every registered MCP tool declares exactly one risk class and the session scope it operates on. The classes and their enforcement requirements:

| Class | Meaning | Autonomy | Enforcement |
|---|---|---|---|
| `read` | No external side effect beyond a narrow, named exception: provider-side bookkeeping that is intrinsic to reading the caller's own data (today: Messenger read receipts — opening a thread marks it "Seen", which the other participant can see). Anything that discloses content, delivers a message, or changes state the counterpart observes beyond that bookkeeping is not `read`. | Autonomous | Declared scope; no grant. The scope selects the browser profile and probe the tool's backend uses, and each surface's backend validates its own session, failing closed on `session_unknown` (search/fetch and the conversation reads all do this) |
| `prepare` | Builds a draft/artifact with no external effect (e.g. a message draft) | Autonomous, but its output is **not** authorization to send | Same as `read`; no grant |
| `send` | Delivers content to an external party (e.g. sends a seller message) | Never autonomous | Valid scope **and** a single-use, issuance-authenticated approval grant bound to the exact payload, verified and consumed atomically before execution (no production send path exists today) |
| `high_consequence` | Purchases, payments, sharing private data, hard commitments | Never | Refused unconditionally. No grant can enable it; enabling it later requires changing this gate explicitly, not presenting a better grant |

Registered today: `marketplace_search`, `marketplace_fetch`, `marketplace_status` (scope `marketplace`) and `messenger_threads_list`, `messenger_thread_read` (scope `messenger`) — all `read`. The registry is derived from the tool declarations themselves, so a tool cannot exist without a risk class.

## Approval grants

When Miso decides an external message may be sent, OpenClaw presents Musebridge a grant. Musebridge verifies and consumes; it never issues, stores, extends, or retries grants. **Issuance is not yet verifiable**: the shipped enforcement today is structural only — scope, payload digest, expiry, and single-use consumption. It protects against altered payloads and replay, but a fabricated grant with matching fields would pass, so no production send path exists until #43 ships a verifier that also authenticates issuance (a trusted host-only grant channel or an issuer signature). Until then, production authorization for `send` is deny-all: the service installs `DenyAllAuthorizer` and every send fails with `APPROVAL_REQUIRED`.

Grant shape (zod-validated, `approvalGrantSchema` in `src/authorization.ts`):

- `grant_id` — opaque token (16–128 chars). Musebridge does not parse meaning from it.
- `provider`, `account`, `surface`, `action` — must match the action's declared scope and name exactly.
- `subject_digest` — lowercase SHA-256 hex (uppercase is rejected as malformed) of the canonical (key-sorted) JSON of the **validated** tool input: the form after Zod parsing, trimming, and defaults — the same form the backend executes. Hosts computing digests must use that form, not the raw request arguments. Inputs must stay JSON-representable (`undefined` fields canonicalize as `null`); any change to the payload invalidates the grant.
- `expires_at` — ISO 8601 with offset. Expired at or before the verification instant.

Enforcement rules (`authorizeAction` + a provenance-verifying authorizer, once #43 provides one — production today is deny-all):

1. Missing, malformed, or unparsable grant for a `send` action → `APPROVAL_REQUIRED`. The action never runs.
2. Grant present but not valid for this request (scope mismatch, digest mismatch, expired, already consumed) → `ACTION_FORBIDDEN`.
3. A verified grant is consumed in the same synchronous step that authorizes the action — verification and consumption share one step with no interleaving point, so a grant authorizes exactly one execution. Replay is impossible, including concurrent calls.
4. `read`/`prepare` actions never consult the authorizer; `high_consequence` is refused before the authorizer is consulted.
5. Registration-time check: registering a `send` or `high_consequence` tool without an authorizer configured fails at startup, not at first call. Without this PR's gate, a write tool would dispatch straight to the backend — that path no longer exists.
6. If the host supplies no authorizer, a deny-all authorizer is installed; every `send` request fails closed with `APPROVAL_REQUIRED`.

**Verifier scope and limits.** The only authorizer shipped for production is `DenyAllAuthorizer` — every `send` fails closed until a provenance-verifying implementation exists (#43). The verifying implementation used by the test suite (`UnverifiedGrantAuthorizer` under `tests/helpers/`) deliberately does **not** authenticate issuance and must never be wired into a production service. When the real verifier lands, consumed grants must be durable and bounded: per-instance in-memory consumption does not survive a restart or span processes, and an eviction cap would reopen replay — the set grows only with approved sends, since a grant reaches it solely by passing full verification, not by attacker input.

**Timeout and resend semantics (binding for #43):** a `TIMEOUT` on a send means the outcome is unknown. It is never permission to resend. The send path must reconcile actual delivery state (read the thread, match by an idempotency token embedded in the draft) before any retry, and any retry is a new approval decision for Miso. Unconfirmed sends are reported as unknown, not as failure or success.

## Failure responses

Authorization refusals are normal, non-exceptional tool responses — `{ ok: false, error: { code, message } }` with `isError: true`, like other runtime failures, but they are distinct from provider errors:

- `APPROVAL_REQUIRED` and `ACTION_FORBIDDEN` are new `runtimeErrorCodeSchema` codes, deliberately **not** in `PROVIDER_ERROR_CODES`: provider errors describe the external service; these describe Musebridge policy. They cannot be triggered by any tool registered today.
- Refusals are not logged as service failures (no stack, no `logger.error`); the response itself is the record. Messages never embed grant contents, digests of user content, or credentials.

## Secrets and logging

- Credentials remain environment-only (existing rule). Grants carry opaque ids and digests — no secret material ever enters the authorization path.
- Log redaction rules are unchanged: no page content, cookies, storage, headers, credentials, or form values. Authorization adds one rule: never log grant ids or subject digests alongside user content such that a grant could be reconstructed.
- Tests use synthetic identities and opaque refs only; no real tokens, passwords, or accounts are ever retrieved to build or test these interfaces.

## Migration path from the read-only connector

1. **This change (#41):** gate, risk classes, scope declarations, grant verifier, tests. Registered tools are all `read`; deployed Marketplace consumers see zero behavior change.
2. **#43 step 1 — conversation reads (this change):** `messenger_threads_list` and `messenger_thread_read` are `read` tools under the `messenger` surface scope with their own session assessment and profile directory. No approval needed. One named exception to the side-effect-free read definition applies, decided with the operator: opening a thread page marks it "Seen" for the other participant (and may surface presence), which is intrinsic to the only available access path — there is no side-effect-free way to read a Messenger thread in a browser session. `messenger_threads_list` reads the inbox page without opening threads and has no receipt side effect. Miso must treat thread reads as visible to the counterpart. The provider-surface research behind them — including what is verified versus assumed and the live-site validation plan — is in [`conversation-surface-research.md`](conversation-surface-research.md). Interactive reauth for the messenger scope is deferred to step 3.
3. **Shopping surface:** `shopping_search` and `shopping_fetch` are autonomous `read` tools under `(ebay, default, shopping)`, with no grant and no browser session (the token is application-scoped, not a user session); no reauth surface is needed in this wave.
3. **#43 step 2 — drafts:** a `prepare` tool that renders a message draft and its `subject_digest`. Autonomous. Output explicitly marked as not-sent and not-authorized.
4. **#43 step 3 — send:** a `send` tool wired to a real approval flow: OpenClaw presents a grant scoped to (provider, account, `messenger`, send action) whose `subject_digest` is the digest of the previously drafted payload; Musebridge verifies, consumes, sends once with an idempotency token, and reconciles on timeout. Host-path research (real Messenger surface, API vs browser) happens in #43; this boundary applies regardless of access method.
5. **Later:** `high_consequence` stays refused until a deliberate, separately reviewed change to this gate.

## Test invariants

The suite pins: registry covers every registered tool and all are `read` today; unknown/malformed grants fail closed; every grant field mismatch refuses; expiry is exact; consumption is single-use and race-free; `high_consequence` refuses even a valid grant; digest is key-order independent and payload-sensitive; and existing search/fetch/status responses are unchanged.
