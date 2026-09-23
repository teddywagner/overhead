-- Overhead: per-frame display settings, committed display selections and
-- admin users.
--
-- device_display_settings: how a frame chooses which recent overflights to
--   show (a rolling window, 1-4 planes, scoring weights) and how often that
--   choice may change. Owner-editable; defaults apply when no row exists.
-- display_selections: every selection the worker commits for a frame. This
--   is the render queue (each row becomes one poster once rendering exists)
--   and its history shows how often a frame changes. Written by the worker.
-- private.admins: users allowed to use /admin/v1 (the admin board).

-- Child tables reference devices by (owner_id, id), like every other
-- owned table, so a row can never point at another owner's frame.
alter table public.devices add constraint devices_owner_id_id_key unique (owner_id, id);

-- ---------------------------------------------------------------------------
-- device_display_settings
-- ---------------------------------------------------------------------------
create table public.device_display_settings (
  device_id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  max_planes smallint not null default 3 check (max_planes between 1 and 4),
  window_hours integer not null default 6 check (window_hours between 1 and 168),
  min_dwell_minutes integer not null default 60 check (min_dwell_minutes between 0 and 1440),
  include_near_misses boolean not null default false,
  include_helicopters boolean not null default true,
  airline_only boolean not null default false,
  one_per_operator_type boolean not null default true,
  weight_rarity double precision not null default 3 check (weight_rarity between 0 and 10),
  weight_proximity double precision not null default 2 check (weight_proximity between 0 and 10),
  weight_recency double precision not null default 1 check (weight_recency between 0 and 10),
  weight_artwork double precision not null default 2 check (weight_artwork between 0 and 10),
  weight_detail double precision not null default 1 check (weight_detail between 0 and 10),
  quiet_start_hour smallint check (quiet_start_hour is null or quiet_start_hour between 0 and 23),
  quiet_end_hour smallint check (quiet_end_hour is null or quiet_end_hour between 0 and 23),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_display_settings_device_fk foreign key (owner_id, device_id)
    references public.devices (owner_id, id) on delete cascade,
  constraint device_display_settings_quiet_pair
    check ((quiet_start_hour is null) = (quiet_end_hour is null))
);

create index device_display_settings_owner_idx on public.device_display_settings (owner_id);

create trigger device_display_settings_updated_at before update on public.device_display_settings
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- display_selections (no coordinates: items are labels and scores only)
-- ---------------------------------------------------------------------------
create table public.display_selections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null,
  selected_at timestamptz not null,
  reason text not null check (reason in ('initial', 'changed')),
  overflight_ids uuid[] not null check (cardinality(overflight_ids) between 1 and 4),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  constraint display_selections_device_fk foreign key (owner_id, device_id)
    references public.devices (owner_id, id) on delete cascade
);

create index display_selections_device_selected_idx
  on public.display_selections (device_id, selected_at desc, id desc);
create index display_selections_owner_idx on public.display_selections (owner_id);
create index display_selections_selected_idx on public.display_selections (selected_at);

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------
alter table public.device_display_settings enable row level security;
alter table public.display_selections enable row level security;

revoke all on public.device_display_settings, public.display_selections from anon, authenticated;
grant select, insert, update, delete on public.device_display_settings, public.display_selections
  to service_role;

grant select on public.device_display_settings to authenticated;
grant insert (device_id, owner_id, max_planes, window_hours, min_dwell_minutes, include_near_misses,
              include_helicopters, airline_only, one_per_operator_type, weight_rarity,
              weight_proximity, weight_recency, weight_artwork, weight_detail,
              quiet_start_hour, quiet_end_hour)
  on public.device_display_settings to authenticated;
grant update (max_planes, window_hours, min_dwell_minutes, include_near_misses,
              include_helicopters, airline_only, one_per_operator_type, weight_rarity,
              weight_proximity, weight_recency, weight_artwork, weight_detail,
              quiet_start_hour, quiet_end_hour)
  on public.device_display_settings to authenticated;

create policy device_display_settings_select_own on public.device_display_settings
  for select to authenticated using (owner_id = (select auth.uid()));
create policy device_display_settings_insert_own on public.device_display_settings
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy device_display_settings_update_own on public.device_display_settings
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Selections are written only by the worker; owners may read theirs.
grant select on public.display_selections to authenticated;
create policy display_selections_select_own on public.display_selections
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- private.admins
-- Grant with: insert into private.admins (user_id)
--             select id from auth.users where email = 'you@example.com';
-- or `bun run admin:grant you@example.com`.
-- ---------------------------------------------------------------------------
create table private.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table private.admins enable row level security;
revoke all on private.admins from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retention: keep 90 days of selection history (new trailing parameter, so
-- existing `private.apply_retention()` calls keep working).
-- ---------------------------------------------------------------------------
drop function private.apply_retention(integer, integer, integer, integer, integer, integer);

create function private.apply_retention(
  overflight_point_days integer default 365,
  device_log_days integer default 30,
  device_log_max_per_device integer default 500,
  poll_run_days integer default 14,
  worker_error_days integer default 30,
  enrichment_days integer default 90,
  display_selection_days integer default 90
)
returns table (table_name text, deleted_count bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n bigint;
  n2 bigint;
begin
  delete from public.overflight_points
   where created_at < now() - make_interval(days => overflight_point_days);
  get diagnostics n = row_count;
  table_name := 'overflight_points'; deleted_count := n; return next;

  delete from private.device_logs
   where received_at < now() - make_interval(days => device_log_days);
  get diagnostics n = row_count;
  delete from private.device_logs dl
   using (
     select id from (
       select id, row_number() over (partition by device_id order by received_at desc, id desc) as rn
       from private.device_logs
     ) ranked
     where ranked.rn > device_log_max_per_device
   ) excess
   where dl.id = excess.id;
  get diagnostics n2 = row_count;
  table_name := 'device_logs'; deleted_count := n + n2; return next;

  delete from private.provider_poll_runs
   where started_at < now() - make_interval(days => poll_run_days);
  get diagnostics n = row_count;
  table_name := 'provider_poll_runs'; deleted_count := n; return next;

  delete from private.worker_errors
   where occurred_at < now() - make_interval(days => worker_error_days);
  get diagnostics n = row_count;
  table_name := 'worker_errors'; deleted_count := n; return next;

  delete from private.enrichment_attempts
   where attempted_at < now() - make_interval(days => enrichment_days);
  get diagnostics n = row_count;
  table_name := 'enrichment_attempts'; deleted_count := n; return next;

  -- Keep each frame's latest selection however old: it is what the frame shows.
  delete from public.display_selections ds
   where ds.selected_at < now() - make_interval(days => display_selection_days)
     and exists (select 1 from public.display_selections newer
                  where newer.device_id = ds.device_id and newer.selected_at > ds.selected_at);
  get diagnostics n = row_count;
  table_name := 'display_selections'; deleted_count := n; return next;
end;
$$;

revoke all on function private.apply_retention(integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
