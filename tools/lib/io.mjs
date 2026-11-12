// Node-side image IO for the CLI tools and tests (the browser uses canvas).
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export const IMAGE_EXT = /\.(jpe?g|png|tiff?)$/i;

/** Decode an image file to { data: Uint8Array RGBA, width, height }. */
export async function readImage(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 400 });
    return { data: img.data, width: img.width, height: img.height };
  }
  if (ext === '.png') {
    const img = PNG.sync.read(buf);
    return { data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height };
  }
  if (ext === '.tif' || ext === '.tiff') {
    const { default: UTIF } = await import('utif');
    const ifds = UTIF.decode(buf);
    UTIF.decodeImage(buf, ifds[0]);
    return { data: UTIF.toRGBA8(ifds[0]), width: ifds[0].width, height: ifds[0].height };
  }
  throw new Error(`Unsupported image type: ${file}`);
}

/** Write RGBA or single-channel data as PNG. */
export function writePng(file, data, width, height, channels = 4) {
  const png = new PNG({ width, height });
  if (channels === 4) {
    png.data.set(data);
  } else {
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      png.data[j] = png.data[j + 1] = png.data[j + 2] = data[i];
      png.data[j + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png, channels === 1 ? { colorType: 0, inputColorType: 6 } : {}));
}

export function writeJpeg(file, rgba, width, height, quality = 85) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jpeg.encode({ data: rgba, width, height }, quality).data);
}

/** Recursively list image files below a directory (sorted). */
export function listImages(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (IMAGE_EXT.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
