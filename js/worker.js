// Analysis worker. One job at a time; the pool (pool.js) runs several workers.
//
// Messages in   { id, type, ... }
//   analyze   file, params, engine{kind, key}           → result (compact)
//   model     key, bytes                                → loads the ONNX model
//   preview   file, maxSize                             → ImageBitmap
//   sample    file, params, rle?, gw?, gh?              → PNGs for the training set
// Messages out  { id, ok, ... } or { id, ok:false, error }

import { decodeToRgba, previewBitmap } from './decode.js';
import { prepare, classicalRawMask, buildResult, LABEL } from './core/pipeline.js';
import { sampleImageRgba, sampleLabelGrey } from './core/dataset.js';
import { rleDecode } from './core/rle.js';

let engineModule = null;
const loadEngine = () => (engineModule ||= import('./ml/engine.js'));

async function analyze(msg) {
  const t0 = performance.now();
  const img = await decodeToRgba(msg.file);
  const t1 = performance.now();
  const prep = prepare(img.data, img.width, img.height, msg.params);
  let raw;
  let info = {};
  let engineId = 'classical';
  if (msg.engine && msg.engine.kind === 'model') {
    const engine = await loadEngine();
    if (!engine.hasModel(msg.engine.key)) throw new Error('MODEL_NOT_LOADED');
    raw = await engine.inferRawMask(prep);
    engineId = 'model:' + msg.engine.key;
  } else {
    const c = classicalRawMask(prep);
    raw = c.raw;
    info = { threshold: c.threshold };
  }
  const result = buildResult(prep, raw, engineId, info);
  delete result.labels; // the run-length form is all the main thread keeps
  const t2 = performance.now();
  return { payload: { result, timing: { decode: t1 - t0, analyse: t2 - t1 } }, transfer: [result.rle.buffer] };
}

async function pngBytes(rgba, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

async function sample(msg) {
  const img = await decodeToRgba(msg.file);
  const prep = prepare(img.data, img.width, img.height, msg.params);
  let labels;
  if (msg.rle && msg.gw === prep.gw && msg.gh === prep.gh) {
    labels = rleDecode(msg.rle, prep.gw * prep.gh);
    // The growth area may have been detected with another rim margin when the
    // mask was made; the exported label must agree with the exported image.
    for (let i = 0; i < labels.length; i++) {
      if (!prep.well.mask[i]) labels[i] = LABEL.OUTSIDE;
      else if (labels[i] === LABEL.OUTSIDE) labels[i] = LABEL.CELLS;
    }
  } else {
    const c = classicalRawMask(prep);
    labels = buildResult(prep, c.raw, 'classical', { threshold: c.threshold }).labels;
  }
  const grey = sampleLabelGrey(labels);
  const greyRgba = new Uint8Array(grey.length * 4);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
    greyRgba[j] = greyRgba[j + 1] = greyRgba[j + 2] = grey[i];
    greyRgba[j + 3] = 255;
  }
  const image = await pngBytes(sampleImageRgba(prep), prep.gw, prep.gh);
  const label = await pngBytes(greyRgba, prep.gw, prep.gh);
  return { payload: { image, label, gw: prep.gw, gh: prep.gh, S: prep.S, width: img.width, height: img.height }, transfer: [image, label] };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    let out;
    if (msg.type === 'analyze') out = await analyze(msg);
    else if (msg.type === 'sample') out = await sample(msg);
    else if (msg.type === 'model') {
      const engine = await loadEngine();
      await engine.useModel(msg.key, msg.bytes);
      out = { payload: {}, transfer: [] };
    } else if (msg.type === 'preview') {
      const p = await previewBitmap(msg.file, msg.maxSize || 1600);
      out = { payload: p, transfer: [p.bitmap] };
    } else if (msg.type === 'ping') {
      out = { payload: { offscreen: typeof OffscreenCanvas !== 'undefined' }, transfer: [] };
    } else throw new Error('Unknown job type: ' + msg.type);
    self.postMessage({ id: msg.id, ok: true, ...out.payload }, out.transfer);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
