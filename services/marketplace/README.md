# Marketplace MCP service

A small Model Context Protocol service for exercising Marketplace-shaped integrations. The default `fixture` backend returns synthetic listings only and makes no remote requests; an explicitly selected Facebook backend supports search and listing fetch through a persistent browser session. Its public MCP server identity is `marketplace`.

## Run

Requires Node.js 24.

Run these commands from the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm start
```

`npm start` launches the service from its workspace while keeping the runtime entry at `dist/index.js` inside the service. If a host previously launched the built file directly, update `node dist/index.js` to `node services/marketplace/dist/index.js`. The Streamable HTTP MCP endpoint is `POST /mcp` on `127.0.0.1:8080` by default. Set `HOST=0.0.0.0` when running in a container and optionally override `PORT`. `GET /healthz` is a separate liveness endpoint. The MCP transport is stateless and returns JSON responses; request bodies are limited to 64 KiB. Requests carrying any `Origin` header (including `Origin: null`) are rejected, so this first milestone is server-to-server only.

Build and run the container locally:

```sh
docker build -f services/marketplace/Dockerfile -t marketplace-mcp .
docker run --rm -p 8080:8080 marketplace-mcp
```

GHCR publishes `ghcr.io/misospace/marketplace` for pushes to `main` and semantic version tags matching `v*.*.*`, after the Node 24 typecheck, lint, test, and build checks pass. The existing version-tag release scheme is retained; image tags (`main`, SHA, and semantic version) remain unchanged. Future image, profile, or tag changes must be coordinated with the service owner. Renovate uses the shared org preset; automatic dependency merges remain disabled for manual review during the fixture milestone.

The service has no built-in authentication. Run it only on a trusted private network and provide network-level access controls before exposing it to other networks. ToolHive can use the service's Streamable HTTP transport at port `8080` and path `/mcp`, but it is not registered with ToolHive yet.

## Tools

- `marketplace_search` requires trimmed, non-empty `query` and `location` strings (each maximum 256 characters). `min_price` and `max_price` must be finite and non-negative with minimum no greater than maximum. `limit` defaults to 5 and must be an integer from 1 through 20. Unknown input keys are rejected.
- `marketplace_search` matches `query` as a case-insensitive substring within the title or the description (a single field, never across the title/description boundary), and matches `location` case-insensitively. Results retain fixture order. Price filters exclude listings whose price is `null`.
- `marketplace_fetch` requires exactly one of `id` or `url`. IDs are bounded, safe identifiers; URLs must be HTTP(S), contain no credentials, and be at most 2048 characters. On the fixture backend, matching strips the fragment and lowercases the host before comparing against fixture URLs (lightweight normalization, not full canonicalization), and never performs network requests. On the opt-in Facebook backend, fetch accepts a numeric listing id or an item URL on the configured Facebook base origin. It extracts only the item id and rebuilds the canonical item URL from that configured base before navigation, so a caller-supplied origin, query string, or fragment is never navigated to. The backend verifies the session through the same fail-closed login, captcha, and checkpoint path as search, then extracts and validates a normalized listing. A page that still renders a complete listing is returned in full, including `state: removed` when Facebook marks it so; `NOT_FOUND` applies only to an unavailable or expired shell that cannot satisfy `Listing` (no usable title, price, or location). A fetched listing can have `state: active`, while search results never do.
- `marketplace_status` accepts `{}`; omitted arguments are also valid and report service `0.1.0`, schema `1.1.0`, and `backend: "fixture"`.
- Successful search and fetch results include the configured backend `name`; `marketplace_status` reports that same identity. The built-in backend is named `fixture`. Backend names must be non-empty strings of at most 64 characters. The schema version is `1.1.0`; additive output changes bump the minor version.
- Unknown but valid fetch identifiers return a `NOT_FOUND` runtime envelope. Invalid tool arguments are JSON-RPC `InvalidParams` errors, not tool-error envelopes.

Listing records use `images` (an array of at most six HTTP(S) URLs), required nullable ISO date-time fields `posted_at` and `updated_at`, and required nullable `seller`. Seller details are bounded and optional within a non-null seller object. `state` is one of `active`, `sold`, `pending`, `removed`, or `unknown`. The fixed fixtures use `example.com` URLs and include removed, pending, sold, unknown-state, and null-price examples.

Backends may throw the exported `ProviderError` class to return a known runtime failure. Supported codes are `AUTH_EXPIRED`, `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, `RATE_LIMITED`, `UPSTREAM_ERROR`, and `TIMEOUT`; messages and optional metadata (`action_required`, HTTP(S) `login_url`, and non-negative integer `retry_after` seconds) are validated and bounded. Only valid `ProviderError` instances are exposed to callers. Unexpected errors and malformed provider errors are logged server-side and reduced to a generic `INTERNAL_ERROR` envelope. A fetch miss remains `NOT_FOUND`.

