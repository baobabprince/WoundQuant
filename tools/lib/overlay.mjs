// Draw the analysis result over the (reduced) image — Node-side preview.
import { LABEL } from '../../js/core/segment.js';

export function renderOverlay(prep, labels, size = 800) {
  const { gw, gh, mean } = prep;
  const scale = size / Math.max(gw, gh);
  const W = Math.round(gw * scale);
  const H = Math.round(gh * scale);
  const data = new Uint8Array(W * H * 4);
  const at = (x, y) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : labels[y * gw + x]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / scale));
      const gy = Math.min(gh - 1, Math.floor(y / scale));
      const l = at(gx, gy);
      const v = mean[gy * gw + gx];
      let r = v, g = v, b = v;
      const edge = (cls) => l === cls && (at(gx - 1, gy) !== cls || at(gx + 1, gy) !== cls || at(gx, gy - 1) !== cls || at(gx, gy + 1) !== cls);
      if (l === LABEL.OUTSIDE) { r *= 0.45; g *= 0.45; b *= 0.45; }
      else if (edge(LABEL.WOUND)) { r = 255; g = 45; b = 45; }
      else if (l === LABEL.WOUND) { r = r * 0.72 + 70; g *= 0.78; b *= 0.78; }
      else if (edge(LABEL.FREE)) { r = 250; g = 190; b = 20; }
      const q = (y * W + x) * 4;
      data[q] = r; data[q + 1] = g; data[q + 2] = b; data[q + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}
