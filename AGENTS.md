# Marketplace fixture MCP

- Node.js 24 ESM TypeScript service. Keep the build output entry at `dist/index.js`.
- Owned app files: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.test.json`, `src/**`, `tests/**`, `README.md`, `AGENTS.md`, and `.gitignore`. Coordinate container/CI changes with their owner; do not rewrite unrelated files.
- Validate tool inputs strictly with Zod and return malformed arguments as JSON-RPC `InvalidParams`. Preserve the public names `marketplace_search`, `marketplace_fetch`, and `marketplace_status`.
- The fixture backend is synthetic only. Never fetch a supplied listing URL; serve only on trusted private networks. Any `Origin` header is rejected until browser access has an explicit origin policy.
- Development checks: `npm ci --ignore-scripts`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint`.
