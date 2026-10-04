# Marketplace MCP fixture service

A small Model Context Protocol service for exercising Marketplace-shaped integrations. The default `fixture` backend returns synthetic listings only and makes no remote requests; an explicitly selected Facebook backend provides search-only access through a persistent browser session. Its public MCP server identity is `marketplace`.

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
- `marketplace_status` accepts `{}`; omitted arguments are also valid and report service `0.1.0`, schema `1.1.0`, and `backend: "fixture"`.
- Successful search and fetch results include the configured backend `name`; `marketplace_status` reports that same identity. The built-in backend is named `fixture`. Backend names must be non-empty strings of at most 64 characters. The schema version is `1.1.0`; additive output changes bump the minor version.
- Unknown but valid fetch identifiers return a `NOT_FOUND` runtime envelope. Invalid tool arguments are JSON-RPC `InvalidParams` errors, not tool-error envelopes.

Listing records use `images` (an array of at most six HTTP(S) URLs), required nullable ISO date-time fields `posted_at` and `updated_at`, and required nullable `seller`. Seller details are bounded and optional within a non-null seller object. `state` is one of `active`, `sold`, `pending`, `removed`, or `unknown`. The fixed fixtures use `example.com` URLs and include removed, pending, sold, unknown-state, and null-price examples.

Backends may throw the exported `ProviderError` class to return a known runtime failure. Supported codes are `AUTH_EXPIRED`, `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, `RATE_LIMITED`, `UPSTREAM_ERROR`, and `TIMEOUT`; messages and optional metadata (`action_required`, HTTP(S) `login_url`, and non-negative integer `retry_after` seconds) are validated and bounded. Only valid `ProviderError` instances are exposed to callers. Unexpected errors and malformed provider errors are logged server-side and reduced to a generic `INTERNAL_ERROR` envelope. A fetch miss remains `NOT_FOUND`.

Each search/fetch backend call has its own deadline, defaulting to 30,000 ms. Override it with `BACKEND_TIMEOUT_MS` or the `backendTimeoutMs` service option; values must be positive integers below 60,000 ms. The backend receives an `AbortSignal` that aborts on deadline, MCP request cancellation/disconnect, or service shutdown. A backend must cooperate with this signal to stop its underlying work: the service can stop awaiting an arbitrary non-cooperative promise, but cannot forcibly cancel the work itself.

## Browser runtime

The service includes a minimal Chromium session layer backed by Playwright `1.63.0`. It lazily starts one browser with a persistent profile at `BROWSER_PROFILE_DIR` (default `$HOME/.marketplace/browser-profile`) and serializes browser work through one page at a time. An invalid `BROWSER_PROFILE_DIR` fails service startup. Browser operations use the same `AbortSignal` and deadline path as backend work. An in-progress browser launch cannot be aborted mid-launch (Playwright exposes no signal for it): it is bounded by the launch timeout, defaulting to 30,000 ms, and the signal is honoured immediately before and after the launch. Non-cancellable infrastructure steps (page creation and page/context teardown) are bounded by a settle timeout, defaulting to 5,000 ms, so an unresponsive browser cannot wedge the serialized queue. If the timeout expires during page creation or page teardown, the current browser context is discarded and the session is marked unavailable; the next operation waits for teardown to settle and relaunches a clean context rather than continuing against a potentially unhealthy browser. Chromium runs as the non-root container user; no credentials are stored by this service, and cookies, localStorage, headers, page content, and profile contents are never logged. Do not set `PWDEBUG` or `DEBUG=pw:*` in production: Playwright debug logging can include page content. No CDP endpoint is exposed. The Facebook session probe and opt-in search backend use this browser; the fixture backend does not.

Container users should mount a persistent volume at the profile directory and run Chromium with `--init --ipc=host`, following Playwright's Docker guidance.

### Facebook session probe

`FacebookSessionProbe` in `src/facebook.ts` composes over the serialized browser manager. `probeSession(signal)` loads the Marketplace entry point and reports `session_usable` for an authenticated Marketplace page, `session_needs_reauth` for a login page or redirect (`LOGIN_REQUIRED`), checkpoint/challenge (`SESSION_INVALID`), or captcha (`CAPTCHA_REQUIRED`). `session_unknown` means no verdict is available for the current probe: the session has never been probed, the page is ambiguous, an in-flight probe is cancelled, or loading fails. A probe cancelled before it starts leaves the previous assessment untouched. Do not read `session_unknown` as "not usable"; only `session_usable` asserts an authenticated Marketplace.

Classification uses the final URL and a small set of semantic signals: a password field or login form, checkpoint form or copy, captcha frame or copy, an authenticated marker (account/profile label or logout affordance), a login prompt, and a main landmark plus a Marketplace link. It does not depend on hashed CSS classes. The default origin is exactly `https://www.facebook.com`. The probe never automates login, stores or exports credentials, or logs page HTML, cookies, storage, headers, form values, or screenshots.

