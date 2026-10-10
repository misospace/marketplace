# Commerce checkout and purchasing boundaries (#49)

This document complements [`provider-action-boundaries.md`](provider-action-boundaries.md), which remains the normative authorization contract. It records research and design decisions only; it does not enable or implement live checkout capability.

## Decision in brief

**Decision: permit only autonomous, non-mutating preparation and preview; refuse purchasing.** Shopping reads remain unchanged. A local cart manifest and a provider-backed preview are separate `prepare` actions with no external effect. `purchase`/`charge` is `high_consequence` and returns `ACTION_FORBIDDEN` unconditionally. No grant, approval, or preview authorizes a purchase.

## Transaction-risk policy

**Risk classes and permissions.** The existing classes are `read`, `prepare`, `send`, and `high_consequence` (`authorization.ts:4`). Apply them as follows:

| Action | Risk class | Policy |
|---|---|---|
| Shopping browse/search | `read` | Autonomous; unchanged (`tools.ts:63-75`) |
| Cart prepare | `prepare` | Autonomous; local-only manifest, no provider write |
| Checkout preview | `prepare` | Autonomous; only non-mutating provider reads/quotes |
| Purchase/charge | `high_consequence` | Refused unconditionally with `ACTION_FORBIDDEN` |

The gate accepts `read` and `prepare`, but refuses `high_consequence` before consulting an authorizer (`authorization.ts:70-84`). No grant or approval for one action authorizes another. A `prepare` result is never authorization to purchase. Existing grant fields bind scope, action, and subject digest (`authorization.ts:18-26`); the registered shopping reads use `(ebay, default, shopping)` (`tools.ts:36-38`), and policy failures use the runtime error vocabulary (`domain.ts:162-168`).

**No silent substitution.** Pin provider/merchant, exact item and variant ids, quantity, unit price, currency, and canonical offer URL in the transaction. Fail closed if the requested variant cannot be resolved from provider facts; never choose a nearby variant or substitute merchant silently.

**No silent spend.** Any future purchase approval must bind the exact final amount and currency and an explicit spend ceiling. A change in price, tax, shipping, availability, or other bound transaction fact invalidates approval and requires a fresh preview and re-approval. No estimate may be treated as a final amount.

**No disclosure of credentials or saved values.** Payment methods and shipping addresses are opaque references only. Raw saved values are never tool arguments, output, logs, or persisted data; Musebridge does not custody them. Destination-dependent provider quoting is out of scope. If added later, it must be a non-mutating quote with strict no-log/no-persist handling.

**Retries and duplicate orders.** A `TIMEOUT` or unknown future purchase outcome is never permission to retry. Reconcile by idempotency key and order state first; any retry requires a new approval. Future execution must combine a single-use grant, idempotency key, and deduplication on confirmation. Unknown outcomes remain unknown, not success or failure.

**Inventory and landed cost.** Re-check availability at preview and immediately before any future execution; out-of-stock fails closed. Only provider-computed tax and shipping amounts are final. If a source provides estimates, label them as estimates and never use them as final checkout values. The current shopping research says seller-listed shipping is not destination-validated (`shopping-provider-research.md:48-53`).

**Auditable confirmation.** If a future purchase is separately enabled, return a bounded receipt containing order id, provider, amount, currency, line items, timestamp, and idempotency key—never payment or address details. Record refusals and unknowns as normal tool responses, not as service-failure logs; the existing boundary contract treats authorization refusals as normal responses (`provider-action-boundaries.md:70-80`).

## Proposed minimal tools

**Three tools, proposals only—not implemented.** Cart preparation consumes facts already obtained through `shopping_fetch`/`shopping_search`. `ProductOffer` currently identifies the provider offer, canonical id and URL, price, currency, condition, availability, shipping facts, and update timestamp (`domain.ts:89-107`); it does not define checkout or variant selection, so variant resolution must be explicit and fail closed.

