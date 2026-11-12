// Image decoding inside a worker: File → RGBA pixels / preview bitmap.

import { tiffToRgba, isTiff } from './tiff.js';

let utifPromise = null;

/** UTIF.js and pako are classic scripts; evaluate them once in this worker. */
function loadUtif() {
  if (!utifPromise) {
    utifPromise = (async () => {
      for (const name of ['pako_inflate.min.js', 'UTIF.js']) {
        const res = await fetch(new URL(`../vendor/${name}`, import.meta.url));
        if (!res.ok) throw new Error(`Could not load ${name}`);
        (0, eval)(await res.text()); // indirect eval → runs in the worker's global scope
      }
      return self.UTIF;
    })();
    utifPromise.catch(() => { utifPromise = null; });
  }
  return utifPromise;
}

/** @returns {Promise<{data:Uint8ClampedArray, width:number, height:number}>} */
export async function decodeToRgba(file) {
  if (isTiff(file)) {
    const UTIF = await loadUtif();
    return tiffToRgba(await file.arrayBuffer(), UTIF);
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data: img.data, width: img.width, height: img.height };
  } finally {
    bitmap.close();
  }
}

/** Downscaled bitmap for display (longest side ≤ maxSize). */
export async function previewBitmap(file, maxSize) {
  let source;
  let width;
  let height;
  if (isTiff(file)) {
    const img = await decodeToRgba(file);
    source = new ImageData(img.data, img.width, img.height);
    width = img.width;
    height = img.height;
  } else {
    source = await createImageBitmap(file);
    width = source.width;
    height = source.height;
  }
  const scale = Math.min(1, maxSize / Math.max(width, height));
  if (scale === 1 && source instanceof ImageBitmap) return { bitmap: source, width, height };
  const bitmap = await createImageBitmap(source, {
    resizeWidth: Math.max(1, Math.round(width * scale)),
    resizeHeight: Math.max(1, Math.round(height * scale)),
    resizeQuality: 'high',
  });
  if (source instanceof ImageBitmap) source.close();
  return { bitmap, width, height };
}
