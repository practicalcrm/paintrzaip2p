-- Paintrz — billing period anchor + profile update policy
-- Safe to run on the live database: additive only, no drops, no data loss.
-- Re-running it is harmless.

-- ---------------------------------------------------------------------------
-- 1. When the current subscription began.
--
-- Monthly allowances (Starter 7, Crew 16, Pro 35, Studio 80) have to be counted
-- against the real billing cycle, not the calendar month, or someone who
-- subscribes on the 20th gets a fresh allowance eleven days later.
--
-- We store only the START and roll monthly anniversaries forward from it. The
-- alternative — storing current_period_start from Stripe — would need the
-- webhook to listen for renewal events (invoice.paid), which it does not. With
-- that approach the period would freeze after the first month and every
-- subscriber would be locked out. Anchoring needs no new Stripe events.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists subscription_started_at timestamptz;

comment on column public.profiles.subscription_started_at is
  'Start of the current subscription. Billing periods are monthly anniversaries of this date. Null for pay-as-you-go.';

-- Backfill anyone already subscribed, so existing subscribers get a sane period
-- instead of being treated as unlimited. created_at is the best anchor we have
-- retroactively; it is only ever used to date a period boundary.
update public.profiles
   set subscription_started_at = coalesce(subscription_started_at, created_at)
 where subscription_status = 'active'
   and subscription_started_at is null;

-- ---------------------------------------------------------------------------
-- 2. Let a user update their own profile.
--
-- RLS covers select and insert, but not update — so the Settings panel could
-- not save a logo, company name or contact line. Without this, saving silently
-- affects zero rows.
--
-- Note the with-check clause: it stops a user rewriting the id and taking over
-- another row.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'profiles'
       and policyname = 'Users can update own profile'
  ) then
    create policy "Users can update own profile"
      on public.profiles for update
      using (auth.uid() = id)
      with check (auth.uid() = id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='profiles'
      and column_name='subscription_started_at')                as period_column_added,
  (select count(*) from pg_policies
    where schemaname='public' and tablename='profiles'
      and policyname='Users can update own profile')            as update_policy_added,
  (select count(*) from public.profiles
    where subscription_status='active'
      and subscription_started_at is null)                      as subscribers_still_unanchored;
