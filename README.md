# Musebridge

Musebridge is a Node.js 24 ESM monorepo. The Marketplace MCP service lives in [`services/marketplace`](services/marketplace/README.md); it provides synthetic fixture data by default and an opt-in Facebook backend.

- `package.json` and `package-lock.json` — shared npm workspace root and single lockfile.
- `services/marketplace/` — service package, implementation, tests, scripts, and service documentation; there are no shared app packages.

Run service development checks from the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run lint
npm start
```

The service package retains its own `dist/index.js` runtime entry. See the [Marketplace service README](services/marketplace/README.md) for tools, configuration, safety constraints, and container instructions.

Before write-capable provider tools, actions are governed by the [provider action boundary contract](docs/provider-action-boundaries.md): session scopes per provider/account/surface, action risk classes, and single-use approval grants enforced by the service. Consumer-surface research and integration-path decisions are recorded in the [capability inventory](docs/capability-inventory.md) (#39).
