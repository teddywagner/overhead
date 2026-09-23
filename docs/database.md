# Database

Migrations live in `supabase/migrations` and are applied in filename order:

| File                       | Contents                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `…0100_foundation.sql`     | revoke implicit Data API default privileges; `private` schema; `private.set_updated_at()`     |
| `…0200_public_tables.sql`  | user-facing tables, indexes, composite ownership FKs, `updated_at` triggers                   |
| `…0300_private_tables.sql` | device credentials, active passes, poll runs, worker errors, device logs, enrichment attempts |
| `…0400_grants_and_rls.sql` | explicit least-privilege grants and ownership policies                                        |
| `…0500_views.sql`          | `public.hangar_aircraft` (security invoker)                                                   |
| `…0600_storage.sql`        | four private buckets and owner-prefix object policies                                         |
| `…0700_retention.sql`      | `private.apply_retention(...)`                                                                |

## Supabase 2026 Data API behaviour

Supabase no longer grants `anon`/`authenticated`/`service_role` access to new
`public` objects automatically (opt-in April 2026, default for new projects
from 30 May 2026, enforced for all projects on 30 Oct 2026). Local config sets
`[api] auto_expose_new_tables = false` to match, the foundation migration
revokes the old default privileges explicitly, and every table/view gets
explicit grants. Nothing depends on the project's creation-time setting.

## Schemas

- **`public`** — exposed through the Data API. RLS enabled on every table.
- **`private`** — never listed in `[api] schemas`; no grants for any Data API
  role; RLS enabled with no policies (defence in depth). Only the trusted
  server connection (`DATABASE_URL`) reads or writes it.

## Tables (public)

| Table               | Notes                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles`          | `id` = `auth.users.id`; display name, timezone. Created on first `GET /api/v1/profile`.                                                                                                                                                                                                                                                                   |
| `locations`         | **Coordinates are sensitive.** Radii/altitude limits with range checks; `overhead_radius_m ≤ search_radius_nm × 1852`.                                                                                                                                                                                                                                    |
| `aircraft`          | Shared reference data keyed by unique `icao24`. Unknown values are `NULL` (text checks forbid empty strings). Visible only to users who observed or annotated the aircraft.                                                                                                                                                                               |
| `overflights`       | One row per recorded pass. `status` ∈ `qualified`, `near_miss`; `qualification_reason` ∈ `crossed_within_overhead_radius`, `outside_overhead_radius`, `above_max_altitude`, `unknown_altitude`. **Idempotency key** `unique (owner_id, location_id, provider, provider_pass_key)`. `local_date` is the closest-approach date in the location's time zone. |
| `overflight_points` | Sampled track points (bounded per pass, `unique (overflight_id, observed_at, source)`), subject to retention.                                                                                                                                                                                                                                             |
| `source_images`     | Reference photos with licence/attribution fields. URLs are metadata only; nothing is fetched.                                                                                                                                                                                                                                                             |
| `art_assets`        | `scope` ∈ `registration`, `operator_livery`, `operator_type`, `type`, `fallback` with per-scope required fields; `status` ∈ `draft`, `pending_review`, `approved`, `rejected`, `archived`; `approved ⇔ approved_at is not null`.                                                                                                                          |
| `posters`           | Metadata only. `status` ∈ `draft`, `rendering`, `ready`, `failed`, `archived`; `ready` requires `device_binary_path` and `binary_sha256`.                                                                                                                                                                                                                 |
| `poster_items`      | Links posters to overflights and art. Carries `owner_id` so RLS is a direct comparison.                                                                                                                                                                                                                                                                   |
| `devices`           | FlightPortrait frames: unique `mac_address`, unique 32-hex `device_ref`, telemetry, poll interval, reset flag.                                                                                                                                                                                                                                            |

### Ownership integrity

Parents expose `unique (owner_id, id)` and children reference them through
composite foreign keys, e.g. `overflights (owner_id, location_id) →
locations (owner_id, id)`. A row can only point at parents with the same
owner — even when written by RLS-bypassing trusted code. Nullable references
use `ON DELETE SET NULL (column)` so the owner column is never nulled.

## Tables (private)

| Table                 | Notes                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_credentials`  | `setup_secret_hash`, `token_hash` (both SHA-256 hex, `token_hash` unique), creation/rotation timestamps, `enrollment_state` ∈ `pending`, `enrolled`, `revoked`, failed-attempt counters. **No plaintext is ever stored.** |
| `active_passes`       | Restart-safe worker state; `unique (location_id, provider, icao24)`; previous/current position columns, sample count, and a `state` JSONB (identity, closest approach, qualifying crossing, sampled points).              |
| `provider_poll_runs`  | One row per location poll: status, counts, error code, duration. No coordinates.                                                                                                                                          |
| `worker_errors`       | Sanitised error records.                                                                                                                                                                                                  |
| `device_logs`         | Frame log batches (level, ≤512-char message, device timestamp).                                                                                                                                                           |
| `enrichment_attempts` | Aircraft metadata enrichment audit trail.                                                                                                                                                                                 |

