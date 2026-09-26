-- Overhead: the photo collection, one best photo per operator + aircraft type.
--
-- Admins save photos per airframe (source_images with raw_metadata.kind =
-- 'photo_pick'). The collection marks which of those picks is the best one
-- for its operator + type slot ("United Airlines B738"), so the Aircraft page
-- can check slots off and compare a new pick against the current best.
--
-- A slot belongs to the admin who fills it; operator_icao is null for the
-- private / unknown-operator slot of a type. Removing the picked photo
-- empties the slot.

create table public.photo_collection (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  operator_icao text check (operator_icao is null or operator_icao ~ '^[A-Z]{3}$'),
  icao_type_code text not null check (icao_type_code ~ '^[A-Z0-9]{2,4}$'),
  source_image_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint photo_collection_slot_key
    unique nulls not distinct (owner_id, operator_icao, icao_type_code),
  constraint photo_collection_source_image_fk foreign key (owner_id, source_image_id)
    references public.source_images (owner_id, id) on delete cascade
);

create index photo_collection_source_image_idx on public.photo_collection (source_image_id);

create trigger photo_collection_updated_at before update on public.photo_collection
  for each row execute function private.set_updated_at();

-- Written only by the API (admin board); owners may read theirs.
alter table public.photo_collection enable row level security;

revoke all on public.photo_collection from anon, authenticated;
grant select, insert, update, delete on public.photo_collection to service_role;
grant select on public.photo_collection to authenticated;

create policy photo_collection_select_own on public.photo_collection
  for select to authenticated using (owner_id = (select auth.uid()));
