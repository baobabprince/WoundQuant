// TIFF decoding on top of UTIF.js, with proper handling of 16-bit greyscale
// (microscope cameras): the intensity range actually used is stretched to
// 8 bit instead of just dropping the low byte.

/**
 * @param {ArrayBuffer} buffer
 * @param {object} UTIF  the UTIF.js namespace
 * @returns {{data:Uint8ClampedArray, width:number, height:number}}
 */
export function tiffToRgba(buffer, UTIF) {
  const ifds = UTIF.decode(buffer);
  if (!ifds.length) throw new Error('TIFF has no image');
  // Pick the largest page (files often carry a thumbnail as well).
  let ifd = null;
  let bestArea = -1;
  for (const d of ifds) {
    const w = d.t256 ? d.t256[0] : 0;
    const h = d.t257 ? d.t257[0] : 0;
    if (w * h > bestArea) { bestArea = w * h; ifd = d; }
  }
  UTIF.decodeImage(buffer, ifd, ifds);
  const width = ifd.width;
  const height = ifd.height;
  if (!width || !height || !ifd.data) throw new Error('TIFF could not be decoded');

  const bps = ifd.t258 ? ifd.t258[0] : 1;
  const samples = ifd.t277 ? ifd.t277[0] : 1;
  const photometric = ifd.t262 ? ifd.t262[0] : 1;
  if (bps === 16 && samples === 1 && photometric <= 1) {
    // UTIF leaves 16-bit samples little-endian after decoding.
    const n = width * height;
    const bytes = ifd.data;
    const values = new Uint16Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 2) values[i] = bytes[j] | (bytes[j + 1] << 8);
    const hist = new Uint32Array(65536);
    for (let i = 0; i < n; i++) hist[values[i]]++;
    const loCount = n * 0.001;
    const hiCount = n * 0.999;
    let lo = 0;
    let hi = 65535;
    let acc = 0;
    let loSet = false;
    for (let v = 0; v < 65536; v++) {
      acc += hist[v];
      if (!loSet && acc > loCount) { lo = v; loSet = true; }
      if (acc >= hiCount) { hi = v; break; }
    }
    if (hi <= lo) hi = lo + 1;
    const scale = 255 / (hi - lo);
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let g = (values[i] - lo) * scale;
      if (photometric === 0) g = 255 - g; // WhiteIsZero
      data[j] = data[j + 1] = data[j + 2] = g;
      data[j + 3] = 255;
    }
    return { data, width, height };
  }
  const rgba = UTIF.toRGBA8(ifd);
  return { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height };
}

export function isTiff(file) {
  return /\.tiff?$/i.test(file.name || '') || file.type === 'image/tiff';
}