## Grants and RLS

Summary (`…0400_grants_and_rls.sql` is authoritative):

| Table                          | authenticated grants                                                          | Policies (all `to authenticated`, `owner_id = (select auth.uid())`)              |
| ------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| profiles                       | select; insert/update (display_name, timezone)                                | own row (`id`)                                                                   |
| locations                      | select, delete; insert/update on data columns                                 | select/insert/update/delete own                                                  |
| aircraft                       | select; update on curated columns                                             | visible/editable when observed by the caller                                     |
| overflights, overflight_points | select                                                                        | own (points via parent overflight)                                               |
| source_images, art_assets      | select, delete; column-scoped insert/update                                   | own; art approval additionally requires the object to exist in `storage.objects` |
| posters                        | select, delete; insert/update excluding `device_binary_path`, `binary_sha256` | own                                                                              |
| poster_items                   | select, delete; insert; update (art, order, labels)                           | own + parent poster/overflight owned                                             |
| devices                        | select, delete; insert/update excluding telemetry                             | own                                                                              |
| hangar_aircraft (view)         | select                                                                        | inherits via `security_invoker`                                                  |

`anon` has no grants on any Overhead table. `service_role` has table grants
for trusted tooling but the application never uses it for user requests.
Every UPDATE policy has both `USING` and `WITH CHECK`; no policy reads
`user_metadata`; there are no `SECURITY DEFINER` functions.

## Storage

Buckets (all private): `source-images`, `aircraft-art`, `poster-previews`
(PNG/JPEG/WebP, 20 MiB) and `device-binaries` (`application/octet-stream`,
1 MiB). Objects live under `<owner_id>/<kind>/…`; policies for SELECT,
INSERT, UPDATE and DELETE (upsert needs the first three) require the first
path segment to equal `auth.uid()`.

## Retention

`private.apply_retention(overflight_point_days => 365, device_log_days => 30,
device_log_max_per_device => 500, poll_run_days => 14, worker_error_days => 30,
enrichment_days => 90)` deletes expired rows and returns per-table counts. The
worker calls it every `RETENTION_INTERVAL_MINUTES`; it can also be scheduled
with pg_cron:

```sql
select cron.schedule('overhead-retention', '17 * * * *', 'select private.apply_retention()');
```

## Verification

- `bun run db:test` — pgTAP (`supabase/tests/database/security.test.sql`):
  RLS on every table, no anon grants, private schema unreachable, UPDATE
  policies have `WITH CHECK`, views are security invoker, no security definer
  functions, bucket privacy, storage policy coverage, and behavioural
  cross-user isolation as the `authenticated` role.
- `bun run test:integration` — the same guarantees end to end through the API,
  raw PostgREST and Storage.
- `bunx supabase db advisors --local --type all` and `bun run db:lint`.

## Types

`bun run db:types` regenerates `packages/database/src/database.types.ts` from
the local database (public schema).
