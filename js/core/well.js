// Well (growth area) detection.
//
// Whole-well images from plate imagers (IncuCyte and similar) show a bright
// disk — the illuminated field — on a black background. The disk is slightly
// larger than the well bottom: on one side the well wall shows up as a sharp
// bright/dark arc, and the crescent between that arc and the edge of the disk
// is an out-of-focus view of the wall where no cells can grow.
//
//   growth area = illuminated disk  ∩  inside of the wall circle
//
// Images that are not whole-well views (a rectangular field of view inside
// the well) have no dark background; the whole frame is then the growth area.

import { boxBlur } from './features.js';
import { labelComponents, fillHoles, erode } from './morph.js';

/** Deterministic PRNG (mulberry32) so RANSAC gives the same answer every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Algebraic least-squares circle through points (Kåsa fit). */
export function fitCircle(xs, ys, idx = null) {
  const n = idx ? idx.length : xs.length;
  if (n < 3) return null;
  // Centre the data for numerical stability.
  let mx = 0;
  let my = 0;
  for (let k = 0; k < n; k++) { const i = idx ? idx[k] : k; mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k;
    const u = xs[i] - mx;
    const v = ys[i] - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const bu = 0.5 * (suuu + suvv);
  const bv = 0.5 * (svvv + svuu);
  const uc = (bu * svv - bv * suv) / det;
  const vc = (bv * suu - bu * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return { cx: uc + mx, cy: vc + my, r };
}

function circleFrom3(x1, y1, x2, y2, x3, y3) {
  const a = x2 - x1, b = y2 - y1, c = x3 - x1, d = y3 - y1;
  const e = a * (x1 + x2) + b * (y1 + y2);
  const f = c * (x1 + x3) + d * (y1 + y3);
  const g = 2 * (a * (y3 - y2) - b * (x3 - x2));
  if (Math.abs(g) < 1e-9) return null;
  const cx = (d * e - b * f) / g;
  const cy = (a * f - c * e) / g;
  return { cx, cy, r: Math.hypot(x1 - cx, y1 - cy) };
}

function medianOf(values) {
  const a = Float32Array.from(values).sort();
  return a.length ? a[a.length >> 1] : 0;
}

/**
 * Illuminated field: largest bright blob of the block-mean image.
 * @returns {{lit:Uint8Array, litFraction:number, level:number}}
 */
export function illuminatedMask(mean, w, h) {
  const sm = boxBlur(mean, w, h, 2);
  // Typical brightness of the lit area = median of everything clearly not black.
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < sm.length; i++) {
    if (sm[i] > 20) { hist[Math.min(255, sm[i] | 0)]++; total++; }
  }
  let level = 128;
  if (total > 0) {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc * 2 >= total) { level = v; break; } }
  }
  const thr = Math.max(8, 0.25 * level);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = sm[i] > thr ? 1 : 0;
  const { labels, count, areas } = labelComponents(bin, w, h);
  let best = 0;
  for (let l = 1; l <= count; l++) if (!best || areas[l] > areas[best]) best = l;
  const blob = new Uint8Array(w * h);
  if (best) for (let i = 0; i < blob.length; i++) blob[i] = labels[i] === best ? 1 : 0;
  const lit = fillHoles(blob, w, h);
  let c = 0;
  for (let i = 0; i < lit.length; i++) c += lit[i];
  return { lit, litFraction: c / lit.length, level };
}

/** Circle through the outline of the illuminated field (robust, trimmed). */
function fitAperture(lit, w, h) {
  const xs = [];
  const ys = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!lit[p]) continue;
      if (lit[p - 1] && lit[p + 1] && lit[p - w] && lit[p + w]) continue;
      // Outline pixels hugging the image frame say nothing about the circle.
      if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) continue;
      xs.push(x); ys.push(y);
    }
  }
  if (xs.length < 40) return null;
  let fit = fitCircle(xs, ys);
  if (!fit) return null;
  let keep = null;
  for (let it = 0; it < 4 && fit; it++) {
    const res = xs.map((x, i) => Math.abs(Math.hypot(x - fit.cx, ys[i] - fit.cy) - fit.r));
    const tol = Math.max(1.5, 2.5 * medianOf(res));
    keep = [];
    for (let i = 0; i < xs.length; i++) if (res[i] <= tol) keep.push(i);
    if (keep.length < 20) return null;
    fit = fitCircle(xs, ys, keep);
  }
  if (!fit) return null;
  let rms = 0;
  for (const i of keep) rms += (Math.hypot(xs[i] - fit.cx, ys[i] - fit.cy) - fit.r) ** 2;
  rms = Math.sqrt(rms / keep.length);
  return { ...fit, rms, support: keep.length / xs.length };
}

