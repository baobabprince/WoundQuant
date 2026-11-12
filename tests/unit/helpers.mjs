// Synthetic whole-well images for tests: textured "cells", a smooth round
// "wound", black outside the circular field of view.

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{size?:number, wellRadius?:number|null, woundRadius?:number, woundX?:number, woundY?:number, seed?:number}} o
 *   wellRadius null → the cells fill the whole frame (no dark surround)
 * @returns {{data:Uint8ClampedArray, width:number, height:number}}
 */
export function syntheticWell(o = {}) {
  const size = o.size ?? 1200;
  const wellRadius = o.wellRadius === undefined ? size * 0.47 : o.wellRadius;
  const woundRadius = o.woundRadius ?? size * 0.15;
  const cx = size / 2;
  const cy = size / 2;
  const wx = o.woundX ?? cx;
  const wy = o.woundY ?? cy;
  const rand = rng(o.seed ?? 1);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let g;
      const inWell = wellRadius === null || Math.hypot(x - cx, y - cy) <= wellRadius;
      if (!inWell) g = 2 + rand() * 2;
      else if (Math.hypot(x - wx, y - wy) <= woundRadius) g = 128 + (rand() - 0.5) * 2; // smooth plastic
      else g = 128 + (rand() - 0.5) * 90; // cell texture
      const p = (y * size + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = g;
      data[p + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}
