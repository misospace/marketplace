# Marketplace MCP fixture service

A small, fixture-only Model Context Protocol service for exercising Marketplace-shaped integrations. It returns synthetic listings only: it does not access Facebook, Marketplace, or any remote listing or image URL. Its public MCP server identity is `marketplace`; the built-in backend is named `fixture`.

## Run

Requires Node.js 24.

```sh
npm ci --ignore-scripts
npm run build
npm start
```

The Streamable HTTP MCP endpoint is `POST /mcp` on `127.0.0.1:8080` by default. Set `HOST=0.0.0.0` when running in a container and optionally override `PORT`. `GET /healthz` is a separate liveness endpoint. The MCP transport is stateless and returns JSON responses; request bodies are limited to 64 KiB. Requests carrying any `Origin` header (including `Origin: null`) are rejected, so this first milestone is server-to-server only.

Build and run the container locally:

```sh
docker build -t marketplace-mcp-fixture .
docker run --rm -p 8080:8080 marketplace-mcp-fixture
```

GHCR publishing runs for pushes to `main` and version tags (`v*.*.*`), after the Node 24 typecheck, lint, test, and build checks pass. Renovate uses the shared org preset; automatic dependency merges remain disabled for manual review during the fixture milestone.

The service has no built-in authentication. Run it only on a trusted private network and provide network-level access controls before exposing it to other networks. ToolHive can use the service's Streamable HTTP transport at port `8080` and path `/mcp`, but it is not registered with ToolHive yet.

## Tools

- `marketplace_search` requires trimmed, non-empty `query` and `location` strings (each maximum 256 characters). `min_price` and `max_price` must be finite and non-negative with minimum no greater than maximum. `limit` defaults to 5 and must be an integer from 1 through 20. Unknown input keys are rejected.
- `marketplace_search` matches `query` as a case-insensitive substring within the title or the description (a single field, never across the title/description boundary), and matches `location` case-insensitively. Results retain fixture order. Price filters exclude listings whose price is `null`.
- `marketplace_fetch` requires exactly one of `id` or `url`. IDs are bounded, safe identifiers; URLs must be HTTP(S), contain no credentials, and be at most 2048 characters. URL matching strips the fragment and lowercases the host before comparing against fixture URLs (lightweight normalization, not full canonicalization). It never performs network requests.
- `marketplace_status` accepts `{}`; omitted arguments are also valid and report service `0.1.0`, schema `1.0.0`, and `backend: "fixture"`.
- Successful search and fetch results include the configured backend `name`; `marketplace_status` reports that same identity. The built-in backend is named `fixture`. Backend names must be non-empty strings of at most 64 characters, and the schema version remains `1.0.0` for this unreleased initial contract.
- Unknown but valid fetch identifiers return a `NOT_FOUND` runtime envelope. Invalid tool arguments are JSON-RPC `InvalidParams` errors, not tool-error envelopes.

Listing records use `images` (an array of at most six HTTP(S) URLs), required nullable ISO date-time fields `posted_at` and `updated_at`, and required nullable `seller`. Seller details are bounded and optional within a non-null seller object. `state` is one of `active`, `sold`, `pending`, `removed`, or `unknown`. The fixed fixtures use `example.com` URLs and include removed, pending, sold, unknown-state, and null-price examples.

Backends may throw the exported `ProviderError` class to return a known runtime failure. Supported codes are `AUTH_EXPIRED`, `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, `RATE_LIMITED`, `UPSTREAM_ERROR`, and `TIMEOUT`; messages and optional metadata (`action_required`, HTTP(S) `login_url`, and non-negative integer `retry_after` seconds) are validated and bounded. Only valid `ProviderError` instances are exposed to callers. Unexpected errors and malformed provider errors are logged server-side and reduced to a generic `INTERNAL_ERROR` envelope. A fetch miss remains `NOT_FOUND`.

Each search/fetch backend call has its own deadline, defaulting to 30,000 ms. Override it with `BACKEND_TIMEOUT_MS` or the `backendTimeoutMs` service option; values must be positive integers below 60,000 ms. The backend receives an `AbortSignal` that aborts on deadline, MCP request cancellation/disconnect, or service shutdown. A backend must cooperate with this signal to stop its underlying work: the service can stop awaiting an arbitrary non-cooperative promise, but cannot forcibly cancel the work itself.

## Browser runtime

The service includes a minimal Chromium session layer backed by Playwright `1.63.0`. It lazily starts one browser with a persistent profile at `BROWSER_PROFILE_DIR` (default `$HOME/.marketplace/browser-profile`) and serializes browser work through one page at a time. Browser operations use the same `AbortSignal` and deadline path as backend work. An in-progress browser launch cannot be aborted mid-launch (Playwright exposes no signal for it): it is bounded by the launch timeout, defaulting to 30,000 ms, and the signal is honoured immediately before and after the launch. `close()` is bounded by a 5,000 ms timeout so shutdown cannot hang. Chromium runs as the non-root container user; no credentials are stored by this service, and cookies, localStorage, headers, page content, and profile contents are never logged. No CDP endpoint is exposed. This is infrastructure for a future provider; no current MCP tool uses the browser.

Container users should mount a persistent volume at the profile directory and run Chromium with `--init --ipc=host`, following Playwright's Docker guidance.

## Development checks

```sh
npm run build
npm run typecheck
npm test
npm run lint
```
