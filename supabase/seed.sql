-- Overhead local development seed. LOCAL USE ONLY.
--
-- Everything here is fake. The location sits in open ocean next to
-- "Null Island" (0°, 0°) so it can never be mistaken for a real address.
--
--   user:          dev@overhead.local / overhead-local-password
--   device MAC:    aa:bb:cc:00:00:01
--   setup secret:  overhead-local-setup-secret   (hash stored, never plaintext)

-- ---------------------------------------------------------------------------
-- User (auth.users + email identity) and profile
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated', 'authenticated', 'dev@overhead.local',
  extensions.crypt('overhead-local-password', extensions.gen_salt('bf')),
  now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  gen_random_uuid(),
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"dev@overhead.local","email_verified":true}',
  'email', now(), now(), now()
);

insert into public.profiles (id, display_name, timezone)
values ('11111111-1111-4111-8111-111111111111', 'Local Developer', 'America/New_York');

-- ---------------------------------------------------------------------------
-- Location (obviously fake coordinates)
-- ---------------------------------------------------------------------------
insert into public.locations (
  id, owner_id, name, latitude, longitude, search_radius_nm, overhead_radius_m,
  max_altitude_ft, timezone, is_active
) values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'Null Island Test Site', 0.5, 0.5, 5, 1200, 15000, 'America/New_York', true
);

-- ---------------------------------------------------------------------------
-- Aircraft (fictional addresses and registrations)
-- ---------------------------------------------------------------------------
insert into public.aircraft (id, icao24, registration, icao_type_code, manufacturer, family, model,
                             operator_name, operator_icao, operator_iata, country, metadata_source)
values
  ('33333333-0000-4000-8000-000000000001', 'f00001', 'N101OH', 'B738', 'Boeing', '737', '737-800',
   'Example Air', 'EXA', 'EX', 'United States', 'seed'),
  ('33333333-0000-4000-8000-000000000002', 'f00002', 'N202OH', 'A320', 'Airbus', 'A320', 'A320-200',
   'Sample Airways', 'SMP', 'SM', 'United States', 'seed'),
  ('33333333-0000-4000-8000-000000000003', 'f00003', 'N303OH', 'C172', 'Cessna', '172', '172S Skyhawk',
   null, null, null, 'United States', 'seed'),
  ('33333333-0000-4000-8000-000000000004', 'f00004', null, null, null, null, null,
   null, null, null, null, 'seed');

-- ---------------------------------------------------------------------------
-- Overflights: one qualifying pass and one near miss
-- ---------------------------------------------------------------------------
insert into public.overflights (
  id, owner_id, location_id, aircraft_id, provider, provider_pass_key, icao24, registration,
  callsign, first_seen_at, closest_seen_at, last_seen_at, local_date, minimum_distance_m,
  minimum_altitude_ft, closest_altitude_ft, closest_latitude, closest_longitude, heading,
  status, qualification_reason, raw_summary
) values
  ('44444444-0000-4000-8000-000000000001',
   '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   '33333333-0000-4000-8000-000000000001', 'mock', 'mock:f00001:1789700000', 'f00001', 'N101OH',
   'EXA101', '2026-09-20T14:00:00Z', '2026-09-20T14:02:00Z', '2026-09-20T14:04:00Z', '2026-09-20',
   210.5, 4200, 4300, 0.5012, 0.5009, 88, 'qualified', 'crossed_within_overhead_radius',
   '{"sample_count":16,"seed":true}'),
  ('44444444-0000-4000-8000-000000000002',
   '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   '33333333-0000-4000-8000-000000000002', 'mock', 'mock:f00002:1789710000', 'f00002', 'N202OH',
   'SMP202', '2026-09-20T16:45:00Z', '2026-09-20T16:47:00Z', '2026-09-20T16:49:00Z', '2026-09-20',
   2100, 6000, 6100, 0.519, 0.5, 270, 'near_miss', 'outside_overhead_radius',
   '{"sample_count":14,"seed":true}');

insert into public.overflight_points (overflight_id, observed_at, latitude, longitude, altitude_ft,
                                      groundspeed_knots, track_degrees, source)
values
  ('44444444-0000-4000-8000-000000000001', '2026-09-20T14:00:00Z', 0.4990, 0.4700, 4000, 250, 88, 'provider'),
  ('44444444-0000-4000-8000-000000000001', '2026-09-20T14:02:00Z', 0.5012, 0.5009, 4300, 250, 88, 'closest_approach'),
  ('44444444-0000-4000-8000-000000000001', '2026-09-20T14:04:00Z', 0.5030, 0.5300, 4600, 250, 88, 'provider');

-- ---------------------------------------------------------------------------
-- Artwork, poster and device
-- ---------------------------------------------------------------------------
insert into public.art_assets (id, owner_id, aircraft_id, icao_type_code, operator_icao, scope, status,
                               storage_path, reviewer_notes)
values ('55555555-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        '33333333-0000-4000-8000-000000000001', 'B738', 'EXA', 'operator_type', 'pending_review',
        '11111111-1111-4111-8111-111111111111/art/seed-b738-exa.png',
        'Seed record; no storage object exists, so approval will fail until one is uploaded.');

insert into public.posters (id, owner_id, location_id, local_date, template_version, status, width, height)
values ('66666666-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222', '2026-09-20', 'v0-draft', 'draft', 1200, 1600);

insert into public.poster_items (owner_id, poster_id, overflight_id, art_asset_id, display_order, rendered_labels)
values ('11111111-1111-4111-8111-111111111111', '66666666-0000-4000-8000-000000000001',
        '44444444-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000001', 0,
        '{"title":"N101OH","subtitle":"Boeing 737-800"}');

insert into public.devices (id, owner_id, location_id, name, device_ref, mac_address, hardware_revision,
                            poll_interval_seconds)
values ('77777777-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222', 'Hallway frame', '0123456789abcdef0123456789abcdef',
        'aa:bb:cc:00:00:01', 'proto-e1004', 3600);

insert into private.device_credentials (device_id, setup_secret_hash, enrollment_state)
values ('77777777-0000-4000-8000-000000000001',
        encode(sha256(convert_to('overhead-local-setup-secret', 'UTF8')), 'hex'), 'pending');
