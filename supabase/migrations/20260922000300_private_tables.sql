-- Overhead: private (non-exposed) tables. Accessed only by the worker and the
-- device endpoints over a trusted server-side Postgres connection. RLS is
-- enabled with no policies as defence in depth; no Data API role has grants.

-- ---------------------------------------------------------------------------
-- Device credentials: only SHA-256 hashes are ever stored.
-- ---------------------------------------------------------------------------
create table private.device_credentials (
  device_id uuid primary key references public.devices (id) on delete cascade,
  setup_secret_hash text not null check (setup_secret_hash ~ '^[0-9a-f]{64}$'),
  setup_secret_created_at timestamptz not null default now(),
  token_hash text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_created_at timestamptz,
  token_rotated_at timestamptz,
  enrollment_state text not null default 'pending'
    check (enrollment_state in ('pending', 'enrolled', 'revoked')),
  failed_setup_attempts integer not null default 0 check (failed_setup_attempts >= 0),
  last_setup_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_credentials_token_hash_key unique (token_hash),
  constraint device_credentials_enrolled_has_token
    check (enrollment_state <> 'enrolled' or token_hash is not null)
);

create trigger device_credentials_updated_at before update on private.device_credentials
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Active passes: compact, restart-safe worker state.
-- ---------------------------------------------------------------------------
create table private.active_passes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  location_id uuid not null,
  icao24 text not null check (icao24 ~ '^~?[0-9a-f]{6}$'),
  aircraft_id uuid references public.aircraft (id) on delete set null,
  provider text not null check (provider in ('airplanes_live', 'mock')),
  provider_pass_key text not null check (char_length(provider_pass_key) between 1 and 200),
  callsign text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  closest_seen_at timestamptz not null,
  minimum_distance_m double precision not null check (minimum_distance_m >= 0),
  minimum_altitude_ft integer,
  prev_observed_at timestamptz,
  prev_latitude double precision,
  prev_longitude double precision,
  prev_altitude_ft integer,
  current_observed_at timestamptz not null,
  current_latitude double precision not null,
  current_longitude double precision not null,
  current_altitude_ft integer,
  current_groundspeed_knots double precision,
  current_track_degrees double precision,
  sample_count integer not null default 1 check (sample_count >= 1),
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one active pass per location, provider and aircraft address.
  constraint active_passes_one_per_aircraft unique (location_id, provider, icao24),
  constraint active_passes_location_fk foreign key (owner_id, location_id)
    references public.locations (owner_id, id) on delete cascade
);

create index active_passes_owner_location_idx on private.active_passes (owner_id, location_id);
create index active_passes_aircraft_idx on private.active_passes (aircraft_id);

create trigger active_passes_updated_at before update on private.active_passes
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Operational records (bounded by private.apply_retention()).
-- Never store coordinates, tokens or raw provider URLs here.
-- ---------------------------------------------------------------------------
create table private.provider_poll_runs (
  id bigint generated always as identity primary key,
  location_id uuid references public.locations (id) on delete set null,
  provider text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('ok', 'error', 'rate_limited', 'skipped')),
  aircraft_count integer not null default 0,
  active_pass_count integer not null default 0,
  started_pass_count integer not null default 0,
  finalized_count integer not null default 0,
  rejected_sample_count integer not null default 0,
  error_code text,
  duration_ms integer not null default 0
);

create index provider_poll_runs_started_idx on private.provider_poll_runs (started_at);
create index provider_poll_runs_location_idx on private.provider_poll_runs (location_id, started_at desc);

create table private.worker_errors (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  component text not null check (char_length(component) <= 60),
  error_code text not null check (char_length(error_code) <= 60),
  message text not null check (char_length(message) <= 1000),
  location_id uuid references public.locations (id) on delete set null,
  context jsonb not null default '{}'::jsonb
);

create index worker_errors_occurred_idx on private.worker_errors (occurred_at);
create index worker_errors_location_idx on private.worker_errors (location_id);

create table private.device_logs (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.devices (id) on delete cascade,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  message text not null check (char_length(message) between 1 and 512),
  device_ts timestamptz,
  firmware_version text check (firmware_version is null or char_length(firmware_version) <= 40),
  received_at timestamptz not null default now()
);

create index device_logs_device_received_idx on private.device_logs (device_id, received_at desc);
create index device_logs_received_idx on private.device_logs (received_at);

create table private.enrichment_attempts (
  id bigint generated always as identity primary key,
  aircraft_id uuid references public.aircraft (id) on delete cascade,
  icao24 text not null,
  provider text not null check (char_length(provider) <= 60),
  attempted_at timestamptz not null default now(),
  status text not null check (status in ('success', 'not_found', 'error', 'skipped')),
  error_code text,
  details jsonb not null default '{}'::jsonb
);

create index enrichment_attempts_attempted_idx on private.enrichment_attempts (attempted_at);
create index enrichment_attempts_aircraft_idx on private.enrichment_attempts (aircraft_id, attempted_at desc);

-- Defence in depth: RLS on, no policies, no grants for Data API roles.
alter table private.device_credentials enable row level security;
alter table private.active_passes enable row level security;
alter table private.provider_poll_runs enable row level security;
alter table private.worker_errors enable row level security;
alter table private.device_logs enable row level security;
alter table private.enrichment_attempts enable row level security;

revoke all on all tables in schema private from public, anon, authenticated, service_role;
revoke all on all sequences in schema private from public, anon, authenticated, service_role;