```ts
// Proposed, not implemented
commerce_cart_prepare: {
  risk: 'prepare',
  input: { lines: Array<{ provider: string; offer_id: string; variant_id: string | null; quantity: number }> },
  output: {
    manifest: CanonicalLineFacts[],
    manifest_digest: string,
    committed: false,
    authorized: false
  }
}
```

`commerce_cart_prepare` is local-only: it constructs a canonical transaction manifest from read facts and performs no provider cart write. A provider-side cart write, if ever wanted, is a distinct write-class decision outside this wave. The manifest pins provider/merchant, item and variant ids, quantity, unit price, currency, and canonical URL. It reports stale/missing facts rather than manufacturing them. Each line is traceable to the source offer; a manifest digest identifies those normalized facts, not an authorization token. Repeating cart preparation must not silently broaden or alter the requested line set.

```ts
// Proposed, not implemented
commerce_checkout_preview: {
  risk: 'prepare',
  input: { cart_ref: string; destination_ref: string; payment_ref: string },
  output: {
    lines: ConfirmedLineFacts[],
    subtotal: Money | null,
    seller_listed_shipping: Money | null,
    destination_amounts: 'unknown',
    currency: string | null,
    availability: string,
    quote_expires_at: string | null,
    transaction_digest: string,
    committed: false,
    authorized: false
  }
}
```

`commerce_checkout_preview` may call only operations that create no order, hold, reservation, or other state change. Any inventory-reserving operation is a write, not a preview, and must be gated separately. Return authoritative line facts where available—unit price, currency, quantity, availability, and seller-listed shipping. Separate destination-dependent tax and shipping as explicitly unknown; do not estimate them. The preview never charges or commits. `transaction_digest` binds the exact transaction and is the only valid subject for any future purchase approval grant.

```ts
// Proposed, documented but not enabled
commerce_purchase: {
  risk: 'high_consequence',
  input: { transaction_digest: string },
  result: { ok: false; error: { code: 'ACTION_FORBIDDEN' } }
}
```

**Scope and backend seam.** Proposed scope: `(ebay, default, commerce)`, distinct from `(ebay, default, shopping)` so transaction permissions are separable (`tools.ts:36-38`). Follow the existing optional-backend injection pattern used for `shopping?` and `conversations?` (`tools.ts:99-109`, `tools.ts:236-237`; shopping construction at `service.ts:96-101`, conversations at `service.ts:186-195`): add a `commerce?` seam that fails closed when unconfigured, with fixture backend as the default and credentials supplied only through the environment. This is a design proposal, not a claim that such a seam exists today. No provider endpoint or checkout API is assumed.

## Safe preview/dry-run path

**The preview is the dry-run.** Exercise the full `commerce_cart_prepare` → `commerce_checkout_preview` path using fixture-backed data first. Preparation is local-only; preview may perform only non-mutating reads/quotes. Both outputs explicitly say `committed: false` and `authorized: false`; no provider cart, order, hold, reservation, or charge is created. The `commerce_purchase` step remains refused. A fixture success validates contract shape only, not provider behavior or live availability.

## Provider capability finding

**No evaluated provider has a sanctioned consumer cart/checkout/charge API available to a solo operator.** Therefore any future live checkout would be a browser-based `high_consequence` decision, not a v1 API integration. This finding is not permission or a recommendation to automate browser checkout.

| Provider | Finding | Evidence status |
|---|---|---|
| eBay | Production Buy APIs are partner-gated by an Application Growth Check; a personal assistant is not an exemplar use case. | Existing repository research; official docs are auth-gated (`shopping-provider-research.md:37-46`). The docs' gate and exemplar details are reported by that research, not independently revalidated here. |
| Best Buy | Developer API is product discovery only, not consumer checkout/charge. | Checked against official docs in the shopping-provider research; no checkout capability found. |
| Amazon | Consumer APIs are affiliate-gated; PA-API v5 is deprecated and Creators API requires qualifying sales. | Checked against official docs/program pages in the shopping-provider research. |
| Facebook Marketplace | No API; access is browser-only. | Assumed capability finding, not live-site validation. The marketplace and conversation research document browser-only access and no sanctioned consumer API (`shopping-provider-research.md`; `conversation-surface-research.md:14-21`). |

