# Reservations and events research (#50)

Parent: #38 (verticals). Issue: #50. Status: research complete; one read-only event-availability case demonstrated fixture-first. Restaurant reservations remain partner-gated with no sanctioned read path. No booking, hold, or purchase write path exists. Live validation of the Ticketmaster route is pending an operator key.

## What the reservations/events vertical needs

Miso locates restaurants and events, compares real availability and ticket options, and prepares bookings — while every reservation, ticket purchase, and cancellation stays explicit and operator-approved. The issue asks for four things before any booking capability is considered:

1. Choose the top provider routes for restaurant reservations and event tickets.
2. Demonstrate read-only availability for one case.
3. Report exact party/date/time or seat/price constraints, and handle holds, fees, cancellation rules, and expiring offers.
4. Keep availability lookup strictly separate from a confirmed booking: an external write or purchase requires user approval, and confirmation is captured from the provider — never inferred from a click or a UI state.

This wave delivers (1) and (2): provider evaluation, a chosen event route, and a fixture-first read-only events surface. It documents (3) and (4) as boundaries. No cart, hold, reservation, or purchase write exists in this change.

## Access paths evaluated

Researched against official developer documentation and program pages as of October 2026. Access-bar ratings are about solo-operator friction, not money. `VERIFIED` means confirmed by reading official documentation; `ASSUMED` means inferred from the absence of documentation or from incomplete access.

### Restaurant reservation platforms

| Provider | Sanctioned path | Access bar | Availability semantics | ToS / automation posture | Verdict |
|---|---|---|---|---|---|
| **OpenTable** | Partner-only API | ★★★ approval-gated partner program | Exact party-size / date / time slots | No public API; scraping prohibited (`VERIFIED`) | **Not available** to a solo operator |
| **Resy** | None found | — | Browser-only access | No public API; ToS prohibits scraping (`VERIFIED`) | **No sanctioned read path** |
| **Tock** | None found | — | Browser-only | No public API found; terms likely prohibit scraping (`ASSUMED`) | **No sanctioned read path** |
| **SevenRooms** | None found | — | No availability info surfaced | No public API found; B2B product (`ASSUMED`) | **Not applicable** |
| **Yelp Fusion** | Self-serve API key (private key) | ★ low | Business info / ratings / hours; **no reservation slots** | Commercial use requires a paid license (`VERIFIED`) | **Business metadata only — not availability** |

**Key finding:** no major restaurant reservation platform offers a self-serve read-only availability API for solo operators. OpenTable's API is partner-only, Resy has no public API, and Yelp Fusion returns business data but not real-time reservation slots.

### Event / ticket providers

| Provider | Sanctioned path | Access bar | Availability semantics | ToS / automation posture | Verdict |
|---|---|---|---|---|---|
| **Ticketmaster Discovery API v2** | Self-serve `apikey` query param | ★ very low | Event-level on-sale status, price ranges, on-sale windows; **no seat-level inventory** | ToS compliance required; scraping prohibited (`VERIFIED`) | **Chosen** — only major self-serve read-only event API found |
| **Ticketmaster Inventory Status API** | Partner-gated (`devportalinquiry@ticketmaster.com`) | ★★★ approval | Event-level `TICKETS_AVAILABLE` / `FEW_TICKETS_LEFT` / `TICKETS_NOT_AVAILABLE` plus min/max price | Access-controlled partner API (`VERIFIED`) | **Not available now** — possible later upgrade |
| **Eventbrite API v3** | Private key / bearer token | ★★ self-serve for organizers | Organization-owned events only; ticket classes via `for_sale` endpoint | **Public event search shut down Dec 12, 2019** (`VERIFIED`) | **Rejected for discovery** — no way to find events |
| **SeatGeek** | Unknown | Unknown | Assumed event listings | Assumed scraping prohibited | Not evaluated — docs portal JS-gated |
| **StubHub** | Unknown | Unknown | Assumed event listings | Assumed scraping prohibited | Not evaluated — docs not accessible |
| **AXS** | Unknown | Unknown | Assumed event listings | Assumed scraping prohibited | Not evaluated — docs portal JS-gated |
| **Dice** | Unknown | Unknown | Assumed event listings | Assumed scraping prohibited | Not evaluated — docs not accessible |

**Key finding:** Ticketmaster Discovery API v2 is the only major self-serve read-only event availability API found. Eventbrite killed public event search in 2019, and the other ticket providers could not be assessed from official docs.

## The chosen routes

### Events → Ticketmaster Discovery API v2

