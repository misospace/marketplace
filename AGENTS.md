# Musebridge monorepo

- Node.js 24 ESM monorepo. Service packages live under `services/*`; root scripts delegate to the relevant workspace.
- Keep service implementation, tests, scripts, package metadata, and TypeScript configuration inside their owning service. Coordinate Dockerfile, CI, release, image, profile, and tag changes with their owner; do not rewrite unrelated files.
- Marketplace-specific contracts and safety invariants are documented in `services/marketplace/AGENTS.md`; follow them for all work in that service.
- Run dependency installation and root-level build, typecheck, test, and lint checks from the repository root.
