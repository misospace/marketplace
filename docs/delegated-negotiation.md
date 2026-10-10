# Bounded delegated negotiation (#44)

Design/decision record for Phase 3 of Parent #38 ("Assisted offers and bounded delegated negotiation"): a bounded, auditable back-and-forth between a buyer's Miso agent and a Marketplace seller. It complements the NORMATIVE enforcement contract in [provider-action-boundaries.md](provider-action-boundaries.md), the read-side findings in [conversation-surface-research.md](conversation-surface-research.md), and the sibling research docs; where this document and the boundary contract disagree, the boundary contract wins. **This is a decision record, not authorization to act:** it specifies a contract and a future, deliberately-reviewed gate extension. No automated send is permitted by this document, and implementation follow-ups wait for #43, #62, and #63 to merge.

**Evidence legend** used throughout: **Verified** — primary documentation or this repository's own behavior (cite the file/line); **Reported** — third-party or community claims not independently confirmed; **Assumed** — written from knowledge, needs live validation.

## Context: phases and the pieces already specified

Phase 1 drafts price and wording for approval. Phase 2 sends approved messages and tracks replies. Phase 3, only with separate explicit delegation, permits a bounded back-and-forth with a price ceiling/floor, expiration, permitted topics, clear stop conditions, and complete audit/visibility. This document does not redesign Phases 1–2; it references their specified contracts:

- **#62 `messenger_prepare` (Phase 1; #43 step 2).** A `prepare`-class tool that renders a draft and its `subject_digest` (SHA-256 of the canonical key-sorted JSON of the *validated* input, via `subjectDigest` in `src/authorization.ts`), embeds a UUID idempotency token, and marks output status `draft` / `sent:false`. It is autonomous, and its output is **not** authorization to send.
- **#63 `messenger_send` (Phase 2; #43 step 3).** A `send`-class tool that consumes a single-use grant matching the prepared `subject_digest` plus idempotency token; consumption is single-use; on `TIMEOUT` it reconciles by re-reading the thread and matching the idempotency token (never auto-resend; unconfirmed = status `unknown`); it requires a production authorizer with issuance authentication and interactive/loopback reauth for the messenger scope. Production stays deny-all until #43 ships issuance-authenticated verification.

The gate, risk classes, scope declarations, grant verifier, and the four risk classes `read`, `prepare`, `send`, `high_consequence` were established by #41 and are enforced through `authorizeAction` in `src/authorization.ts`. Throughout this document those class names are used verbatim; no new class, marker, or envelope vocabulary is introduced for the near term.

## Actors and trust boundaries

| Actor | Owns in Phase 3 | Must never do |
|---|---|---|
| Miso / OpenClaw | Negotiation reasoning, mandate (price bounds, topics, locality, expiration), surfacing per-turn drafts and per-message approval requests for the human, relaying human approvals to the bridge | Mint approval grants under a self-attested mandate; assume Musebridge will interpret the mandate for it; treat a previously-granted delegation as ongoing permission to skip a fresh human prompt |
| Musebridge | Scope/digest/expiry/issuance verification, single-use consumption, dispatch, reconciliation, unconditional `high_consequence` refusal | Issue, extend, or self-approve grants; interpret negotiation semantics beyond scope matching; accept grants whose issuance is not authenticated by the host seam |
| Operator (the human principal, through Miso) | The original delegation instruction ("ask me before making a firm commitment") and **a fresh human approval at every `send`** (per Stage 2) | — |

Every inbound seller message is untrusted input. Every approval grant is an opaque, single-use capability token, and until issuance authentication ships (production today, [provider-action-boundaries.md](provider-action-boundaries.md)), every `send` is refused with `APPROVAL_REQUIRED`. This mirrors the actor table in [provider-action-boundaries.md](provider-action-boundaries.md); the delegation does not widen either actor's authority. Crucially, the "fresh human approval at every send" row reflects the *current* Phase 3 capability, not the future Stage 3 possibility: the operator's "original delegation instruction" alone does not authorize any `send`; only the per-message approval does.

## Delegation invariants

