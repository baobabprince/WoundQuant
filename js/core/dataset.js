// Training-sample encoding shared by the web app export and the Node tool.
//
// One sample = two small images on the analysis grid:
//   images/<id>.png  RGB   R = block-mean grey, G = texture, B = texture relative
//                          to the well's dense-cell level; all 0 outside the growth area
//   labels/<id>.png  grey  0 outside · 85 cells · 170 cell-free · 255 wound
// The RGB image is byte-for-byte what the network sees at inference time
// (see pipeline.modelInput), so training needs no image processing of its own.

import { featureBytes } from './pipeline.js';

export const LABEL_GREY = Object.freeze([0, 85, 170, 255]);

/** @returns {Uint8Array} RGBA pixels (gw × gh) of the network-input image. */
export function sampleImageRgba(prep) {
  const n = prep.gw * prep.gh;
  const out = new Uint8Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    featureBytes(prep, i, out, j);
    out[j + 3] = 255;
  }
  return out;
}

/** @returns {Uint8Array} one byte per grid cell. */
export function sampleLabelGrey(labels) {
  const out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = LABEL_GREY[labels[i] & 3];
  return out;
}

/** Safe, unique file stem for a sample. */
export function sampleId(index, fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `${String(index).padStart(5, '0')}_${stem}`;
}
