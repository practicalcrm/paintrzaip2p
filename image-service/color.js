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
  // Primary test: how far a pixel must move between the original photo and the
  // model's output before it counts as repainted.
  threshold: 28,

  // If the primary threshold finds almost nothing, the change was subtle -
  // cream walls to Snowbound move maybe 10-15 in RGB distance. Without this
  // pass those renders get no correction at all and the exact-colour promise
  // silently does not apply. Only used when the first pass looks empty.
  fallbackThreshold: 12,
  fallbackMinFraction: 0.005,

  // Secondary test: whatever the model put there has to be plausibly this
  // paint. Deliberately loose. A model renders a colour with far more life in
  // it than the flat chip has - bronze cabinets land 20-25 away from Urbane
  // Bronze in a/b - so this is tight enough only to reject a surface the model
  // changed into something else entirely.
  chromaRadius: 40,

  // A matte painted surface cannot carry a highlight far brighter than the
  // paint itself. Daylight through a window can, and the model regenerates the
  // view through it on every render, so those pixels always read as changed.
  lightnessHeadroom: 45,

  // Shape. A repainted cabinet run is a large solid region; the confetti left
  // by wood grain and granite speckle failing to line up between the two
  // images is not. Both pass the colour and diff tests, so only the shape
  // separates them. A pixel survives if a neighbourhood this wide is mostly
  // masked too, then the survivors are grown back by the same radius so
  // straight cabinet edges - which sit at 50% density by definition - do not
  // come back with an unpainted rim.
  densityRadius: 6,
  minDensity: 0.65,

  // Flag masking. How far a pixel must lean along the flag colour's hue to
  // count as flagged. Room surfaces lean the OTHER way - beige, wood and brass
  // all project negative onto magenta - so the honest threshold is near zero
  // and this is mostly headroom. Raised per photo when the room already holds
  // some of the flag's hue.
  //
  // Kept low deliberately. A sunlit cabinet face washes out towards white,
  // which collapses its chroma and therefore its projection, and at 30 the
  // highlight on the island fell out of the mask and stayed the wrong colour.
  // The room only reached 8.7 on the photo this was measured against, so a
  // floor of 30 was buying nothing and costing highlights.
  flagProjection: 12,

  // How far above anything already in the room the threshold has to sit.
  flagMargin: 10,

  // Grow the finished mask by this many pixels.
  //
  // The two renders agree about where the cabinets are, but not to the pixel,
  // so a rim of the picture's own colour survives along every door edge and
  // reads as chipped, distressed paint. Growing past the seam covers it. The
  // cost is a hairline of paint colour on the wall side of each edge, which is
  // far less visible than the chipping.
  dilateRadius: 3,

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

  // Where the surface should sit. LRV is authoritative when we have it.
  const targetL = targetLrv != null && targetLrv !== ''
    ? lrvToL(targetLrv)
    : rgbToLab(hexToRgb(targetHex))[0];

  // Where the paint went. Two tests, and it needs both.
  //
  // The diff against the original answers "did the model touch this pixel",
  // and it is only meaningful because the workflow now asks Kontext for the
  // source aspect ratio. Before that it answered a 1244x1265 photo with a
  // 1024x1024 image, nothing lined up, and this test alone selected 62% of the
  // frame and forced the floor and ceiling to navy. With the ratio matched,
  // 99% of the recoloured region also reads as changed - the images line up.
  //
  // The colour test answers "is what the model put there plausibly this
  // paint", and it catches what the diff cannot: the model regenerates the
  // whole frame, so the view through a window changes on every render and
  // reads as repainted.
  //
  // Neither works alone. The diff alone smears any incidental change. The
  // colour test alone is worse for a near-neutral paint: a radius around
  // Urbane Bronze (chroma 4.1) swallows every wall, ceiling and countertop in
  // the room while rejecting the cabinets the model actually painted, because
  // it rendered them richer than the flat chip. That render came back with
  // grey walls and mottled cabinets.
  const targetChroma = Math.hypot(ta, tb);

  // A genuinely neutral paint has no side of neutral to be on, so this test
  // would reject every pixel including the ones it should keep.
  const useHueSide = targetChroma > 2;

  const build = (threshold) => {
    const mask = new Uint8Array(px);
    let count = 0, sumL = 0, minL = 100, maxL = 0, changed = 0, plausible = 0;
    for (let i = 0, p = 0; i < px; i++, p += 3) {
      const dr = orig[p] - rend[p];
      const dg = orig[p + 1] - rend[p + 1];
      const db = orig[p + 2] - rend[p + 2];
      const moved = Math.sqrt(dr * dr + dg * dg + db * db) > threshold;
      if (moved) changed++;

      const [L, a, b] = rgbToLab([rend[p], rend[p + 1], rend[p + 2]]);
      const fits =
        (!useHueSide || a * ta + b * tb > 0) &&
        Math.hypot(a - ta, b - tb) < o.chromaRadius &&
        L < targetL + o.lightnessHeadroom;
      if (fits) plausible++;

      if (!moved || !fits) continue;

      mask[i] = 1;
      count++;
      sumL += L;
      if (L < minL) minL = L;
      if (L > maxL) maxL = L;
    }
    return { mask, count, changed, plausible };
  };

  // Summed-area table, so the density of any window is three additions
  // regardless of its size.
  const integrate = (src) => {
    const w1 = width + 1;
    const sat = new Int32Array(w1 * (height + 1));
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        row += src[y * width + x];
        sat[(y + 1) * w1 + (x + 1)] = sat[y * w1 + (x + 1)] + row;
      }
    }
    return sat;
  };

  const windowSum = (sat, x, y, r) => {
    const w1 = width + 1;
    const x0 = Math.max(0, x - r), x1 = Math.min(width - 1, x + r);
    const y0 = Math.max(0, y - r), y1 = Math.min(height - 1, y + r);
    const sum = sat[(y1 + 1) * w1 + (x1 + 1)] - sat[y0 * w1 + (x1 + 1)]
              - sat[(y1 + 1) * w1 + x0] + sat[y0 * w1 + x0];
    return { sum, area: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };

  // Erode to cores, then dilate the cores back over the original mask. Plain
  // erosion alone would strip a band off every cabinet edge, because a
  // straight boundary sits at exactly half density.
  const open = (mask) => {
    const r = o.densityRadius;
    if (r <= 0) return mask;

    const core = new Uint8Array(px);
    const satMask = integrate(mask);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        const { sum, area } = windowSum(satMask, x, y, r);
        if (sum / area >= o.minDensity) core[i] = 1;
      }
    }

    const out2 = new Uint8Array(px);
    const satCore = integrate(core);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        if (windowSum(satCore, x, y, r).sum > 0) out2[i] = 1;
      }
    }
    return out2;
  };

  // A mask supplied by the caller comes from the flag render, which answers
  // "which surface" far better than anything derivable from these two images.
  // When there is one, the tests above are not consulted at all.
  let region;
  let thresholdUsed;
  if (opts.mask) {
    let c = 0;
    for (let i = 0; i < px; i++) if (opts.mask[i]) c++;
    region = { mask: opts.mask, count: c, changed: 0, plausible: 0 };
    thresholdUsed = 'flag';
  } else {
    region = build(o.threshold);
    thresholdUsed = o.threshold;
    if (region.count / px < o.fallbackMinFraction) {
      const relaxed = build(o.fallbackThreshold);
      if (relaxed.count > region.count) {
        region = relaxed;
        thresholdUsed = o.fallbackThreshold;
      }
    }
  }

  // Grow a mask outwards by r pixels. Same summed-area trick as the opening:
  // any pixel with a masked neighbour inside the window joins it.
  const dilate = (mask, r) => {
    if (r <= 0) return mask;
    const sat = integrate(mask);
    const grown = new Uint8Array(px);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (windowSum(sat, x, y, r).sum > 0) grown[y * width + x] = 1;
      }
    }
    return grown;
  };

  const rawCount = region.count;
  region.mask = open(region.mask);

  // Only the flag mask is grown. The diff-and-colour mask already errs
  // generous, and widening it further is exactly the wrong direction.
  if (opts.mask) region.mask = dilate(region.mask, o.dilateRadius);

  // Lightness statistics have to come from the mask that will actually be
  // used, so this sweep runs after the opening rather than during the build.
  let count = 0, sumL = 0, minL = 100, maxL = 0;
  for (let i = 0, p = 0; i < px; i++, p += 3) {
    if (!region.mask[i]) continue;
    const L = rgbToLab([rend[p], rend[p + 1], rend[p + 2]])[0];
    count++;
    sumL += L;
    if (L < minL) minL = L;
    if (L > maxL) maxL = L;
  }
  region.count = count;
  region.meanL = count ? sumL / count : 0;
  region.minL = minL;
  region.maxL = maxL;

  if (!region.count) {
    return {
      buffer: out,
      stats: {
        maskPixels: 0,
        thresholdUsed,
        changedFraction: +(region.changed / px).toFixed(4),
        plausibleFraction: +(region.plausible / px).toFixed(4),
        applied: false,
        reason: 'nothing that moved looks like this paint',
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
      // What the shape test threw away. A big number here is misalignment on a
      // high-frequency texture - wood grain, granite - not a real surface.
      openingRemoved: +((rawCount - region.count) / px).toFixed(4),
      thresholdUsed,
      // The two tests, reported separately. changedFraction well above
      // maskFraction means the model altered a lot the colour test rejected -
      // usually the view through a window. plausibleFraction well above it
      // means the room already held a lot of this colour, which is exactly
      // when the diff is carrying the result.
      changedFraction: +(region.changed / px).toFixed(4),
      plausibleFraction: +(region.plausible / px).toFixed(4),
      targetChroma: +targetChroma.toFixed(1),
      hueSideApplied: useHueSide,
      chromaRadius: o.chromaRadius,
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

// ---------- flag-colour masking ----------
//
// The pipeline renders the photo twice from one seed: once in the paint colour
// the customer asked for, and once in a colour that cannot occur in a room.
// The second render is not for looking at. It is a stencil.
//
// This exists because masking on the real paint colour cannot work for the
// colours this market actually sells. Urbane Bronze sits at chroma 4.1, which
// makes it indistinguishable from half a warm kitchen; #FF00FF is
// indistinguishable from nothing at all. Naval only ever worked because it was
// cool and the room was warm.

// Extreme, and none of them a colour a kitchen contains. Red is deliberately
// absent - it is too close to wood, brick and terracotta.
const FLAG_CANDIDATES = [
  { hex: '#FF00FF', name: 'magenta' },
  { hex: '#00FF00', name: 'green' },
  { hex: '#00FFFF', name: 'cyan' },
  { hex: '#0000FF', name: 'blue' },
];

// Unit vector along a colour's hue in the LAB a/b plane.
function hueUnit(hex) {
  const [, a, b] = rgbToLab(hexToRgb(hex));
  const mag = Math.hypot(a, b) || 1;
  return { ua: a / mag, ub: b / mag };
}

/**
 * Choose a flag colour this photo cannot be confused with.
 *
 * A fixed flag is a trap: a kitchen with pink peonies, a red stand mixer or
 * magenta artwork would hand back those pixels as cabinet. So score every
 * candidate against the photo and take the hue the room has least of.
 *
 * Returns the winner plus the headroom it won by, which becomes the mask
 * threshold - measured from this photo rather than assumed.
 */
function pickFlag(orig, width, height, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const px = width * height;

  // Every 7th pixel. This decides one number and does not need all 1.5M.
  const step = Math.max(1, Math.floor(px / 200000));

  const scored = FLAG_CANDIDATES.map((c) => {
    const { ua, ub } = hueUnit(c.hex);
    let worst = -Infinity;
    for (let i = 0, p = 0; i < px; i += step, p = i * 3) {
      const [, a, b] = rgbToLab([orig[p], orig[p + 1], orig[p + 2]]);
      const proj = a * ua + b * ub;
      if (proj > worst) worst = proj;
    }
    return { ...c, roomMax: +worst.toFixed(1) };
  });

  scored.sort((x, y) => x.roomMax - y.roomMax);
  const winner = scored[0];

  // Sit above whatever the room already has, but never below the floor - a
  // room full of foliage should not drag the threshold down to nothing.
  const threshold = Math.max(o.flagProjection, winner.roomMax + o.flagMargin);

  return { flagHex: winner.hex, flagName: winner.name, threshold, scored };
}

/**
 * Mask the flagged surface out of a flag render.
 *
 * Projection along the flag's hue rather than distance to the flag's colour,
 * because the model renders a flat instruction with shading: cabinet faces in
 * shadow come back darker and less saturated, which moves them a long way in
 * distance while leaving the hue exactly where it was.
 */
function flagMask(flag, width, height, flagHex, threshold, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const px = width * height;
  const { ua, ub } = hueUnit(flagHex);
  const cut = threshold != null ? threshold : o.flagProjection;

  const mask = new Uint8Array(px);
  let count = 0, maxProj = -Infinity;
  for (let i = 0, p = 0; i < px; i++, p += 3) {
    const [, a, b] = rgbToLab([flag[p], flag[p + 1], flag[p + 2]]);
    const proj = a * ua + b * ub;
    if (proj > maxProj) maxProj = proj;
    if (proj >= cut) { mask[i] = 1; count++; }
  }
  return { mask, count, threshold: cut, maxProjection: +maxProj.toFixed(1) };
}

module.exports = { correct, flagMask, pickFlag, hexToRgb, rgbToLab, labToRgb, lrvToL, DEFAULTS, FLAG_CANDIDATES };
