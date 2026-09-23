-- Overhead: aircraft type reference (ICAO type designator -> make/model).
--
-- Shared reference data, not user data: every signed-in user may read it.
-- Rows are written by `bun run db:load-types` (source 'tar1090-db') or by
-- hand in the dashboard (source 'manual'; never overwritten by the loader).
-- The enricher uses it to fill manufacturer/model that adsbdb lacks.

create table public.aircraft_types (
  icao_type_code text primary key check (icao_type_code ~ '^[A-Z0-9]{2,4}$'),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  manufacturer text check (manufacturer is null or char_length(btrim(manufacturer)) between 1 and 120),
  model text check (model is null or char_length(btrim(model)) between 1 and 120),
  aircraft_class text check (aircraft_class is null or aircraft_class in (
    'landplane', 'seaplane', 'amphibian', 'helicopter', 'gyrocopter', 'tiltrotor', 'balloon', 'drone')),
  engine_count integer check (engine_count is null or engine_count between 0 and 10),
  engine_type text check (engine_type is null or engine_type in ('jet', 'turbine', 'piston', 'electric', 'rocket')),
  wake_category text check (wake_category is null or char_length(wake_category) <= 3),
  source text not null default 'manual' check (char_length(btrim(source)) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger aircraft_types_updated_at before update on public.aircraft_types
  for each row execute function private.set_updated_at();

alter table public.aircraft_types enable row level security;

revoke all on public.aircraft_types from anon, authenticated;
grant select on public.aircraft_types to authenticated;
grant select, insert, update, delete on public.aircraft_types to service_role;

-- Reference data readable by any signed-in user. Deliberately not owner
-- scoped: it contains no user data. No write policies => no user writes.
create policy aircraft_types_select_reference on public.aircraft_types
  for select to authenticated using (true);
