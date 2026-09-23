-- Overhead: user-facing tables in the exposed `public` schema.
--
-- Ownership integrity: child rows reference parents through composite
-- foreign keys on (owner_id, id). A row can therefore only point at parents
-- owned by the same user, even when written by trusted (RLS-bypassing) code.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 100),
  timezone text not null default 'America/New_York'
    check (timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- locations (coordinates are sensitive: owner-only, never logged)
-- ---------------------------------------------------------------------------
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  search_radius_nm double precision not null default 5
    check (search_radius_nm > 0 and search_radius_nm <= 250),
  overhead_radius_m integer not null default 1200
    check (overhead_radius_m > 0 and overhead_radius_m <= 50000),
  max_altitude_ft integer not null default 15000
    check (max_altitude_ft > 0 and max_altitude_ft <= 60000),
  timezone text not null default 'America/New_York'
    check (timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locations_owner_id_id_key unique (owner_id, id),
  constraint locations_overhead_within_search
    check (overhead_radius_m <= search_radius_nm * 1852)
);

create index locations_owner_created_idx on public.locations (owner_id, created_at desc, id desc);
create index locations_active_idx on public.locations (id) where is_active;

-- ---------------------------------------------------------------------------
-- aircraft (shared reference data keyed by ICAO 24-bit address)
-- ---------------------------------------------------------------------------
create table public.aircraft (
  id uuid primary key default gen_random_uuid(),
  icao24 text not null check (icao24 ~ '^~?[0-9a-f]{6}$'),
  registration text check (registration is null or registration ~ '^[A-Z0-9-]{1,12}$'),
  icao_type_code text check (icao_type_code is null or icao_type_code ~ '^[A-Z0-9]{2,4}$'),
  manufacturer text check (manufacturer is null or char_length(btrim(manufacturer)) between 1 and 120),
  family text check (family is null or char_length(btrim(family)) between 1 and 120),
  model text check (model is null or char_length(btrim(model)) between 1 and 120),
  variant text check (variant is null or char_length(btrim(variant)) between 1 and 120),
  operator_name text check (operator_name is null or char_length(btrim(operator_name)) between 1 and 160),
  operator_icao text check (operator_icao is null or operator_icao ~ '^[A-Z]{3}$'),
  operator_iata text check (operator_iata is null or operator_iata ~ '^[A-Z0-9]{2}$'),
  country text check (country is null or char_length(btrim(country)) between 1 and 80),
  metadata_source text check (metadata_source is null or char_length(btrim(metadata_source)) between 1 and 60),
  raw_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aircraft_icao24_key unique (icao24)
);

create index aircraft_registration_idx on public.aircraft (registration) where registration is not null;
create index aircraft_type_code_idx on public.aircraft (icao_type_code) where icao_type_code is not null;
create index aircraft_operator_icao_idx on public.aircraft (operator_icao) where operator_icao is not null;
create index aircraft_manufacturer_idx on public.aircraft (lower(manufacturer)) where manufacturer is not null;
create index aircraft_model_idx on public.aircraft (lower(model)) where model is not null;

-- ---------------------------------------------------------------------------
-- overflights (one row per completed, recorded pass)
-- ---------------------------------------------------------------------------
create table public.overflights (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  location_id uuid not null,
  aircraft_id uuid references public.aircraft (id) on delete set null,
  provider text not null check (provider in ('airplanes_live', 'mock')),
  provider_pass_key text not null check (char_length(provider_pass_key) between 1 and 200),
  icao24 text not null check (icao24 ~ '^~?[0-9a-f]{6}$'),
  registration text check (registration is null or registration ~ '^[A-Z0-9-]{1,12}$'),
  callsign text check (callsign is null or callsign ~ '^[A-Z0-9]{1,8}$'),
  flight_number text check (flight_number is null or char_length(flight_number) between 1 and 10),
  origin_code text check (origin_code is null or origin_code ~ '^[A-Z0-9]{3,4}$'),
  destination_code text check (destination_code is null or destination_code ~ '^[A-Z0-9]{3,4}$'),
  first_seen_at timestamptz not null,
  closest_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  local_date date not null,
  minimum_distance_m double precision not null check (minimum_distance_m >= 0),
  minimum_altitude_ft integer,
  closest_altitude_ft integer,
  closest_latitude double precision check (closest_latitude between -90 and 90),
  closest_longitude double precision check (closest_longitude between -180 and 180),
  heading double precision check (heading >= 0 and heading < 360),
  status text not null check (status in ('qualified', 'near_miss')),
  qualification_reason text not null check (qualification_reason in (
    'crossed_within_overhead_radius', 'outside_overhead_radius',
    'above_max_altitude', 'unknown_altitude')),
  raw_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_summary) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint overflights_owner_id_id_key unique (owner_id, id),
  -- Idempotency: the worker may retry finalisation any number of times.
  constraint overflights_idempotency_key unique (owner_id, location_id, provider, provider_pass_key),
  constraint overflights_location_fk foreign key (owner_id, location_id)
    references public.locations (owner_id, id) on delete cascade,
  constraint overflights_time_order
    check (first_seen_at <= closest_seen_at and closest_seen_at <= last_seen_at)
);

