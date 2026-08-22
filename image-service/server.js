// Paintrz image service.
//
// Exists because the colour pass cannot run inside n8n: Code nodes execute in a
// separate @n8n/task-runner process that dies outright when jimp is required,
// and n8n is capped at one replica while a volume is attached. This is a pure
// function - images in, images out. n8n still performs every Supabase write, so
// the credit, refund and error-routing logic stays where it already works.

const express = require('express');
const sharp = require('sharp');
const dns = require('dns').promises;
const net = require('net');
const { correct } = require('./color');

const app = express();

// Renders are a few MB of base64. The default 100kb limit would reject every
// real request with a confusing 413.
app.use(express.json({ limit: '32mb' }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.IMAGE_SERVICE_TOKEN || '';
const FETCH_TIMEOUT_MS = 20000;

app.get('/health', (_req, res) => res.json({ ok: true, service: 'paintrz-image', sharp: sharp.versions }));

// Reached over Railway private networking, so this is defence in depth rather
// than the only thing standing between the service and the internet.
app.use((req, res, next) => {
  if (!TOKEN) return next();
  if (req.get('x-service-token') === TOKEN) return next();
  return res.status(401).json({ ok: false, reason: 'unauthorized' });
});

// brand_logo_url is supplied by the contractor, so this service will fetch
// whatever any customer puts in their branding settings. Without a guard that
// makes it a request forwarder sitting inside the private network: point it at
// another service's internal address, or at cloud metadata, and it returns the
// bytes. Resolve first, then refuse anything that is not a public address.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::' || v === '::1' || v.startsWith('fe80') ||
    v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:');
}

async function assertFetchable(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('malformed url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported scheme');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length) throw new Error('host did not resolve');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('refusing to fetch a private address');
  }
  return u;
}

async function fetchBuffer(url) {
  await assertFetchable(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// Accepts either a URL or inline base64 for each image, because the original
// photo lives at a public Supabase URL while the model's output only ever
// exists as binary inside the n8n execution.
async function resolveImage(url, b64, label) {
  if (b64) return Buffer.from(b64, 'base64');
  if (url) return fetchBuffer(url);
  throw new Error(`missing ${label}`);
}

// "Input buffer contains unsupported image format" says nothing about WHAT
// arrived. Nearly always the answer is in the first few bytes: FF D8 FF is a
// JPEG, 89 50 4E 47 a PNG, and anything starting '{' is an error body that
// something upstream stored as if it were a file. Report it rather than making
// the next person guess.
function describe(buf, label) {
  if (!buf || !buf.length) return { label, bytes: 0, note: 'empty' };
  const head = buf.subarray(0, 12);
  const d = {
    label,
    bytes: buf.length,
    hex: head.toString('hex'),
    ascii: head.toString('latin1').replace(/[^ -~]/g, '.'),
  };
  // A short buffer that starts with { or [ is an API response someone stored as
  // a file. The whole point of the diagnostic is to read what it says, so print
  // it rather than making the next person go digging for it.
  const first = buf[0];
  if (buf.length <= 4096 && (first === 0x7b || first === 0x5b)) {
    d.body = buf.toString('utf8').slice(0, 2000);
  }
  return d;
}

async function decode(buf, label) {
  try {
    return await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (e) {
    const d = describe(buf, label);
    throw new Error(`${label}: ${e.message} | ${d.bytes} bytes, starts ${d.hex} (${d.ascii})${d.body ? ' | body: ' + d.body : ''}`);
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/**
 * Brand a copy of the corrected image.
 *
 * Always works on a clone. The unbranded copy is what corrections re-render
 * from - branding the source would stamp the logo again on every correction,
 * compounding each time.
 */
async function brand(buffer, width, height, logoUrl, contact) {
  const layers = [];

  if (logoUrl) {
    try {
      const targetH = Math.max(1, Math.round(height * 0.08));
      const logo = await sharp(await fetchBuffer(logoUrl))
        .resize({ height: targetH, fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer();
      const meta = await sharp(logo).metadata();
      layers.push({ input: logo, left: 16, top: Math.max(0, height - (meta.height || targetH) - 16) });
    } catch (e) {
      // A missing or broken logo URL must not cost the customer their render.
      console.warn('logo skipped:', e.message);
    }
  }

  if (contact) {
    // Text as an SVG overlay rather than a font file: sharp has no text API,
    // and this avoids shipping and loading font binaries entirely.
    const fontSize = Math.max(12, Math.round(height * 0.022));
    const svg = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
         <text x="16" y="${height - 14}" font-family="Inter, 'DejaVu Sans', Helvetica, Arial, sans-serif"
               font-size="${fontSize}" fill="#ffffff"
               style="paint-order:stroke; stroke:#000000; stroke-width:${Math.max(2, Math.round(fontSize / 6))}; stroke-opacity:0.45;">
           ${escapeXml(contact)}
         </text>
       </svg>`
    );
    layers.push({ input: svg, left: 0, top: 0 });
  }

  if (!layers.length) return buffer;
  return sharp(buffer).composite(layers).jpeg({ quality: 92 }).toBuffer();
}

app.post('/correct', async (req, res) => {
  const started = Date.now();
  try {
    const {
      original_url, original_b64,
      rendered_url, rendered_b64,
      target_hex, target_lrv,
      brand_logo_url, brand_contact,
      options,
    } = req.body || {};

    if (!target_hex) return res.status(400).json({ ok: false, reason: 'target_hex required' });

    const [origBuf, rendBuf] = await Promise.all([
      resolveImage(original_url, original_b64, 'original'),
      resolveImage(rendered_url, rendered_b64, 'rendered'),
    ]);

    // The original photo defines the output dimensions. The model returns
    // whatever size it likes, and a corrected image that does not line up with
    // the source is useless for a before/after.
    const orig = await decode(origBuf, 'original');
    const { width, height } = orig.info;

    let rend;
    try {
      rend = await sharp(rendBuf)
        // 'fill' stretched every render: Kontext answers a 1244x1265 photo
        // with a 1024x1024 image, and forcing that back distorted the whole
        // room. 'cover' scales uniformly and trims the overhang instead, so
        // geometry survives. The workflow now also asks Kontext for the source
        // aspect ratio, which keeps that trim down to a sliver.
        .resize(width, height, { fit: 'cover', position: 'centre' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (e) {
      const d = describe(rendBuf, 'rendered');
      throw new Error(`rendered: ${e.message} | ${d.bytes} bytes, starts ${d.hex} (${d.ascii})${d.body ? ' | body: ' + d.body : ''}`);
    }

    const { buffer: corrected, stats } = correct(
      orig.data, rend.data, width, height, target_hex, target_lrv, options || {}
    );

    const clean = await sharp(corrected, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();

    const branded = (brand_logo_url || brand_contact)
      ? await brand(clean, width, height, brand_logo_url, brand_contact)
      : clean;

    res.json({
      ok: true,
      width,
      height,
      ms: Date.now() - started,
      stats,
      render_b64: clean.toString('base64'),
      branded_b64: branded.toString('base64'),
    });
  } catch (e) {
    // Always answer. A thrown error with no body is the failure mode that hid
    // two separate outages on this project - n8n cannot route what it cannot see.
    console.error('correct failed:', e);
    res.status(500).json({ ok: false, reason: e.message || String(e), ms: Date.now() - started });
  }
});

app.listen(PORT, '::', () => console.log(`paintrz-image listening on ${PORT}`));
