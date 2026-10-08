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
- **surface** — one product area on the provider (e.g. `marketplace`, `messenger`). **Never assume one Facebook session is safe for every Meta surface.** A Marketplace session grants nothing on Messenger; each surface gets its own session assessment, its own reauth flow, and its own browser profile directory. The current service uses a single profile because it serves a single scope (`facebook` / `default` / `marketplace`); before a second surface goes live (#43), each scope must map to its own profile directory, with the existing default directory assigned to the marketplace scope.

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
| `read` | No external side effect, no disclosure beyond the caller's own data | Autonomous | Valid session scope; no grant |
| `prepare` | Builds a draft/artifact with no external effect (e.g. a message draft) | Autonomous, but its output is **not** authorization to send | Valid scope; no grant |
| `send` | Delivers content to an external party (e.g. sends a seller message) | Never autonomous | Valid scope **and** a single-use approval grant bound to the exact payload, verified and consumed atomically before execution |
| `high_consequence` | Purchases, payments, sharing private data, hard commitments | Never | Refused unconditionally. No grant can enable it; enabling it later requires changing this gate explicitly, not presenting a better grant |

Registered today: `marketplace_search`, `marketplace_fetch`, `marketplace_status` — all `read`. The registry is derived from the tool declarations themselves, so a tool cannot exist without a risk class.

## Approval grants

When Miso decides an external message may be sent, OpenClaw presents Musebridge a grant. Musebridge verifies and consumes; it never issues, stores, extends, or retries grants.

Grant shape (zod-validated, `approvalGrantSchema` in `src/authorization.ts`):

- `grant_id` — opaque token (16–128 chars). Musebridge does not parse meaning from it.
- `provider`, `account`, `surface`, `action` — must match the action's declared scope and name exactly.
- `subject_digest` — lowercase SHA-256 hex (uppercase is rejected as malformed) of the canonical (key-sorted) JSON of the **validated** tool input: the form after Zod parsing, trimming, and defaults — the same form the backend executes. Hosts computing digests must use that form, not the raw request arguments. Inputs must stay JSON-representable (`undefined` fields canonicalize as `null`); any change to the payload invalidates the grant.
- `expires_at` — ISO 8601 with offset. Expired at or before the verification instant.

Enforcement rules (`authorizeAction` + `InMemoryActionAuthorizer`):

1. Missing, malformed, or unparsable grant for a `send` action → `APPROVAL_REQUIRED`. The action never runs.
2. Grant present but not valid for this request (scope mismatch, digest mismatch, expired, already consumed) → `ACTION_FORBIDDEN`.
3. A verified grant is consumed in the same synchronous step that authorizes the action — verification and consumption share one step with no interleaving point, so a grant authorizes exactly one execution. Replay is impossible, including concurrent calls.
4. `read`/`prepare` actions never consult the authorizer; `high_consequence` is refused before the authorizer is consulted.
5. Registration-time check: registering a `send` or `high_consequence` tool without an authorizer configured fails at startup, not at first call. Without this PR's gate, a write tool would dispatch straight to the backend — that path no longer exists.
6. If the host supplies no authorizer, a deny-all authorizer is installed; every `send` request fails closed with `APPROVAL_REQUIRED`.

**Verifier scope and limits.** The in-memory verifier is per service instance: consumed grants do not survive a restart and are not shared across processes, so a multi-process deployment must not rely on it. A durable verifier with bounded storage is a prerequisite for shipping the first `send` tool (#43). The consumed set deliberately has no eviction cap — evicting a consumed grant would reopen replay — and grows only with approved sends, since a grant reaches it solely by passing full verification, not by attacker input.

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
2. **#43 step 1 — conversation reads:** new `read` tools for seller threads/messages under a `messenger` surface scope with their own session assessment and profile directory. No approval needed; still no external effect.
3. **#43 step 2 — drafts:** a `prepare` tool that renders a message draft and its `subject_digest`. Autonomous. Output explicitly marked as not-sent and not-authorized.
4. **#43 step 3 — send:** a `send` tool wired to a real approval flow: OpenClaw presents a grant scoped to (provider, account, `messenger`, send action) whose `subject_digest` is the digest of the previously drafted payload; Musebridge verifies, consumes, sends once with an idempotency token, and reconciles on timeout. Host-path research (real Messenger surface, API vs browser) happens in #43; this boundary applies regardless of access method.
5. **Later:** `high_consequence` stays refused until a deliberate, separately reviewed change to this gate.

## Test invariants

The suite pins: registry covers every registered tool and all are `read` today; unknown/malformed grants fail closed; every grant field mismatch refuses; expiry is exact; consumption is single-use and race-free; `high_consequence` refuses even a valid grant; digest is key-order independent and payload-sensitive; and existing search/fetch/status responses are unchanged.