create index overflights_owner_closest_idx on public.overflights (owner_id, closest_seen_at desc, id desc);
create index overflights_location_date_idx on public.overflights (location_id, local_date);
create index overflights_aircraft_idx on public.overflights (aircraft_id);
create index overflights_owner_icao24_idx on public.overflights (owner_id, icao24);
create index overflights_registration_idx on public.overflights (registration) where registration is not null;

-- ---------------------------------------------------------------------------
-- overflight_points (sampled, bounded per pass; subject to retention)
-- ---------------------------------------------------------------------------
create table public.overflight_points (
  id bigint generated always as identity primary key,
  overflight_id uuid not null references public.overflights (id) on delete cascade,
  observed_at timestamptz not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  altitude_ft integer,
  groundspeed_knots double precision check (groundspeed_knots is null or groundspeed_knots >= 0),
  track_degrees double precision check (track_degrees is null or (track_degrees >= 0 and track_degrees < 360)),
  source text not null default 'provider' check (source in ('provider', 'closest_approach')),
  created_at timestamptz not null default now(),
  constraint overflight_points_unique_sample unique (overflight_id, observed_at, source)
);

create index overflight_points_created_idx on public.overflight_points (created_at);

-- ---------------------------------------------------------------------------
-- source_images (reference photos + licensing; no remote fetching yet)
-- ---------------------------------------------------------------------------
create table public.source_images (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  aircraft_id uuid references public.aircraft (id) on delete set null,
  source_provider text not null check (char_length(btrim(source_provider)) between 1 and 60),
  source_page_url text check (source_page_url is null or (source_page_url ~ '^https?://' and char_length(source_page_url) <= 2048)),
  original_file_url text check (original_file_url is null or (original_file_url ~ '^https?://' and char_length(original_file_url) <= 2048)),
  storage_path text check (storage_path is null or starts_with(storage_path, owner_id::text || '/')),
  creator text check (creator is null or char_length(creator) <= 200),
  license_name text check (license_name is null or char_length(license_name) <= 120),
  license_url text check (license_url is null or (license_url ~ '^https?://' and char_length(license_url) <= 2048)),
  attribution_text text check (attribution_text is null or char_length(attribution_text) <= 1000),
  view_angle_score double precision check (view_angle_score is null or view_angle_score between 0 and 1),
  identity_confidence double precision check (identity_confidence is null or identity_confidence between 0 and 1),
  raw_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_images_owner_id_id_key unique (owner_id, id)
);

create index source_images_owner_created_idx on public.source_images (owner_id, created_at desc, id desc);
create index source_images_aircraft_idx on public.source_images (aircraft_id);

