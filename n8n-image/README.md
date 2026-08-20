# n8n image

Railway service **n8n** in project **adventurous-kindness**
(`n8n-production-e390.up.railway.app`).

## Pointing Railway at this folder

Service → Settings → Source:

1. Source Repo → `practicalcrm/paintrzaip2p`
2. Add Root Directory → `n8n-image`
3. Build → Builder is already `Dockerfile`
4. **Watch Paths → `n8n-image/**`** — without this, every frontend commit
   redeploys n8n, and a redeploy of n8n is not a free action.

## Verifying after a deploy

Import `workflows/paintrz-jimp-probe-workflow.json`, run it, and GET
`/webhook-test/paintrz-jimp-probe`. `resolved` and `works` should both be true.

## Upgrading n8n

Bump the `FROM` tag, deploy, check the version in the UI. Never use `:latest`:
n8n's migrations are one-way, so landing on a tag older than the database
leaves the instance unable to start.
