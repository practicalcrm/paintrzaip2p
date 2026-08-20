-- Paintrz — move the client-mode PIN onto the account
--
-- The PIN was stored per device, so a contractor with a phone and a tablet had
-- to set it twice, and clearing browser data lost it entirely. Holding it on the
-- profile makes it follow the account.
--
-- Safe to run more than once.
--
-- ---------------------------------------------------------------------------
-- On storing it in plain text
--
-- This is a four-digit PIN whose whole job is to stop the person physically
-- holding the phone from walking back into the app. It is not a password and it
-- guards nothing at the database level - anyone who can read this column
-- already has the row it belongs to. Hashing it would add ceremony without
-- changing what it defends against.
--
-- RLS still applies: the existing profiles policies mean an account can only
-- ever read or write its own row.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists client_pin text;

comment on column public.profiles.client_pin is
  'Four-digit PIN guarding the exit from client mode. Device-local copy is kept as a fallback when this is null.';

-- ---------------------------------------------------------------------------
-- Verify — expect one row: client_pin / text / YES
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'profiles'
   and column_name  = 'client_pin';
