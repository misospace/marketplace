FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
COPY services/marketplace/package.json ./services/marketplace/package.json
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY services/marketplace/tsconfig.json ./services/marketplace/tsconfig.json
COPY services/marketplace/src ./services/marketplace/src
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
COPY services/marketplace/package.json ./services/marketplace/package.json
RUN npm ci --omit=dev --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BROWSER_PROFILE_DIR=/home/node/.marketplace/browser-profile
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
RUN rm -f node_modules/marketplace-mcp
# These packages support the temporary interactive re-auth console.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*
# Follow Playwright's documented build-your-own-image approach; match the browser to the pinned npm package.
RUN ./node_modules/.bin/playwright install --with-deps chromium \
    && chown -R node:node /ms-playwright \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/services/marketplace/dist ./dist
COPY --chown=node:node services/marketplace/package.json ./package.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
