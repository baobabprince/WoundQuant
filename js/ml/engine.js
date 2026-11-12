// Neural engine (worker side): runs an ONNX model with ONNX Runtime Web
// (WebAssembly). The runtime is loaded only when a model is actually used.

import { modelInput, rawMaskFromLogits } from '../core/pipeline.js';

let ortPromise = null;
let session = null;
let sessionKey = null;

function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('../../vendor/ort/ort.wasm.min.mjs').then((ort) => {
      ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
      // Threads need cross-origin isolation, which static hosts such as GitHub
      // Pages do not provide; parallelism comes from the worker pool instead.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.logLevel = 'error';
      return ort;
    });
    ortPromise.catch(() => { ortPromise = null; });
  }
  return ortPromise;
}

/**
 * Prepare a model. `key` identifies it so repeated jobs reuse the session.
 * @param {string} key
 * @param {ArrayBuffer} bytes  contents of the .onnx file
 */
export async function useModel(key, bytes) {
  if (session && sessionKey === key) return;
  const ort = await loadOrt();
  if (session) { try { await session.release(); } catch { /* ignore */ } session = null; }
  const created = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  if (created.inputNames.length !== 1 || created.outputNames.length < 1) {
    throw new Error('Model must have exactly one input and one output');
  }
  session = created;
  sessionKey = key;
}

export function hasModel(key) {
  return !!session && sessionKey === key;
}

/** Run the model on a prepared image → raw cell-free mask on the grid. */
export async function inferRawMask(prep) {
  if (!session) throw new Error('No model loaded');
  const ort = await loadOrt();
  const input = modelInput(prep, 32);
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input.data, input.dims) };
  const out = await session.run(feeds);
  const logits = out[session.outputNames[0]];
  const dims = logits.dims;
  if (dims[dims.length - 1] !== input.width || dims[dims.length - 2] !== input.height) {
    throw new Error(`Model output is ${dims.join('×')}, expected …×${input.height}×${input.width}`);
  }
  return rawMaskFromLogits(logits.data, input.width, prep, 0);
}