The origin can be injected only through the constructor for tests (or the service's `facebookBaseUrl` option); it is not an environment variable or tool input. It must be exactly `https://www.facebook.com` or a loopback test origin (`localhost`, `127.0.0.1`, or `::1`, over HTTP or HTTPS); any other origin is rejected, so this seam cannot reach an arbitrary host. A redirect to any other origin, including another Facebook subdomain, deliberately produces `session_unknown` rather than `session_usable`. `marketplace_status` also reports `facebook_session: { status }`, the last known assessment (`session_unknown`, `session_usable`, or `session_needs_reauth`), without doing browser work. This is additive: `schema_version` is `1.1.0`, and no tool name or other field changed.

The Facebook backend is opt-in; `MARKETPLACE_BACKEND` defaults to `fixture`. Set `MARKETPLACE_BACKEND=facebook` or pass `backendKind: 'facebook'` to select it. The backend currently implements search only. It verifies the session before each search and fails closed when the probe returns `session_unknown`; listing fetch is intentionally not implemented and returns a typed `UPSTREAM_ERROR` rather than a misleading `NOT_FOUND`.

Search URLs follow `/marketplace/<slug>/search/?query=` (with optional `minPrice` and `maxPrice`). The built-in map covers ten US metro markets, all in USD; callers can supply an explicit replacement market map through `facebookMarkets`. Locations must resolve through a configured label, slug, or alias. Unknown and ambiguous locations return a typed error, and slugs are never guessed.

The parser never synthesizes an item id, never marks a search card `active`, leaves relative timestamps as `null`, always sets `updated_at` to `null`, and uses only the first price token. A search reads one page only: it does not scroll or paginate. Login, captcha, invalid session/checkpoint, rate limit, timeout, and unrecognized/invalid upstream pages return bounded typed provider errors; only a recognized no-results page becomes an empty success. These errors do not expose page text, card contents, hrefs, images, cookies, or storage.

## Manual re-auth console

When a provider reports `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, or `SESSION_INVALID`, an operator can temporarily take over the persistent browser profile and complete the challenge manually. This console is an operator-only side channel; it is not exposed through any MCP tool and does not change the tool contract.

The loopback-only admin listener provides three JSON endpoints:

- `POST /reauth/start` starts or returns the active lease.
- `GET /reauth/status` reports the current lease state.
- `POST /reauth/stop` ends the lease and returns the idle state.

Successful responses have the shape `{ "phase": "active", "lease": { "id": "...", "startedAt": "...", "expiresAt": "...", "consoleUrl": "http://127.0.0.1:.../vnc.html?...#password=...", "viewerPort": 6080 }, "expiresAt": "...", "remainingMs": 600000 }`. Idle responses use `"phase": "idle"`, `"lease": null`, and null `expiresAt` and `remainingMs`. Failed operations return a generic JSON error without exposing internals.

Configuration is through environment variables: `REAUTH_ADMIN_PORT` defaults to `8787`, `REAUTH_VIEWER_PORT` defaults to `6080`, and `REAUTH_LEASE_MS` defaults to `600000` (10 minutes). A lease must be a positive safe integer and cannot exceed `1800000` ms (30 minutes). The service options provide internal constructor/test seams for custom targets and runtimes; these are not environment variables or request inputs.

The intended access path is `kubectl port-forward` for both the admin and viewer ports, then use the returned console URL from the operator's local machine. This admin interface is intentionally unauthenticated because both listeners bind only to `127.0.0.1`; never expose either port through a Kubernetes Service or Ingress. This project ships no Kubernetes manifests. In a container, configure port-forwarding to the pod's admin and viewer ports without changing their loopback binds.

Each lease takes exclusive ownership of the one browser profile, so ordinary browser work fails fast instead of queueing until the lease ends. The console password is ephemeral and delivered only in the URL fragment, which browsers do not send to the viewer's HTTP access log. The password is held only for the lease; its file is mode `0600` inside a private temporary directory, and the directory and file are removed at teardown. Credentials and page content are never logged or stored by the service, and no CDP/remote-debugging endpoint is exposed. Closing the console does not mean the session is authenticated: stopping a lease resets the assessment to `session_unknown`, and the next ordinary probe must verify the session again.

## Development checks

```sh
npm run build
npm run typecheck
npm test
npm run lint
```
