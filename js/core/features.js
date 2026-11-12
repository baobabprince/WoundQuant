// Feature extraction — pure functions on typed arrays (no DOM), shared by the
// browser worker, the Node CLI tools and the unit tests.
//
// Every image is reduced to an "analysis grid": the full-resolution image is
// split into S×S blocks and each block is summarised by
//   mean  – mean grey level                     (illumination / well shape)
//   grad  – mean gradient magnitude             (fine texture = cells)
//   gmax  – max gradient magnitude              (sharp lines = well wall)
// Computing texture at FULL resolution and only then pooling is what keeps
// single cells (4–8 px wide) visible after a 4× reduction.

/** Target size (longest side, in grid cells) of the analysis grid. */
export const GRID_TARGET = 600;

/** Integer block size so that the longest side lands near GRID_TARGET. */
export function blockSizeFor(width, height, target = GRID_TARGET) {
  return Math.max(1, Math.round(Math.max(width, height) / target));
}

/** RGBA (Uint8ClampedArray) → luma (Uint8Array), BT.601 integer approximation. */
export function rgbaToGray(rgba, width, height) {
  const n = width * height;
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29 + 128) >> 8;
  }
  return gray;
}

/**
 * Block-pooled features of a grey image.
 * @returns {{gw:number, gh:number, S:number, mean:Float32Array, grad:Float32Array, gmax:Float32Array}}
 */
export function gridFeatures(gray, width, height, S = blockSizeFor(width, height)) {
  const gw = Math.floor(width / S);
  const gh = Math.floor(height / S);
  const n = gw * gh;
  const mean = new Float32Array(n);
  const grad = new Float32Array(n);
  const gmax = new Float32Array(n);
  const inv = 1 / (S * S);

  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy * S;
    for (let dy = 0; dy < S; dy++) {
      const y = y0 + dy;
      const row = y * width;
      const up = (y > 0 ? y - 1 : y) * width;
      const dn = (y < height - 1 ? y + 1 : y) * width;
      const yScale = y > 0 && y < height - 1 ? 0.5 : 1;
      let gi = gy * gw;
      for (let gx = 0; gx < gw; gx++, gi++) {
        const x0 = gx * S;
        let sMean = 0;
        let sGrad = 0;
        let mMax = gmax[gi];
        for (let dx = 0; dx < S; dx++) {
          const x = x0 + dx;
          const xl = x > 0 ? x - 1 : x;
          const xr = x < width - 1 ? x + 1 : x;
          const ddx = (gray[row + xr] - gray[row + xl]) * (xr - xl === 2 ? 0.5 : 1);
          const ddy = (gray[dn + x] - gray[up + x]) * yScale;
          const m = Math.sqrt(ddx * ddx + ddy * ddy);
          sMean += gray[row + x];
          sGrad += m;
          if (m > mMax) mMax = m;
        }
        mean[gi] += sMean;
        grad[gi] += sGrad;
        gmax[gi] = mMax;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    mean[i] *= inv;
    grad[i] *= inv;
  }
  return { gw, gh, S, mean, grad, gmax };
}

/** In-place-safe separable box blur (radius r, edge-normalised). */
export function boxBlur(src, w, h, r) {
  if (r <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let cnt = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) { sum += src[row + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / cnt;
      const add = x + r + 1;
      const rem = x - r;
      if (add < w) { sum += src[row + add]; cnt++; }
      if (rem >= 0) { sum -= src[row + rem]; cnt--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let cnt = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) { sum += tmp[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / cnt;
      const add = y + r + 1;
      const rem = y - r;
      if (add < h) { sum += tmp[add * w + x]; cnt++; }
      if (rem >= 0) { sum -= tmp[rem * w + x]; cnt--; }
    }
  }
  return out;
}

/** Approximate Gaussian blur (three box passes). */
export function gaussBlur(src, w, h, sigma) {
  if (sigma <= 0) return Float32Array.from(src);
  // Box radius for 3 passes that matches the requested sigma.
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}

/**
 * Texture map used by both engines: log2 of the smoothed mean gradient.
 * Roughly 0–1 for empty plastic, 2–3 for burnt/dead layers, 3.5–5.5 for cells.
 */
export function textureMap(grad, w, h, sigma = 2) {
  const sm = gaussBlur(grad, w, h, sigma);
  const out = new Float32Array(sm.length);
  for (let i = 0; i < sm.length; i++) out[i] = Math.log2(sm[i] + 0.5);
  return out;
}