/**
 * Find the well-wall arc: a long, thin, high-contrast line running roughly
 * parallel to the aperture edge. Works in polar coordinates around the
 * aperture centre where the arc is a nearly horizontal ridge.
 */
function fitWallArc(gmax, w, h, ap) {
  const NT = 360;
  const rMin = Math.floor(0.78 * ap.r);
  const rMax = Math.floor(ap.r) - 3;
  const NR = rMax - rMin;
  if (NR < 8) return null;
  const polar = new Float32Array(NR * NT);
  for (let t = 0; t < NT; t++) {
    const cs = Math.cos((t * 2 * Math.PI) / NT);
    const sn = Math.sin((t * 2 * Math.PI) / NT);
    for (let k = 0; k < NR; k++) {
      const x = Math.round(ap.cx + (rMin + k) * cs);
      const y = Math.round(ap.cy + (rMin + k) * sn);
      polar[k * NT + t] = x >= 0 && y >= 0 && x < w && y < h ? gmax[y * w + x] : 0;
    }
  }
  // Average along the tangent (±5°): cells are random, the wall is coherent.
  const HALF = 5;
  const smooth = new Float32Array(NR * NT);
  for (let k = 0; k < NR; k++) {
    const row = k * NT;
    let sum = 0;
    for (let d = -HALF; d <= HALF; d++) sum += polar[row + ((d + NT) % NT)];
    for (let t = 0; t < NT; t++) {
      smooth[row + t] = sum / (2 * HALF + 1);
      sum += polar[row + ((t + HALF + 1) % NT)] - polar[row + ((t - HALF + NT) % NT)];
    }
  }
  // Per angle: strongest ridge and how much it stands out from that ray.
  const xs = [];
  const ys = [];
  const col = new Float32Array(NR);
  for (let t = 0; t < NT; t++) {
    let best = 0;
    for (let k = 0; k < NR; k++) {
      col[k] = smooth[k * NT + t];
      if (col[k] > col[best]) best = k;
    }
    const peak = col[best];
    const med = medianOf(col);
    // Beyond the wall lies the blurred crescent: clearly calmer than the ridge.
    let beyond = 0;
    let nb = 0;
    for (let k = best + 3; k < NR; k++) { beyond += col[k]; nb++; }
    beyond = nb ? beyond / nb : peak;
    if (peak > 60 && peak > 1.6 * med && nb >= 2 && beyond < 0.5 * peak) {
      const ang = (t * 2 * Math.PI) / NT;
      xs.push(ap.cx + (rMin + best) * Math.cos(ang));
      ys.push(ap.cy + (rMin + best) * Math.sin(ang));
    }
  }
  if (xs.length < 30) return null;

  const tol = Math.max(1.2, 0.006 * ap.r);
  const inliersOf = (c) => {
    const inl = [];
    for (let p = 0; p < xs.length; p++) {
      if (Math.abs(Math.hypot(xs[p] - c.cx, ys[p] - c.cy) - c.r) <= tol) inl.push(p);
    }
    return inl;
  };
  const nearAperture = (c, rTol) =>
    c && Math.abs(c.r - ap.r) <= rTol * ap.r && Math.hypot(c.cx - ap.cx, c.cy - ap.cy) <= 0.2 * ap.r;
  const rand = rng(12345);

  // (a) Free fit: centre and radius from the arc. Only trustworthy when the
  // arc is long, otherwise the radius is poorly determined.
  let free = null;
  let freeInl = [];
  for (let it = 0; it < 400; it++) {
    const i = (rand() * xs.length) | 0;
    const j = (rand() * xs.length) | 0;
    const k = (rand() * xs.length) | 0;
    if (i === j || j === k || i === k) continue;
    const c = circleFrom3(xs[i], ys[i], xs[j], ys[j], xs[k], ys[k]);
    if (!nearAperture(c, 0.08)) continue;
    const inl = inliersOf(c);
    if (inl.length > freeInl.length) { free = c; freeInl = inl; }
  }
  if (free && freeInl.length >= 90) {
    let fit = fitCircle(xs, ys, freeInl) || free;
    const inl = inliersOf(fit);
    if (inl.length >= 90) fit = fitCircle(xs, ys, inl) || fit;
    if (nearAperture(fit, 0.08)) return { ...fit, arcDegrees: inliersOf(fit).length, radiusFitted: true };
  }

  // (b) Short arc: the illuminated field is cut to the size of the well, so
  // take the aperture radius as the wall radius and solve for the centre only.
  const R = ap.r;
  let fixed = null;
  let fixedInl = [];
  for (let it = 0; it < 400; it++) {
    const i = (rand() * xs.length) | 0;
    const j = (rand() * xs.length) | 0;
    if (i === j) continue;
    const mx = (xs[i] + xs[j]) / 2;
    const my = (ys[i] + ys[j]) / 2;
    const dx = xs[j] - xs[i];
    const dy = ys[j] - ys[i];
    const half = Math.hypot(dx, dy) / 2;
    if (half < 0.05 * R || half >= R) continue;
    const off = Math.sqrt(R * R - half * half);
    const nx = -dy / (2 * half);
    const ny = dx / (2 * half);
    const c1 = { cx: mx + nx * off, cy: my + ny * off, r: R };
    const c2 = { cx: mx - nx * off, cy: my - ny * off, r: R };
    const c = Math.hypot(c1.cx - ap.cx, c1.cy - ap.cy) < Math.hypot(c2.cx - ap.cx, c2.cy - ap.cy) ? c1 : c2;
    if (!nearAperture(c, 0.001)) continue;
    const inl = inliersOf(c);
    if (inl.length > fixedInl.length) { fixed = c; fixedInl = inl; }
  }
  if (!fixed || fixedInl.length < 30) return null;
  for (let round = 0; round < 3; round++) {
    for (let it = 0; it < 15; it++) {
      let sx = 0;
      let sy = 0;
      for (const p of fixedInl) {
        const dx = xs[p] - fixed.cx;
        const dy = ys[p] - fixed.cy;
        const d = Math.hypot(dx, dy) || 1;
        sx += ((d - R) * dx) / d;
        sy += ((d - R) * dy) / d;
      }
      fixed.cx += sx / fixedInl.length;
      fixed.cy += sy / fixedInl.length;
    }
    const inl = inliersOf(fixed);
    if (inl.length < 30) break;
    fixedInl = inl;
  }
  if (!nearAperture(fixed, 0.001) || fixedInl.length < 30) return null;
  return { ...fixed, arcDegrees: fixedInl.length, radiusFitted: false };
}

