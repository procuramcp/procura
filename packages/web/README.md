# @cairnmcp/web: the curation console

A React app (Vite, Tailwind, shadcn/ui, AI Elements) that the server serves at `/app` (D-033).
Owners and admins sign in and edit toolsets: tools on or off, names, descriptions, pins, access,
and a test panel that runs a tool for real through the same runtime as the MCP endpoint.

## Run it locally

No Auth0 or real data needed: `dev:console` starts the server with a throwaway local Postgres
database, a sign-in that approves you at once, and a stand-in for the Intervals.icu API.

```bash
pnpm --filter @cairnmcp/web build
CAIRNMCP_TEST_DATABASE_URL=postgres://$USER@localhost:5432/postgres pnpm --filter @cairnmcp/server dev:console
```

Open http://localhost:8787/app/. For live reload, also run `pnpm --filter @cairnmcp/web dev` with
`CAIRNMCP_DEV_SERVER=http://localhost:8787` and open the URL Vite prints (`/app/` on its port); it
proxies the API and sign-in to the dev server.

## Notes

- Every dependency is a devDependency: they are only needed to build the bundle, so the server's
  production install (and the image) doesn't carry them.
- Components in `src/components/ui` come from shadcn (`pnpm dlx shadcn add …`) and those in
  `src/components/ai-elements` from AI Elements. Local change: the code block loads only JSON in
  Shiki, with its JavaScript engine, so the console's CSP needs no WebAssembly.
- The server's API is in `packages/server/src/console.ts`, with its tests in `console.test.ts`.
