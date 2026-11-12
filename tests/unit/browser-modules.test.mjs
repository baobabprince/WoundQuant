// Browser-side modules that have no DOM dependency at import time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ZipWriter, crc32 } from '../../js/zip.js';
import { tiffToRgba, isTiff } from '../../js/tiff.js';
import { I18N_KEYS } from '../../js/i18n.js';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);

test('zip: stored archive with a valid directory and checksums', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = new ZipWriter();
  zip.add('a/hello.txt', 'hello');
  zip.add('תיקייה/b.bin', new Uint8Array([1, 2, 3, 4]));
  const bytes = new Uint8Array(await zip.finish().arrayBuffer());
  const view = new DataView(bytes.buffer);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), 2);
  let p = view.getUint32(eocd + 16, true);
  const names = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    names.push(name);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    assert.equal(crc32(bytes.subarray(dataStart, dataStart + size)), view.getUint32(p + 16, true));
    p += 46 + nameLen;
  }
  assert.deepEqual(names, ['a/hello.txt', 'תיקייה/b.bin']);
});

test('tiff: 8-bit RGBA and 16-bit greyscale with range stretching', () => {
  const UTIF = require('utif');
  // 8-bit RGBA written by UTIF itself
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]);
  const out8 = tiffToRgba(UTIF.encodeImage(rgba, 2, 2), UTIF);
  assert.equal(out8.width, 2);
  assert.deepEqual([...out8.data], [...rgba]);

  // 16-bit greyscale, little-endian, uncompressed, values 1000…3000
  const w = 64;
  const h = 64;
  const pixels = new Uint16Array(w * h);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 1000 + Math.round((2000 * i) / (pixels.length - 1));
  const entries = [[256, 3, w], [257, 3, h], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 3, h], [279, 4, pixels.byteLength]];
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataOffset = 8 + ifdSize;
  const buf = new ArrayBuffer(dataOffset + pixels.byteLength);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, value], i) => {
    const o = 10 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, 1, true);
    if (tag === 273) dv.setUint32(o + 8, dataOffset, true);
    else if (type === 3) dv.setUint16(o + 8, value, true);
    else dv.setUint32(o + 8, value, true);
  });
  new Uint8Array(buf, dataOffset).set(new Uint8Array(pixels.buffer));
  const out16 = tiffToRgba(buf, UTIF);
  assert.equal(out16.width, w);
  assert.equal(out16.height, h);
  assert.ok(out16.data[0] <= 2, `darkest ${out16.data[0]}`);
  assert.ok(out16.data[(w * h - 1) * 4] >= 253, `brightest ${out16.data[(w * h - 1) * 4]}`);
  const mid = out16.data[(w * h >> 1) * 4];
  assert.ok(mid > 110 && mid < 145, `mid ${mid}`);

  assert.ok(isTiff({ name: 'a.TIF', type: '' }));
  assert.ok(isTiff({ name: 'a', type: 'image/tiff' }));
  assert.ok(!isTiff({ name: 'a.jpg', type: 'image/jpeg' }));
});

test('i18n: Hebrew and English have the same keys, and every key used exists', () => {
  const he = new Set(I18N_KEYS.he);
  const en = new Set(I18N_KEYS.en);
  assert.deepEqual([...he].filter((k) => !en.has(k)), [], 'keys missing in English');
  assert.deepEqual([...en].filter((k) => !he.has(k)), [], 'keys missing in Hebrew');
  const html = fs.readFileSync(new URL('index.html', root), 'utf8');
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);
  for (const f of fs.readdirSync(new URL('js/', root)).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(new URL('js/' + f, root), 'utf8');
    for (const m of src.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) if (!m[1].endsWith('_')) used.add(m[1]);
  }
  assert.ok(used.size > 80);
  assert.deepEqual([...used].filter((k) => !en.has(k)), [], 'keys used but not defined');
});

test('page: every element id the scripts ask for exists in index.html', () => {
  const html = fs.readFileSync(new URL('index.html', root), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const main = fs.readFileSync(new URL('js/main.js', root), 'utf8');
  const asked = new Set([...main.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.deepEqual([...asked].filter((id) => !ids.has(id)), []);
});
