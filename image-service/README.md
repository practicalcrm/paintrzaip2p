# Paintrz image service

Deterministic colour correction and branding for renders. A pure function:
images in, images out. **n8n still performs every Supabase write** — credits,
refunds and error routing stay where they already work.

## Why this is not a Code node

- Code nodes run in a separate `@n8n/task-runner` process that **dies on
  `require('jimp')`** — `InternalTaskRunnerDisconnectAnalyzer`, ~60ms, and no
  amount of `NODE_PATH` / `N8N_RUNNERS_*` tuning moved it
- Railway caps n8n at **one replica while a volume is attached**, so image work
  there can never scale out
- `sharp` is native and cannot run in that sandbox at all
- The segmentation fork (handoff #4 §7.3) later lands as a second endpoint here
  rather than a re-platform

## Railway setup

1. New service → repo `practicalcrm/paintrzaip2p`, branch **`image-service`**
2. Root directory **`image-service`**, builder Dockerfile (auto-detected)
3. Watch paths **`image-service/**`**
4. **No volume** — that is what allows replicas
5. Do **not** generate a public domain. n8n reaches it over private networking at
   `http://<service>.railway.internal:3000`
6. Optional: set `IMAGE_SERVICE_TOKEN` here and send it as `x-service-token`

## API

`GET /health` → `{ ok: true, ... }`

`POST /correct`

```jsonc
{
  "original_url": "https://…/photos/original.jpg",  // or original_b64
  "rendered_b64": "<base64 of the model output>",   // or rendered_url
  "target_hex": "#EFEFE9",
  "target_lrv": 83,                 // optional but preferred, see below
  "brand_logo_url": "https://…",    // optional
  "brand_contact": "Paintr · 520-555-0134",  // optional
  "options": { "contrast": 0.8 }    // optional, see color.js DEFAULTS
}
```

Returns `render_b64` (clean) and `branded_b64`. **Corrections must re-render from
the clean copy** — branding the source stamps the logo again every time.

`stats` explains what it decided, and is worth logging on every render:

```jsonc
{
  "maskPixels": 812431, "maskFraction": 0.42, "thresholdUsed": 28,
  "regionMeanL": 45.0, "regionMinL": 18.0, "regionMaxL": 72.0,
  "targetL": 93.0, "targetLSource": "lrv", "gap": 48.0,
  "applied": true, "curve": "soft-knee",
  "reason": "mean-L retargeted"
}
```

## The colour decision

The original spec (handoff #1 §147) kept **L** per pixel and swapped only a/b.
That cannot change lightness, so espresso cabinets → Snowbound produced a
correctly-hued **mid grey** whenever the model undershot.

This retargets the masked region's **mean L** to the target and keeps each
pixel's deviation from that mean:

| Pixel | L-preservation | this service |
|---|---|---|
| shadow L 18 | `rgb(46,46,42)` | `rgb(176,176,171)` |
| surface L 45 | `rgb(107,107,102)` | `rgb(235,235,229)` |
| highlight L 72 | `rgb(184,184,178)` | `rgb(255,255,249)` |

Three things keep it honest:

- **Gated.** If the region mean is already within `meanLGate` (10 L) of target,
  lightness is left completely alone — identical to the original spec. The
  corrective only engages where the model could not reach.
- **Soft knee.** Full contrast near the mean, asymptotic roll-off at the bounds.
  A linear fit squashed a 54-point range into 14; the knee keeps 28 and never
  clips.
- **LRV preferred.** `target_lrv` is the manufacturer's published lightness and
  the colour proxy already returns it. More defensible than deriving lightness
  from a hex, and contractors already think in LRV.

Also fixed here: the old `THRESHOLD = 28` mask silently skipped subtle changes
(cream → Snowbound moves only 10–15 RGB), so those renders got **no correction
at all**. A fallback pass at 12 runs when the first finds almost nothing.

## Known limits

- The mask is still a whole-image diff, so it catches incidental changes such as
  shifted shadows. Shifting lightness on those is more visible than shifting
  hue. Real segmentation is the fix, and belongs here.
- Multi-colour still locks a single hex per render.
