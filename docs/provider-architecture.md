# Provider architecture and compatibility strategy (#40)

Parent: #38 (verticals). Issue: #40. Status: architecture and compatibility strategy documented; eBay shopping is the second capability shipped against it, proving #40's "done when" — a second provider added without copying Marketplace's runtime.

This document is the reference for the provider/module layout of `services/marketplace/` and for the compatibility rules that keep existing consumers working. It is descriptive of the code as it exists (plus the schema `1.2.0` capability-discovery change); recommendations and not-yet-implemented items are marked as follow-ups. For the enforcement contract on sessions, actions, and grants, see [`provider-action-boundaries.md`](provider-action-boundaries.md); for the shopping research behind the second provider, see [`shopping-provider-research.md`](shopping-provider-research.md).

## Purpose and non-goals

Musebridge is a narrow **capability bridge**. It connects Miso/OpenClaw to external provider surfaces and returns typed facts; it does not decide, schedule, reason, or approve. Execution, scheduling, negotiation, ranking, and approval stay in Miso — via OpenClaw. The repository contains exactly one service package, `marketplace-mcp` under `services/marketplace/`, with one MCP tool registry and one process.

Explicit non-goals for this wave:

- **No second agent runtime.** Adding a provider adds a backend and typed tools, not an execution loop.
- **No plugin framework.** There is no dynamic provider loader, no manifest, no plugin lifecycle.
- **No shared package extraction.** The provider code lives inside `marketplace-mcp`; there is no `packages/providers` yet.
- **No config-driven provider table.** Surfaces and backends are declared in TypeScript, not in a data file.
- **No generalization ahead of evidence.** Per #40, only infrastructure actually shared by two capabilities is generalized.

## Capability model

A **capability surface** is the tuple:

```
(provider, account, surface)  +  a backend interface  +  registered tools  +  typed domain contracts
```

The scope triple is defined by the action-boundary contract (`provider-action-boundaries.md`): `provider` is the external service identity, `account` is one login identity (today always `default`), and `surface` is one product area on that provider. Each scope owns its own session assessment, browser profile (when browser-backed), and failure posture. A tool declares exactly one scope and one risk class; dispatch enforces it.

Today's three surfaces:

| Surface | Provider | Backend interface (`backend.ts`) | Tools (`tools.ts`) | Session kind |
|---|---|---|---|---|
| `marketplace` | `facebook` | `MarketplaceBackend` | `marketplace_search`, `marketplace_fetch`, `marketplace_status` | Browser session scope |
| `shopping` | `ebay` | `ShoppingBackend` | `shopping_search`, `shopping_fetch` | API token, no browser |
| `messenger` | `facebook` | `ConversationBackend` | `messenger_threads_list`, `messenger_thread_read` | Separate browser session scope |

Backends are selected by kind and expose a bounded `name` (`fixture`, `facebook`, or `ebay`). The backend interface is the only thing core dispatch knows about a provider; the domain contract is the only shape a provider must fill.

## Module layout and cohesive namespaces

Files under `services/marketplace/src/` are grouped by cohesion rather than by tool:

**Core / service-level modules** — the provider-agnostic spine:

- `service.ts` — composition root: reads environment/config, constructs backends, wires the HTTP server and MCP sessions.
- `tools.ts` — the tool registry, validation, authorization, dispatch, cancellation, and the single `CallToolRequestSchema` handler.
- `domain.ts` — all Zod contracts and the versioned output schemas; the single source of truth for shapes.
- `backend.ts` — the `MarketplaceBackend`, `ConversationBackend`, and `ShoppingBackend` interfaces plus `ProviderError`.
- `authorization.ts` — risk classes, scopes, grant shape, `authorizeAction`, `DenyAllAuthorizer`.
- `browser.ts` — the provider-agnostic Playwright persistent-profile manager.
- `fixtures.ts` — synthetic fixture data and the `FixtureBackend` / `FixtureShoppingBackend` implementations.
- `reauth.ts` / `admin.ts` — the operator re-auth lease and its loopback admin API.
- `market-config.ts` — startup loader for a mounted Facebook market map.

