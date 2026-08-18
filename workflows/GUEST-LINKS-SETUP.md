# Guest links (QR handover) — setup

Everything in the repo is done. Three steps remain, all of which need a screen.

## 1. Run the SQL

`sql/guest-links.sql` in the Supabase SQL editor. Safe to run more than once.
Expected verify row at the bottom: **1 / 1 / 3 / 2**.

Until this runs, the Settings card shows a load error instead of the controls.

## 2. Import the workflow

`workflows/paintrz-guest-workflow.json` — Import from URL works, the repo is public:

```
https://raw.githubusercontent.com/practicalcrm/paintrzaip2p/main/workflows/paintrz-guest-workflow.json
```

Nine HTTP nodes need the **Paintrz Supabase service role** custom-auth
credential attached. It is the same credential the render pipeline uses, so if
that one already exists there is nothing new to create.

Then publish, and check the three Production URLs match `CONFIG` in `app.html`:

| Webhook | CONFIG key |
|---|---|
| `paintrz-guest-info` | `N8N_GUEST_INFO` |
| `paintrz-guest-render` | `N8N_GUEST_RENDER` |
| `paintrz-guest-status` | `N8N_GUEST_STATUS` |

## 3. Try it

Settings → Guest links → Create a guest link → scan the QR with a second phone.

Watch the n8n Executions tab, not the spinner. The guest page reports what the
server said, but a pipeline failure downstream looks the same from the phone as
a slow render.

---

## What this does not do

- **The render pipeline still has never completed a render.** This workflow
  prepares the row and hands off to it; if the pipeline is broken, guest renders
  are broken in exactly the same way. Fixing one fixes both, which is why this
  calls the pipeline rather than cloning it.
- **CORS on POST is unproven.** These are `application/json` POSTs, so the
  browser sends a preflight `OPTIONS` first. `allowedOrigins: "*"` on each
  Webhook node is what answers it. The colours proxy never had to deal with this
  because it is a simple GET. The same question applies to the existing
  `paintrz-render` webhook, which app.html has always called the same way but
  which has never actually been reached.
- **No corrections for guests.** The correction box is hidden in guest mode; a
  correction would need a fourth endpoint and its own count against the cap.
- **Multi-colour is still one exact colour.** The LAB pass locks a single hex,
  so with three colours only the first is pixel-exact. Same as the signed-in
  path.
- **Guest renders count twice**, by design: against the link's cap and against
  the owner's monthly allowance.
