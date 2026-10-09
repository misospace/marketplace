# Shopping provider research (#48)

Parent: #38 (verticals). Issue: #48. Status: research complete, awaiting provider-choice confirmation before implementation. The consolidated cross-capability inventory and integration-path decision record is [`capability-inventory.md`](capability-inventory.md) (#39); this document remains authoritative for the shopping vertical.

## What the shopping vertical needs

Miso compares real purchasable products — price, stock, shipping, listing provenance — across sources, focused on hardware, solar panels, batteries, and electronics. Today she can only read Facebook Marketplace. The issue asks for three things before any browser automation is chosen:

1. An inventory of candidate provider surfaces and existing APIs/plugins.
2. A provider choice, documented.
3. A minimum shared product data contract, so retailer inventory facts stay separate from Miso's deal scoring and watch scheduling (those are consumer-side; Musebridge returns facts only).

No cart writes in this umbrella — everything here is `read`-class or does not exist yet.

## Access paths evaluated

Researched against official developer documentation and program pages as of October 2026. Access-bar ratings are about solo-operator friction, not money.

| Source | Sanctioned path | Access bar | Search | Item detail | Stock | Price + shipping | Price history | Canonical IDs | Currency | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **eBay** | Browse API (dev key self-serve; **production access requires an Application Growth Check approval**) | ★★ key instant, production gated | ✅ | ✅ | ✅ | ✅ | ❌ (Marketplace Insights is Limited Release — closed to new users) | ✅ `itemId`/`ePID` | ✅ per-marketplace | **Coverage winner; access must be confirmed at registration** |
| **Best Buy** | Developer API (free self-serve key, production included) | ★ very low | ✅ | ✅ | ✅ incl. store-level | ✅ | ❌ | ✅ SKU | ❌ USD only | **The reliably accessible fallback** — instant key, single retailer |
| **Amazon** | Creators API (PA-API v5 retired ~May 2026) | ★★★ — requires 10 qualifying affiliate sales in trailing 30 days before keys | ✅ | ✅ | ✅ | ✅ | ❌ (Keepa, paid) | ✅ ASIN | ✅ per-locale keys | Blocked for a new personal account; revisit later |
| **Walmart** | Affiliate API | ★★ affiliate approval; product-data API separately gated | ✅ | partial | ❌ | ✅ | ❌ | ✅ | ❌ USD | Affiliate-link-shaped, weak coverage |
| **AliExpress** | Open Platform affiliate track | ★★ app audit + identity verification (passport for individuals), ~3–5 days | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | Viable later; friction up front |
| **Newegg** | Marketplace API | seller-side only | — | — | — | — | — | — | — | Not a buyer-discovery API |
| **Target** | Partner API | business partnership only | — | — | — | — | — | — | — | No public path |
| **Home Depot / Lowe's** | none | — | — | — | — | — | — | — | — | No sanctioned path; scraping is ToS-violating |
| **Google Shopping** | Merchant API (merchants submit their own data) | — | — | — | — | — | — | — | — | Not a consumer price-query API; scraping violates ToS |
| **Craigslist** | none | — | — | — | — | — | — | — | — | ToS explicitly prohibits automated collection — excluded |
| **OfferUp / KSL** | none | — | — | — | — | — | — | — | — | No API; manual surfaces only |
| **Keepa** | paid API (~€49/mo) | ★ but paid | ✅ | ✅ | ✅ | ✅ | ✅✅ core feature | ✅ ASIN | ✅ | The Amazon price-history answer, when/if Amazon matters |
| **camelcamelcamel** | no official API | — | — | — | — | — | — | — | — | Manual research only |

Prior-art survey (not dependencies): the MCP ecosystem has several shopping servers — eBay official (`@ebay/npm-public-api-mcp`, read-only GET), community `ebay-mcp` (sell-side), `shopping-deals-mcp-server` (multi-source, Python, mixes official APIs with scraping) — useful as references for API shapes and failure modes, none suitable for adoption into this TypeScript monorepo. Craigslist-scraping servers exist and are excluded for the same ToS reason.

## The recommended source: eBay Browse API — with an honest access caveat

Why eBay is still the coverage winner for this use case:

- **Best data coverage** for the contract below: keyword/category/condition/price-range search, item detail with condition and seller info, availability, price with shipping service options, canonical RESTful item IDs plus `ePID` for catalog-level normalization, per-marketplace currency/locale handling.
- **No browser.** A plain HTTPS API with an application token means no browser profile, no session probe, no login, no read-receipt-style side effects, no reauth console. The whole session machinery this service needed for Facebook simply does not apply.

