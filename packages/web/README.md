# @procura/web: the curation console

A React app (Vite, Tailwind, shadcn/ui, AI Elements) that the server serves at `/app` (D-033).
The team signs in here (D-038): viewers look, editors edit toolsets (tools on or off, names,
descriptions, pins, access, and a test panel that runs a tool for real through the same runtime as
the MCP endpoint), admins also set API keys and manage the team. Under *People and profiles* they
define access profiles (D-034), set team roles, and find, suspend, or remove customers.

## Run it locally

No Auth0 or real data needed: `dev:console` starts the server with a throwaway local Postgres
database, a sign-in that approves you at once, and a stand-in for the Intervals.icu API.

```bash
pnpm --filter @procura/web build
PROCURA_TEST_DATABASE_URL=postgres://$USER@localhost:5432/postgres pnpm --filter @procura/server dev:console
```

Open http://localhost:8787/app/. For live reload, also run `pnpm --filter @procura/web dev` with
`PROCURA_DEV_SERVER=http://localhost:8787` and open the URL Vite prints (`/app/` on its port); it
proxies the API and sign-in to the dev server.

## Notes

- Every dependency is a devDependency: they are only needed to build the bundle, so the server's
  production install (and the image) doesn't carry them.
- Components in `src/components/ui` come from shadcn (`pnpm dlx shadcn add …`) and those in
  `src/components/ai-elements` from AI Elements. Local change: the code block loads only JSON in
  Shiki, with its JavaScript engine, so the console's CSP needs no WebAssembly.
- The server's API is in `packages/server/src/console/` (one route table per area), with its tests in `packages/server/src/console.test.ts`.
  Its request and response types live once in `packages/console-api`; `src/lib/api.ts` imports them
  (types only, so nothing from it ships in the bundle).
