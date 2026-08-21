// The colour maths, kept separate from the HTTP layer so it can be reasoned
// about and tested without a server.

// ---------- sRGB <-> LAB ----------
// D65 white point, the same conversion the original n8n Code node used. Keeping
// it identical matters: any drift here changes every render's output colour.

const XN = 0.9505, YN = 1.0, ZN = 1.089;

function hexToRgb(hex) {
  const h = String(hex).replace('#', '').trim();
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function rgbToLab([r, g, b]) {
  const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [rl, gl, bl] = [toLin(r), toLin(g), toLin(b)];
  const x = rl * 0.4124 + gl * 0.3576 + bl * 0.1805;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / XN), fy = f(y / YN), fz = f(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fi = (t) => (Math.pow(t, 3) > 0.008856 ? Math.pow(t, 3) : (t - 16 / 116) / 7.787);
  const x = fi(fx) * XN, y = fi(fy) * YN, z = fi(fz) * ZN;
  const rl = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const gl = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const bl = x * 0.0557 + y * -0.2040 + z * 1.0570;
  const toGamma = (c) => {
    c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(c * 255)));
  };
  return [toGamma(rl), toGamma(gl), toGamma(bl)];
}

// Light Reflectance Value is the manufacturer's own published lightness for a
// paint, and the colour proxy already returns it. It is a better answer to
// "how light should this surface be" than anything derived from the hex, which
// is only a screen approximation of the chip.
//
// LRV is percent reflectance, i.e. Y*100 against a perfect diffuser.
function lrvToL(lrv) {
  const y = Math.min(1, Math.max(0, Number(lrv) / 100));
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

// ---------- tuning ----------
const DEFAULTS = {
  // How far a pixel must move between the original photo and the model's output
  // before it counts as repainted.
  threshold: 28,

  // If the primary threshold finds almost nothing, the change was subtle -
  // cream walls to Snowbound move maybe 10-15 in RGB distance. Without this
  // pass those renders get no correction at all and the exact-colour promise
  // silently does not apply. Only used when the first pass looks empty.
  fallbackThreshold: 12,
  fallbackMinFraction: 0.005,

  // Below this much difference between the region's mean lightness and the
  // target's, leave lightness alone entirely and behave exactly as the original
  // spec did. The corrective is for the cases the model could not reach, not a
  // filter applied to work that already came out right.
  meanLGate: 10,

  // How much of each pixel's deviation from the region mean survives the shift.
  // 1.0 preserves shading exactly but clips hard at the ends; lower flattens.
  contrast: 0.8,
};

/**
 * Force the repainted region to the target colour.
 *
 * orig/rend are raw RGB buffers of identical dimensions.
 * Returns a new RGB buffer plus stats describing what it decided to do.
 */
function correct(orig, rend, width, height, targetHex, targetLrv, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const px = width * height;
  const out = Buffer.from(rend);

  const [, ta, tb] = rgbToLab(hexToRgb(targetHex));

  // Pass 1: find the repainted region and its mean lightness in one sweep.
  const build = (threshold) => {
    const mask = new Uint8Array(px);
    let count = 0, sumL = 0, minL = 100, maxL = 0;
    for (let i = 0, p = 0; i < px; i++, p += 3) {
      const dr = orig[p] - rend[p];
      const dg = orig[p + 1] - rend[p + 1];
      const db = orig[p + 2] - rend[p + 2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) > threshold) {
        mask[i] = 1;
        count++;
        const L = rgbToLab([rend[p], rend[p + 1], rend[p + 2]])[0];
        sumL += L;
        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
      }
    }
    return { mask, count, meanL: count ? sumL / count : 0, minL, maxL };
  };

  let region = build(o.threshold);
  let thresholdUsed = o.threshold;
  if (region.count / px < o.fallbackMinFraction) {
    const relaxed = build(o.fallbackThreshold);
    if (relaxed.count > region.count) {
      region = relaxed;
      thresholdUsed = o.fallbackThreshold;
    }
  }

  if (!region.count) {
    return { buffer: out, stats: { maskPixels: 0, thresholdUsed, applied: false, reason: 'no repainted region found' } };
  }

  // Where the surface should sit. LRV is authoritative when we have it.
  const targetL = targetLrv != null && targetLrv !== '' ? lrvToL(targetLrv) : rgbToLab(hexToRgb(targetHex))[0];
  const gap = targetL - region.meanL;
  const retarget = Math.abs(gap) > o.meanLGate;

  // Shading has to survive the shift, and it has to fit inside 0-100.
  //
  // Scaling everything down linearly satisfies the second and destroys the
  // first: moving espresso to Snowbound leaves so little headroom above the
  // target that a linear fit squashes the whole range into a few points and the
  // surface reads as a flat sticker.
  //
  // A soft knee keeps full contrast near the mean, where nearly all the pixels
  // are, and rolls off asymptotically towards the bound. tanh(x) approximates x
  // for small x, so mid-tones move exactly as the contrast factor intends and
  // only the extremes compress - which is also physically honest, since a white
  // surface genuinely cannot carry as much highlight range as a dark one.
  const knee = (L) => {
    const d = (L - region.meanL) * o.contrast;
    const room = d >= 0 ? 100 - targetL : targetL;
    if (room <= 0) return targetL;
    return targetL + room * Math.tanh(d / room);
  };

  for (let i = 0, p = 0; i < px; i++, p += 3) {
    if (!region.mask[i]) continue;
    const [L] = rgbToLab([rend[p], rend[p + 1], rend[p + 2]]);

    // Keep the pixel's own deviation from the region mean so shadows stay
    // shadows and highlights stay highlights - only the level moves.
    const newL = retarget ? Math.min(100, Math.max(0, knee(L))) : L;

    const [nr, ng, nb] = labToRgb([newL, ta, tb]);
    out[p] = nr; out[p + 1] = ng; out[p + 2] = nb;
  }

  return {
    buffer: out,
    stats: {
      maskPixels: region.count,
      maskFraction: +(region.count / px).toFixed(4),
      thresholdUsed,
      regionMeanL: +region.meanL.toFixed(1),
      targetL: +targetL.toFixed(1),
      targetLSource: targetLrv != null && targetLrv !== '' ? 'lrv' : 'hex',
      gap: +gap.toFixed(1),
      regionMinL: +region.minL.toFixed(1),
      regionMaxL: +region.maxL.toFixed(1),
      contrast: o.contrast,
      curve: retarget ? 'soft-knee' : 'none',
      applied: retarget,
      reason: retarget ? 'mean-L retargeted' : 'within gate, lightness preserved',
    },
  };
}

module.exports = { correct, hexToRgb, rgbToLab, labToRgb, lrvToL, DEFAULTS };
