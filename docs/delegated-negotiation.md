# Bounded delegated negotiation (#44)

Design/decision record for Phase 3 of Parent #38 ("Assisted offers and bounded delegated negotiation"): a bounded, auditable back-and-forth between a buyer's Miso agent and a Marketplace seller. It complements the NORMATIVE enforcement contract in [provider-action-boundaries.md](provider-action-boundaries.md), the read-side findings in [conversation-surface-research.md](conversation-surface-research.md), and the sibling research docs; where this document and the boundary contract disagree, the boundary contract wins. **This is a decision record, not authorization to act:** it specifies a contract and a future, deliberately-reviewed gate extension. No automated send is permitted by this document, and implementation follow-ups wait for #43, #62, and #63 to merge.

**Evidence legend** used throughout: **Verified** — primary documentation or this repository's own behavior (cite the file/line); **Reported** — third-party or community claims not independently confirmed; **Assumed** — written from knowledge, needs live validation.

## Context: phases and the pieces already specified

Phase 1 drafts price and wording for approval. Phase 2 sends approved messages and tracks replies. Phase 3, only with separate explicit delegation, permits a bounded back-and-forth with a price ceiling/floor, expiration, permitted topics, clear stop conditions, and complete audit/visibility. This document does not redesign Phases 1–2; it references their specified contracts:

- **#62 `messenger_prepare` (Phase 1).** A `prepare`-class tool that renders a draft and its `subject_digest` (SHA-256 of the canonical key-sorted JSON of the *validated* input, via `subjectDigest` in `src/authorization.ts`), embeds a UUID idempotency token, and marks output status `draft` / `sent:false`. It is autonomous, and its output is **not** authorization to send.
- **#63 `messenger_send` (Phase 2).** A `send`-class tool that consumes a single-use grant matching the prepared `subject_digest` plus idempotency token; consumption is single-use; on `TIMEOUT` it reconciles by re-reading the thread and matching the idempotency token (never auto-resend; unconfirmed = status `unknown`); it requires a production authorizer with issuance authentication and interactive/loopback reauth for the messenger scope. Production stays deny-all until #43 ships issuance-authenticated verification.

The gate, risk classes, scope declarations, grant verifier, and the four risk classes `read`, `prepare`, `send`, `high_consequence` were established by #41 and are enforced through `authorizeAction` in `src/authorization.ts`. Throughout this document those class names are used verbatim; no new class, marker, or envelope vocabulary is introduced for the near term.

## Actors and trust boundaries

| Actor | Owns in Phase 3 | Must never do |
|---|---|---|
| Miso / OpenClaw | Negotiation reasoning, mandate (price bounds, topics, locality, expiration), turn-by-turn authorization under a granted human delegation, issuing approval grants | Assume Musebridge will interpret the mandate for it |
| Musebridge | Scope/digest/expiry verification, single-use consumption, dispatch, reconciliation, unconditional `high_consequence` refusal | Issue, extend, or self-approve grants; interpret negotiation semantics beyond scope matching |
| Operator (Miso / human) | The original delegation instruction ("ask me before making a firm commitment") and any fresh approval at escalation | — |

Every inbound seller message is untrusted input. Every approval grant is an opaque, single-use capability token. This mirrors the actor table in [provider-action-boundaries.md](provider-action-boundaries.md); the delegation does not widen either actor's authority.

## Delegation invariants

- A delegation is a **reasoning authority** held by Miso, never a field Musebridge reads. Musebridge sees only individual message grants.
- Every outgoing message has its **own** grant, digested to its exact validated payload, consumed once.
- A message dispatch is authorized only when scope, digest, and expiry match at the verification instant.
- No delegation, however broad, reaches `high_consequence`.
- Unknown outcomes are reconciled, not retried automatically.
- A revocation or expiry stops further sends; it never retroactively re-enables them.

## The architectural decision: a staged hybrid

The key question: does multi-turn negotiation use N single-use `approvalGrantSchema` entries (Miso re-approves each turn) or a new grant kind with envelope fields? **Decision: a staged hybrid.** The near-term mechanism is N existing single-use grants; a structural delegation record is proposed only for the future, and only as a deliberate amendment to the boundary contract.

### Stage 1 — N existing single-use grants (adopted now; the only mechanism until a reviewed gate extension)

