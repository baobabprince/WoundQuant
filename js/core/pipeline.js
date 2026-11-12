// The analysis pipeline, independent of where it runs (browser worker / Node).
//
//   RGBA pixels ──► prepare() ──► engine (classical | neural) ──► buildResult()
//
// prepare()      grey conversion, grid features, well detection, texture map
// engine         produces a raw "cell-free" mask on the analysis grid
// buildResult()  clean-up, wound definition, areas, QC flags, compact storage

import { rgbaToGray, gridFeatures, textureMap, blockSizeFor } from './features.js';
import { detectWell } from './well.js';
import { DEFAULT_PARAMS, LABEL, chooseThreshold, finalizeLabels } from './segment.js';
import { rleEncode } from './rle.js';

/** Bump when results of earlier versions should no longer be reused from cache. */
export const PIPELINE_VERSION = 3;

export { DEFAULT_PARAMS, LABEL };

/** Scaling of the texture map into 0–1 (and 0–255 for exported PNGs). */
export const TEXTURE_RANGE = Object.freeze({ min: -1, max: 7 });
/** Scaling of the texture relative to the well's dense-cell level. */
export const RELATIVE_RANGE = Object.freeze({ min: -6, max: 1 });

/**
 * Reference texture of a well: the 95th percentile inside the growth area,
 * i.e. what a dense cell layer looks like in *this* image. Texture relative
 * to it cancels differences in focus and contrast between images.
 */
export function textureReference(texture, mask) {
  const BINS = 256;
  const hist = new Uint32Array(BINS);
  const scale = BINS / (TEXTURE_RANGE.max - TEXTURE_RANGE.min);
  let total = 0;
  for (let i = 0; i < texture.length; i++) {
    if (!mask[i]) continue;
    let b = ((texture[i] - TEXTURE_RANGE.min) * scale) | 0;
    if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    hist[b]++;
    total++;
  }
  if (!total) return 0;
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= 0.95 * total) return TEXTURE_RANGE.min + (b + 0.5) / scale;
  }
  return TEXTURE_RANGE.max;
}

/**
 * The three feature planes of one grid cell as bytes — the single definition
 * used for network input and for exported training images:
 *   [0] mean grey, at least 1 inside the growth area, 0 outside
 *   [1] texture (absolute scale)        0 outside
 *   [2] texture relative to reference   0 outside
 */
export function featureBytes(prep, i, out, o) {
  if (!prep.well.mask[i]) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; return; }
  const m = Math.round(prep.mean[i]);
  out[o] = m < 1 ? 1 : m > 255 ? 255 : m;
  const a = Math.round(((prep.texture[i] - TEXTURE_RANGE.min) * 255) / (TEXTURE_RANGE.max - TEXTURE_RANGE.min));
  out[o + 1] = a < 0 ? 0 : a > 255 ? 255 : a;
  const r = Math.round(((prep.texture[i] - prep.textureRef - RELATIVE_RANGE.min) * 255) / (RELATIVE_RANGE.max - RELATIVE_RANGE.min));
  out[o + 2] = r < 0 ? 0 : r > 255 ? 255 : r;
}

export function normalizeParams(params = {}) {
  const p = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(DEFAULT_PARAMS)) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') p[k] = params[k];
  }
  p.woundMode = p.woundMode === 'all' ? 'all' : 'largest';
  for (const k of ['wellMargin', 'textureSigma', 'sensitivity', 'smoothRadius', 'minRegionFrac', 'fillIslandsFrac']) {
    p[k] = Number(p[k]);
    if (!Number.isFinite(p[k])) p[k] = DEFAULT_PARAMS[k];
  }
  return p;
}

/** Stable key of everything that changes the outcome (for result caching). */
export function paramsKey(params, engineId = 'classical') {
  const p = normalizeParams(params);
  return [PIPELINE_VERSION, engineId, p.wellMargin, p.textureSigma, p.sensitivity, p.smoothRadius,
    p.minRegionFrac, p.fillIslandsFrac, p.woundMode].join('|');
}

/**
 * Steps shared by all engines.
 * @param {Uint8Array|Uint8ClampedArray} rgba
 */
export function prepare(rgba, width, height, params = DEFAULT_PARAMS) {
  const p = normalizeParams(params);
  const gray = rgbaToGray(rgba, width, height);
  const S = blockSizeFor(width, height);
  const F = gridFeatures(gray, width, height, S);
  const well = detectWell(F.mean, F.gmax, F.gw, F.gh, { marginFrac: p.wellMargin });
  const texture = textureMap(F.grad, F.gw, F.gh, p.textureSigma);
  const textureRef = textureReference(texture, well.mask);
  return { width, height, S, gw: F.gw, gh: F.gh, mean: F.mean, texture, textureRef, well, params: p };
}

