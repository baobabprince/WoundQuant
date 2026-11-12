// Numbers derived from stored results: per image and along a time series.

import { LABEL } from './segment.js';
import { rleDecode } from './rle.js';

/**
 * Per-image metrics.
 * @param {object} r  result from pipeline.buildResult()
 * @param {number|null} pixelSizeUm  micrometres per image pixel (null → px only)
 */
export function imageMetrics(r, pixelSizeUm = null) {
  const px = r.S * r.S;
  const wellPx = r.counts.well * px;
  const woundPx = r.counts.wound * px;
  const freePx = (r.counts.wound + r.counts.free) * px;
  const out = {
    wellAreaPx: wellPx,
    woundAreaPx: woundPx,
    cellFreeAreaPx: freePx,
    woundPct: wellPx ? (100 * woundPx) / wellPx : 0,
    confluencePct: wellPx ? (100 * (wellPx - freePx)) / wellPx : 0,
    woundEqDiameterPx: 2 * Math.sqrt(woundPx / Math.PI),
    wellAreaMm2: null,
    woundAreaMm2: null,
    woundEqDiameterUm: null,
  };
  if (pixelSizeUm && pixelSizeUm > 0) {
    const mm2 = (pixelSizeUm * pixelSizeUm) / 1e6;
    out.wellAreaMm2 = wellPx * mm2;
    out.woundAreaMm2 = woundPx * mm2;
    out.woundEqDiameterUm = out.woundEqDiameterPx * pixelSizeUm;
  }
  return out;
}

/** Least-squares slope of y over x (null with fewer than two distinct x). */
export function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  return sxx > 0 ? sxy / sxx : null;
}

/**
 * Time-series metrics of one well.
 *
 * closurePct        100·(A₀ − Aₜ)/A₀ with A = wound area of the same image.
 * t0RegionClosure   share of the *initial* wound region that is covered by
 *                   cells at time t (insensitive to what happens elsewhere
 *                   in the well; comparable to IncuCyte "wound confluence").
 * ratePctPerH       change of closurePct per hour since the previous point.
 *
 * @param {Array<{time:number, hours:(number|null), result:(object|null)}>} points  sorted by time
 * @returns {{points:Array<object>, summary:object}}
 */
export function seriesMetrics(points, pixelSizeUm = null) {
  const out = [];
  let base = null; // first analysed time point = reference
  let baseLabels = null;
  let prev = null;

  for (const pt of points) {
    const r = pt.result;
    if (!r) { out.push({ time: pt.time, hours: pt.hours, analysed: false }); continue; }
    const m = imageMetrics(r, pixelSizeUm);
    const row = { time: pt.time, hours: pt.hours, analysed: true, ...m, source: r.source, engine: r.engine, qc: [...r.qc],
      closurePct: null, t0RegionClosurePct: null, ratePctPerH: null };

    if (!base) {
      base = { r, m };
      if (m.woundAreaPx > 0) {
        row.closurePct = 0;
        row.t0RegionClosurePct = 0;
        baseLabels = r.labels || rleDecode(r.rle, r.gw * r.gh);
      }
    } else if (base.m.woundAreaPx > 0) {
      // Relative to the well area so that small changes of the detected
      // growth area between time points do not leak into the closure.
      row.closurePct = 100 * (1 - m.woundPct / base.m.woundPct);
      if (baseLabels && r.gw === base.r.gw && r.gh === base.r.gh) {
        const labels = r.labels || rleDecode(r.rle, r.gw * r.gh);
        let region = 0;
        let covered = 0;
        for (let i = 0; i < labels.length; i++) {
          if (baseLabels[i] !== LABEL.WOUND || labels[i] === LABEL.OUTSIDE) continue;
          region++;
          if (labels[i] === LABEL.CELLS) covered++;
        }
        row.t0RegionClosurePct = region ? (100 * covered) / region : null;
      }
    }
    if (prev && row.closurePct !== null && prev.closurePct !== null && pt.hours !== null && prev.hours !== null && pt.hours > prev.hours) {
      row.ratePctPerH = (row.closurePct - prev.closurePct) / (pt.hours - prev.hours);
    }
    if (prev && m.woundPct > prev.woundPct * 1.2 && m.woundPct - prev.woundPct > 2) row.qc.push('wound_grew');
    out.push(row);
    prev = row;
  }

  const done = out.filter((p) => p.analysed && p.closurePct !== null);
  const timed = done.filter((p) => p.hours !== null);
  const summary = {
    n: out.length,
    analysed: out.filter((p) => p.analysed).length,
    baselineWoundPct: base ? base.m.woundPct : null,
    baselineWoundAreaPx: base ? base.m.woundAreaPx : null,
    finalClosurePct: done.length ? done[done.length - 1].closurePct : null,
    maxClosurePct: done.length ? Math.max(...done.map((p) => p.closurePct)) : null,
    meanRatePctPerH: timed.length >= 2 ? slope(timed.map((p) => p.hours), timed.map((p) => p.closurePct)) : null,
    t50Hours: null,
    flagged: out.filter((p) => p.analysed && p.qc.length > 0).length,
  };
  // Time to 50 % closure: first crossing, linearly interpolated.
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1];
    const b = timed[i];
    if (a.closurePct < 50 && b.closurePct >= 50) {
      summary.t50Hours = a.hours + ((50 - a.closurePct) / (b.closurePct - a.closurePct)) * (b.hours - a.hours);
      break;
    }
  }
  return { points: out, summary };
}