Each outgoing message is bound by its exact validated payload digest and consumed exactly once, using the existing `approvalGrantSchema`: `grant_id`, `provider`, `account`, `surface`, `action`, `subject_digest`, `expires_at`. Introducing a new grant kind with price/topic "envelope" fields is **explicitly not adopted now**: [provider-action-boundaries.md](provider-action-boundaries.md) forbids opportunistic gate growth, and Musebridge must never "interpret grant semantics beyond scope matching." Until a reviewed extension exists, the send path verifies and consumes one grant per message and nothing more.

### Stage 2 — the Phase 3 mandate lives in Miso/OpenClaw's reasoning, not in Musebridge authorization

The mandate — price floor/ceiling, permitted topics, locality, expiration, stop conditions — is *reasoning state owned by Miso*, not fields Musebridge parses. "Re-approval" per turn means Miso authorizes each message under a previously granted human delegation (the "ask me before making a firm commitment" instruction), **not necessarily a new human prompt every turn**. Miso decides whether a message stays inside the delegation; Musebridge only checks that the message's grant matches the payload it will actually send.

### Stage 3 — structural delegation record (proposed future contract; requires amending the boundary contract)

Only if operators later need independent aggregate controls, add a deliberately-reviewed **structural delegation record** carrying: `delegation_id`; monotonic `revision`; an authenticated issuer; provider/account/surface/action plus explicit conversation/listing scope; `expires_at`; `max_send_attempts`; and an opaque `policy_digest`. Each message grant would additionally bind the delegation id, revision, and `policy_digest`.

