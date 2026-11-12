#!/usr/bin/env node
// Build a training set from a folder of images, labelled by the classical
// engine ("pseudo-labels"). Use it to bootstrap a model before hand-corrected
// masks exist; corrected masks are exported from the web app in the same format.
//
//   node tools/export-dataset.mjs <image-folder> <out-folder> [--params json] [--skip-flagged]

import fs from 'node:fs';
import path from 'node:path';
import { readImage, listImages, writePng } from './lib/io.mjs';
import { analyzeClassical, PIPELINE_VERSION } from '../js/core/pipeline.js';
import { parseFileName } from '../js/core/naming.js';
import { sampleImageRgba, sampleLabelGrey, sampleId } from '../js/core/dataset.js';

const argv = process.argv.slice(2);
const pos = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--params');
if (pos.length < 2) {
  console.error('usage: node tools/export-dataset.mjs <image-folder> <out-folder> [--params json] [--skip-flagged]');
  process.exit(2);
}
const [src, dst] = pos.map((p) => path.resolve(p));
const params = argv.includes('--params') ? JSON.parse(argv[argv.indexOf('--params') + 1]) : {};
const skipFlagged = argv.includes('--skip-flagged');

fs.mkdirSync(dst, { recursive: true });
const meta = [];
let index = 0;
for (const file of listImages(src)) {
  const name = path.basename(file);
  const img = await readImage(file);
  const { prep, result } = analyzeClassical(img.data, img.width, img.height, params);
  if (skipFlagged && result.qc.length) { console.error(`skip ${name} (${result.qc.join(',')})`); continue; }
  const id = sampleId(index++, name);
  writePng(path.join(dst, 'images', id + '.png'), sampleImageRgba(prep), prep.gw, prep.gh, 4);
  writePng(path.join(dst, 'labels', id + '.png'), sampleLabelGrey(result.labels), prep.gw, prep.gh, 1);
  const info = parseFileName(name, path.relative(src, path.dirname(file)));
  meta.push({ id, file: name, series: info.seriesKey, well: info.well, hours: info.hours, source: 'auto',
    engine: 'classical', qc: result.qc, width: img.width, height: img.height, grid: [prep.gw, prep.gh], block: prep.S,
    pipeline: PIPELINE_VERSION });
  console.error(`${id}  ${result.qc.join(',') || 'ok'}`);
}
fs.writeFileSync(path.join(dst, 'meta.jsonl'), meta.map((m) => JSON.stringify(m)).join('\n') + '\n');
console.error(`${meta.length} samples → ${dst}`);