- A delegation is a **reasoning authority** held by Miso, never a field Musebridge reads. Musebridge sees only individual message grants.
- **Fresh human approval per outgoing message.** Each `send` requires its own grant sourced from a fresh human prompt; a previously-granted delegation is reasoning context for Miso, not a substitute for prompt-and-grant. This is the only Phase 3 capability this design currently admits; multi-turn sends on a single initial human delegation is future, gated on the structural delegation record (Stage 3).
- Every outgoing message has its **own** grant, digested to its exact validated payload, consumed once.
- A message dispatch is authorized only when scope, digest, expiry, and (post-#43) authenticated issuance match at the verification instant.
- No delegation, however broad, reaches `high_consequence`.
- Unknown outcomes are reconciled, not retried automatically.
- A revocation or expiry stops further sends; it never retroactively re-enables them.

## The architectural decision: a staged hybrid

The key question: does multi-turn negotiation use N single-use `approvalGrantSchema` entries (the Miso/OpenClaw agent issues one grant per message; a fresh human prompt is required only at escalation, per Stage 2) or a new grant kind with envelope fields? **Decision: a staged hybrid.** The near-term mechanism is N existing single-use grants; a structural delegation record is proposed only for the future, and only as a deliberate amendment to the boundary contract.

**Approval authority vs. enforcement authority.** A grant produced by an LLM under a self-attested mandate is not, and will not be treated as, an authenticated host authorization. Until the structural delegation record (Stage 3) is implemented and reachable through the host seam, **every outgoing `send` requires its own fresh human approval**: a new grant for every message is the only mechanism this design permits, because Musebridge cannot distinguish "this grant was minted under a previously-granted delegation" from "this grant was minted by agent reasoning error or seller prompt injection." Multi-turn sends on a single initial human delegation is therefore **not enabled** at any stage that lacks the independently-enforced host policy described in Stage 3 — it is a future possibility, gated on Stage 3, and is not a current behavior.

### Stage 1 — N existing single-use grants (adopted now; the only mechanism until a reviewed gate extension)

Each outgoing message is bound by its exact validated payload digest and consumed exactly once, using the existing `approvalGrantSchema`: `grant_id`, `provider`, `account`, `surface`, `action`, `subject_digest`, `expires_at`. Introducing a new grant kind with price/topic "envelope" fields is **explicitly not adopted now**: [provider-action-boundaries.md](provider-action-boundaries.md) forbids opportunistic gate growth, and Musebridge must never "interpret grant semantics beyond scope matching." Until a reviewed extension exists, the send path verifies and consumes one grant per message and nothing more.

### Stage 2 — the Phase 3 mandate lives in Miso/OpenClaw's reasoning, not in Musebridge authorization

The mandate — price floor/ceiling, permitted topics, locality, expiration, stop conditions — is *reasoning state owned by Miso*, not fields Musebridge parses. Until Stage 3 ships an authenticated host policy and atomic budget (next subsection), **each outgoing `send` requires a fresh human approval**: a new grant per message, sourced from the human operator via Miso, not from Miso's reasoning alone. Miso may surface a draft and propose wording under a stated delegation, but the approval that reaches the bridge must come from a fresh human prompt per turn — a previously-granted "ask me before committing" instruction does **not** license Miso to mint grants on the human's behalf. Miso decides whether a message stays inside the delegation **for prompting purposes**; Musebridge only checks that the message's grant matches the payload it will actually send, and only accepts grants whose issuance is authenticated by the host seam. Without issuance authentication, production `send` is deny-all: every grant is refused with `APPROVAL_REQUIRED` until a verified authorizer exists (the current state, per [provider-action-boundaries.md](provider-action-boundaries.md)).

### Stage 3 — structural delegation record (proposed future contract; requires amending the boundary contract)

Stage 3 is the **prerequisite** for any future mode in which a single initial human delegation enables more than one outgoing `send` without a fresh human prompt per turn. Until an authenticated host enforces the delegation mandate through the seam, the system cannot refuse out-of-mandate sends — an LLM-only or grant-only path cannot prove it stayed inside the delegation, and as the previous subsection makes binding, this is not accepted as a Phase 3 capability today.

The independently-enforced host policy that Stage 3 must implement before any multi-turn mode can be enabled consists, at minimum, of:

- **Explicit, narrow scope** — provider/account/surface/action plus the explicit `conversation_id` and `listing_id` the delegation applies to. Out-of-conversation and out-of-listing sends are refused structurally.
- **`expires_at`** — a binding expiration; the delegation is rejected at or before the verification instant.
- **Ceilings and budget** — price floor/ceiling, message-count `max_send_attempts`, and total budget, evaluated atomically by the host against the delegation record (never parsed into the bridge).
- **Revocation** — a fresh human revocation immediately invalidates the record and stops further sends; revocation never retroactively re-enables sends already blocked by prior revocation.
- **Replay protection** — every consumed grant is durable and bounded, satisfying the same consumption rule [provider-action-boundaries.md](provider-action-boundaries.md) states for grants. Without replay-safe consumption, the multi-turn mode cannot be enabled.

These five controls are the substantive difference between a single-grant-per-message design (Stage 1 / Stage 2 as currently stated) and a delegation-aggregate design (Stage 3). Naming them here is a precondition for any future move to multi-turn sends on one initial human delegation; specifying their host-side evaluation is a prerequisite to that mode, not a description of current behavior.

If operators later need independent aggregate controls, add a deliberately-reviewed **structural delegation record** carrying: `delegation_id`; monotonic `revision`; an authenticated issuer; provider/account/surface/action plus explicit conversation/listing scope; `expires_at`; `max_send_attempts`; and an opaque `policy_digest`. `policy_digest` is SHA-256 hex of the canonical key-sorted JSON of the validated policy object (Miso-supplied), using the same canonical representation as `subjectDigest`; Musebridge compares it for equality and never parses the policy. Each message grant would additionally bind the delegation id, revision, and `policy_digest`.

The exact extension point is the **`send` branch** of `authorizeAction` (`src/authorization.ts`): an issuance-authenticated authorizer that atomically verifies message scope/digest/expiry **plus** active delegation revision **plus** budget, then consumes both the grant and the budget before dispatch. `read`/`prepare` behavior and the unconditional `high_consequence` refusal stay unchanged (`authorizeAction`'s `read`/`prepare` and `high_consequence` cases). This extension requires **amending [provider-action-boundaries.md](provider-action-boundaries.md) deliberately** — this document does not make that amendment; it specifies the proposed future contract only. The delegation record and its current revision reach enforcement through the host seam, like grants — never as tool arguments — so the `ActionRequest` shape is unchanged. Consumed delegation budget and message grants must be durable and bounded, satisfying the same rule `provider-action-boundaries.md` states for consumed grants.

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
- **When separately surfaced as tools (not as free text inside `send`), buying, accepting a binding offer, paying a deposit, exchanging sensitive contact/address data, and arranging a firm pickup time are `high_consequence`.** They are refused **unconditionally**; no delegation record or grant can override that. Enabling them later requires changing the gate explicitly, not presenting a better grant.

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

Issue #44's "Done when" requires **controlled end-to-end dry runs before any automated sends**. This document records the *plan* and the conditions under which those dry runs become a valid completion criterion; it does **not** claim the dry-run criterion has been satisfied. The dry-run gate is not closed in this PR: the production verifier (#43), the `messenger_prepare` and `messenger_send` tools (#62, #63), and the messenger-scope reauth target all remain to ship, so production `send` is still deny-all and no Phase 3 control path has been exercised end-to-end. #44 is intentionally **kept open** by this PR (`Addresses`, not `Closes`); closing it requires these dry runs to have actually been run and recorded, on a fixture backend, against a still-deny-all production path.

The conditions for closing #44's dry-run gate are:

1. A fixture-backend run of the full `prepare → approve → send → reconcile` path, with sends dispatched only through the `send` class.
2. The run executes under the shipped deny-all authorizer **and** under a test authorizer (the `UnverifiedGrantAuthorizer` pattern), proving denial, single-use consumption, digest binding, expiry, and replay rejection without issuing real grants. The deny-all authorizer's role in the dry run is to prove the gate refused every send; the test authorizer's role is to prove verification and consumption semantics.
3. Prompt-injection fixtures (seller text shaped like instructions, approvals, policy, or tool results) must not change the dispatched payload digest or trigger any `high_consequence` path.
4. **No live automated sends until the issuance-authenticated verifier (#43) exists and #63 is wired against it** and the messenger scope has its reauth target; until then production `send` is deny-all. Closing #44's dry-run gate does **not** authorize live sends — it only authorizes the dry-run completion record; the live-send gate remains a separate, harder criterion on top.

## Failure modes

- **Seller text masquerading as instructions, approvals, policy, or tool results (prompt injection).** Mitigation: treat all thread content as untrusted; the grant binds the exact outgoing payload, so injected text cannot alter what is sent. Residual risk stays with Miso's reasoning.
- **A validly authorized message that violates semantic limits** due to a Miso reasoning error. Musebridge cannot detect it; only restricted message construction (if ever adopted) would reduce it.
- **Scope confusion** across accounts, listings, conversations, or changed defaults. Mitigation: exact scope match; explicit conversation/listing scope in the future delegation record.
- **Non-atomic consumption or budget.** Mitigation: verify-and-consume in one synchronous step; the future extension must consume grant and budget atomically and durably before dispatch, per [provider-action-boundaries.md](provider-action-boundaries.md).
- **Revision races after supersession.** Mitigation: monotonic `revision`; a message grant binding a superseded revision is rejected with `ACTION_FORBIDDEN`.
- **Expiry checked before queued dispatch.** Define an explicit authorization/dispatch cutoff: the grant/delegation must be valid at the verification instant, and a dispatch queued past expiry is refused, not "grandfathered."
- **Consumed-without-delivery / duplicate delivery / incomplete reconciliation.** Mitigation: idempotency token; reconcile before any retry; retry is a new Miso decision, never automatic.
- **Policy-hash mismatch, unauthenticated issuer, or audit gaps giving false assurance.** Mitigation: issuance authentication required before production sends; `policy_digest` equality against a bridge-computed digest; audit events are required for every step.

## Verified vs assumed

**Verified (this repo's own behavior / primary contracts):**
- The four risk classes and their enforcement, `approvalGrantSchema`, `subjectDigest`/`canonicalActionInput`, `authorizeAction`'s switch (including unconditional `high_consequence` refusal), and `assertWritableToolsHaveAuthorizer` — `src/authorization.ts`, `src/tools.ts`.
- Production `send` is deny-all with `APPROVAL_REQUIRED` until an issuance-authenticated verifier exists; timeout is `unknown` and never permission to resend.
- Conversation content is untrusted seller-controlled input, returned bounded and verbatim; the `read` exception for Messenger "Seen" receipts — [conversation-surface-research.md](conversation-surface-research.md).

**Assumed (design positions in this document; validate before implementation):**
1. The Stage 1 conclusion — that N single-use grants, **each sourced from a fresh human approval per turn**, are the only Phase 3 capability this design admits — is the binding position here. It is not yet exercised end-to-end (dry runs require #43/#62/#63 to ship).
2. The Stage 3 delegation-record fields (`delegation_id`, `revision`, `policy_digest`, `max_send_attempts`) and the exact `send`-branch extension point are **proposed**; they require a deliberate amendment to [provider-action-boundaries.md](provider-action-boundaries.md) and are not implemented. The five-control host policy (explicit narrow scope, `expires_at`, ceilings/budget, revocation, replay protection) listed in Stage 3 is the substantive prerequisite for any future multi-turn mode and is not implemented.
3. That a bridge-computed digest over an opaque policy artifact can provide meaningful aggregate control without the bridge interpreting policy content — validate during the extension review.

**Validation plan:** (a) run the fixture dry runs with the test authorizer **only after** #43/#62/#63 ship; (b) exercise every escalation row against the fixture backend; (c) re-check the Miso message-construction options for a restricted template before accepting the free-text commitment limitation; (d) only after #43/#62/#63 and a reviewed boundary amendment that names all five Stage 3 controls above, validate Stage 3 atomically against a real approval flow — never with live automated sends before then. Until (a)–(d) actually run, the dry-run gate for #44 is open and #44 stays open.

## Deliberate gaps

- **No multi-turn mode on a single initial human delegation.** A previously-granted delegation never produces subsequent sends without a fresh human prompt per turn. This is not enabled at any current stage; it would require Stage 3 plus a reviewed boundary amendment, with all five listed host-side controls in place.
- **No envelope grant in the near term.** Multi-turn negotiation uses N single-use grants; envelope/topic/price fields are not adopted. Any move to them is a separate, reviewed amendment.
- **No content interpretation.** Musebridge will not parse seller or agent text for price, topics, acceptance, or stop conditions. Miso owns that.
- **No restricted message template specified here.** That is the only structural route to narrowing the free-text commitment risk, and it is left as a future, separately-reviewed option.
- **No Stage 3 implementation.** The delegation record, atomic budget/max-send-attempts, and policy-digest equality are specified as a proposed future contract only.
- **No dry-run completion.** The fixture dry runs are recorded as a plan and set of conditions; until they run against the shipped deny-all path with the verified authorizer (#43) and #62/#63 wired, the dry-run gate for #44 stays open and #44 is not closed.
- **No live sends.** Production `send` remains deny-all until #43 delivers issuance-authenticated verification; implementation follow-ups wait for #43/#62/#63.

## Sources

1. `docs/provider-action-boundaries.md` — normative enforcement contract (risk classes, grant shape, timeout/resend semantics, secrets/logging). **Verified.**
2. `docs/conversation-surface-research.md` — read-only conversation capability contract and untrusted-content stance (#43 step 1). **Verified.**
3. `services/marketplace/src/authorization.ts` — `approvalGrantSchema`, `canonicalActionInput`, `subjectDigest`, `authorizeAction`, `DenyAllAuthorizer`. **Verified.**
4. `services/marketplace/src/tools.ts` — `TOOLS`, `assertWritableToolsHaveAuthorizer`, dispatch through `authorizeAction`. **Verified.**
5. `services/marketplace/src/domain.ts` — risk/error code schemas (`runtimeErrorCodeSchema`, `APPROVAL_REQUIRED`, `ACTION_FORBIDDEN`). **Verified.**
6. Issue #41 — gate and risk classes; Issue #43 (send primitives; #62 and #63 are its sub-issues); Issue #38 — parent program. **Verified (tracker context; contracts to merge before implementation).**