The exact extension point is the **`send` branch** of `authorizeAction` (`src/authorization.ts`): an issuance-authenticated authorizer that atomically verifies message scope/digest/expiry **plus** active delegation revision **plus** budget, then consumes both the grant and the budget before dispatch. `read`/`prepare` behavior and the unconditional `high_consequence` refusal stay unchanged (`authorizeAction`'s `read`/`prepare` and `high_consequence` cases). This extension requires **amending [provider-action-boundaries.md](provider-action-boundaries.md) deliberately** — this document does not make that amendment; it specifies the proposed future contract only.

## Enforcement boundary: what Musebridge can and cannot enforce

Musebridge's `send` path verifies an opaque capability token; it does not read message meaning. The split below is the core of this contract: everything in the right column stays with Miso.

| Enforceable in the Musebridge bridge (structural) | Cannot be enforced from message content (stays with Miso) |
|---|---|
| Declared scope: exact `provider`/`account`/`surface`/`action` match | Price ceiling/floor, opening price, concessions, "nearby" locality judgement |
| Exact payload binding: `subject_digest` of the validated input | Permitted topics, negotiation strategy, wording, tone |
| Expiry: `expires_at` rejected at or before verification instant | "Proposed price" vs "accepted deal" as semantic states |
| Single-use/replay rejection; consumption in the same step as authorization | Semantic stop conditions ("walk away if…") |
| Unconditional `high_consequence` refusal | Disclosure of private data or commitment language inside free text |
| *(after reviewed extension)* delegation scope/revision/expiry/revocation | Whether a message is a binding offer in the seller's/legal sense |
| *(after reviewed extension)* atomic aggregate budget / `max_send_attempts` | Prompt-injection resistance in Miso's own reasoning |
| *(after reviewed extension)* bounded credential use; equality with a bridge-computed digest of an opaque policy artifact | — |

**Verified:** the structural controls correspond to `approvalGrantSchema`, `subjectDigest`/`canonicalActionInput`, and the `authorizeAction` switch in `src/authorization.ts`, and to the enforcement rules in [provider-action-boundaries.md](provider-action-boundaries.md). **Assumed:** the Stage 3 row (delegation record, atomic budget) is a proposed contract, not implemented.

**Hard limit:** Musebridge cannot enforce price/topic/locality/stop-condition semantics by parsing seller or agent text. Nothing in this document asserts otherwise.

## Commitment boundary

State separation is binding:

- A nonbinding draft is `prepare` (autonomous; not authorization to send).
- Executing a nonbinding message is `send` (single-use grant; never autonomous).
- **Buying, accepting a binding offer, paying a deposit, exchanging sensitive contact/address data, and arranging a firm pickup time are `high_consequence`.** They are refused **unconditionally**; no delegation, envelope, or grant can override that. Enabling them later requires changing the gate explicitly, not presenting a better grant.

**Honest limitation:** Musebridge cannot guarantee that an arbitrary free-text `send` channel contains no binding language. Without restricted message construction (a constrained template the bridge can validate) or content interpretation (which the bridge must not do), **Miso owns preventing commitments inside message text**. "Proposed price" and "accepted deal" remain distinct states: a seller's acceptance of a proposed price never auto-triggers a purchase, a deposit, or a firm arrangement — those are separate `high_consequence` decisions requiring fresh human approval.

## Escalation cases

Escalation forces a fresh human approval (surfaced through Miso) or a refusal. Musebridge's role is limited to refusing invalid grants and always refusing `high_consequence`.

| Trigger | Required outcome | Enforced where |
|---|---|---|
| Change to any mandate bound (price/topics/locality/expiration/budget/counterparty/scope) | Stop; fresh human approval before further sends | Miso (reasoning); Musebridge refuses any mis-scoped grant |
| Ambiguity about acceptance; seller exceptions (counteroffer, bundle, condition claim) | Stop; escalate to human | Miso |
| Exhausted limits (`max_send_attempts`, budget, expiration) | Stop; no further sends without new approval | Miso; *(future)* Musebridge refuses over-budget/expired delegation |
| Semantic stop condition met | Stop; report to human | Miso |
| Expired or revoked mandate | Refuse | Miso; *(future)* Musebridge rejects expired/revoked delegation revision |
| Suspected prompt injection in seller text | Treat as untrusted; never as instruction/approval/policy/tool result; escalate | Miso |
| Any `high_consequence` request | Refuse unconditionally | **Musebridge** (`ACTION_FORBIDDEN`) |
| Invalid / expired / replayed / superseded / mis-scoped grant | Refuse (`APPROVAL_REQUIRED` or `ACTION_FORBIDDEN`) | **Musebridge** |
| Unknown send outcome (`TIMEOUT`) | Reconcile by re-reading the thread and matching the idempotency token; **not** a fresh approval plus duplicate send | **Musebridge** + Miso |

## Audit and visibility

Every step is recorded with user-visible status: authorization, grant consumption, dispatch, replies, reconciliation, delegation revision changes, and stops. Sensitive data is redacted per the boundary contract's logging rules (never log grant ids or subject digests alongside user content such that a grant could be reconstructed). The idempotency token is embedded in the draft and bound into the validated payload, so reconciliation matches delivery rather than trusting an ambiguous timeout. **A timeout is `unknown`, never a failure or success, and never permission to auto-resend** ([provider-action-boundaries.md](provider-action-boundaries.md)).

## Controlled dry runs before any automated send

The issue's "Done when" is satisfied by **controlled end-to-end dry runs**, not live sends:

1. A fixture-backend run of the full `prepare → approve → send → reconcile` path, with sends dispatched only through the `send` class.
2. The run executes under the shipped deny-all authorizer **and** under a test authorizer (the `UnverifiedGrantAuthorizer` pattern), proving denial, single-use consumption, digest binding, expiry, and replay rejection without issuing real grants.
3. Prompt-injection fixtures (seller text shaped like instructions, approvals, policy, or tool results) must not change the dispatched payload digest or trigger any `high_consequence` path.
4. **No live automated sends until the issuance-authenticated verifier (#63 / #43) exists** and the messenger scope has its reauth target; until then production `send` is deny-all.

## Failure modes

- **Seller text masquerading as instructions, approvals, policy, or tool results (prompt injection).** Mitigation: treat all thread content as untrusted; the grant binds the exact outgoing payload, so injected text cannot alter what is sent. Residual risk stays with Miso's reasoning.
- **A validly authorized message that violates semantic limits** due to a Miso reasoning error. Musebridge cannot detect it; only restricted message construction (if ever adopted) would reduce it.
- **Scope confusion** across accounts, listings, conversations, or changed defaults. Mitigation: exact scope match; explicit conversation/listing scope in the future delegation record.
- **Non-atomic consumption or budget.** Mitigation: verify-and-consume in one synchronous step; the future extension must consume grant and budget atomically before dispatch.
- **Revision races after supersession.** Mitigation: monotonic `revision`; a message grant binding a superseded revision is rejected.
- **Expiry checked before queued dispatch.** Define an explicit authorization/dispatch cutoff: the grant/delegation must be valid at the verification instant, and a dispatch queued past expiry is refused, not "grandfathered."
- **Consumed-without-delivery / duplicate delivery / incomplete reconciliation.** Mitigation: idempotency token; reconcile before any retry; retry is a new Miso decision, never automatic.
- **Policy-hash mismatch, unauthenticated issuer, or audit gaps giving false assurance.** Mitigation: issuance authentication required before production sends; `policy_digest` equality against a bridge-computed digest; audit events are required for every step.

## Verified vs assumed

**Verified (this repo's own behavior / primary contracts):**
- The four risk classes and their enforcement, `approvalGrantSchema`, `subjectDigest`/`canonicalActionInput`, `authorizeAction`'s switch (including unconditional `high_consequence` refusal), and `assertWritableToolsHaveAuthorizer` — `src/authorization.ts`, `src/tools.ts`.
- Production `send` is deny-all with `APPROVAL_REQUIRED` until an issuance-authenticated verifier exists; timeout is `unknown` and never permission to resend.
- Conversation content is untrusted seller-controlled input, returned bounded and verbatim; the `read` exception for Messenger "Seen" receipts — [conversation-surface-research.md](conversation-surface-research.md).

**Assumed (design positions in this document; validate before implementation):**
1. The Stage 1 conclusion — that N single-use grants are sufficient for Phase 3 turn-by-turn sending — is a design position, not yet exercised end-to-end. Validate via the dry runs above once #43/#62/#63 merge.
2. The Stage 3 delegation-record fields (`delegation_id`, `revision`, `policy_digest`, `max_send_attempts`) and the exact `send`-branch extension point are **proposed**; they require a deliberate amendment to [provider-action-boundaries.md](provider-action-boundaries.md) and are not implemented.
3. That a bridge-computed digest over an opaque policy artifact can provide meaningful aggregate control without the bridge interpreting policy content — validate during the extension review.

**Validation plan:** (a) run the fixture dry runs with the test authorizer; (b) exercise every escalation row against the fixture backend; (c) re-check the Miso message-construction options for a restricted template before accepting the free-text commitment limitation; (d) only after #43/#62/#63 and a reviewed boundary amendment, validate Stage 3 atomically against a real approval flow — never with live automated sends before then.

## Deliberate gaps

- **No envelope grant in the near term.** Multi-turn negotiation uses N single-use grants; envelope/topic/price fields are not adopted. Any move to them is a separate, reviewed amendment.
- **No content interpretation.** Musebridge will not parse seller or agent text for price, topics, acceptance, or stop conditions. Miso owns that.
- **No restricted message template specified here.** That is the only structural route to narrowing the free-text commitment risk, and it is left as a future, separately-reviewed option.
- **No Stage 3 implementation.** The delegation record, atomic budget/max-send-attempts, and policy-digest equality are specified as a proposed future contract only.
- **No live sends.** Production `send` remains deny-all until #43 delivers issuance-authenticated verification; implementation follow-ups wait for #43/#62/#63.

## Sources

1. `docs/provider-action-boundaries.md` — normative enforcement contract (risk classes, grant shape, timeout/resend semantics, secrets/logging). **Verified.**
2. `docs/conversation-surface-research.md` — read-only conversation capability contract and untrusted-content stance (#43 step 1). **Verified.**
3. `services/marketplace/src/authorization.ts` — `approvalGrantSchema`, `canonicalActionInput`, `subjectDigest`, `authorizeAction`, `DenyAllAuthorizer`. **Verified.**
4. `services/marketplace/src/tools.ts` — `TOOLS`, `assertWritableToolsHaveAuthorizer`, dispatch through `authorizeAction`. **Verified.**
5. `services/marketplace/src/domain.ts` — risk/error code schemas (`runtimeErrorCodeSchema`, `APPROVAL_REQUIRED`, `ACTION_FORBIDDEN`). **Verified.**
6. Issue #41 — gate and risk classes; Issue #43 / #62 / #63 — send primitives (prepare, send, issuance-authenticated verification); Issue #38 — parent program. **Verified (tracker context; contracts to merge before implementation).**