Each search/fetch backend call has its own deadline, defaulting to 30,000 ms. Override it with `BACKEND_TIMEOUT_MS` or the `backendTimeoutMs` service option; values must be positive integers below 60,000 ms. The backend receives an `AbortSignal` that aborts on deadline, MCP request cancellation/disconnect, or service shutdown. A backend must cooperate with this signal to stop its underlying work: the service can stop awaiting an arbitrary non-cooperative promise, but cannot forcibly cancel the work itself.

## Browser runtime

The service includes a minimal Chromium session layer backed by the pinned Playwright package. It lazily starts one browser with a persistent profile at `BROWSER_PROFILE_DIR` (default `$HOME/.marketplace/browser-profile`) and serializes browser work through one page at a time. An invalid `BROWSER_PROFILE_DIR` fails service startup. Browser operations use the same `AbortSignal` and deadline path as backend work. An in-progress browser launch cannot be aborted mid-launch (Playwright exposes no signal for it): it is bounded by the launch timeout, defaulting to 30,000 ms, and the signal is honoured immediately before and after the launch. Non-cancellable infrastructure steps (page creation and page/context teardown) are bounded by a settle timeout, defaulting to 5,000 ms, so an unresponsive browser cannot wedge the serialized queue. If the timeout expires during page creation or page teardown, the current browser context is discarded and the session is marked unavailable; the next operation waits for teardown to settle and relaunches a clean context rather than continuing against a potentially unhealthy browser. Chromium runs as the non-root container user. Credentials are supplied only through the environment and are never persisted by this service; cookies, localStorage, headers, page content, and profile contents are never logged. Do not set `PWDEBUG` or `DEBUG=pw:*` in production: Playwright debug logging can include page content. No CDP endpoint is exposed. The Facebook session probe and opt-in Facebook backend use this browser for search and fetch; the fixture backend does not.

Container users should mount a persistent volume at the profile directory and run Chromium with `--init --ipc=host`, following Playwright's Docker guidance.

### Facebook session probe

`FacebookSessionProbe` in `src/facebook.ts` composes over the serialized browser manager. `probeSession(signal)` loads the Marketplace entry point and reports `session_usable` for an authenticated Marketplace page, `session_needs_reauth` for a login page or redirect (`LOGIN_REQUIRED`), checkpoint/challenge (`SESSION_INVALID`), or captcha (`CAPTCHA_REQUIRED`). `session_unknown` means no verdict is available for the current probe: the session has never been probed, the page is ambiguous, an in-flight probe is cancelled, or loading fails. A probe cancelled before it starts leaves the previous assessment untouched. Do not read `session_unknown` as "not usable"; only `session_usable` asserts an authenticated Marketplace.

Classification uses the final URL and a small set of semantic signals: a password field or login form, checkpoint form or copy, captcha frame or copy, an authenticated marker (account/profile label or logout affordance), a login prompt, and a main landmark plus a Marketplace link. It does not depend on hashed CSS classes. The default origin is exactly `https://www.facebook.com`. The probe never automates login, stores or exports credentials, or logs page HTML, cookies, storage, headers, form values, or screenshots. Credential submission is a separate, opt-in step (see below); the no-logging rule applies to it unchanged.