/** Classical engine: threshold the texture map inside the well. */
export function classicalRawMask(prep) {
  const { gw, gh, texture, well, params } = prep;
  const threshold = chooseThreshold(texture, well.mask, params.sensitivity);
  const raw = new Uint8Array(gw * gh);
  for (let i = 0; i < raw.length; i++) raw[i] = well.mask[i] && texture[i] < threshold.threshold ? 1 : 0;
  return { raw, threshold };
}

/**
 * Network input: 4 planes (mean, texture, relative texture, growth-area mask)
 * in 0–1, padded on the right/bottom to a multiple of `multiple`.
 * Layout NCHW with N = 1. Values go through the same 8-bit quantisation as
 * the exported training images, so training and inference see identical data.
 */
export function modelInput(prep, multiple = 32) {
  const { gw, gh, well } = prep;
  const W = Math.ceil(gw / multiple) * multiple;
  const H = Math.ceil(gh / multiple) * multiple;
  const plane = W * H;
  const data = new Float32Array(4 * plane);
  const px = new Uint8Array(3);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const s = y * gw + x;
      if (!well.mask[s]) continue;
      const d = y * W + x;
      featureBytes(prep, s, px, 0);
      data[d] = px[0] / 255;
      data[plane + d] = px[1] / 255;
      data[2 * plane + d] = px[2] / 255;
      data[3 * plane + d] = 1;
    }
  }
  return { data, dims: [1, 4, H, W], width: W, height: H };
}

/** Network output (logits of "cell-free", padded layout) → raw mask on the grid. */
export function rawMaskFromLogits(logits, outWidth, prep, threshold = 0) {
  const { gw, gh, well } = prep;
  const raw = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const s = y * gw + x;
      raw[s] = well.mask[s] && logits[y * outWidth + x] > threshold ? 1 : 0;
    }
  }
  return raw;
}

/** Share of the wound outline that lies on the rim of the growth area. */
function rimContact(labels, w, h) {
  let outline = 0;
  let rim = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (labels[p] !== LABEL.WOUND) continue;
      const l = x > 0 ? labels[p - 1] : 0;
      const r = x < w - 1 ? labels[p + 1] : 0;
      const u = y > 0 ? labels[p - w] : 0;
      const d = y < h - 1 ? labels[p + w] : 0;
      if (l === LABEL.WOUND && r === LABEL.WOUND && u === LABEL.WOUND && d === LABEL.WOUND) continue;
      outline++;
      if (l === LABEL.OUTSIDE || r === LABEL.OUTSIDE || u === LABEL.OUTSIDE || d === LABEL.OUTSIDE) rim++;
    }
  }
  return outline ? rim / outline : 0;
}

/** Counts + QC flags of a label map (also used after manual edits). */
export function summarizeLabels(labels, w, h, extra = {}) {
  const c = [0, 0, 0, 0];
  for (let i = 0; i < labels.length; i++) c[labels[i]]++;
  const well = c[1] + c[2] + c[3];
  const rim = rimContact(labels, w, h);
  const qc = [];
  if (well === 0) qc.push('no_well');
  if (extra.wellKind === 'blob') qc.push('well_irregular');
  if (well > 0 && c[3] === 0) qc.push('no_wound');
  if (well > 0 && c[3] / well > 0.6) qc.push('wound_large');
  if (c[3] > 0 && rim > 0.25) qc.push('wound_at_rim');
  if (extra.threshold && (extra.threshold.mode === 'uniform' || extra.threshold.separation < 1.3)) qc.push('low_contrast');
  return { counts: { well, cells: c[1], free: c[2], wound: c[3] }, rimContact: rim, qc };
}

/**
 * Final result of one image — plain data, cheap to post between threads.
 * Areas are in analysis-grid cells; multiply by S² for image pixels.
 */
export function buildResult(prep, raw, engine, info = {}) {
  const { gw, gh, S, well, params } = prep;
  const labels = finalizeLabels(raw, well.mask, gw, gh, well.area, params);
  const summary = summarizeLabels(labels, gw, gh, { wellKind: well.kind, threshold: info.threshold });
  return {
    version: PIPELINE_VERSION,
    engine,
    source: 'auto',
    width: prep.width,
    height: prep.height,
    S,
    gw,
    gh,
    well: { kind: well.kind, aperture: well.aperture, wall: well.wall },
    threshold: info.threshold || null,
    counts: summary.counts,
    rimContact: summary.rimContact,
    qc: summary.qc,
    rle: rleEncode(labels),
    labels, // dropped by callers that only keep the compact form
  };
}

/** One-call classical analysis (used by the CLI, tests and the worker). */
export function analyzeClassical(rgba, width, height, params = DEFAULT_PARAMS) {
  const prep = prepare(rgba, width, height, params);
  const { raw, threshold } = classicalRawMask(prep);
  return { prep, result: buildResult(prep, raw, 'classical', { threshold }) };
}
