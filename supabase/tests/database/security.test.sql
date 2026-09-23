-- Overhead security verification (pgTAP). Run with: bun run db:test
-- Structural checks on grants/RLS/views/functions, then behavioural
-- cross-user isolation checks executed as the `authenticated` role.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0, 'RLS is enabled on every table in the exposed public schema');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relkind = 'r' and not c.relrowsecurity),
  0, 'RLS is enabled on every private table (defence in depth)');

select is(
  (select count(*)::int from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'),
  0, 'anon has no privileges on any public table or view');

select is(
  (select count(*)::int from information_schema.role_table_grants
    where grantee in ('anon', 'authenticated', 'service_role') and table_schema = 'private'),
  0, 'no Data API role has privileges on private tables');

select ok(not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated cannot use the private schema');
select ok(not has_schema_privilege('anon', 'private', 'usage'),
  'anon cannot use the private schema');

select is(
  (select count(*)::int from pg_policies
    where (schemaname = 'public' or (schemaname = 'storage' and policyname like 'overhead_%'))
      and cmd = 'UPDATE' and (qual is null or with_check is null)),
  0, 'every UPDATE policy has both USING and WITH CHECK');

select is(
  (select count(*)::int from pg_policies
    where schemaname in ('public', 'storage')
      and (coalesce(qual, '') ilike '%user_metadata%' or coalesce(with_check, '') ilike '%user_metadata%')),
  0, 'no policy authorises via user_metadata');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and roles <> '{authenticated}'),
  0, 'all public policies target authenticated only');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_policies p
                       where p.schemaname = 'public' and p.tablename = c.relname and p.cmd = 'SELECT')),
  0, 'every public table has a SELECT policy');

select ok(
  (select coalesce('security_invoker=true' = any(c.reloptions), false)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'hangar_aircraft'),
  'hangar_aircraft is a security_invoker view');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce('security_invoker=true' = any(c.reloptions), false)),
  0, 'every public view is security_invoker');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef),
  0, 'no SECURITY DEFINER functions');

select ok(not has_function_privilege('authenticated', 'private.apply_retention(integer,integer,integer,integer,integer,integer,integer)', 'execute'),
  'authenticated cannot execute the retention function');

select is(
  (select count(*)::int from storage.buckets
    where id in ('source-images', 'aircraft-art', 'poster-previews', 'device-binaries') and not public),
  4, 'all four buckets exist and are private');

select is(
  (select array_agg(cmd order by cmd) from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname like 'overhead_%'),
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[],
  'storage policies cover SELECT, INSERT, UPDATE (upsert) and DELETE');

select ok(not has_table_privilege('authenticated', 'public.overflights', 'INSERT'),
  'authenticated cannot insert overflights');
select ok(not has_column_privilege('authenticated', 'public.devices', 'battery_mv', 'UPDATE'),
  'authenticated cannot update device telemetry');
select ok(not has_column_privilege('authenticated', 'public.posters', 'binary_sha256', 'UPDATE'),
  'authenticated cannot set a poster binary hash');
select ok(not has_column_privilege('authenticated', 'public.locations', 'owner_id', 'UPDATE'),
  'authenticated cannot change a location owner');

-- ---------------------------------------------------------------------------
-- Behaviour: two users, each with a location, overflight and device
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'a@rls.test'),
       ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'b@rls.test');

insert into public.locations (id, owner_id, name, latitude, longitude)
values ('aaaaaaaa-1111-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a', 'A', 0.1, 0.1),
       ('bbbbbbbb-1111-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-00000000000b', 'B', 0.2, 0.2);

insert into public.aircraft (id, icao24, registration) values ('cccccccc-0000-4000-8000-00000000000c', 'fabcde', 'N1RLS');

insert into public.overflights (id, owner_id, location_id, aircraft_id, provider, provider_pass_key, icao24,
  first_seen_at, closest_seen_at, last_seen_at, local_date, minimum_distance_m, status, qualification_reason)
values ('aaaaaaaa-2222-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a',
        'aaaaaaaa-1111-4000-8000-00000000000a', 'cccccccc-0000-4000-8000-00000000000c', 'mock', 'k1', 'fabcde',
        now(), now(), now(), current_date, 10, 'qualified', 'crossed_within_overhead_radius');

insert into public.overflight_points (overflight_id, observed_at, latitude, longitude)
values ('aaaaaaaa-2222-4000-8000-00000000000a', now(), 0.1, 0.1);

insert into public.devices (id, owner_id, name, mac_address)
values ('aaaaaaaa-3333-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a', 'A frame', 'aa:00:00:00:00:0a');

-- Act as user B.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-00000000000b', true);

select results_eq('select id from public.locations', $$values ('bbbbbbbb-1111-4000-8000-00000000000b'::uuid)$$,
  'B sees only their own location');
select is_empty('select 1 from public.overflights', 'B sees none of A''s overflights');
select is_empty('select 1 from public.overflight_points', 'B sees none of A''s points');
select is_empty('select 1 from public.aircraft', 'B cannot see aircraft they never observed');
select is_empty('select 1 from public.hangar_aircraft', 'B''s hangar is empty (security_invoker view)');
select is_empty('select 1 from public.devices', 'B sees none of A''s devices');

select is_empty($$update public.locations set name = 'pwned' where id = 'aaaaaaaa-1111-4000-8000-00000000000a' returning 1$$,
  'B cannot update A''s location');
select is_empty($$delete from public.locations where id = 'aaaaaaaa-1111-4000-8000-00000000000a' returning 1$$,
  'B cannot delete A''s location');
select is_empty($$update public.devices set reset_requested = true where id = 'aaaaaaaa-3333-4000-8000-00000000000a' returning 1$$,
  'B cannot request a reset of A''s device');
select throws_ok($$insert into public.locations (owner_id, name, latitude, longitude)
                   values ('aaaaaaaa-0000-4000-8000-00000000000a', 'forged', 0, 0)$$,
  '42501', null, 'B cannot insert a location owned by A');
select throws_ok($$insert into public.posters (owner_id, location_id, local_date, template_version)
                   values ('bbbbbbbb-0000-4000-8000-00000000000b', 'aaaaaaaa-1111-4000-8000-00000000000a', current_date, 'v')$$,
  '23503', null, 'B cannot attach a poster to A''s location (composite FK)');
select throws_ok($$update public.locations set owner_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
                   where id = 'bbbbbbbb-1111-4000-8000-00000000000b'$$,
  '42501', null, 'B cannot transfer a location to A');
select throws_ok('select * from private.device_credentials', '42501', null, 'B cannot read private tables');

-- Act as user A.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-00000000000a', true);

select results_eq('select count(*)::int from public.overflights', array[1], 'A sees their overflight');
select results_eq('select count(*)::int from public.overflight_points', array[1], 'A sees their points');
select results_eq('select registration from public.aircraft', array['N1RLS'::text], 'A sees the observed aircraft');
select results_eq('select pass_count from public.hangar_aircraft', array[1], 'A''s hangar aggregates their pass');

reset role;
select * from finish();
rollback;
