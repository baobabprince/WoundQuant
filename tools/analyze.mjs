#!/usr/bin/env node
// Batch analysis from the command line with the same code as the web app.
//
//   node tools/analyze.mjs <folder> [--csv out.csv] [--overlays dir]
//                                   [--pixel-size 2.825] [--params '{"sensitivity":0.2}']
//
// Only the classical engine is available here; the neural engine runs in the browser.

import fs from 'node:fs';
import path from 'node:path';
import { readImage, listImages, writeJpeg } from './lib/io.mjs';
import { analyzeClassical } from '../js/core/pipeline.js';
import { groupIntoSeries } from '../js/core/naming.js';
import { seriesMetrics } from '../js/core/metrics.js';
import { buildCsv } from '../js/core/csv.js';
import { renderOverlay } from './lib/overlay.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args._[0]) {
  console.error('usage: node tools/analyze.mjs <folder> [--csv out.csv] [--overlays dir] [--pixel-size um] [--params json]');
  process.exit(2);
}
const root = path.resolve(args._[0]);
const params = args.params ? JSON.parse(args.params) : {};
const pixelSize = args['pixel-size'] ? Number(args['pixel-size']) : null;

const files = listImages(root).map((p) => ({ path: p, name: path.basename(p), dir: path.relative(root, path.dirname(p)) }));
const series = groupIntoSeries(files);
console.error(`${files.length} images in ${series.length} series`);

const analysed = [];
for (const s of series) {
  const points = [];
  for (const item of s.items) {
    const t0 = performance.now();
    const img = await readImage(item.file.path);
    const { prep, result } = analyzeClassical(img.data, img.width, img.height, params);
    if (args.overlays) {
      const o = renderOverlay(prep, result.labels, 800);
      writeJpeg(path.join(path.resolve(args.overlays), item.file.dir, item.file.name.replace(/\.[^.]+$/, '') + '_overlay.jpg'), o.data, o.width, o.height, 88);
    }
    points.push({ time: item.time, hours: item.hours, result, fileName: item.file.name });
    console.error(`  ${item.file.name}  wound ${(100 * result.counts.wound / Math.max(1, result.counts.well)).toFixed(1)}%  ${result.qc.join(',') || 'ok'}  (${Math.round(performance.now() - t0)} ms)`);
  }
  analysed.push({ series: s, metrics: seriesMetrics(points, pixelSize), points });
}

const csv = buildCsv(analysed.map((a) => ({
  label: a.series.label, plate: a.series.plate, well: a.series.well, site: a.series.site, timeUnit: a.series.timeUnit,
  rows: a.metrics.points.map((p, i) => ({ ...p, fileName: a.points[i].fileName })),
})), { pixelSizeUm: pixelSize });
if (args.csv) { fs.writeFileSync(args.csv, csv); console.error(`wrote ${args.csv}`); } else process.stdout.write(csv);
