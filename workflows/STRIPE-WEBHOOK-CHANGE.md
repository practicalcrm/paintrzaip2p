# Stripe Billing Webhook — required change

One field, made **by hand in the n8n UI**. This workflow processes real
payments, so it is not shipped here as an importable file: replacing a working
billing workflow with a possibly-stale export risks breaking live billing for
the sake of a one-line change.

## Why

`profiles.subscription_started_at` anchors the billing period that monthly
allowances (Starter 7, Crew 16, Pro 35, Studio 80) are counted against. Nothing
writes it yet, so every subscriber has `null` — and the render pipeline
deliberately **fails open** on a missing anchor rather than locking a paying
customer out. Until this change is made, allowances are displayed but not
enforced.

Run `sql/add-subscription-period.sql` first — it adds the column and backfills
existing subscribers.

## The change

n8n → **Paintrz — Stripe Billing Webhook** → **Activate Subscription** node →
the **JSON body** field.

Current:

```
={{ { "subscription_status": "active", "subscription_plan": $json.planName, "stripe_customer_id": $json.stripeCustomerId } }}
```

Replace with:

```
={{ { "subscription_status": "active", "subscription_plan": $json.planName, "stripe_customer_id": $json.stripeCustomerId, "subscription_started_at": $now.toISO() } }}
```

Only `subscription_started_at` is added; the other three fields are unchanged.
Then **Save** to publish.

## Why the start date, and not Stripe's period fields

Stripe sends `current_period_start` / `current_period_end`, which look like the
obvious choice. They are not usable here: this webhook listens only for
`checkout.session.completed` and `customer.subscription.deleted`. It never sees
a renewal, so a stored period would freeze at the first month's value and every
subscriber would be locked out on day 31.

Storing only the start date and rolling monthly anniversaries forward needs no
renewal events at all. If you later add `invoice.paid` to the Stripe
destination, switching to real period boundaries becomes worthwhile — until
then this is both simpler and correct.

## Verifying it worked

After the change, make a test subscription purchase and check:

```sql
select email, subscription_plan, subscription_status, subscription_started_at
  from profiles
 where subscription_status = 'active'
 order by subscription_started_at desc nulls last;
```

`subscription_started_at` should hold the moment of purchase. Existing
subscribers are backfilled from `created_at` by the SQL migration.

## Known gap

A subscriber who cancels and later resubscribes gets a fresh
`subscription_started_at`, which resets their allowance early. Rare, and it
errs in the customer's favour, so it is left alone deliberately.
