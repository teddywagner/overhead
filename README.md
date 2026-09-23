# Overhead — backend

Private backend for **Overhead** (working name): it watches the sky above a
location you define, records the aircraft that genuinely fly overhead,
manages aircraft and artwork metadata and poster records, and serves posters to
a [FlightPortrait](https://github.com/flightportrait/frame)-compatible e‑ink
frame.

This repository is **backend only**: Supabase schema, a typed Hono API, a
polling worker and FlightPortrait device endpoints. The name is centralised in
`APP_NAME` / [`packages/core/src/app.ts`](packages/core/src/app.ts).

```text
apps/api                 Hono HTTP API (+ device endpoints)
apps/worker              long-running aircraft polling worker
packages/core            config, domain types, geodesy, logging
packages/database        Supabase clients, Bun SQL, generated types
packages/flight-tracking provider clients + overflight state machine
packages/device-protocol FlightPortrait protocol helpers
supabase/                migrations, seed, pgTAP tests
docs/                    architecture, database, API, worker, protocol, security, deployment
```

## 1. Install Bun

The Bun version is pinned in `package.json` (`packageManager: bun@1.4.2`).

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

```bash
bun install
```

Bun is the package manager, workspace manager, script runner, test runner and
production runtime. `bun.lock` is committed. On Windows the hoisted linker is
used (see `bunfig.toml`) to stay within path-length limits.

## 2. Supabase CLI

The CLI is a pinned dev dependency, so no global install is needed:

```bash
bunx supabase --version
bunx supabase --help          # discover commands
bunx supabase db --help       # includes `db advisors`, `db lint`, `db reset`
```

Local Supabase needs Docker (Docker Desktop, OrbStack, Podman…) running.
This project uses ports **54420–54429** (API 54421, Postgres 54422, Studio
54423; see `supabase/config.toml`) so it can run alongside other local
Supabase projects on the default 5432x ports.

## 3. Start local Supabase and apply migrations

```bash
bun run db:start      # supabase start
bun run db:reset      # re-create the DB: migrations + supabase/seed.sql
bunx supabase status -o env
```

`db:reset` applies every file in `supabase/migrations` in order and loads the
seed (one user `dev@overhead.local` / `overhead-local-password`, a fake
location beside Null Island, aircraft, one qualifying pass, one near miss, an
artwork record, a poster and a device). Nothing in the seed is real.

## 4. Generate database types

```bash
bun run db:types      # supabase gen types typescript --local > packages/database/src/database.types.ts
```

## 5. Environment

```bash
cp .env.example .env
```

Fill in from `bunx supabase status -o env`:

| Variable                       | Local value                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `SUPABASE_URL`                 | `API_URL` (http://127.0.0.1:54421)                                             |
| `SUPABASE_PUBLISHABLE_KEY`     | `PUBLISHABLE_KEY` (`sb_publishable_…`)                                         |
| `SUPABASE_SECRET_KEY`          | `SECRET_KEY` (`sb_secret_…`) — server only                                     |
| `DATABASE_URL`                 | `DB_URL` (postgresql://postgres:postgres@127.0.0.1:54422/postgres)             |
| `AIRCRAFT_PROVIDER_USER_AGENT` | something descriptive with contact info, e.g. `overhead/0.1 (you@example.com)` |

Both apps validate their environment with Zod on start-up and exit with a
list of missing/invalid variables (values are never echoed).

## 6. Run

```bash
bun run dev           # API + worker with watch mode
bun run dev:api       # http://localhost:3001  (GET /health, /ready, /openapi.json)
bun run dev:worker
```

To try the worker without the internet, set `AIRCRAFT_PROVIDER=mock` (and
optionally `MOCK_SCENARIO=busy`); it replays deterministic traffic around every
active location.

Get an access token for API calls (local):

```bash
curl -s -X POST 'http://127.0.0.1:54421/auth/v1/token?grant_type=password' \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'Content-Type: application/json' \
  -d '{"email":"dev@overhead.local","password":"overhead-local-password"}'
```

then `Authorization: Bearer <access_token>` on every `/api/v1` request.

## 7. Tests and checks

```bash
bun run test               # unit + route tests; integration tests run if local Supabase is up
bun run test:integration   # require local Supabase (fails instead of skipping)
bun run db:test            # pgTAP: RLS, grants, views, cross-user isolation (supabase test db)
bun run lint               # ESLint + Prettier check
bun run typecheck
bun run build
bun run verify             # lint + typecheck + test + build
bunx supabase db advisors --local --type all   # security & performance advisors
```

## 8. Hosted Supabase

See [docs/deployment.md](docs/deployment.md). In short: `bunx supabase login`,
`bunx supabase link --project-ref <ref>`, `bunx supabase db push`, then set the
four Supabase variables from the project's API settings (publishable + secret
keys) and a direct or session-pooler `DATABASE_URL`. Run
`bunx supabase db advisors --linked` afterwards.

## 9. Enrolling a frame

1. `POST /api/v1/devices` with `{ "name", "mac_address", "location_id" }`.
   The response contains `setup_secret` **once**; only its hash is stored.
2. On the frame, hold the right arrow for ~2 s to reopen provisioning and, in
   the app, choose a custom server: URL = your API base (e.g.
   `https://overhead.example.com`), setup secret = the value from step 1.
3. The frame calls `POST /device/v1/setup`, receives its bearer token and then
   polls `GET /device/v1/display`.
4. Create a poster, upload a 960,000-byte panel binary via
   `POST /api/v1/posters/{id}/device-binary-upload-url`, then
   `PATCH /api/v1/posters/{id}` with `{"status":"ready"}` to verify it. Until a
   verified binary exists the frame receives `503` and backs off.

Details: [docs/device-protocol.md](docs/device-protocol.md).

## Deferred (not in this phase)

- Web application / any UI
- AI image generation, background removal, remote image fetching
- Poster composition and rendering (only metadata and manually uploaded files)
- E‑ink firmware and OTA firmware updates (`firmware` is always `null`)
- FlightPortrait account-pairing extension (setup returns only `device_token`)
- Deployment infrastructure (guidance only in `docs/deployment.md`)
- Aircraft enrichment beyond what the ADS-B provider reports

## Documentation

[Architecture](docs/architecture.md) · [Database](docs/database.md) ·
[API](docs/api.md) · [Worker](docs/worker.md) ·
[Device protocol](docs/device-protocol.md) · [Security](docs/security.md) ·
[Deployment](docs/deployment.md) · [OpenAPI](docs/openapi.json)
