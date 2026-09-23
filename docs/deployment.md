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
the worker: `DATABASE_URL` and, with `AIRCRAFT_PROVIDER=airplanes_live`,
`AIRPLANES_LIVE_USER_AGENT`. Store secrets in the platform's secret manager.

## Airplanes.live

The public API is free for non-commercial use and rate limited (about one
request per second). Keep `WORKER_POLL_INTERVAL_SECONDS × active locations`
comfortably above that, and use a User-Agent that identifies you.
