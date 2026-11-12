// Binary morphology on Uint8Array masks (0 = background, non-zero = foreground).
// All functions return new arrays and never touch the DOM.

const INF = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    } while (s <= z[k] && --k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/**
 * Squared Euclidean distance from every pixel to the nearest pixel where
 * `mask` is zero (so foreground pixels get their depth, background gets 0).
 */
export function distanceToBackgroundSq(mask, w, h) {
  const out = new Float64Array(w * h);
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? INF : 0;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
  return out;
}

/** Erosion with a disk of radius r (pixels outside the image count as foreground). */
export function erode(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask, (v) => (v ? 1 : 0));
  const d = distanceToBackgroundSq(mask, w, h);
  const out = new Uint8Array(w * h);
  const r2 = r * r;
  for (let i = 0; i < out.length; i++) out[i] = d[i] > r2 ? 1 : 0;
  return out;
}

/** Dilation with a disk of radius r. */
export function dilate(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask, (v) => (v ? 1 : 0));
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const d = distanceToBackgroundSq(inv, w, h);
  const out = new Uint8Array(w * h);
  const r2 = r * r;
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r2 ? 1 : 0;
  return out;
}

export const open = (mask, w, h, r) => dilate(erode(mask, w, h, r), w, h, r);
export const close = (mask, w, h, r) => erode(dilate(mask, w, h, r), w, h, r);

/**
 * Connected-component labelling (4-connectivity by default).
 * @returns {{labels:Int32Array, count:number, areas:Int32Array, touchesBorder:Uint8Array}}
 *   labels are 1-based; index 0 of `areas` is unused.
 */
export function labelComponents(mask, w, h, eight = false) {
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const areas = [0];
  const border = [0];
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start]) continue;
    count++;
    let area = 0;
    let touches = 0;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = 1;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = count; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = count; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = count; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = count; stack[sp++] = p + w; }
      if (eight) {
        if (x > 0 && y > 0 && mask[p - w - 1] && !labels[p - w - 1]) { labels[p - w - 1] = count; stack[sp++] = p - w - 1; }
        if (x < w - 1 && y > 0 && mask[p - w + 1] && !labels[p - w + 1]) { labels[p - w + 1] = count; stack[sp++] = p - w + 1; }
        if (x > 0 && y < h - 1 && mask[p + w - 1] && !labels[p + w - 1]) { labels[p + w - 1] = count; stack[sp++] = p + w - 1; }
        if (x < w - 1 && y < h - 1 && mask[p + w + 1] && !labels[p + w + 1]) { labels[p + w + 1] = count; stack[sp++] = p + w + 1; }
      }
    }
    areas.push(area);
    border.push(touches);
  }
  return { labels, count, areas: Int32Array.from(areas), touchesBorder: Uint8Array.from(border) };
}

/** Remove foreground components smaller than minArea pixels. */
export function removeSmall(mask, w, h, minArea, eight = false) {
  const { labels, areas } = labelComponents(mask, w, h, eight);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = labels[i] && areas[labels[i]] >= minArea ? 1 : 0;
  return out;
}

/** Keep only the largest foreground component (empty mask if none). */
export function keepLargest(mask, w, h, eight = false) {
  const { labels, count, areas } = labelComponents(mask, w, h, eight);
  const out = new Uint8Array(w * h);
  if (!count) return out;
  let best = 1;
  for (let l = 2; l <= count; l++) if (areas[l] > areas[best]) best = l;
  for (let i = 0; i < out.length; i++) out[i] = labels[i] === best ? 1 : 0;
  return out;
}

/**
 * Fill background holes that are fully enclosed by foreground.
 * Holes larger than maxArea (pixels) are left open; `within`, when given,
 * restricts which pixels count as part of the canvas (outside = border).
 */
export function fillHoles(mask, w, h, maxArea = Infinity, within = null) {
  const n = w * h;
  const bg = new Uint8Array(n);
  for (let i = 0; i < n; i++) bg[i] = !mask[i] && (!within || within[i]) ? 1 : 0;
  const { labels, count, areas, touchesBorder } = labelComponents(bg, w, h, false);
  // A background component is "open" when it reaches the image border or,
  // with `within`, when it touches a pixel outside the allowed region.
  const isOpen = new Uint8Array(count + 1);
  for (let l = 1; l <= count; l++) isOpen[l] = touchesBorder[l];
  if (within) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const l = labels[p];
        if (!l || isOpen[l]) continue;
        if ((x > 0 && !within[p - 1]) || (x < w - 1 && !within[p + 1]) ||
            (y > 0 && !within[p - w]) || (y < h - 1 && !within[p + w])) isOpen[l] = 1;
      }
    }
  }
  const out = Uint8Array.from(mask, (v) => (v ? 1 : 0));
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l && !isOpen[l] && areas[l] <= maxArea) out[i] = 1;
  }
  return out;
}

export function countMask(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

/** Length of the mask outline in pixels (4-neighbour edge count, bias-corrected). */
export function perimeter(mask, w, h) {
  let edges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      if (x === 0 || !mask[p - 1]) edges++;
      if (x === w - 1 || !mask[p + 1]) edges++;
      if (y === 0 || !mask[p - w]) edges++;
      if (y === h - 1 || !mask[p + w]) edges++;
    }
  }
  // A digitised circle has 4/π times the true circumference in edge count.
  return edges * (Math.PI / 4);
}