-- ---------------------------------------------------------------------------
-- art_assets (generic type / operator+type(+livery) / exact registration)
-- ---------------------------------------------------------------------------
create table public.art_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  aircraft_id uuid references public.aircraft (id) on delete set null,
  icao_type_code text check (icao_type_code is null or icao_type_code ~ '^[A-Z0-9]{2,4}$'),
  operator_icao text check (operator_icao is null or operator_icao ~ '^[A-Z]{3}$'),
  livery_name text check (livery_name is null or char_length(btrim(livery_name)) between 1 and 120),
  registration text check (registration is null or registration ~ '^[A-Z0-9-]{1,12}$'),
  scope text not null check (scope in ('registration', 'operator_livery', 'operator_type', 'type', 'fallback')),
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'approved', 'rejected', 'archived')),
  source_image_id uuid,
  storage_path text not null check (starts_with(storage_path, owner_id::text || '/')),
  thumbnail_path text check (thumbnail_path is null or starts_with(thumbnail_path, owner_id::text || '/')),
  generation_provider text check (generation_provider is null or char_length(generation_provider) <= 60),
  generation_model text check (generation_model is null or char_length(generation_model) <= 120),
  generation_prompt text check (generation_prompt is null or char_length(generation_prompt) <= 8000),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 40),
  identity_confidence double precision check (identity_confidence is null or identity_confidence between 0 and 1),
  reviewer_notes text check (reviewer_notes is null or char_length(reviewer_notes) <= 2000),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint art_assets_owner_id_id_key unique (owner_id, id),
  constraint art_assets_source_image_fk foreign key (owner_id, source_image_id)
    references public.source_images (owner_id, id) on delete set null (source_image_id),
  constraint art_assets_scope_fields check (
    case scope
      when 'registration' then registration is not null
      when 'operator_livery' then operator_icao is not null and icao_type_code is not null and livery_name is not null
      when 'operator_type' then operator_icao is not null and icao_type_code is not null
      when 'type' then icao_type_code is not null
      else true
    end),
  constraint art_assets_approval_consistency check ((status = 'approved') = (approved_at is not null))
);

create index art_assets_owner_created_idx on public.art_assets (owner_id, created_at desc, id desc);
create index art_assets_match_idx on public.art_assets (owner_id, status, scope, icao_type_code, operator_icao);
create index art_assets_registration_idx on public.art_assets (owner_id, registration) where registration is not null;
create index art_assets_aircraft_idx on public.art_assets (aircraft_id);
create index art_assets_source_image_idx on public.art_assets (owner_id, source_image_id);