**The caveat (corrected after initial research overstated it):** eBay's developer key is self-serve, but per the official Buying Application guide, production access to the Buy APIs "is intended for certain approved eBay partners" and requires a mandatory **Application Growth Check** before a production keyset can call the restricted Buy APIs — with acceptance based on the proposed business model. A personal read-only shopping agent is not one of the guide's exemplar use cases (affiliate, member checkout, guest checkout, Offer API), so **whether this operator gets production Browse access is an open question that only registration can answer**. The **Marketplace Insights API** (sold-item history) is a Limited Release that is not open to new users — sold-price benchmarking is *not* a benefit this design can assume. An early correction of the same kind: the marketplace id header is `EBAY_US` (underscore), which matters for every real call.

Consequently: this implementation ships fixture-first and the "first usable non-Facebook source" claim in #48 is **conditional on the operator confirming production Browse access at registration**. If it is not granted, the fallback is **Best Buy** — its key is instant and includes production — at the cost of single-retailer coverage and USD-only. Registration at developer.ebay.com is cheap; the growth-check outcome is the deciding fact.

Honest caveats that hold either way:

- **Rate limits**: on the order of thousands of calls/day on default tiers (confirm exact numbers on the developer dashboard; do not trust the research figure).
- **Quantity/availability divergence**: reported quantities are known to diverge from live state for multi-quantity listings. Treat stock as a fact with a timestamp, not a guarantee.
- **Shipping figures are not destination-validated.** No `X-EBAY-C-ENDUSERCTX` context is sent, so returned shipping costs reflect the listing's own shipping setup, not a landed-cost quote to the operator's address. Treat `shipping_cost` as an origin-side fact; threading a configured delivery destination is a follow-up, not part of this wave.
- **ToS**: API use for personal tooling is fine; reselling data or building a competing marketplace is not. Direct scraping of ebay.com remains prohibited — API only.

## What is verified vs assumed

**Verified against official program/docs pages (Oct 2026):** eBay self-serve key issuance and free tier; Best Buy self-serve key with production included; Amazon's sales-threshold prerequisite and PA-API v5 retirement; Target/HD/Lowe's/Google lacking public discovery APIs; Craigslist ToS prohibition; Keepa pricing tiers. **Verified from the official Buying Application guide (and initially missed):** production Buy API access requires an Application Growth Check approval keyed to the proposed business model, and Marketplace Insights is a Limited Release closed to new users — access and coverage are separate gates and only the first was verified initially.

**Assumed / to verify during implementation** (marked so they are checked at key-acquisition and first-live-call time, not trusted blindly):

0. **Whether this operator is granted production Browse access at all** — the Application Growth Check outcome is the gating fact for the whole eBay path; check it first at registration.

1. Exact Browse API endpoint paths and response field names — to be confirmed against the official Browse API reference when the client is written; the survey above establishes coverage, not spelling.
2. Current default rate-limit numbers (the 5,000/day figure is from docs summaries; confirm on the developer dashboard once keys exist).
3. ~~Marketplace Insights API availability scope for a brand-new application~~ — resolved: the official Buying Application guide states Marketplace Insights is a Limited Release closed to new users; sold-price benchmarking is not available to this operator and is not part of any plan.
4. OAuth client-credentials token lifetime and refresh behavior (implement token caching with proactive refresh and a typed error on 401 regardless).

The synthetic-identities-only policy still applies to testing: the eBay backend is built against fixture HTTP responses first; live calls happen only with an operator-issued key in the environment.

## Minimum shared product data contract (proposal)

One typed shape that any shopping source (eBay now, Best Buy/AliExpress later, Marketplace bridged later) can fill. Facts only — deal scoring, watch scheduling, and ranking stay in Miso.

```ts
productOffer = {
  provider: string                  // 'ebay' | 'bestbuy' | 'facebook' | ...
  id: string                        // provider-canonical item id (eBay itemId, Best Buy SKU)
  product_id: string | null         // catalog-level id when the provider has one (eBay ePID)
  url: string                       // https canonical item URL (link provenance)
  title: string
  price: number | null              // in currency
  currency: string                  // ISO 4217, 3 chars
  condition: 'new' | 'used' | 'refurbished' | 'unknown'
  availability: 'in_stock' | 'out_of_stock' | 'preorder' | 'unknown'
  shipping_cost: number | null      // null when the source does not separate it
  shipping_currency: string | null
  location: string | null
  seller: { id?, name?, url? } | null
  posted_at: string | null          // ISO 8601
  updated_at: string | null
  images: string[]                  // https, bounded
  state: 'active' | 'sold' | 'pending' | 'removed' | 'unknown'   // same vocabulary as listings
}
```

