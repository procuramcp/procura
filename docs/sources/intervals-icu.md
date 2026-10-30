# Intervals.icu: source notes

Behaviour of the Intervals.icu API that the OpenAPI description doesn't state, or states
ambiguously. "Confirmed" means observed with a real key via `pnpm try:intervals`.

| Topic | Finding | Status |
| --- | --- | --- |
| Basic auth username | The username is the literal `API_KEY`; the password is the key. Set as `fixedUsername` on the `APIKey` scheme (curation). | Confirmed 2026-10-30 |
| Security declaration | The spec ANDs `APIKey` and `AccessToken`; either one works. The mapper splits them into alternatives (D-007). | Spec quirk, handled |
| Athlete id `0` | `/api/v1/athlete/0/...` addresses the athlete the key belongs to. Default pinned value for the `id` path parameter on athlete-scoped tools. | Confirmed 2026-10-30 |
| `fields` query parameter | Both `fields=a&fields=b` (what the spec implies) and `fields=a,b` (what its description says) are honored. A full activity has ~184 fields; asking for 3 returns 3. Tools should encourage agents to pass `fields`. | Confirmed 2026-10-30 |
| Strava-synced activities | Returned as stubs with only `id`, `start_date_local`, `source`, `_note`, `icu_athlete_id` (Strava's API terms). Their details can't be read via the API; upload from the device or another service to make them visible. The analyzer must skip stubs and say so. | Confirmed 2026-10-30 |
| Response media type | Every JSON response is declared `*/*`; the mapper assumes JSON (confidence 0.8). | Spec quirk, handled |
| Rate limits | Not documented officially. Runtime defaults are conservative guesses (D-020). | Open |
| OAuth app registration | Needed for delegated tokens instead of API keys. Process to be asked on the Intervals.icu forum. | Open |
