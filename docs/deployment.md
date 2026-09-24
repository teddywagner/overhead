# Deployment

Deployment infrastructure is out of scope for this phase; this is guidance.

## Hosted Supabase

```bash
bunx supabase login
bunx supabase link --project-ref <project-ref>
bunx supabase db push                      # applies supabase/migrations
bunx supabase db advisors --linked --type all
```

- Do **not** run `supabase/seed.sql` against a hosted project (it creates a
  development user).
- Keep only `public` in the project's exposed schemas (Dashboard → API
  settings). `private` must never be exposed.
- Keys: use the **publishable** key (`sb_publishable_…`) and the **secret**
  key (`sb_secret_…`) from the project's API keys page. Legacy `anon` /
  `service_role` JWT keys are not needed.
- `DATABASE_URL`: the direct connection or the **session** pooler (port 5432).
  The transaction pooler (6543) also works because prepared statements are
  disabled in `createSql`.
- Recommended: create dedicated login roles for the API and worker instead of
  `postgres`, granting only what `apps/api/src/trusted-repo.ts` and
  `apps/worker/src/store.ts` use (select/insert/update/delete on the relevant
  `public` and `private` tables and execute on `private.apply_retention`).
  Those roles must bypass RLS (or be the table owner) for the trusted paths.
- Optional: schedule retention with pg_cron instead of the worker
  (see database.md).

## Railway

Deploy from GitHub: **New Project → Deploy from GitHub repo →** this repo.
Railway detects the Bun workspaces and creates one service per app,
**@overhead/api** and **@overhead/worker**. Each service reads its config
from its own folder:

- `apps/api/railway.json`: builds the API only, starts it with
  `bun run start:api`, `/health` check, restarts on failure.
- `apps/worker/railway.json`: builds the worker only, starts it with
  `bun run start:worker`, always restarts.
- `watchPatterns`: each service redeploys when its own app, the shared
  `packages/`, or the lockfile changes.
- Each app also has a `start` script, so Railway's default command
  (`bun run --filter <package> start`) works too.
- The root `start` script (`scripts/start.ts`) picks the app from
  `RAILWAY_SERVICE_NAME` (or `OVERHEAD_SERVICE=api|worker`), so Railpack's
  build step always finds a start command.

Then:

1. **@overhead/api → Settings → Networking → Generate Domain**. This is the
   public HTTPS address the web app and frames use. Don't give the worker a
   domain, and keep it at **one replica**.
2. **Variables** (each service → Variables → Raw editor):

   | Variable                                                          | API | Worker |
   | ----------------------------------------------------------------- | --- | ------ |
   | `NODE_ENV=production`                                             | ✓   | ✓      |
   | `DATABASE_URL` (session pooler, ending `?sslmode=require`)        | ✓   | ✓      |
   | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | ✓   |        |
   | `TRUST_PROXY=true` (Railway sits behind a proxy)                  | ✓   |        |
   | `CORS_ALLOWED_ORIGINS` (your web app's origin, when it exists)    | ✓   |        |
   | `AIRCRAFT_PROVIDER=adsb_lol`                                      |     | ✓      |
   | `AIRCRAFT_PROVIDER_USER_AGENT` (API: admin board aircraft photos) | ✓   | ✓      |
   | `WORKER_POLL_INTERVAL_SECONDS=30`                                 |     | ✓      |

   Don't set `API_PORT`: Railway provides `PORT` and the API uses it.

3. Deploy. Check `https://<your-domain>/ready`, and look in the worker's logs
   for `worker starting` followed by successful polls.
4. **Stop any worker running on your own machine.** Two workers don't create
   duplicate overflights, but they double the requests to adsb.lol.

Pushes to `main` redeploy automatically.

## Running the processes

Both apps build to single-file Bun bundles:

```bash
bun install --frozen-lockfile
bun run build
bun apps/api/dist/index.js       # API
bun apps/worker/dist/index.js    # worker (exactly one instance)
```

- Run **one** worker instance. (Two workers would both finalise passes
  idempotently, but double the provider traffic.)
- The API is stateless apart from in-memory rate limits; see security.md
  before running several instances.
- Health checks: `GET /health` (liveness) and `GET /ready` (database).
- Terminate TLS in front of the API; frames need HTTPS unless on a trusted LAN.
- Set `TRUST_PROXY=true` only behind a proxy that sets `X-Forwarded-For`.
- Set `CORS_ALLOWED_ORIGINS` to the future web app's origin(s).
- Logs are JSON lines on stdout.

## Environment

See `.env.example`. Required for the API: `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`. Required for
the worker: `DATABASE_URL` and, unless `AIRCRAFT_PROVIDER=mock`,
`AIRCRAFT_PROVIDER_USER_AGENT`. The API also uses `AIRCRAFT_PROVIDER_USER_AGENT`
for the admin board's Planespotters.net photos; without it that one endpoint
returns `not_ready`. Store secrets in the platform's secret manager.

## ADS-B provider

The worker defaults to [adsb.lol](https://api.adsb.lol) (free, ODbL data, no
key today; rate limits are dynamic). adsb.lol has said feeder-issued API keys
will be required in future, as Airplanes.live already does (non-feeders get
HTTP 403 since ~August 2026). Requests are spaced ≥1.1 s apart, so keep
`WORKER_POLL_INTERVAL_SECONDS` comfortably above `1.1 s × active locations`,
and set `AIRCRAFT_PROVIDER_USER_AGENT` to something that identifies you.

If a provider refuses access (401/403), the worker logs `access_denied` and
pauses all polling for 15 minutes rather than retrying every poll. Long term,
a home ADS-B receiver (RTL-SDR + antenna) removes the third-party dependency
and also earns feeder access.
