-- ============================================================
-- PAINTRZ — Supabase schema
-- Run this in Supabase SQL editor. Auth users are handled by
-- Supabase's built-in auth.users table; this extends it.
--
-- Safe to re-run: drops its own objects first, so if a previous
-- partial run left something behind, this will clean up and
-- recreate everything fresh.
-- ============================================================

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists decrement_credit(uuid);
drop table if exists billing_events cascade;
drop table if exists renders cascade;
drop table if exists profiles cascade;

-- One row per account (paint company, rep, or public user)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  account_type text not null default 'public', -- 'paint_company' | 'rep' | 'public'
  company_name text,
  brand_logo_url text,        -- applied to every downloaded render
  brand_contact text,         -- name / phone / email overlay text
  credits_balance int not null default 1,       -- 1 credit = 1 render. Starts at 1: the free trial —
                                                  -- one render, plus the existing 2-free-corrections
                                                  -- policy below covers the "two free edits" on it.
  subscription_status text not null default 'none', -- 'none' | 'active' | 'past_due' | 'canceled'
  subscription_plan text,     -- e.g. 'monthly_unlimited'
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

-- No local paint color table: color search is served live from the
-- free PaintDB REST API (https://paintdb.com/api/v1, no key needed,
-- 51,000+ colors across 27 brands) — see paintrz-app.html. Each render
-- just stores the resolved hex + label it got back from that search.

-- Every render a user generates
create table renders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  original_photo_url text not null,
  rendered_photo_url text,           -- latest version (after corrections)
  branded_photo_url text,            -- final, with logo/contact overlay applied
  color_hex text,                    -- resolved target hex, whether from PaintDB or free-text prompt
  color_name text,                   -- e.g. "Sherwin-Williams Naval (SW 6244)", from PaintDB
  prompt text,                       -- freeform color/style request, if not DB-sourced
  corrections_used int not null default 0,  -- 2 free, then each correction = 1 credit
  status text not null default 'pending',   -- 'pending' | 'processing' | 'done' | 'failed'
  created_at timestamptz not null default now()
);

-- Stripe event log — for reconciliation / support, not required for the app to function
create table billing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  stripe_event_id text unique,
  type text,          -- 'checkout.session.completed', 'invoice.paid', etc.
  amount_cents int,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row when someone signs up via Supabase Auth
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Atomic credit deduction — called by the n8n render workflow after a
-- successful render, so concurrent requests can't double-spend a credit.
create or replace function decrement_credit(uid uuid)
returns void as $$
begin
  update profiles set credits_balance = greatest(credits_balance - 1, 0) where id = uid;
end;
$$ language plpgsql security definer;

-- Row-level security: users only see their own data
alter table profiles enable row level security;
alter table renders enable row level security;

create policy "own profile" on profiles for select using (auth.uid() = id);
create policy "own profile update" on profiles for update using (auth.uid() = id);
create policy "own renders" on renders for select using (auth.uid() = user_id);
create policy "own renders insert" on renders for insert with check (auth.uid() = user_id);
