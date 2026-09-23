-- Overhead: explicit Data API grants and row-level security.
--
-- Principles
--   * anon: no access to any Overhead table.
--   * authenticated: only the operations the API needs, column-scoped where
--     practical, and always paired with ownership RLS. `to authenticated` is
--     never the only condition.
--   * service_role (secret key): full table access for trusted server code;
--     it bypasses RLS by design, so it is never used for user requests.
--   * auth.uid() is wrapped in a scalar subquery so it is evaluated once per
--     statement. No policy reads user_metadata.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere in the exposed schema.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.locations enable row level security;
alter table public.aircraft enable row level security;
alter table public.overflights enable row level security;
alter table public.overflight_points enable row level security;
alter table public.source_images enable row level security;
alter table public.art_assets enable row level security;
alter table public.posters enable row level security;
alter table public.poster_items enable row level security;
alter table public.devices enable row level security;

-- ---------------------------------------------------------------------------
-- service_role grants (trusted backend only)
-- ---------------------------------------------------------------------------
grant usage on schema public to service_role;
grant select, insert, update, delete on
  public.profiles, public.locations, public.aircraft, public.overflights,
  public.overflight_points, public.source_images, public.art_assets,
  public.posters, public.poster_items, public.devices
to service_role;
grant usage, select on sequence public.overflight_points_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- profiles: a user sees and edits only their own row.
-- ---------------------------------------------------------------------------
grant select on public.profiles to authenticated;
grant insert (id, display_name, timezone) on public.profiles to authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
create policy profiles_delete_own on public.profiles for delete to authenticated
  using (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------------------
grant select, delete on public.locations to authenticated;
grant insert (owner_id, name, latitude, longitude, search_radius_nm, overhead_radius_m,
              max_altitude_ft, timezone, is_active) on public.locations to authenticated;
grant update (name, latitude, longitude, search_radius_nm, overhead_radius_m,
              max_altitude_ft, timezone, is_active) on public.locations to authenticated;

create policy locations_select_own on public.locations for select to authenticated
  using (owner_id = (select auth.uid()));
create policy locations_insert_own on public.locations for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy locations_update_own on public.locations for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy locations_delete_own on public.locations for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- aircraft: shared reference data. Visible only when the user has observed
-- the aircraft or attached their own imagery/art to it, so the table never
-- reveals what other owners have seen. Curated fields are editable by users
-- who can see the row. Rows are created only by the worker (service side).
-- ---------------------------------------------------------------------------
grant select on public.aircraft to authenticated;
grant update (registration, icao_type_code, manufacturer, family, model, variant,
              operator_name, operator_icao, operator_iata, country, metadata_source)
  on public.aircraft to authenticated;

create policy aircraft_select_observed on public.aircraft for select to authenticated
  using (
    exists (select 1 from public.overflights o
            where o.aircraft_id = aircraft.id and o.owner_id = (select auth.uid()))
    or exists (select 1 from public.source_images s
               where s.aircraft_id = aircraft.id and s.owner_id = (select auth.uid()))
    or exists (select 1 from public.art_assets a
               where a.aircraft_id = aircraft.id and a.owner_id = (select auth.uid()))
  );
create policy aircraft_update_observed on public.aircraft for update to authenticated
  using (
    exists (select 1 from public.overflights o
            where o.aircraft_id = aircraft.id and o.owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.overflights o
            where o.aircraft_id = aircraft.id and o.owner_id = (select auth.uid()))
  );
-- No INSERT/DELETE grants or policies for authenticated: denied.

-- ---------------------------------------------------------------------------
-- overflights / overflight_points: written by the worker; read-only to owners.
-- ---------------------------------------------------------------------------
grant select on public.overflights to authenticated;
create policy overflights_select_own on public.overflights for select to authenticated
  using (owner_id = (select auth.uid()));

grant select on public.overflight_points to authenticated;
create policy overflight_points_select_own on public.overflight_points for select to authenticated
  using (exists (select 1 from public.overflights o
                 where o.id = overflight_points.overflight_id
                   and o.owner_id = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- source_images
-- ---------------------------------------------------------------------------
grant select, delete on public.source_images to authenticated;
grant insert (owner_id, aircraft_id, source_provider, source_page_url, original_file_url,
              storage_path, creator, license_name, license_url, attribution_text,
              view_angle_score, identity_confidence, raw_metadata)
  on public.source_images to authenticated;
grant update (aircraft_id, source_provider, source_page_url, original_file_url, storage_path,
              creator, license_name, license_url, attribution_text, view_angle_score,
              identity_confidence, raw_metadata)
  on public.source_images to authenticated;

create policy source_images_select_own on public.source_images for select to authenticated
  using (owner_id = (select auth.uid()));
create policy source_images_insert_own on public.source_images for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy source_images_update_own on public.source_images for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy source_images_delete_own on public.source_images for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- art_assets
-- ---------------------------------------------------------------------------
grant select, delete on public.art_assets to authenticated;
grant insert (owner_id, aircraft_id, icao_type_code, operator_icao, livery_name, registration,
              scope, status, source_image_id, storage_path, thumbnail_path,
              generation_provider, generation_model, generation_prompt, prompt_version,
              identity_confidence, reviewer_notes)
  on public.art_assets to authenticated;
grant update (aircraft_id, icao_type_code, operator_icao, livery_name, registration, scope,
              status, source_image_id, storage_path, thumbnail_path, generation_provider,
              generation_model, generation_prompt, prompt_version, identity_confidence,
              reviewer_notes, approved_at)
  on public.art_assets to authenticated;

create policy art_assets_select_own on public.art_assets for select to authenticated
  using (owner_id = (select auth.uid()));
create policy art_assets_insert_own on public.art_assets for insert to authenticated
  with check (owner_id = (select auth.uid()) and status in ('draft', 'pending_review'));
-- Approval additionally requires the artwork object to exist in the owner's
-- aircraft-art folder (visible to them through storage.objects RLS).
create policy art_assets_update_own on public.art_assets for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and (status <> 'approved' or exists (
      select 1 from storage.objects so
      where so.bucket_id = 'aircraft-art' and so.name = art_assets.storage_path))
  );
create policy art_assets_delete_own on public.art_assets for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- posters. device_binary_path, binary_sha256 are set only by trusted API
-- code after verifying the uploaded object, so they are not user-writable.
-- ---------------------------------------------------------------------------
grant select, delete on public.posters to authenticated;
grant insert (owner_id, location_id, local_date, template_version, status, width, height)
  on public.posters to authenticated;
grant update (local_date, template_version, status, full_color_preview_path, eink_preview_path,
              width, height, generated_at, error)
  on public.posters to authenticated;

create policy posters_select_own on public.posters for select to authenticated
  using (owner_id = (select auth.uid()));
create policy posters_insert_own on public.posters for insert to authenticated
  with check (owner_id = (select auth.uid()) and status in ('draft', 'rendering'));
create policy posters_update_own on public.posters for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy posters_delete_own on public.posters for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- poster_items (composite FKs already force same-owner parents; the policy
-- repeats the checks explicitly so intent is visible in one place)
-- ---------------------------------------------------------------------------
grant select, delete on public.poster_items to authenticated;
grant insert (owner_id, poster_id, overflight_id, art_asset_id, display_order, rendered_labels)
  on public.poster_items to authenticated;
grant update (art_asset_id, display_order, rendered_labels) on public.poster_items to authenticated;

create policy poster_items_select_own on public.poster_items for select to authenticated
  using (owner_id = (select auth.uid()));
create policy poster_items_insert_own on public.poster_items for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.posters p
                where p.id = poster_items.poster_id and p.owner_id = (select auth.uid()))
    and exists (select 1 from public.overflights o
                where o.id = poster_items.overflight_id and o.owner_id = (select auth.uid()))
  );
create policy poster_items_update_own on public.poster_items for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy poster_items_delete_own on public.poster_items for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- devices. Telemetry columns are written only by the device endpoints.
-- ---------------------------------------------------------------------------
grant select, delete on public.devices to authenticated;
grant insert (owner_id, name, location_id, mac_address, hardware_revision, poll_interval_seconds)
  on public.devices to authenticated;
grant update (name, location_id, latest_poster_id, poll_interval_seconds, reset_requested)
  on public.devices to authenticated;

create policy devices_select_own on public.devices for select to authenticated
  using (owner_id = (select auth.uid()));
create policy devices_insert_own on public.devices for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy devices_update_own on public.devices for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy devices_delete_own on public.devices for delete to authenticated
  using (owner_id = (select auth.uid()));
