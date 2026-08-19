-- Paintrz — grant Studio to a test account, bypassing Stripe
--
-- Purpose: unblock testing of Studio-only features (guest links / QR handover)
-- without putting a real subscription through Stripe.
--
-- ---------------------------------------------------------------------------
-- What this does NOT do
--
-- This writes the profile directly, so it exercises none of the billing path.
-- It does not test the Stripe Trigger, the credit maths, or subscription
-- activation. Those still need a real purchase.
--
-- It also leaves stripe_customer_id null. That matters: the billing workflow
-- matches cancellations and renewals on stripe_customer_id, so this row cannot
-- be deactivated by a Stripe event. Reverse it with the query at the bottom
-- rather than expecting Stripe to.
-- ---------------------------------------------------------------------------

update public.profiles
   set subscription_status     = 'active',
       subscription_plan       = 'Studio',
       -- Anchors the monthly allowance period. Only set if absent, so re-running
       -- this does not hand the account a fresh allowance each time.
       subscription_started_at = coalesce(subscription_started_at, now())
 where email = 'mypaintr@gmail.com';

-- Verify: expect one row, active / Studio / a timestamp.
select email,
       subscription_status,
       subscription_plan,
       subscription_started_at,
       credits_balance,
       stripe_customer_id
  from public.profiles
 where email = 'mypaintr@gmail.com';


-- ---------------------------------------------------------------------------
-- To reverse, once real billing is being tested:
--
-- update public.profiles
--    set subscription_status     = 'none',
--        subscription_plan       = null,
--        subscription_started_at = null
--  where email = 'mypaintr@gmail.com';
-- ---------------------------------------------------------------------------
