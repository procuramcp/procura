# syntax=docker/dockerfile:1
#
# The procura image (D-018): the authorization server, the MCP endpoint, and the
# curation console. No build step for the server: Node runs the TypeScript
# sources directly (D-009); only the console's browser bundle is built (D-033).
#
#   docker build -t procura .
#   docker run --rm -e PROCURA_DATABASE_OWNER_URL=… procura node packages/db/scripts/migrate.ts
#   docker run -p 8080:8080 --env-file .env procura
#
# Published as ghcr.io/procuramcp/procura (D-046); deploy/self-host runs it with compose.
#
# The base image is pinned by digest so a moved tag can't change what we ship;
# Dependabot updates both FROM lines together.
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS deps
WORKDIR /app
ENV CI=true PNPM_HOME=/pnpm
# pnpm comes from package.json "packageManager", through Corepack.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable && corepack install
# Download packages from the lockfile alone, so this layer is cached until dependencies change.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --prod
COPY . .
# Only the server and what it needs at runtime. Workspace packages stay symlinks into
# packages/, outside node_modules, which is where Node strips types.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod --filter "@procura/server..."

# The curation console (D-033): a browser bundle, the only thing that is built.
# Its dev dependencies (Vite, Tailwind) stay in this stage.
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS web
WORKDIR /app
ENV CI=true PNPM_HOME=/pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable && corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@procura/web" && \
    pnpm --filter @procura/web build

FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0
LABEL org.opencontainers.image.source="https://github.com/procuramcp/procura" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=deps --chown=root:root /app /app
COPY --from=web --chown=root:root /app/packages/web/dist /app/packages/web/dist
# Read-only code, unprivileged process.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/server/scripts/serve.ts"]
