// Run-length coding of label maps (values 0–3) so thousands of masks fit in
// memory / IndexedDB. Each Uint32 entry packs (runLength << 2) | value.

const MAX_RUN = 0x3fffffff;

export function rleEncode(labels) {
  const runs = [];
  const n = labels.length;
  let i = 0;
  while (i < n) {
    const v = labels[i] & 3;
    let j = i + 1;
    while (j < n && (labels[j] & 3) === v && j - i < MAX_RUN) j++;
    runs.push(((j - i) << 2) | v);
    i = j;
  }
  return Uint32Array.from(runs);
}

export function rleDecode(runs, length) {
  const out = new Uint8Array(length);
  let p = 0;
  for (let k = 0; k < runs.length; k++) {
    const v = runs[k] & 3;
    const len = runs[k] >>> 2;
    if (v) out.fill(v, p, p + len);
    p += len;
  }
  if (p !== length) throw new Error(`RLE length mismatch: ${p} != ${length}`);
  return out;
}