Ticketmaster Discovery API v2 wins the event case:

- **Self-serve, instant key.** Registration at [developer.ticketmaster.com](https://developer.ticketmaster.com/) issues an `apikey` with no approval step for read operations (`VERIFIED`).
- **Event-level availability facts** the vertical needs: on-sale status via `dates.status.code`, on-sale windows via `sales.public.startDateTime` / `endDateTime`, price ranges via `priceRanges[]`, venue via `_embedded.venues[]`, classification via `classifications[]`, images via `images[]`, and a canonical purchase URL via `url` (`VERIFIED` field paths).
- **No browser.** A plain HTTPS API means no browser profile, no session probe, no login, no reauth console. The session machinery this service needed for Facebook does not apply.
- **Coverage.** 230K+ events across 25+ markets (`VERIFIED`).

**The honest caveat:** Discovery is **event-level only**. It returns no per-seat or per-section inventory, no remaining counts, no holdings, and no cancellation/refund details (`VERIFIED`). It cannot prove a show is sold out. Price ranges are face value and are not guaranteed to include fees in all markets (`VERIFIED`). Treat every returned fact as a snapshot, not a promise, and never read it as a booking.

### Restaurants → no sanctioned self-serve read route

There is no sanctioned self-serve read availability API for restaurant reservations today. OpenTable is partner-gated; Resy and Tock expose no public API; SevenRooms is a B2B product; Yelp Fusion returns business metadata without slots. Restaurant reservations are therefore documented as **partner-gated / browser-backed** and are **not demonstrated** in this wave.

**The browser-backed option, documented but not recommended and not implemented.** A persistent-profile browser could navigate a restaurant's own booking page and extract rendered slots using the same accessibility-contract discipline as the Marketplace extractors. It carries the full cost this service already pays for Facebook: per-scope profile directories, session classification and reauth, profile isolation, checkpoint/captcha handling, and the fact that a login session is user-identity-bound rather than an application token. It also runs against booking surfaces whose terms commonly prohibit automated access, and there is no sanctioned contract guaranteeing stable markup. It is recorded here as the only remaining path, **not as an endorsed one**; nothing in this change recommends or enables scraping, and any future browser-backed reservation surface would need its own access-path review and the operator's explicit decision before implementation.

## Read-only availability demonstration for one case

The demonstrated case is **event availability via Ticketmaster Discovery API v2**, shipped fixture-first.

### The contract

One typed shape, `eventAvailability`, that the events backend fills. Facts only — ranking, comparison, and booking intent stay in Miso.

```ts
eventAvailability = {
  provider: 'ticketmaster'
  id: string                                  // Ticketmaster event id
  url: string                                 // https canonical purchase URL (link provenance)
  name: string
  starts_at: string | null                    // ISO 8601 with offset; null when date/time is TBD/TBA
  timezone: string | null                     // IANA zone, e.g. 'America/New_York'
  status: 'on_sale' | 'off_sale' | 'sold_out' | 'cancelled' | 'postponed' | 'rescheduled' | 'unknown'
  price_min: number | null
  price_max: number | null
  currency: string | null                     // ISO 4217
  venue: string | null
  location: string | null
  on_sale_start: string | null                // ISO 8601 with offset
  on_sale_end: string | null                  // ISO 8601 with offset
  classifications: string[]                   // bounded (max 6)
  images: string[]                            // bounded (max 6), https URLs
}
```

Mapping notes:

- `status` is derived from Ticketmaster's `dates.status.code`. Live Discovery responses yield only `on_sale`, `off_sale`, `cancelled`, `postponed`, `rescheduled`, or `unknown`; an unrecognized code maps to `unknown` rather than guessing. **`sold_out` is fixture-only** — Discovery cannot prove sold-out, so a live response must never produce it.
- `starts_at` is taken from `dates.start.dateTime` (an ISO 8601 instant carrying an offset) when present and parseable; otherwise it is `null` (date/time TBD/TBA, or no resolvable instant). The mapper deliberately does **not** fabricate an offset by combining `localDate`/`localTime` with `dates.timezone`. The `dateTBD` / `dateTBA` / `timeTBA` flags are honored by treating their absence as "no resolvable instant": a `dateTime` is required and a missing or malformed one yields `null` rather than a guessed value.
- `price_min` / `price_max` / `currency` come from `priceRanges[]` (face value; fees not guaranteed).
- `on_sale_start` / `on_sale_end` come from `sales.public.startDateTime` / `endDateTime`.
- `venue` / `location` come from `_embedded.venues[]` (name; city and country code).
- `classifications` and `images` are bounded projections of `classifications[]` and `images[]`.

### Calendar date bounds are local-time, never UTC

The search tool accepts `start_date` and `end_date` as calendar dates (`YYYY-MM-DD`) and maps them onto Discovery's documented `localStartDateTime` / `localEndDateTime` parameters. The local-time filter is interpreted in the event's own timezone, which is the semantics a calendar date implies. The previous mapping onto `startDateTime` / `endDateTime` (UTC instants) silently dropped late-evening shows on `end_date` (a 20:00 event in `America/Edmonton` on the local end date is `02:00Z` the following day) and admitted events from the previous local day on `start_date`. The new mapping sends `2025-06-01T00:00:00` and `2025-06-30T23:59:59` with no `Z` suffix; the provider reads them as local bounds. Regression tests cover the boundary cases.

### `events_fetch` URL round trip — regional hosts and segment-boundary ids

The `url` field on a search result is whatever the provider emits, and Discovery covers markets beyond the US. A `ticketmaster.ca` (or other regional) URL must round-trip back through `events_fetch({ url })` and resolve to the same event id. The URL parser:

- accepts hosts on an explicit allowlist of Ticketmaster regional roots (`ticketmaster.com`, `ticketmaster.ca`, `ticketmaster.co.uk`, `ticketmaster.com.au`, `ticketmaster.com.mx`, `ticketmaster.ie`, `ticketmaster.nl`, plus the other regional roots the provider serves), exact match or any subdomain;
- rejects lookalike hosts that share a suffix with a real root but resolve to a different registrable domain (`ticketmaster.com.evil.example`, `ticketmastercom`, etc.);
- extracts the id as the path segment after the literal `event` segment, so a longer id is never truncated to a prefix and an `event-prefix` path is not misread as the `event` segment;
- requires the id to match the same charset as the Zod input schema so the value still parses downstream.

Regression tests cover the regional round trip (CA / UK / AU), lookalike rejection, segment-boundary id extraction, and the existing US round trip.

### The tools

| Tool | Risk class | Scope | Behaviour |
|---|---|---|---|
| `events_search` | `read` | `(ticketmaster, default, events)` | Searches the configured events source and returns bounded `eventAvailability` facts |
| `events_fetch` | `read` | `(ticketmaster, default, events)` | Fetches one event by id from the configured events source |

Configuration: `EVENTS_BACKEND=fixture|ticketmaster` (default `fixture`, so the tool list is stable without keys, mirroring the shopping opt-in pattern). Key material is read from `TICKETMASTER_API_KEY` in the environment when the service constructs the Ticketmaster client, and is never logged or returned.

Output envelopes:

- Search: `{ ok: true, backend, events: eventAvailability[] }`
- Fetch: `{ ok: true, backend, event: eventAvailability }`
- Failures use the existing typed `ProviderError` / `NOT_FOUND` envelopes. A missing `TICKETMASTER_API_KEY` fails closed with a typed error while the tools stay listed and documented.

### Worked example (fixture-shaped)

A search request against the fixture backend. The tool validates strictly with Zod; its declared input fields are `query` (required), optional `city`, `start_date`, `end_date` (both `YYYY-MM-DD`), and `limit` (1–20, default 10):

```json
{ "query": "example artist", "limit": 1 }
```

The live equivalent calls the verified Discovery endpoint:

```http
GET https://app.ticketmaster.com/discovery/v2/events.json?apikey={TICKETMASTER_API_KEY}
```

(Search/filter parameter names beyond `apikey` are part of the Discovery API reference and are to be confirmed during live validation; the endpoint path itself is `VERIFIED`.)

A sample fixture response object for `events_search`:

```json
{
  "ok": true,
  "backend": "fixture",
  "events": [
    {
      "provider": "ticketmaster",
      "id": "G5v0Z9Yqk1",
      "url": "https://www.ticketmaster.com/example-artist-live/venue/12345",
      "name": "Example Artist: Live",
      "starts_at": "2026-11-14T20:00:00-05:00",
      "timezone": "America/New_York",
      "status": "on_sale",
      "price_min": 45.5,
      "price_max": 150,
      "currency": "USD",
      "venue": "Example Arena",
      "location": "New York, US",
      "on_sale_start": "2026-09-01T10:00:00Z",
      "on_sale_end": "2026-11-14T20:00:00Z",
      "classifications": ["Music", "Rock", "Alternative Rock"],
      "images": ["https://img.ticketmaster.com/example-artist-hero.jpg"]
    }
  ]
}
```

### Availability lookup is not a confirmed booking

The surface returns **facts only**. It does not hold seats, does not create a cart, does not reserve a table, and does not purchase a ticket. `status: "on_sale"` means the provider reports the event on sale; it is not a booking, not a hold, and not a guarantee that any particular seat or price remains. A future "booking prepared" artifact would still not be a booking. Only a provider-side confirmation — an id or status captured from the provider — establishes that a reservation or purchase happened, and nothing in this wave produces one.

## Confirmation, retry, and approval boundaries

This section maps the reservations/events vertical onto [`provider-action-boundaries.md`](provider-action-boundaries.md), which remains the normative enforcement contract.

| Activity | Risk class | Autonomy | Enforcement |
|---|---|---|---|
| Availability lookup (`events_search`, `events_fetch`) | `read` | Autonomous | Declared scope `(ticketmaster, default, events)`; no grant |
| Building a booking/reservation intent (draft) | `prepare` | Autonomous, **but its output is not authorization to book** | Same as `read`; no grant |
| Reserving, booking, purchasing, cancelling | `high_consequence` | Never | **Refused unconditionally** — no grant can enable it |

Boundaries the issue requires:

- **Confirmation is captured from the provider, never inferred.** A confirmation is a provider-side id or status returned by the provider, not a click, a page transition, a UI state, or a timeout that "looked successful." This mirrors the boundary contract's timeout rule: a `TIMEOUT` means the outcome is unknown, is never permission to retry, and unconfirmed actions are reported as unknown — not as failure or success.
- **Retries and idempotency.** Because no write path exists, there is no retry path today. Any future booking write must reconcile provider-side state before retrying, must embed an idempotency token in the prepared payload, and any retry is a **new** approval decision for Miso — never an automatic resend.
- **Duplicate bookings.** A retried or double-submitted booking can create a duplicate reservation. The reconciliation-before-retry rule above is the only defense; it must be enforced by any future write path, not left to the caller.
- **Holds, fees, and cancellation rules.** Discovery exposes none of these (`VERIFIED`: no cancellation/refund info, no expiring offers, no holds). Price ranges are face value and not guaranteed to include fees. Any hold, deposit, or cancellation policy is provider-specific and must be surfaced as an explicit fact before a booking is prepared, not assumed.
- **Expiring offers (on-sale windows).** `on_sale_start` / `on_sale_end` are facts with timestamps, not reservations. An on-sale window closing does not expire a hold Miso holds, because Miso holds nothing. Consumers must treat windows as time-bounded facts.

**No write path exists today, and any future one is deny-all.** Per the boundary contract, no production grant verifier exists: the service installs `DenyAllAuthorizer`, and a `high_consequence` action is refused before the authorizer is consulted. A future booking or purchase path stays deny-all until #43 ships an issuance-authenticated, provenance-verifying authorizer and this gate is deliberately changed — not until a better grant is presented.

## Verified vs assumed

**Verified** (official documentation; see Sources):

- Ticketmaster Discovery API v2 is self-serve with an `apikey` query parameter and free registration; base root `https://app.ticketmaster.com/discovery/v2/`; event search `GET /discovery/v2/events.json`; event detail `GET /discovery/v2/events/{id}.json`; event images `GET /discovery/v2/events/{id}/images.json`.
- Rate limits: default quota 5,000 calls/day, 5 requests/second, deep-paging limit at the 1000th item.
- Response field paths: `.id`, `.name`, `.url`, `.dates.start.localDate` / `.localTime`, `.dates.start.dateTBD` / `dateTBA` / `timeTBA`, `.dates.timezone`, `.dates.status.code` (values `onsale`, `offsale`, `cancelled`, `postponed`, `rescheduled`), `.sales.public.startDateTime` / `endDateTime`, `.priceRanges[]` (`type`, `currency`, `min`, `max`), `._embedded.venues[]` (`name`, `.city.name`, `.country.countryCode`), `.classifications[]` (segment / genre / subGenre), `.images[]`.
- Discovery has **no** seat-level inventory, no remaining counts, and no cancellation/refund info. The separate Inventory Status API is partner-gated.
- Eventbrite public event search shut down Dec 12, 2019; Eventbrite is organization-scoped.
- Restaurant platform access posture (OpenTable partner-only; Resy none; Yelp Fusion business data without slots).

**Assumed / to verify during live validation:**

1. Exact Discovery **search/filter parameter names** beyond `apikey` (e.g. the keyword and paging parameters) — to be confirmed against the official reference at first live call.
2. That live `dates.status.code` values map cleanly onto the `status` enum and that no undocumented code appears; any unmapped code must fall back to `unknown`.
3. That `priceRanges[]` is present and populated for the events returned, and that `currency` is always a valid ISO 4217 code.
4. Timezone/offset handling: whether live responses always carry a parseable `dates.start.dateTime` with an offset. The mapper uses it and otherwise leaves `starts_at` null; it never fabricates an offset from `localDate`/`localTime` plus `dates.timezone`.
5. The exact default rate-limit numbers as they apply to this operator's key (the 5,000/day and 5/sec figures come from the official FAQ and should be reconfirmed on the dashboard).
6. The mapping from the tool inputs (`query`, `city`, `start_date`, `end_date`, `limit`; `id`/`url` for fetch — verified from the implemented Zod schemas) onto the Discovery API's own search/filter parameters.

The synthetic-identities-only policy applies to testing: the events backend is built against fixture responses first. **Live validation has not been performed** — no operator `TICKETMASTER_API_KEY` exists yet — so the implementation is verified against synthetic fixtures only, exactly as `shopping-provider-research.md` documents for the eBay access caveat.

### Validation plan

1. Operator registers at [developer.ticketmaster.com](https://developer.ticketmaster.com/) and provisions `TICKETMASTER_API_KEY` (the one manual step; no account credentials are shared with Musebridge — it is an application key, not a login).
2. Run one live `events_search` and one live `events_fetch` with the operator key.
3. Record the endpoint, field, and rate-limit findings back into this document, moving items from the assumed list to the verified list — before the tools are treated as production-reliable. This matches the bar set by the Messenger extraction contract and the shopping research doc.

## Safety notes

- **Untrusted provider content.** Event names, venue strings, classifications, and image URLs are provider-controlled content returned verbatim (bounded) as tool output. Miso owns interpretation and must treat them as untrusted input.
- **Key material is environment-only.** `TICKETMASTER_API_KEY` lives in the environment, is never logged or echoed in tool output, and a missing key fails closed with a typed error while the tools stay listed.
- **No browser session.** The events surface is a plain HTTPS API — no profile, no session probe, no reauth console, and no read-receipt-style side effects.
- **No writes.** No cart, no hold, no reservation, no purchase, no cancellation, and no scraping. Everything in this wave is `read`-class.

## Deliberate gaps this wave

- **No restaurant availability API.** No sanctioned self-serve read route exists; restaurant reservations are partner-gated / browser-backed and not implemented.
- **No seat-level inventory.** Discovery is event-level only and cannot prove sold-out; `sold_out` is fixture-only.
- **No booking, reservation, or purchase.** `high_consequence` is refused unconditionally; there is no write path.
- **No holds, fees, or cancellation details.** Discovery exposes none of these.
- **Single provider.** Ticketmaster only; Eventbrite is rejected for discovery and the other ticket providers were not assessable from official docs.
- **Live validation pending.** No operator key yet; fixtures are the reference.

## Sources

Official URLs only:

| Source | URL |
|---|---|
| Ticketmaster Discovery API v2 docs | https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/ |
| Ticketmaster Discovery API FAQ | https://developer.ticketmaster.com/support/faq/ |
| Ticketmaster Inventory Status API | https://developer.ticketmaster.com/products-and-docs/apis/inventory-status/ |
| Eventbrite API v3 docs | https://www.eventbrite.com/platform/docs/introduction |
| Eventbrite changelog (public search shutdown) | https://www.eventbrite.com/platform/docs/changelog |
| Yelp Fusion API | https://docs.developer.yelp.com/docs/fusion-intro |
| OpenTable Partner Portal | https://platform.opentable.com/ |
| Resy API | https://www.resy.com/api |

## Cross-links

- [`provider-action-boundaries.md`](provider-action-boundaries.md) — the normative action-authorization contract; the source for the `read` / `prepare` / `high_consequence` mapping and the deny-all stance until #43.
- [`shopping-provider-research.md`](shopping-provider-research.md) — the sibling vertical's provider evaluation, fixture-first access caveat, and minimum-contract discipline this document mirrors.
- [`services/marketplace/AGENTS.md`](../services/marketplace/AGENTS.md) — the service invariants the events surface follows (strict Zod inputs, bounded non-empty backend `name`, typed `ProviderError`, environment-only credentials, fixture default).
