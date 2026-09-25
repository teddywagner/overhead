-- Overhead: background-removed copies ("cutouts") of reference photos.
--
-- An admin asks for a cutout of a source image; the worker downloads the
-- photo, has a background remover isolate the aircraft, and stores the
-- transparent PNG in the source-images bucket at
-- <owner_id>/cutout/<source_image_id>.png. This table is the queue and the
-- record: one row per source image.
--
-- Only photos whose licence allows edited copies are processed (the owner's
-- own uploads and Wikimedia Commons, which hosts free licences only); the
-- API refuses the rest and the worker re-checks.

create table public.image_cutouts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  source_image_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  storage_path text check (storage_path is null or starts_with(storage_path, owner_id::text || '/')),
  provider text check (provider is null or char_length(provider) <= 60),
  error text check (error is null or char_length(error) <= 500),
  attempts integer not null default 0 check (attempts >= 0),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint image_cutouts_source_image_key unique (source_image_id),
  constraint image_cutouts_source_image_fk foreign key (owner_id, source_image_id)
    references public.source_images (owner_id, id) on delete cascade,
  constraint image_cutouts_done_has_path check (status <> 'done' or storage_path is not null)
);

create index image_cutouts_queue_idx on public.image_cutouts (requested_at)
  where status in ('pending', 'processing', 'failed');
create index image_cutouts_owner_idx on public.image_cutouts (owner_id);

create trigger image_cutouts_updated_at before update on public.image_cutouts
  for each row execute function private.set_updated_at();

-- Written only by the API (requests) and the worker (results); owners may read theirs.
alter table public.image_cutouts enable row level security;

revoke all on public.image_cutouts from anon, authenticated;
grant select, insert, update, delete on public.image_cutouts to service_role;
grant select on public.image_cutouts to authenticated;

create policy image_cutouts_select_own on public.image_cutouts
  for select to authenticated using (owner_id = (select auth.uid()));