-- ---------------------------------------------------------------------------
-- posters (metadata only in this phase; rendering is deferred)
-- ---------------------------------------------------------------------------
create table public.posters (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  location_id uuid not null,
  local_date date not null,
  template_version text not null check (char_length(btrim(template_version)) between 1 and 40),
  status text not null default 'draft' check (status in ('draft', 'rendering', 'ready', 'failed', 'archived')),
  full_color_preview_path text check (full_color_preview_path is null or starts_with(full_color_preview_path, owner_id::text || '/')),
  eink_preview_path text check (eink_preview_path is null or starts_with(eink_preview_path, owner_id::text || '/')),
  device_binary_path text check (device_binary_path is null or starts_with(device_binary_path, owner_id::text || '/')),
  binary_sha256 text check (binary_sha256 is null or binary_sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null default 1200 check (width between 1 and 10000),
  height integer not null default 1600 check (height between 1 and 10000),
  generated_at timestamptz,
  error text check (error is null or char_length(error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posters_owner_id_id_key unique (owner_id, id),
  constraint posters_location_fk foreign key (owner_id, location_id)
    references public.locations (owner_id, id) on delete cascade,
  -- A poster can only be served to a frame once its binary is verified.
  constraint posters_ready_requires_binary
    check (status <> 'ready' or (device_binary_path is not null and binary_sha256 is not null))
);

create index posters_owner_created_idx on public.posters (owner_id, created_at desc, id desc);
create index posters_location_date_idx on public.posters (owner_id, location_id, local_date desc);

-- ---------------------------------------------------------------------------
-- poster_items
-- owner_id is denormalised onto the row so RLS is a direct equality check
-- and the composite FKs guarantee poster/overflight/art share one owner.
-- ---------------------------------------------------------------------------
create table public.poster_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  poster_id uuid not null,
  overflight_id uuid not null,
  art_asset_id uuid,
  display_order integer not null check (display_order between 0 and 1000),
  rendered_labels jsonb not null default '{}'::jsonb check (jsonb_typeof(rendered_labels) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint poster_items_poster_fk foreign key (owner_id, poster_id)
    references public.posters (owner_id, id) on delete cascade,
  constraint poster_items_overflight_fk foreign key (owner_id, overflight_id)
    references public.overflights (owner_id, id) on delete cascade,
  constraint poster_items_art_asset_fk foreign key (owner_id, art_asset_id)
    references public.art_assets (owner_id, id) on delete set null (art_asset_id),
  constraint poster_items_unique_overflight unique (poster_id, overflight_id)
);

create index poster_items_owner_poster_idx on public.poster_items (owner_id, poster_id);
create index poster_items_overflight_idx on public.poster_items (owner_id, overflight_id);
create index poster_items_art_asset_idx on public.poster_items (owner_id, art_asset_id);

-- ---------------------------------------------------------------------------
-- devices (FlightPortrait-compatible frames). Credentials live in private.
-- ---------------------------------------------------------------------------
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  location_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  device_ref text not null default replace(gen_random_uuid()::text, '-', '')
    check (device_ref ~ '^[0-9a-f]{32}$'),
  mac_address text not null check (mac_address ~ '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'),
  hardware_revision text check (hardware_revision is null or char_length(hardware_revision) <= 60),
  firmware_version text check (firmware_version is null or char_length(firmware_version) <= 40),
  battery_mv integer check (battery_mv is null or battery_mv between 0 and 10000),
  rssi integer check (rssi is null or rssi between -150 and 20),
  last_boot_reason text check (last_boot_reason is null or last_boot_reason in ('rtc', 'power-on', 'button', 'pairing', 'unknown')),
  last_seen_at timestamptz,
  latest_poster_id uuid,
  poll_interval_seconds integer not null default 3600 check (poll_interval_seconds between 60 and 604800),
  reset_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_device_ref_key unique (device_ref),
  constraint devices_mac_address_key unique (mac_address),
  constraint devices_location_fk foreign key (owner_id, location_id)
    references public.locations (owner_id, id) on delete set null (location_id),
  constraint devices_latest_poster_fk foreign key (owner_id, latest_poster_id)
    references public.posters (owner_id, id) on delete set null (latest_poster_id)
);

create index devices_owner_created_idx on public.devices (owner_id, created_at desc, id desc);
create index devices_location_idx on public.devices (owner_id, location_id);
create index devices_latest_poster_idx on public.devices (owner_id, latest_poster_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger locations_updated_at before update on public.locations
  for each row execute function private.set_updated_at();
create trigger aircraft_updated_at before update on public.aircraft
  for each row execute function private.set_updated_at();
create trigger overflights_updated_at before update on public.overflights
  for each row execute function private.set_updated_at();
create trigger source_images_updated_at before update on public.source_images
  for each row execute function private.set_updated_at();
create trigger art_assets_updated_at before update on public.art_assets
  for each row execute function private.set_updated_at();
create trigger posters_updated_at before update on public.posters
  for each row execute function private.set_updated_at();
create trigger poster_items_updated_at before update on public.poster_items
  for each row execute function private.set_updated_at();
create trigger devices_updated_at before update on public.devices
  for each row execute function private.set_updated_at();
