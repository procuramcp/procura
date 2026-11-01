# @cairnmcp/server

The cairnmcp app: the embedded authorization server (`packages/auth`) and the MCP endpoint
(`packages/mcp`) in one Node process, the one container image of D-018.

```bash
pnpm --filter @cairnmcp/db migrate      # as the owner role, see packages/db/README.md
pnpm --filter @cairnmcp/server start    # as the app role
```

Settings are environment variables, validated at startup; the process refuses to start and lists
every problem if something is missing. See the root `.env.example`. Health check: `GET /healthz`.
