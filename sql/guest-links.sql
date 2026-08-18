-- Paintrz — guest render links (QR handover)
--
-- Lets a Studio subscriber generate a QR code so a homeowner can run renders
-- on their OWN phone, for a limited time, billed to the contractor's account.
--
-- Safe to run more than once.
--
-- ---------------------------------------------------------------------------
-- Design note: why the guest never talks to Supabase
--
-- A guest has no account, so RLS has nothing to key off. Rather than issue
-- anonymous sessions and write intricate policies around them, the guest page
-- talks ONLY to n8n, which validates the token with the service role. That
-- keeps every enforcement decision in one place and lets the guest-facing
-- surface stay dumb — which matters, because it is the surface a stranger's
-- phone touches.
--
-- Consequently these tables are written and read almost entirely by n8n. The
-- policies below exist so the OWNER can manage their own links from the app;
-- guests are never authenticated against Postgres at all.
-- ---------------------------------------------------------------------------

create table if not exists public.guest_links (
  id             uuid primary key default gen_random_uuid(),
  token          text unique not null,
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  render_cap     int  not null default 100,
  renders_used   int  not null default 0,
  revoked        boolean not null default false,
  label          text
);

comment on table  public.guest_links is
  'Time- and count-limited tokens letting a homeowner render on their own device, billed to the owner.';
comment on column public.guest_links.render_cap is
  'Hard ceiling per link. A time window alone does not bound cost — a 2-hour link could otherwise burn the whole plan.';
comment on column public.guest_links.renders_used is
  'Incremented by n8n. Guest renders ALSO count against the owner''s monthly allowance; this is the per-link limit on top.';

create index if not exists guest_links_token_idx  on public.guest_links (token);
create index if not exists guest_links_owner_idx  on public.guest_links (owner_user_id, created_at desc);

-- Ties each render back to the link that produced it, so the owner can see
-- which visit generated what, and so a revoked link's renders stay traceable.
alter table public.renders
  add column if not exists guest_link_id uuid references public.guest_links(id) on delete set null;

create index if not exists renders_guest_link_idx on public.renders (guest_link_id);

-- ---------------------------------------------------------------------------
-- RLS — owner-facing only. n8n uses the service role and bypasses all of this.
-- ---------------------------------------------------------------------------
alter table public.guest_links enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='guest_links'
      and policyname='Owners read own guest links') then
    create policy "Owners read own guest links"
      on public.guest_links for select
      using (auth.uid() = owner_user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='guest_links'
      and policyname='Owners create own guest links') then
    create policy "Owners create own guest links"
      on public.guest_links for insert
      with check (auth.uid() = owner_user_id);
  end if;

  -- Update is limited to revoking. Guests never authenticate, so renders_used
  -- is only ever touched by n8n via the service role; letting the owner edit
  -- it from the browser would make the cap advisory.
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='guest_links'
      and policyname='Owners revoke own guest links') then
    create policy "Owners revoke own guest links"
      on public.guest_links for update
      using (auth.uid() = owner_user_id)
      with check (auth.uid() = owner_user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Validation helper, called by n8n with the service role.
--
-- Returns one row describing whether the token may render right now, and who
-- to bill. Kept in SQL so the rules can't drift between callers.
-- ---------------------------------------------------------------------------
create or replace function public.guest_link_status(p_token text)
returns table (
  valid          boolean,
  reason         text,
  link_id        uuid,
  owner_user_id  uuid,
  renders_left   int,
  expires_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.guest_links%rowtype;
begin
  select * into l from public.guest_links where token = p_token;

  if not found then
    return query select false, 'not_found'::text, null::uuid, null::uuid, 0, null::timestamptz;
  elsif l.revoked then
    return query select false, 'revoked'::text, l.id, l.owner_user_id, 0, l.expires_at;
  elsif l.expires_at <= now() then
    return query select false, 'expired'::text, l.id, l.owner_user_id, 0, l.expires_at;
  elsif l.renders_used >= l.render_cap then
    return query select false, 'cap_reached'::text, l.id, l.owner_user_id, 0, l.expires_at;
  else
    return query select true, 'ok'::text, l.id, l.owner_user_id,
                        (l.render_cap - l.renders_used), l.expires_at;
  end if;
end $$;

-- Atomic increment so two guests on the same link can't both slip past the cap.
create or replace function public.consume_guest_render(p_link_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining int;
begin
  update public.guest_links
     set renders_used = renders_used + 1
   where id = p_link_id
     and revoked = false
     and expires_at > now()
     and renders_used < render_cap
  returning (render_cap - renders_used) into remaining;

  return coalesce(remaining, -1);   -- -1 means the guard rejected it
end $$;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
     where table_schema='public' and table_name='guest_links')               as guest_links_table,
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='renders'
       and column_name='guest_link_id')                                      as renders_link_column,
  (select count(*) from pg_policies
     where schemaname='public' and tablename='guest_links')                  as guest_link_policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname in ('guest_link_status','consume_guest_render'))        as helper_functions;
-- Expect: 1 / 1 / 3 / 2