The origin can be injected only through the constructor for tests (or the service's `facebookBaseUrl` option); it is not an environment variable or tool input. It must be exactly `https://www.facebook.com` or a loopback test origin (`localhost`, `127.0.0.1`, or `::1`, over HTTP or HTTPS); any other origin is rejected, so this seam cannot reach an arbitrary host. A redirect to any other origin, including another Facebook subdomain, deliberately produces `session_unknown` rather than `session_usable`. `marketplace_status` also reports `facebook_session: { status }`, the last known assessment (`session_unknown`, `session_usable`, or `session_needs_reauth`), without doing browser work. This is additive: `schema_version` is `1.1.0`, and no tool name or other field changed.

The Facebook backend is opt-in; `MARKETPLACE_BACKEND` defaults to `fixture`. Set `MARKETPLACE_BACKEND=facebook` or pass `backendKind: 'facebook'` to select it. The backend implements search and listing fetch. It verifies the session before each operation and fails closed when the probe returns `session_unknown`; a plain `LOGIN_REQUIRED` verdict triggers the credential login below when credentials are configured.

Search URLs follow `/marketplace/<slug>/search/?query=` (with optional `minPrice` and `maxPrice`). The built-in map covers ten US metro markets, all in USD; callers can supply an explicit replacement market map through `facebookMarkets`. Locations must resolve through a configured label, slug, or alias. Unknown and ambiguous locations return a typed error, and slugs are never guessed.

For deployment-time configuration, set `FACEBOOK_MARKETS_FILE` to a mounted JSON file holding an array of markets, for example `[{"slug":"calgary","label":"Calgary, AB","currency":"CAD","aliases":["calgary alberta"]}]`. The file *replaces* the built-in map rather than adding to it, so leave it unset to keep the defaults; an empty value counts as unset. It is read once and validated at startup, whether or not the Facebook backend is selected, so a misconfigured file fails the process rather than surfacing on the first search. An unreadable or non-regular file, invalid JSON, an unknown key, an entry that breaks the same rules as the built-in map, a duplicate slug, or a label or alias that maps to two different markets all fail startup; the error names the file and, for a per-entry defect, the entry's index. `MARKETPLACE_MARKETS_FILE` is the name this first shipped under and still works as a fallback, but it is deprecated in favour of `FACEBOOK_MARKETS_FILE`.

The parser never synthesizes an item id, never marks a search card `active`, leaves relative timestamps as `null`, always sets `updated_at` to `null`, and uses only the first price token. For fetched listings, currency must come from an explicit marker in the price text or from a configured market resolved using the listing's own extracted location; otherwise the fetch fails closed with `UPSTREAM_ERROR` rather than guessing from an arbitrary configured market. A search reads one page only: it does not scroll or paginate. Login, captcha, invalid session/checkpoint, rate limit, timeout, and unrecognized/invalid upstream pages return bounded typed provider errors; only a recognized no-results page becomes an empty success. These errors do not expose page text, card contents, hrefs, images, cookies, or storage.

### Facebook credential login

`FacebookCredentialLogin` in `src/facebook-login.ts` is the opt-in path that replaces manual VNC re-auth as the normal way a logged-out session recovers. It is deliberately separate from the probe, which still only classifies state.

When `MARKETPLACE_BACKEND=facebook` and the probe reports `LOGIN_REQUIRED`, the backend submits credentials if they are configured: it loads Facebook's regular login page, enters `FACEBOOK_USERNAME` into `input[name="email"]` and `FACEBOOK_PASSWORD` into `input[name="pass"]`, and submits by pressing Enter, because Facebook no longer renders a login button. It then polls the same page classification every 2 seconds for up to `FACEBOOK_LOGIN_WAIT_SECONDS` (default 180) while the login is approved from the Facebook mobile app. This independent wait survives an individual search's shorter backend deadline; that search returns the ordinary backend deadline error (`TIMEOUT`) if its budget expires, while the single in-flight login continues for later requests. Approval may land on any authenticated same-origin page: the login navigates to Marketplace and classifies there before reporting success. Only the backend's confirming probe records `session_usable`. The authenticated profile is persisted by the existing persistent-profile volume, so later searches skip the login entirely.

Credentials are optional and environment-only:

- `FACEBOOK_USERNAME` / `FACEBOOK_PASSWORD` — set together or not at all; a half-configured pair fails startup once the Facebook backend is selected. They are read only for that backend, so a fixture deployment never touches them. They are never written to disk, returned in a tool result, placed in a URL, or logged. A login is attempted only for a plain login requirement.
- `FACEBOOK_LOGIN_WAIT_SECONDS` — how long to wait for the mobile approval, as a positive integer. Defaults to 180.

This is not a 2FA implementation and it bypasses nothing. A captcha stops the attempt immediately, because it cannot be satisfied from the phone. A checkpoint is tolerated while the window is open — Facebook uses one as the gate for the approval itself — and reported as `SESSION_INVALID` only once the window closes. Either outcome, and a timeout, leaves the session `session_unknown` or `session_needs_reauth`, never usable, and hands off to the manual re-auth console below. Credentials are submitted at most once per attempt; a challenge never triggers a retry.

Playwright's error text from the credential step is deliberately not surfaced: an error raised while typing can quote the typed value, so only the error name is logged.

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

Run from the repository root:

```sh
npm run build
npm run typecheck
npm test
npm run lint
```

The source package, tests, scripts, and TypeScript configs now live under `services/marketplace`. Hosts that mounted the old source, `tests`, or `dist` paths must update those paths to `services/marketplace/src`, `services/marketplace/tests`, and `services/marketplace/dist`; `npm start` and the runtime path inside the container remain unchanged. The image remains `ghcr.io/misospace/marketplace` with pinned `v*` tags. Coordinate any future image, profile, or tag changes with the service owner.

The stale release PR #21 must be regenerated after this monorepo change merges; it must not be auto-merged.
