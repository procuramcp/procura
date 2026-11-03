# The cairnmcp IR

Every ingestor produces an `IrDocument`; everything downstream (runtime, MCP server, curation UI,
evals) reads only the IR. Source: `packages/core/src/ir/`.

```
IrDocument { irVersion: 1, source: Source, operations: Operation[] }
Toolset    { id, sourceId, name, tools: ToolBinding[] }   // curated per tenant
```

## Source

| Field | Meaning |
| --- | --- |
| `id` | Slug, e.g. `intervals-icu` |
| `baseUrl` | `https:` only; no credentials, query, or trailing slash |
| `authSchemes` | Shapes only (`http_basic`, `http_bearer`, `api_key`, `oauth2`, `oidc`). Credential values never appear in the IR. |
| `defaultAuth` | Alternatives of conjunctions, as in OpenAPI: `[[A], [B]]` = A or B; `[[A, B]]` = A and B; `[]` = none |
| `rateLimits` | `{ scope: ip/credential/application/global, maxRequests, windowSeconds, basis: documented/observed/assumed }` |
| `derivation` | Ingestor and version, document URL and SHA-256, format and API version, `derivedAt` |

## Operation

| Field | Meaning |
| --- | --- |
| `id` | Stable snake_case id, unique per source; also the default tool name |
| `title`, `description` | As ingested; toolsets override them for agents |
| `input` | JSON Schema 2020-12, root `type: object`, self-contained (`$defs`) |
| `output` | Schema of the success response, if known; over 64 KB, deeper types are left open (D-042) |
| `mapping` | `kind: "http"`: method, path template, one binding per input property, optional `fixedQuery` (always-sent query values), body binding (with per-field `encoding` for form bodies, e.g. `deepObject` as `a[b]=v`), response decode |
| `sideEffect` | `{ class: read/write/destructive, basis, reason }` |
| `auth` | Overrides `defaultAuth` when present |
| `provenance` | `{ kind: spec/introspection/inferred/verified, sourceRef, originalId }` |
| `confidence` | 0 to 1; only `verified` may be 1 |

Invariants enforced by the schema (not just documented):

- Every input property has exactly one binding, and every binding has a property.
- Path placeholders and path bindings match one to one; path parameters are required.
- All `$ref`s point into the schema's own `$defs` and resolve.
- A non-curated `sideEffect` can't be less severe than the HTTP method implies. Labels inform
  users and MCP clients; they never block a tool.
- Operation ids are unique; auth requirements name existing schemes.

## Toolset

Each tool binding has an `enabled` flag; that is the only switch. `defaultToolset(ir, …)` offers
every operation as a tool and enables only reads. Users can enable anything else directly
(DECISIONS D-016). `resolveToolset(toolset, ir)` returns either every enabled tool, ready to serve
(input schema with pinned inputs removed, MCP annotations), or a list of structural issues
(unknown operation, pin for a missing input, wrong source).

## Example: Intervals.icu `list_activities`

Abbreviated (`$defs` contents elided). Run `pnpm ir:dump` for the full IR in `out/`.

```json
{
  "id": "list_activities",
  "title": "List activities for a date range in desc date order",
  "description": "List activities for a date range in desc date order\n\nAn empty stub object is returned for Strava activities",
  "tags": ["Activities"],
  "deprecated": false,
  "input": {
    "type": "object",
    "properties": {
      "id": { "type": "string" },
      "oldest": { "type": "string", "description": "Local ISO-8601 date or date and time e.g. 2019-07-22T16:18:49 or 2019-07-22" },
      "newest": { "type": "string", "description": "Local ISO-8601 date or date and time, defaults to now" },
      "route_id": { "type": "integer", "format": "int64", "description": "Only return activities on this route" },
      "limit": { "type": "integer", "format": "int32", "description": "Return at most this many activities" },
      "fields": { "type": "array", "items": { "type": "string" }, "uniqueItems": true, "description": "Comma separated list of field names to include ..." }
    },
    "required": ["id", "oldest"],
    "additionalProperties": false
  },
  "output": { "type": "array", "items": { "$ref": "#/$defs/Activity" }, "$defs": { "Activity": "…", "ZoneTime": "…" } },
  "mapping": {
    "kind": "http",
    "method": "GET",
    "pathTemplate": "/api/v1/athlete/{id}/activities",
    "parameters": [
      { "property": "id", "in": "path", "wireName": "id", "style": "simple", "explode": false },
      { "property": "oldest", "in": "query", "wireName": "oldest", "style": "form", "explode": true },
      { "property": "fields", "in": "query", "wireName": "fields", "style": "form", "explode": true }
    ],
    "response": { "status": "200", "mediaType": "*/*", "decode": "json" }
  },
  "sideEffect": { "class": "read", "basis": "http_method", "reason": "default for GET" },
  "provenance": { "kind": "spec", "sourceRef": "#/paths/~1api~1v1~1athlete~1{id}~1activities/get", "originalId": "listActivities" },
  "confidence": 0.8
}
```

`confidence` is 0.8 because the spec declares the response as `*/*`, so JSON is assumed.

The reviewed one-line-per-operation summary of all 148 Intervals.icu operations is
`packages/ingest/src/openapi/__snapshots__/intervals-icu.summary.txt`. A test fails if it changes.
