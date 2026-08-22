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
  // How far a pixel's colour may sit from the paint, in the LAB a/b plane, and
  // still count as part of that painted surface. Generous on purpose: the
  // model's idea of a colour is only ever approximately right, and closing
  // that gap is the entire reason this pass exists.
  chromaRadius: 25,

  // Used only when the first pass finds almost nothing, which means the model
  // barely applied the colour at all. Widening once is better than returning a
  // render with no correction and no explanation.
  fallbackChromaRadius: 40,
  fallbackMinFraction: 0.005,

  // A matte painted surface cannot carry a highlight far brighter than the
  // paint itself. Daylight through a window can, and does. Without this the
  // mask swallowed the window on the first real render.
  lightnessHeadroom: 45,

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
 * orig/rend are raw RGB buffers of identical dimensions. orig is read only for
 * diagnostics now - see the note on masking below.
 *
 * Returns a new RGB buffer plus stats describing what it decided to do.
 */
function correct(orig, rend, width, height, targetHex, targetLrv, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const px = width * height;
  const out = Buffer.from(rend);

  const [, ta, tb] = rgbToLab(hexToRgb(targetHex));

  // Where the surface should sit. LRV is authoritative when we have it.
  const targetL = targetLrv != null && targetLrv !== ''
    ? lrvToL(targetLrv)
    : rgbToLab(hexToRgb(targetHex))[0];

  // Where the paint went.
  //
  // This used to be "every pixel that differs from the original photo", which
  // assumes the model edits the photo in place. FLUX.1 Kontext does not - it
  // regenerates the whole frame, so even untouched walls come back with
  // different pixels, and the output does not line up with the input at all
  // unless the aspect ratio matches. On the first real render that mask
  // selected 62% of the frame and forced the floor, ceiling and countertops to
  // navy. The photo came back shredded.
  //
  // So the mask is now read from the rendered image alone, and asks a question
  // that needs no alignment: did the model already paint this pixel roughly
  // the target colour? Three tests, all in LAB.
  const targetChroma = Math.hypot(ta, tb);

  // A genuinely neutral paint has no side of neutral to be on, so the hue test
  // would reject every pixel including the ones it should keep.
  const useHueSide = targetChroma > 2;

  const build = (radius) => {
    const mask = new Uint8Array(px);
    let count = 0, sumL = 0, minL = 100, maxL = 0, changed = 0;
    for (let i = 0, p = 0; i < px; i++, p += 3) {
      const [L, a, b] = rgbToLab([rend[p], rend[p + 1], rend[p + 2]]);

      // 1. Same side of neutral as the paint. A dot product rather than a hue
      //    angle, because for a barely saturated paint the angle is mostly
      //    noise. This is what separates a cool navy from a warm beige, and it
      //    is why white appliances - 11.7 away from Naval in a/b, but warm -
      //    come through untouched.
      if (useHueSide && a * ta + b * tb <= 0) continue;

      // 2. Close enough in a/b to be this colour rather than a different one.
      if (Math.hypot(a - ta, b - tb) >= radius) continue;

      // 3. Not far brighter than the paint itself.
      if (L >= targetL + o.lightnessHeadroom) continue;

      mask[i] = 1;
      count++;
      sumL += L;
      if (L < minL) minL = L;
      if (L > maxL) maxL = L;

      // Diagnostic only. How much of the masked region also moved relative to
      // the original says how well aligned the two images are, which is the
      // number to check before ever trusting a diff-based rule here again.
      if (orig) {
        const dr = orig[p] - rend[p];
        const dg = orig[p + 1] - rend[p + 1];
        const db = orig[p + 2] - rend[p + 2];
        if (Math.sqrt(dr * dr + dg * dg + db * db) > 28) changed++;
      }
    }
    return { mask, count, changed, meanL: count ? sumL / count : 0, minL, maxL };
  };

  let region = build(o.chromaRadius);
  let radiusUsed = o.chromaRadius;
  if (region.count / px < o.fallbackMinFraction) {
    const relaxed = build(o.fallbackChromaRadius);
    if (relaxed.count > region.count) {
      region = relaxed;
      radiusUsed = o.fallbackChromaRadius;
    }
  }

  if (!region.count) {
    return {
      buffer: out,
      stats: {
        maskPixels: 0,
        radiusUsed,
        applied: false,
        reason: 'the model did not put this colour anywhere in the render',
      },
    };
  }

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
      radiusUsed,
      // Of the pixels this pass recoloured, how many also differ from the
      // original photo. Near 1 means the two images line up; well below means
      // they do not, and no diff-based rule should be trusted here.
      changedFraction: +(region.changed / region.count).toFixed(4),
      targetChroma: +targetChroma.toFixed(1),
      hueSideApplied: useHueSide,
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
