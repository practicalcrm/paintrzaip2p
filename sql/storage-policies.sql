-- Paintrz — Storage policies for the `photos` bucket
--
-- Fixes: "Upload failed: new row violates row-level security policy"
--
-- storage.objects has RLS on by default and no policies were ever created, so
-- every browser upload was refused. n8n was unaffected because the service-role
-- key bypasses RLS entirely — which is why this only ever surfaced in the app.
--
-- The app writes to `<user-id>/<timestamp>_<filename>`, so the first path
-- segment identifies the owner and policies can be scoped to it.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Bucket exists and is public.
--
-- The render pipeline writes back /storage/v1/object/public/photos/... URLs and
-- the app renders them in <img> tags, so a private bucket would 404 every
-- finished render even on a completely successful job.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do update set public = true;

-- ---------------------------------------------------------------------------
-- 2. Policies.
--
-- create policy has no IF NOT EXISTS, so each is guarded individually.
-- ---------------------------------------------------------------------------

-- Upload: only into your own folder. The folder check is what stops one
-- account writing into another's.
do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='Paintrz: users upload to own folder') then
    create policy "Paintrz: users upload to own folder"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end $$;

-- Update: needed because the Settings panel replaces a logo with upsert.
do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='Paintrz: users update own objects') then
    create policy "Paintrz: users update own objects"
      on storage.objects for update to authenticated
      using (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
      with check (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end $$;

-- Delete: so a user can clear their own uploads later.
do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='Paintrz: users delete own objects') then
    create policy "Paintrz: users delete own objects"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end $$;

-- Read: the bucket is public, so finished renders and logos resolve for anyone
-- holding the URL. That is required — the branded image is meant to be shared
-- with a homeowner, and n8n composites logos from a plain URL.
--
-- NOTE: this does mean any customer photo is readable by anyone who has (or
-- guesses) its URL. Paths contain a uuid and a millisecond timestamp so they
-- are not enumerable in practice, but they are not secret either. If that ever
-- needs tightening, the move is a private bucket plus signed URLs, which also
-- means changing how the render pipeline hands URLs back.
do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='Paintrz: public read photos') then
    create policy "Paintrz: public read photos"
      on storage.objects for select to public
      using (bucket_id = 'photos');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------
select
  (select public from storage.buckets where id='photos')            as bucket_is_public,
  (select count(*) from pg_policies
     where schemaname='storage' and tablename='objects'
       and policyname like 'Paintrz:%')                             as paintrz_policies;
-- Expect: bucket_is_public = true, paintrz_policies = 4
