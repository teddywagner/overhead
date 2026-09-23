# Architecture

```text
             ┌──────────────── Supabase ────────────────┐
 web app ──► │ Auth (JWT)   Postgres            Storage │
 (future)    │              ├─ public  (Data API, RLS)  │
   │         │              └─ private (never exposed)  │
   │         └──────▲─────────────▲──────────▲──────────┘
   │ Bearer JWT     │ user token  │ SQL      │ secret key (sign URLs only)
   ▼                │ (RLS)       │          │
 ┌───────────── apps/api (Hono on Bun) ──────┴──┐        ┌─ apps/worker (Bun) ─┐
 │ /api/v1/*   user-scoped supabase-js client   │        │ Poller              │
 │ /device/v1/* trusted repo (Bun SQL + secret) │        │  └ provider ──► adsb.lol
 │ /health /ready /openapi.json                 │        │  └ processTick (pure state machine)
 └──────────────▲───────────────────────────────┘        │  └ PostgresWorkerStore (Bun SQL)
                │ /device/v1 (FlightPortrait protocol)   └─────────────────────┘
          e-ink frame
```

## Packages

| Package                     | Responsibility                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@overhead/core`            | App name, Zod env schemas, domain enums, geodesy, local dates, redacting logger, storage path rules, artwork precedence                                                                      |
| `@overhead/database`        | `createUserClient` (acts as the caller, RLS applies), `createAuthClient` (`auth.getClaims`), `createAdminClient` (secret key), `createSql` (Bun's built-in Postgres client), generated types |
| `@overhead/flight-tracking` | `AircraftPositionProvider` interface, readsb v2 client (adsb.lol, Airplanes.live), mock/scripted providers, the overflight state machine (`processTick`)                                     |
| `@overhead/device-protocol` | FlightPortrait wire rules: token/secret generation and hashing, telemetry parsing, `/display` contract validation, panel binary verification                                                 |
| `apps/api`                  | Hono + `@hono/zod-openapi` routes, middleware (request IDs, access log, security headers, CORS allowlist, body limits, rate limits, auth)                                                    |
| `apps/worker`               | Poll loop, per-location backoff, persistence of passes/overflights, retention scheduling                                                                                                     |

Provider wire types never leave `packages/flight-tracking/src/providers/*`;
everything downstream sees `NormalizedAircraftPosition`.

## Data access model

Three distinct ways of touching the database, chosen per call site:

1. **User-scoped Data API** (`createUserClient(token)`): every `/api/v1`
   query runs as the caller, so Postgres RLS and Storage policies enforce
   ownership. Handlers additionally filter `owner_id = <caller>`.
2. **Trusted SQL** (`createSql(DATABASE_URL)`): the worker and the device
   endpoints need the `private` schema (credential hashes, active passes,
   operational logs), which is deliberately not exposed through PostgREST.
   Every trusted query is scoped by owner id or by an authenticated device.
3. **Secret-key Storage** (`createAdminClient`): used for exactly one thing —
   signing short-lived download URLs for device binaries after the frame has
   authenticated.

## Request lifecycle (`/api/v1`)

`requestContext` (X-Request-Id) → `accessLog` → `secureHeaders` → `no-store`
→ CORS allowlist → body limit → `requireUser` (`auth.getClaims`, role must be
`authenticated`) → per-user rate limit → Zod validation (`@hono/zod-openapi`)
→ handler → `{ data, error, request_id }` envelope. Errors are `AppError`s with
stable codes; database errors are mapped to safe messages (raw Postgres
messages are never returned).

## Overflight pipeline

`Poller.runCycle` → for each active location: provider query →
`loadActivePasses` → `processTick` (pure) → `applyTick` (one transaction:
upsert aircraft, insert overflight `ON CONFLICT DO NOTHING`, insert sampled
points, delete finished active passes by pass key, upsert continuing passes)
→ `provider_poll_runs` row. See [worker.md](worker.md).

## Artwork matching (future renderer)

`matchArtAsset` in `packages/core/src/domain.ts` implements, over approved
assets only:

1. exact registration
2. operator + aircraft type + livery
3. operator + aircraft type
4. generic aircraft type
5. generic fallback

The `hangar_aircraft` view reports the best available scope per aircraft.