Design points:

- **`productOffer` is a superset-shaped sibling of the existing `listing` schema**, not a replacement: `listing` stays exactly as deployed for Facebook tools. Anything `listing` already carries keeps its field name in `productOffer` so a later unified comparison layer can union the two without remapping.
- **Provenance is structural**: `provider` + canonical `url` on every offer, so Miso can always click through to the source and can attribute any price claim to a specific surface.
- **Availability is a snapshot, not a promise**: `availability` + `updated_at` carry the timestamp semantics; consumers treat stock as stale-by-default.
- **Condition enters the contract explicitly** — the Facebook `listing` shape implies used-goods context; a cross-retailer contract cannot.
- Search output: `{ ok: true, provider, offers: productOffer[] }`; fetch: `{ ok: true, provider, offer: productOffer }`; failures use the existing typed `ProviderError` code set (all existing codes are already provider-agnostic in name despite the Facebook heritage).

## Where it plugs into the service

The architecture recon found the seams already exist:

- The `MarketplaceBackend` search/fetch interface and the `conversations?` optional-backend seam (added in #60 for Messenger) are the pattern: a second optional backend (`shopping?`) injected the same way, with tools that fail closed with a typed error when it is not configured — exactly how the Messenger tools behave when `MARKETPLACE_MESSENGER` is off.
- New tools `shopping_search` and `shopping_fetch` in the registry, scope `(ebay, default, shopping)` under the #41 model: `read` class, autonomous, no grant, no browser session — the "session" dimension for this scope is the API token being configured or not.
- Configuration seam: `SHOPPING_BACKEND=fixture|ebay` (default `fixture` so the tool list is stable without keys, mirroring the Messenger opt-in pattern); the key material comes from env at call time and is never logged.
- Facebook-specific artifacts that need touching: `marketplace_status` output gains a provider-keyed session/config block rather than assuming `facebook_session`; everything else (`authorization.ts`, `backend.ts`, error codes) is already provider-agnostic.

Alternatives considered: a separate `services/shopping` package (rejected for now — one MCP server, one tool registry, and the seams above make a second package premature); fitting eBay into the existing `marketplace_search`/`marketplace_fetch` tools via a new `backendKind` (rejected — those tools' semantics and deployed contracts are Facebook-listing-shaped, and preserving deployed behavior beats notational tidiness).

## Safety notes

- Everything in this wave is `read`-class: no cart, no checkout, no bids, no offers, no watch-list writes. The boundary contract's send/high-consequence classes remain untouched.
- No browser session means no presence, no receipts, no profile isolation concerns for this scope.
- Seller-supplied text (titles, descriptions) is untrusted content returned verbatim as tool output — same posture as Marketplace listings and Messenger messages; interpretation is Miso's.
- API key material lives in env, is never logged or echoed in tool output, and a missing key fails closed with a typed error while the tool stays listed and documented.

## Deliberate gaps this wave

- **No Amazon.** Blocked by affiliate-sales prerequisites; revisit only if the operator decides the Keepa/API budget is worth it.
- **No price history endpoint** in the first slice, and none is planned: Marketplace Insights (sold-item history) is a Limited Release closed to new users, so sold-price benchmarking is not attainable through eBay's sanctioned path for this operator.
- **Single marketplace locale, hardcoded `EBAY_US`.** The client pins the marketplace id header and the search price-filter currency; multi-locale is a parameter later, not a design change (the code carries a comment marking where to thread it).
- **eBay mapping covers a subset of the `state` vocabulary.** Live eBay responses only ever produce `state: 'active'` or `'unknown'` (an ended item is unknown, never `sold` — these endpoints cannot prove a sale); `sold`/`pending` appear only in the synthetic fixtures. Documented so consumers do not read the enum as a promise.
- **No comparison logic in Musebridge.** Cross-site ranking/deal scoring is Miso's job; Musebridge returns facts per source.

## Validation plan

1. Operator registers at developer.ebay.com and provisions keys (the one manual step this vertical needs; no account credentials are shared with Musebridge — it is an application token, not a login). **First finding to record: whether production Browse access is granted directly, requires an Application Growth Check, or is refused** — and, if refused, whether the Best Buy fallback becomes the designated first source.
2. Implementation proceeds fixture-first: typed client against recorded fixture responses, then one live search + one live fetch with the operator's key to validate assumption items 1–4 above.
3. Results of the live validation are appended to this doc (verified vs assumed list updated) before the tools are treated as production-reliable — same bar as the Messenger extraction contract.