**Provider-specific modules** — grouped by prefix or provider name:

- `facebook-*.ts` — `facebook-marketplace-*` (URL, extract, parse, backend), `facebook-messenger-*`, `facebook-login.ts`, `facebook.ts` (probe + origin constants).
- `ebay.ts` (HTTP client) and `ebay-backend.ts` (`ShoppingBackend` implementation).

**Dependency rule.** Provider-specific modules are never imported by the core dispatch/contract modules. `tools.ts` imports only `backend.ts`, `domain.ts`, `authorization.ts`, and `browser.ts`; `domain.ts` and `backend.ts` import no provider module. The concrete proof is `ebay-backend.ts`, whose entire import list is:

```ts
import { ProviderError, type ShoppingBackend } from './backend.js';
import { productOfferSchema, type ProductOffer } from './domain.js';
import { EbayClient, EbayHttpError, type EbayClientOptions } from './ebay.js';
```

Zero Facebook imports. Only the composition root (`service.ts`) and the public `index.ts` re-exports reference concrete provider modules; that is the one place allowed to know all providers.

**Honest coupling note.** Three "core" files are not yet fully provider-agnostic in their imports: `reauth.ts` imports the Facebook origin/path constants from `facebook.ts`; `market-config.ts` imports the Facebook market validators from `facebook-marketplace-url.ts`; and `fixtures.ts` carries synthetic data for all three surfaces. The truly agnostic dispatch path is `tools.ts` → `backend.ts` interfaces → `domain.ts` contracts. Untangling the reauth/config edge is deferred until a second browser-backed provider exists (see non-generalizations).

## Typed tool inputs/outputs/errors

`domain.ts` is the single source of truth. Every tool input and output is a Zod schema; `tools.ts` converts them to MCP JSON Schema with `z.toJSONSchema(..., { target: 'draft-7', io })` in `toMcpObjectSchema`, so `ListTools` and dispatch share the same definitions.

