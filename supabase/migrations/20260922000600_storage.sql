-- Overhead: private storage buckets and owner-prefixed object policies.
--
-- Object layout: <owner_id>/<kind>/<uuid>-<safe-name>.<ext>
-- All buckets are private. Downloads use short-lived signed URLs; device
-- binaries are signed only by trusted backend code with the secret key.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('source-images',   'source-images',   false, 20971520, array['image/png', 'image/jpeg', 'image/webp']),
  ('aircraft-art',    'aircraft-art',    false, 20971520, array['image/png', 'image/jpeg', 'image/webp']),
  ('poster-previews', 'poster-previews', false, 20971520, array['image/png', 'image/jpeg', 'image/webp']),
  ('device-binaries', 'device-binaries', false, 1048576,  array['application/octet-stream'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Upsert requires SELECT + INSERT + UPDATE; all four operations are defined.
create policy overhead_objects_select_own on storage.objects for select to authenticated
  using (
    bucket_id in ('source-images', 'aircraft-art', 'poster-previews', 'device-binaries')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy overhead_objects_insert_own on storage.objects for insert to authenticated
  with check (
    bucket_id in ('source-images', 'aircraft-art', 'poster-previews', 'device-binaries')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy overhead_objects_update_own on storage.objects for update to authenticated
  using (
    bucket_id in ('source-images', 'aircraft-art', 'poster-previews', 'device-binaries')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id in ('source-images', 'aircraft-art', 'poster-previews', 'device-binaries')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy overhead_objects_delete_own on storage.objects for delete to authenticated
  using (
    bucket_id in ('source-images', 'aircraft-art', 'poster-previews', 'device-binaries')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