## What is verified vs assumed

**Verified in this repository:** `read` and `prepare` are autonomous, `high_consequence` is refused before authorizer consultation, and the refusal code is `ACTION_FORBIDDEN` (`authorization.ts:70-84`). Tool declarations carry risk class and scope (`tools.ts:40-90`); shopping is currently read-only and uses a fixture-default optional backend seam (`tools.ts:99-109`, `tools.ts:236-237`; `services/marketplace/README.md:47-50`). `ProductOffer` has the existing fields cited above; it does not provide a transaction, quote, or payment contract (`domain.ts:89-107`).

**Verified by the existing provider research:** Best Buy is discovery-only; Amazon's consumer path has affiliate eligibility constraints; and eBay production Buy APIs are gated. The cited eBay material is auth-gated and documented as repository research rather than independently reproduced here (`shopping-provider-research.md:19-24`, `:37-46`, `:55-68`).

**Assumed / pending validation:** Facebook Marketplace has no sanctioned API and is browser-only for this use case. No evaluated source has a sanctioned solo-operator consumer cart/checkout/charge API. Provider preview operations, if any, are non-mutating and return authoritative values; this document assumes no such operation until validated. The proposed manifest, quote, opaque-reference, and digest contracts are design decisions, not verified provider behavior. No endpoint path, API operation, or response field is asserted here.

## Deliberate gaps this wave

- No cart writes to providers, orders, bids, offers, holds, reservations, checkout commits, charges, or purchase retries.
- No live `commerce_purchase` implementation or route to authorize it; a better grant cannot override the current `high_consequence` refusal.
- No destination-dependent provider quote or collection of address/payment data. Opaque references are interface values only; this wave does not resolve or store them.
- No provider-specific checkout endpoint research beyond the capability findings above, and no claim that any preview can currently produce destination-final amounts.
- No alternate retailer selection, variant guessing, price/tax/shipping estimation, or fulfillment promise.

## Preconditions for any future purchase change

**All conditions are mandatory before reconsidering the refusal.** A separately reviewed change to the `high_consequence` gate must establish:

1. An issuance-authenticated grant verifier, meeting the #43 requirement and strengthened for purchase approval; an unverified or host-fabricated grant is insufficient.
2. A single-use grant bound to the exact `transaction_digest`, including merchant/provider, exact item and variant ids, quantities, final amount and currency, shipping destination reference, and payment action.
3. Durable, bounded single-use consumption that remains safe across process restarts and concurrent execution.
4. An idempotency key and order reconciliation for `TIMEOUT` or any unknown result; no blind retry.
5. Operator approval of the exact transaction and its final amount, currency, and ceiling.
6. Confirmed provider access and Terms of Service that permit the intended method and use.

Failure of any precondition means `ACTION_FORBIDDEN` remains the outcome. This list does not authorize work on live checkout.

## Validation plan

1. Keep the current shopping read path unchanged and use synthetic fixtures only to validate the proposed cart manifest and preview response shapes.
2. Review that cart preparation makes no network/provider call; inspect preview adapters, if later proposed, to establish that they cannot create orders, holds, reservations, or other state changes.
3. Validate fail-closed behavior for unresolved variants, unavailable items, missing prices/currencies, expired quotes, and any transaction fact changing between manifest and preview.
4. Verify by inspection and synthetic tests that opaque destination/payment references are never expanded into raw values in tool inputs/outputs, logs, persistence, fixtures, or errors.
5. Confirm the purchase tool remains refused with `ACTION_FORBIDDEN`, including when an approval grant is supplied; no live checkout testing is in scope.
6. Before any future provider quote research, confirm sanctioned access and Terms of Service, and prove the operation is non-mutating. Update verified/assumed findings before relying on provider data.
