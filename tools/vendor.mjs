#!/usr/bin/env node
// Copy the browser libraries from node_modules into vendor/ so the site has
// no CDN dependency (works offline and on locked-down lab networks).
// Run after upgrading a dependency:  npm install && npm run vendor
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  ['chart.js/dist/chart.umd.min.js', 'vendor/chart.umd.min.js'],
  ['utif/UTIF.js', 'vendor/UTIF.js'],
  ['pako/dist/pako_inflate.min.js', 'vendor/pako_inflate.min.js'],
  ['onnxruntime-web/dist/ort.wasm.min.mjs', 'vendor/ort/ort.wasm.min.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'vendor/ort/ort-wasm-simd-threaded.wasm'],
];
const versions = {};
for (const [from, to] of copies) {
  const src = path.join(root, 'node_modules', from);
  const dst = path.join(root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const pkg = from.split('/')[0];
  versions[pkg] = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  console.log(`${to}  (${(fs.statSync(dst).size / 1024).toFixed(0)} kB)`);
}
fs.writeFileSync(path.join(root, 'vendor/VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
