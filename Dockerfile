# syntax=docker/dockerfile:1
#
# The cairnmcp image (D-018): the authorization server and the MCP endpoint.
# No build step: Node runs the TypeScript sources directly (D-009).
#
#   docker build -t cairnmcp .
#   docker run --rm -e CAIRNMCP_DATABASE_OWNER_URL=… cairnmcp node packages/db/scripts/migrate.ts
#   docker run -p 8080:8080 --env-file .env cairnmcp
#
# The base image is pinned by digest so a moved tag can't change what we ship;
# Dependabot updates both FROM lines together.
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS deps
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
    pnpm install --offline --frozen-lockfile --prod --filter "@cairnmcp/server..."

FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=deps --chown=root:root /app /app
# Read-only code, unprivileged process.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/server/scripts/serve.ts"]
