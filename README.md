# Marketplace MCP fixture service

A small, fixture-only Model Context Protocol service for exercising Marketplace-shaped integrations. It returns synthetic listings only: it does not access Facebook, Marketplace, or any remote listing or image URL.

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
- Successful search and fetch results also include `backend: "fixture"`. Unknown but valid fetch identifiers return a `NOT_FOUND` runtime envelope; unexpected fixture backend exceptions are logged on the server and returned as a sanitized `INTERNAL_ERROR` envelope. Invalid arguments are JSON-RPC `InvalidParams` errors, not tool-error envelopes.

Listing records have bounded fields, HTTP(S)-only URLs, optional ISO date-times and a minimal optional seller. The fixed fixtures use `example.com` URLs and include available, pending, sold, unknown-state and null-price examples.

## Development checks

```sh
npm run build
npm run typecheck
npm test
npm run lint
```
