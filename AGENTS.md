# Marketplace fixture MCP

- Node.js 24 ESM TypeScript service. Keep the build output entry at `dist/index.js`.
- Owned app files: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.test.json`, `src/**`, `tests/**`, `README.md`, `AGENTS.md`, and `.gitignore`. Coordinate container/CI changes with their owner; do not rewrite unrelated files.
- Validate tool inputs strictly with Zod and return malformed arguments as JSON-RPC `InvalidParams`. Preserve the public names `marketplace_search`, `marketplace_fetch`, and `marketplace_status` and the versioned consumer listing contract.
- The fixture backend is synthetic only. Never fetch a supplied listing URL; serve only on trusted private networks. Any `Origin` header is rejected until browser access has an explicit origin policy.
- Backends expose a bounded non-empty `name`; provider failures must use validated `ProviderError` values. Search/fetch backend calls receive an abort signal and obey the configured deadline, while recognizing arbitrary promises cannot be forcibly cancelled.
- Browser runtime uses one serialized persistent-profile browser; never store Facebook credentials, log cookies/localStorage/headers/page content/profile contents, or expose CDP. Browser work must honor the abort signal, and the fixture backend stays the default.
- The Facebook session probe only classifies session state; it never automates login or stores/exports credentials. Ambiguous or failed probes remain `session_unknown`, never usable. Keep origin injection an internal test seam, and never log page content, cookies, storage, headers, or form values.
- Development checks: `npm ci --ignore-scripts`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint`.
