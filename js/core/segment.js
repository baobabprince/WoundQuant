// Classical (texture-threshold) segmentation of the cell-free area.
//
// Cells give the image fine texture; bare plastic is smooth. Inside the well
// the log-texture map is split with Otsu's threshold and cleaned up
// morphologically. The largest cell-free region is reported as the wound.

import { textureMap } from './features.js';
import { open, removeSmall, labelComponents, fillHoles, countMask } from './morph.js';

/** Label values of the per-pixel class map stored for every image. */
export const LABEL = Object.freeze({ OUTSIDE: 0, CELLS: 1, FREE: 2, WOUND: 3 });

export const DEFAULT_PARAMS = Object.freeze({
  /** Fraction of the well radius trimmed at the rim (vignetting, meniscus). */
  wellMargin: 0.03,
  /** Smoothing of the texture map, in grid cells. */
  textureSigma: 2,
  /** Threshold shift in log2 units: >0 marks more area as cell-free. */
  sensitivity: 0,
  /** Radius (grid cells) of the opening that removes specks and thin bridges. */
  smoothRadius: 2,
  /** Cell-free regions smaller than this fraction of the well are ignored. */
  minRegionFrac: 0.003,
  /** Cell/debris islands inside the wound smaller than this fraction of the well count as wound. */
  fillIslandsFrac: 0.05,
  /** 'largest' = the main cell-free region (+ comparable ones); 'all' = every cell-free region. */
  woundMode: 'largest',
});

const BINS = 160;
const T_MIN = -1;
const T_MAX = 7;

/**
 * Otsu threshold of the texture values inside the mask.
 * @returns {{threshold:number, lowMean:number, highMean:number, lowFrac:number, eta:number, median:number}}
 */
export function otsuTexture(T, mask) {
  const hist = new Float64Array(BINS);
  let total = 0;
  const scale = BINS / (T_MAX - T_MIN);
  for (let i = 0; i < T.length; i++) {
    if (!mask[i]) continue;
    let b = ((T[i] - T_MIN) * scale) | 0;
    if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    hist[b]++;
    total++;
  }
  const centre = (b) => T_MIN + (b + 0.5) / scale;
  if (!total) return { threshold: 0, lowMean: 0, highMean: 0, lowFrac: 0, eta: 0, median: 0 };
  let sumAll = 0;
  for (let b = 0; b < BINS; b++) sumAll += hist[b] * centre(b);
  const meanAll = sumAll / total;
  let varAll = 0;
  for (let b = 0; b < BINS; b++) varAll += hist[b] * (centre(b) - meanAll) ** 2;
  varAll /= total;

  let best = -1;
  let bestB = 0;
  let w0 = 0;
  let s0 = 0;
  let acc = 0;
  let median = centre(0);
  let medianSet = false;
  for (let b = 0; b < BINS - 1; b++) {
    w0 += hist[b];
    s0 += hist[b] * centre(b);
    acc += hist[b];
    if (!medianSet && acc * 2 >= total) { median = centre(b); medianSet = true; }
    const w1 = total - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = s0 / w0;
    const m1 = (sumAll - s0) / w1;
    const between = (w0 / total) * (w1 / total) * (m1 - m0) ** 2;
    if (between > best) { best = between; bestB = b; }
  }
  let lw = 0;
  let ls = 0;
  for (let b = 0; b <= bestB; b++) { lw += hist[b]; ls += hist[b] * centre(b); }
  const hw = total - lw;
  return {
    threshold: T_MIN + (bestB + 1) / scale,
    lowMean: lw ? ls / lw : 0,
    highMean: hw ? (sumAll - ls) / hw : 0,
    lowFrac: lw / total,
    eta: varAll > 0 ? best / varAll : 0,
    median,
  };
}

/**
 * Decide the cells / cell-free threshold on the log-texture scale.
 * Otsu is only trusted when the two classes really differ; otherwise the
 * well is treated as uniformly covered (or uniformly empty).
 */
export function chooseThreshold(T, mask, sensitivity = 0) {
  const o = otsuTexture(T, mask);
  const separation = o.highMean - o.lowMean; // log2 units → texture ratio
  let threshold = o.threshold;
  let mode = 'otsu';
  if (separation < 0.9 || o.eta < 0.45) {
    // One population only. Bare plastic sits below ~log2(3.5); cells well above.
    mode = 'uniform';
    threshold = 1.8;
  } else {
    // Never call clearly textured tissue "empty", nor smooth plastic "cells".
    threshold = Math.min(Math.max(threshold, 1.2), 3.6);
  }
  return { threshold: threshold + sensitivity, mode, separation, eta: o.eta, lowMean: o.lowMean, highMean: o.highMean };
}

/**
 * Turn a raw cell-free mask into the final label map.
 * Shared by the classical engine and the neural engine (which supplies its
 * own raw mask), so both obey the same clean-up rules and wound definition.
 */
export function finalizeLabels(rawFree, wellMask, w, h, wellArea, params = DEFAULT_PARAMS) {
  const n = w * h;
  const minRegion = Math.max(4, Math.round(params.minRegionFrac * wellArea));
  const maxIsland = Math.round(params.fillIslandsFrac * wellArea);

  let free = new Uint8Array(n);
  for (let i = 0; i < n; i++) free[i] = rawFree[i] && wellMask[i] ? 1 : 0;
  if (params.smoothRadius > 0) free = open(free, w, h, params.smoothRadius);
  // Small cell/debris islands enclosed by cell-free area belong to it.
  if (maxIsland > 0) free = fillHoles(free, w, h, maxIsland, wellMask);
  for (let i = 0; i < n; i++) if (!wellMask[i]) free[i] = 0;
  free = removeSmall(free, w, h, minRegion);

  const { labels: comp, count, areas } = labelComponents(free, w, h);
  let largest = 0;
  for (let l = 1; l <= count; l++) if (!largest || areas[l] > areas[largest]) largest = l;
  const isWound = new Uint8Array(count + 1);
  if (largest) {
    for (let l = 1; l <= count; l++) {
      isWound[l] = params.woundMode === 'all' || l === largest || areas[l] >= 0.25 * areas[largest] ? 1 : 0;
    }
  }
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!wellMask[i]) labels[i] = LABEL.OUTSIDE;
    else if (!free[i]) labels[i] = LABEL.CELLS;
    else labels[i] = isWound[comp[i]] ? LABEL.WOUND : LABEL.FREE;
  }
  return labels;
}

/**
 * Classical engine.
 * @param {{gw:number, gh:number, grad:Float32Array}} F  grid features
 * @param {{mask:Uint8Array, area:number}} well
 * @returns {{labels:Uint8Array, texture:Float32Array, threshold:object}}
 */
export function segmentClassical(F, well, params = DEFAULT_PARAMS) {
  const { gw: w, gh: h } = F;
  const texture = textureMap(F.grad, w, h, params.textureSigma);
  const threshold = chooseThreshold(texture, well.mask, params.sensitivity);
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = well.mask[i] && texture[i] < threshold.threshold ? 1 : 0;
  const labels = finalizeLabels(raw, well.mask, w, h, well.area, params);
  return { labels, texture, threshold };
}

/** Pixel counts of each label. */
export function labelCounts(labels) {
  const c = [0, 0, 0, 0];
  for (let i = 0; i < labels.length; i++) c[labels[i]]++;
  return { outside: c[0], cells: c[1], free: c[2], wound: c[3] };
}

export { countMask };
