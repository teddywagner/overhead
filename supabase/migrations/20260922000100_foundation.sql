-- Overhead: foundation — schemas, default privileges, shared helpers.
--
-- Data API exposure model (Supabase 2026 behaviour): new objects in `public`
-- are NOT granted to anon/authenticated/service_role automatically. Every
-- table and view below receives explicit, least-privilege GRANTs in
-- 20260922000400_grants_and_rls.sql. `private` is never exposed.

-- Belt and braces: make sure objects created by `postgres` in `public` are not
-- implicitly reachable, regardless of the project's creation-time setting.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, truncate, references, trigger on tables
  from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select, update on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role, public;

-- Non-exposed schema for worker state, device credentials and operational logs.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated, service_role;

comment on schema private is
  'Overhead private schema: never listed in the Data API exposed schemas.';

-- updated_at maintenance. SECURITY INVOKER (the default) with a pinned
-- search_path; trigger functions are not callable through the Data API.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;