/**
 * Detect the growth area on the analysis grid.
 *
 * @param {Float32Array} mean  block-mean intensity
 * @param {Float32Array} gmax  block-max gradient
 * @param {object} opts  { marginFrac: fraction of the well radius trimmed at the rim }
 * @returns {{mask:Uint8Array, kind:'circle'|'frame'|'blob', aperture:?object, wall:?object, area:number}}
 *   circles are in grid coordinates.
 */
export function detectWell(mean, gmax, w, h, opts = {}) {
  const marginFrac = opts.marginFrac ?? 0.03;
  const n = w * h;
  const { lit, litFraction } = illuminatedMask(mean, w, h);
  const mask = new Uint8Array(n);

  // No dark surround: the field of view sits inside the well.
  if (litFraction > 0.97) {
    mask.fill(1);
    return { mask, kind: 'frame', aperture: null, wall: null, area: n };
  }

  const ap = fitAperture(lit, w, h);
  const circleArea = ap ? Math.PI * ap.r * ap.r : 0;
  const plausible = ap && ap.rms < 0.02 * ap.r + 1 && ap.support > 0.6 &&
    ap.r > 0.15 * Math.min(w, h) && ap.r < 1.5 * Math.max(w, h);

  if (!plausible) {
    // Irregular bright region: use it as it is, slightly shrunk.
    const r = Math.max(1, Math.round(marginFrac * Math.sqrt((litFraction * n) / Math.PI)));
    const er = erode(lit, w, h, r);
    let area = 0;
    for (let i = 0; i < n; i++) { mask[i] = er[i] && lit[i] ? 1 : 0; area += mask[i]; }
    return { mask, kind: 'blob', aperture: null, wall: null, area };
  }

  const wall = fitWallArc(gmax, w, h, ap);
  const apR = ap.r * (1 - marginFrac);
  const apR2 = apR * apR;
  // The wall line itself is a few pixels thick; step just inside it.
  const wallR = wall ? wall.r - Math.max(1.5, 0.012 * wall.r) : 0;
  const wallR2 = wallR * wallR;
  let area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!lit[p]) continue;
      const dx = x - ap.cx;
      const dy = y - ap.cy;
      if (dx * dx + dy * dy > apR2) continue;
      if (wall) {
        const ex = x - wall.cx;
        const ey = y - wall.cy;
        if (ex * ex + ey * ey > wallR2) continue;
      }
      mask[p] = 1;
      area++;
    }
  }
  return {
    mask,
    kind: 'circle',
    aperture: { cx: ap.cx, cy: ap.cy, r: ap.r, circleArea },
    wall: wall ? { cx: wall.cx, cy: wall.cy, r: wall.r, arcDegrees: wall.arcDegrees } : null,
    area,
  };
}