- **Inputs** are strict: `.strict()` rejects unknown keys, bounds are explicit, and cross-field refinements (for example `min_price <= max_price`, or exactly one of `id`/`url`) are part of the schema. Malformed arguments are validated at dispatch and returned as a JSON-RPC `InvalidParams` (`McpError` with `ErrorCode.InvalidParams`), **not** as a tool-error envelope.
- **Outputs** are success/failure unions parsed before return (`searchOutputSchema`, `fetchOutputSchema`, `shoppingSearchOutputSchema`, `shoppingFetchOutputSchema`, `threadsListOutputSchema`, `threadReadOutputSchema`, and `statusOutputSchema`). The parsed value is returned both as serialized text and as `structuredContent`, with `isError` set when `ok === false`.
- **Provider errors vs runtime failures.** `ProviderError` + `PROVIDER_ERROR_CODES` (`AUTH_EXPIRED`, `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `TIMEOUT`) describe external provider state. The runtime failure envelope adds `NOT_FOUND` and `INTERNAL_ERROR`, and the policy codes `APPROVAL_REQUIRED` / `ACTION_FORBIDDEN`. Policy codes are deliberately **not** in `PROVIDER_ERROR_CODES`. Only validated `ProviderError` instances are surfaced; anything else is logged and reduced to `INTERNAL_ERROR`.

**Versioned output contract.** `SCHEMA_VERSION` in `domain.ts` is the contract version (currently `1.2.0`; `SERVICE_VERSION` is separate). Additive output changes bump the minor version. `listing` (Facebook) and `productOffer` (shopping) are **siblings, not replacements**: `productOffer` preserves `listing` field names where they overlap so a later comparison layer can union them without remapping, while `listing` stays exactly as deployed for the Facebook tools.

## Tool registry and single dispatch choke point

`TOOLS` in `tools.ts` is the registry. Each entry declares `name`, `description`, `inputSchema`, `outputSchema`, and `definition: { riskClass, scope }`. From it the module derives `TOOL_DEFINITIONS`, the input-schema lookup, and the `ListTools` response.

There is exactly one `CallToolRequestSchema` handler. It:

1. Resolves the input schema and rejects unknown tools with `InvalidParams`.
2. Validates arguments (`InvalidParams` on failure).
3. Builds an `ActionRequest` (`scope` + `action` + `subjectDigest`) and calls `authorizeAction`.
4. On success, runs the backend through `runBackendOperation` and parses the output against the selected output schema.
5. On refusal or failure, returns the uniform `runtimeFailureSchema` shape with `isError: true`.

`assertWritableToolsHaveAuthorizer(TOOLS, options.authorizer)` runs at registration and throws before the tool is served if any `send` or `high_consequence` tool has no authorizer. Today all seven tools are `read`, so a `DenyAllAuthorizer` is installed and never consulted.

One caveat for new capabilities: the **output-schema selection is an explicit per-tool branch** (a nested ternary in the handler), as is the backend invocation branch. Adding a tool means touching both branches — there is no name-to-schema map yet. This is the concrete place a new capability must edit core dispatch.

## Explicit provider-specific session dependencies

Session scope is declared per tool, not inferred. Browser-backed scopes each own their own persistent profile, session probe, and (where applicable) reauth/credential-login stack:

- `marketplace` uses `BROWSER_PROFILE_DIR` (default `$HOME/.marketplace/browser-profile`), `FacebookSessionProbe`, `FacebookCredentialLogin`, and the reauth console.
- `messenger` uses a distinct `MESSENGER_PROFILE_DIR` (default `$HOME/.marketplace/browser-profile-messenger`), its own probe, and its own credential-login instance; sharing the marketplace profile directory is a startup error. It has no interactive reauth target yet.
- `shopping` has **no browser session**: the eBay token is application-scoped (`EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`, read at call time, never logged). The "session" dimension is simply whether the API is configured.

Optional surfaces fail closed. `messenger_threads_list` / `messenger_thread_read` throw a typed `ProviderError('UPSTREAM_ERROR', 'The messenger surface is not configured...')` when no `ConversationBackend` is wired; `shopping_*` does the same when no `ShoppingBackend` is wired. `marketplace_status` reports the assessment without doing browser work (`browser.getInfo()`), so status never launches a browser.

Isolation invariants — including the Messenger "Seen" read exception — are normative in `provider-action-boundaries.md` and are not restated here.

## Cancellation and bounded operations

`runBackendOperation` in `tools.ts` is the shared bounded-operation helper. It races the backend call against:

- a **per-call deadline** (`backendTimeoutMs`, default 30,000 ms, configurable via `BACKEND_TIMEOUT_MS`), producing a `ProviderError('TIMEOUT', ...)`;
- the **MCP request signal** (`extra.signal`, cancellation/disconnect);
- the **service shutdown signal** (an `AbortController` aborted by `service.close()`).

It creates one internal `AbortController` and forwards its signal to the backend, so a single abort source reaches the operation. Because arbitrary promises cannot be force-cancelled, the contract is that backends **must honor the signal**; the helper stops awaiting non-cooperative work but cannot stop the work itself. If the request or shutdown signal aborted, the handler rethrows instead of masking the cancellation as a provider failure.

**Honest gap.** `EbayShoppingBackend` layers its own `withDeadline()` (default `requestTimeoutMs` 15,000 ms) inside the shared helper rather than relying solely on `runBackendOperation`. The tool layer still wraps every backend call — including eBay — in `runBackendOperation` (default 30,000 ms), but eBay's inner 15,000 ms `withDeadline` default is the stricter of the two, so the inner deadline binds first in practice. The two mechanisms are not converged, and consistency should not be overstated. Converging them is a follow-up.

## Capability discovery

Shipped in schema `1.2.0`: `marketplace_status` returns `service_version`, `schema_version`, `backend`, optional `shopping_backend`, optional `facebook_session`, and a **required** `capabilities` array. Each entry is `{ surface, provider, backend }`:

- `surface` is one of `marketplace`, `shopping`, `messenger` (closed enum in `capabilitySchema`).
- `provider` is the declared session-scope provider (`facebook` for marketplace/messenger, `ebay` for shopping).
- `backend` is the backend implementation name actually wired for that surface (`fixture` / `facebook` / `ebay`), or `null` when no backend serves it.

The array is non-empty and ordered marketplace, shopping, messenger. Today, `messenger` is the surface that can be `null` (Facebook backend selected but `MARKETPLACE_MESSENGER` off, or a custom non-conversation backend injected); `marketplace` and `shopping` are always wired by the service. The existing fields `backend`, `shopping_backend`, and `facebook_session` are unchanged.

Why this is additive and non-breaking: it adds one required field to `marketplace_status`'s success schema and bumps `SCHEMA_VERSION` from `1.1.0` to `1.2.0`; no tool name, input, or existing field changes. A new surface extends the array with one more entry rather than reshaping the response. Because `ListTools` lists all registered tools regardless of configuration (a fixture deployment still advertises `shopping_*` and `messenger_*`), the capabilities array is what distinguishes **configured backends** without probing a session or calling a tool.

## Compatibility strategy

Distinguish identity surfaces by their stability to consumers:

| Identity surface | Current value | Defined in | Stability |
|---|---|---|---|
| Repository / workspace name | `musebridge` | `package.json` (root) | Internal; rename is cosmetic to MCP consumers |
| Service package name | `marketplace-mcp` | `services/marketplace/package.json` | Internal build/runtime name; coordinate renames |
| Container image | `ghcr.io/misospace/marketplace-mcp` | `.github/workflows/ci.yml`, README | Host-facing; legacy `ghcr.io/misospace/marketplace` has **no alias** |
| MCP server identity | `marketplace` | `new Server({ name: 'marketplace', ... })` in `service.ts` | Consumer contract; do not rename silently |
| Public tool names | the seven above | `TOOLS` in `tools.ts` | **The stable consumer contract** |
| Deployment workload names | ToolHive / OpenClaw profiles | external, not in this repo | Not yet registered; hosts own them |

Rules:

- **The compatibility boundary is the public tool names and the versioned output contract.** Branding, repository, and package renames must not rename tools or the MCP server identity without an explicit, announced migration.
- **Output changes are additive** and bump the minor `SCHEMA_VERSION`. Removing a field, changing a type, or changing a success envelope is a breaking change requiring a migration plan.
- **Environment-variable renames keep a documented fallback.** `FACEBOOK_MARKETS_FILE` is the documented name; `MARKETPLACE_MARKETS_FILE` still works as a fallback in `market-config.ts` so existing deployments keep running.
- **Image renames are breaking host changes with no alias.** `ghcr.io/misospace/marketplace` is no longer published and there is no alias; hosts must update image references. Tags (`main`, SHA, semver) are unchanged.

**Consumer compatibility checklist**

- [ ] Tool names unchanged (`marketplace_search`, `marketplace_fetch`, `marketplace_status`, `shopping_search`, `shopping_fetch`, `messenger_threads_list`, `messenger_thread_read`).
- [ ] MCP server identity still `marketplace`.
- [ ] `SCHEMA_VERSION` bumped only for additive output changes; existing fields keep their names and types.
- [ ] New status fields are additive; `capabilities` entries are added, not reshaped.
- [ ] Env-var renames ship with a fallback for at least one release.
- [ ] Image/workload reference changes are called out to hosts (no alias).

## Adding a provider without copying the runtime (worked example: eBay shopping)

The recipe a new capability follows:

1. **Define the domain contract in `domain.ts`.** Add input, success, and output schemas and exported types (for shopping: `productOfferSchema`, `shoppingSearchInputSchema`, `shoppingFetchInputSchema`, and the `shopping*OutputSchema` unions).
2. **Implement a `backend.ts` interface in provider-specific modules.** For shopping, `ShoppingBackend` is implemented by `EbayShoppingBackend` in `ebay-backend.ts`, over the `EbayClient` in `ebay.ts`.
3. **Wire selection in `service.ts` behind an opt-in env var/option with fail-closed defaults.** `SHOPPING_BACKEND=fixture|ebay` (`parseShoppingBackendKind`) defaults to `fixture`; `ebay` requires `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` and otherwise throws at startup (`requiredEnv`).
4. **Declare tools in `TOOLS`** with name, description, input/output schemas, and a `definition` carrying the scope and risk class (`shoppingScope`, `read`).
5. **Add the dispatch branch.** Add the output-schema selection and the backend invocation branch in the `CallToolRequestSchema` handler, wrapping the call in `runBackendOperation`.
6. **Add fixtures and tests.** Synthetic fixture offers (`FIXTURE_OFFERS` / `FixtureShoppingBackend` in `fixtures.ts`), recorded HTTP fixtures under `tests/fixtures/ebay/`, and unit tests (`tests/ebay-client.test.ts`, `tests/ebay-backend.test.ts`) using a local synthetic HTTP server.
7. **Extend capability discovery.** Add the `shopping` entry to the `capabilities` array (and the optional `shopping_backend` field) so hosts can see the configured backend without calling a tool.

**eBay case study — what it reused:**

- Typed contracts from `domain.ts` (`productOffer` as a sibling of `listing`).
- `ProviderError` and the shared provider-error code set (mapped from HTTP status in `ebay-backend.ts`).
- Deadline/abort plumbing (`withDeadline` and the outer `runBackendOperation`).
- Fixture-first testing with zero real network calls.
- The single registry and dispatch path.

**What it did not need to copy:** the browser session layer, the session probe, the reauth console, the credential-login flow, and the per-scope profile directory — none apply to an API-token surface. This asymmetry is the evidence for #40's done-when: a second provider was added by implementing one interface and one contract group, not by duplicating Marketplace's runtime.

## Deliberate non-generalizations

- **No central provider registry / plugin loader.** Providers are constructed explicitly in `service.ts`; adding one is a code change, not a data change.
- **No shared package extraction.** A second service package would duplicate the transport, registry, and authorization spine for one consumer.
- **No config-driven provider table.** The surfaces are compile-time TypeScript, which keeps the schemas and scopes type-checked.
- **The three backend interfaces stay separate by design.** `MarketplaceBackend`, `ConversationBackend`, and `ShoppingBackend` have different input/output types (`Listing` vs `ConversationThread`/`ConversationMessage` vs `ProductOffer`); collapsing them into one generic interface would erase the types that make the contracts safe.
- **Generalization is deferred until a third capability justifies it**, matching #40's "generalize only infrastructure actually shared by two capabilities." A third browser-backed provider, for example, is the natural trigger to lift the reauth/market-config coupling.

## Tests and fixtures

- Provider-agnostic tests cover the registry, dispatch, validation, authorization, cancellation, and the service lifecycle.
- Per-provider synthetic fixtures live under `tests/fixtures/`: `facebook-marketplace/` (search cards, item pages, login/captcha/checkpoint/layout-change states), `facebook-messenger/` (inbox and thread pages), and `ebay/` (search/item/token/error JSON).
- Browser tests are gated by `REQUIRE_BROWSER_TESTS=1`; they use a synthetic local server and make **zero** real network calls (Facebook tests block network access entirely).
- CI installs Chromium and runs `npm run test -- --fileParallelism=false` with `REQUIRE_BROWSER_TESTS=1` to serialize browser-heavy files; ordinary local `npm test` keeps default parallelism.

## Open questions / follow-ups

Not yet implemented — do not read as shipped:

- **Converge eBay's deadline handling with `runBackendOperation`** so there is one bounded-operation path rather than a nested deadline.
- **Decide when a third capability justifies a provider registry.** Two capabilities did not; the trigger and shape are undefined.
- **Surface the messenger session in status.** `facebook_session` currently reports only the marketplace scope; a messenger-scope assessment is not exposed.
- **Consider per-surface schema versioning** if surfaces start to diverge faster than one shared `SCHEMA_VERSION` can express additively.
- **Untangle the reauth/market-config Facebook coupling** at the point a second browser-backed or market-based provider is added.
