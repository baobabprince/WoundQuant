import test from 'node:test';
import assert from 'node:assert/strict';
import { rleEncode, rleDecode } from '../../js/core/rle.js';
import { open, fillHoles, labelComponents, countMask } from '../../js/core/morph.js';
import { analyzeClassical, prepare, modelInput, rawMaskFromLogits, buildResult, summarizeLabels, normalizeParams, paramsKey, featureBytes, LABEL } from '../../js/core/pipeline.js';
import { seriesMetrics, imageMetrics, slope } from '../../js/core/metrics.js';
import { buildCsv, CSV_COLUMNS } from '../../js/core/csv.js';
import { sampleImageRgba, sampleLabelGrey, LABEL_GREY } from '../../js/core/dataset.js';
import { syntheticWell, rng } from './helpers.mjs';

test('rle: round trip, including long runs', () => {
  const rand = rng(7);
  const labels = new Uint8Array(100000);
  for (let i = 0; i < labels.length;) {
    const v = Math.floor(rand() * 4);
    const len = 1 + Math.floor(rand() * 400);
    labels.fill(v, i, Math.min(labels.length, i + len));
    i += len;
  }
  const runs = rleEncode(labels);
  assert.ok(runs.length < labels.length / 50, 'compresses');
  assert.deepEqual(rleDecode(runs, labels.length), labels);
  assert.throws(() => rleDecode(runs, labels.length + 1), /length mismatch/);
  assert.equal(rleEncode(new Uint8Array(0)).length, 0);
});

test('morphology: opening removes specks, fillHoles respects the size limit', () => {
  const w = 40;
  const h = 40;
  const m = new Uint8Array(w * h);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) m[y * w + x] = 1;
  m[2 * w + 2] = 1; // speck
  const opened = open(m, w, h, 2);
  assert.equal(opened[2 * w + 2], 0);
  assert.equal(opened[20 * w + 20], 1);
  // punch a 3×3 and a 1×1 hole
  for (let y = 14; y < 17; y++) for (let x = 14; x < 17; x++) m[y * w + x] = 0;
  m[24 * w + 24] = 0;
  const small = fillHoles(m, w, h, 4);
  assert.equal(small[24 * w + 24], 1);
  assert.equal(small[15 * w + 15], 0);
  const all = fillHoles(m, w, h);
  assert.equal(all[15 * w + 15], 1);
  assert.equal(labelComponents(m, w, h).count, 2);
  assert.equal(countMask(all), 401);
});

test('pipeline: finds the round field and the wound in a synthetic well', () => {
  const size = 1200;
  const img = syntheticWell({ size, wellRadius: 560, woundRadius: 180 });
  const { result } = analyzeClassical(img.data, img.width, img.height);
  assert.equal(result.well.kind, 'circle');
  assert.equal(result.S, 2);
  const m = imageMetrics(result, 2);
  const wellTrue = Math.PI * (560 * 0.97) ** 2; // default rim margin 3 %
  const woundTrue = Math.PI * 180 ** 2;
  assert.ok(Math.abs(m.wellAreaPx / wellTrue - 1) < 0.04, `well area ${m.wellAreaPx} vs ${wellTrue}`);
  assert.ok(Math.abs(m.woundAreaPx / woundTrue - 1) < 0.08, `wound area ${m.woundAreaPx} vs ${woundTrue}`);
  assert.ok(Math.abs(m.woundAreaMm2 - m.woundAreaPx * 4e-6) < 1e-9);
  assert.deepEqual(result.qc, []);
  // the compact form holds the same mask
  assert.deepEqual(rleDecode(result.rle, result.gw * result.gh), result.labels);
  const s = summarizeLabels(result.labels, result.gw, result.gh, { wellKind: 'circle' });
  assert.deepEqual(s.counts, result.counts);
});

test('pipeline: a frame filled with cells uses the whole image as growth area', () => {
  const img = syntheticWell({ size: 800, wellRadius: null, woundRadius: 120 });
  const { result } = analyzeClassical(img.data, img.width, img.height);
  assert.equal(result.well.kind, 'frame');
  const m = imageMetrics(result);
  assert.ok(m.wellAreaPx > 0.9 * 800 * 800);
  assert.ok(Math.abs(m.woundAreaPx / (Math.PI * 120 ** 2) - 1) < 0.1, `wound ${m.woundAreaPx}`);
});

test('pipeline: no wound and wound-at-rim are flagged', () => {
  const none = syntheticWell({ size: 800, wellRadius: 370, woundRadius: 0 });
  const r0 = analyzeClassical(none.data, none.width, none.height).result;
  assert.equal(r0.counts.wound, 0);
  assert.ok(r0.qc.includes('no_wound'));
  const rim = syntheticWell({ size: 800, wellRadius: 370, woundRadius: 120, woundX: 400 + 300 });
  const r1 = analyzeClassical(rim.data, rim.width, rim.height).result;
  assert.ok(r1.counts.wound > 0);
  assert.ok(r1.qc.includes('wound_at_rim'), r1.qc.join(','));
});

test('pipeline: sensitivity and parameters', () => {
  assert.equal(normalizeParams({ woundMode: 'nonsense', sensitivity: 'abc' }).woundMode, 'largest');
  assert.equal(normalizeParams({ sensitivity: 'abc' }).sensitivity, 0);
  assert.notEqual(paramsKey({ sensitivity: 0.5 }), paramsKey({}));
  assert.notEqual(paramsKey({}, 'model:x'), paramsKey({}, 'classical'));
  assert.equal(paramsKey({}), paramsKey(normalizeParams({})));
});

test('model input: four planes, padded, and a perfect "network" reproduces the mask', () => {
  const img = syntheticWell({ size: 1200, wellRadius: 560, woundRadius: 180 });
  const { prep, result } = analyzeClassical(img.data, img.width, img.height);
  const input = modelInput(prep, 32);
  assert.deepEqual(input.dims, [1, 4, 608, 608]);
  assert.equal(input.data.length, 4 * 608 * 608);
  const plane = 608 * 608;
  // plane 3 is the growth-area mask; everything is zero outside it
  let inside = 0;
  for (let y = 0; y < prep.gh; y++) {
    for (let x = 0; x < prep.gw; x++) {
      const v = input.data[3 * plane + y * 608 + x];
      assert.equal(v, prep.well.mask[y * prep.gw + x]);
      if (v) inside++; else assert.equal(input.data[y * 608 + x], 0);
    }
  }
  assert.equal(inside, prep.well.area);
  // feature bytes match what the dataset exporter writes
  const bytes = new Uint8Array(3);
  const rgba = sampleImageRgba(prep);
  const centre = (prep.gh >> 1) * prep.gw + (prep.gw >> 1);
  featureBytes(prep, centre, bytes, 0);
  assert.deepEqual([...rgba.slice(centre * 4, centre * 4 + 3)], [...bytes]);
  assert.ok(Math.abs(input.data[(prep.gh >> 1) * 608 + (prep.gw >> 1)] - bytes[0] / 255) < 1e-6);
  // logits that say "cell-free" exactly where the classical mask does
  const logits = new Float32Array(plane).fill(-5);
  for (let y = 0; y < prep.gh; y++) for (let x = 0; x < prep.gw; x++) if (result.labels[y * prep.gw + x] >= LABEL.FREE) logits[y * 608 + x] = 5;
  const viaModel = buildResult(prep, rawMaskFromLogits(logits, 608, prep, 0), 'model:test');
  assert.equal(viaModel.engine, 'model:test');
  assert.ok(Math.abs(viaModel.counts.wound / result.counts.wound - 1) < 0.01);
  // label PNG coding
  assert.deepEqual([...sampleLabelGrey(Uint8Array.from([0, 1, 2, 3]))], [...LABEL_GREY]);
});

test('series metrics: closure, rate, T50 and the wound-grew flag', () => {
  const radii = [180, 150, 100, 40];
  const hours = [0, 24, 48, 72];
  const points = radii.map((r, i) => {
    const img = syntheticWell({ size: 800, wellRadius: 370, woundRadius: r, seed: i + 1 });
    return { time: hours[i], hours: hours[i], result: analyzeClassical(img.data, img.width, img.height).result };
  });
  const { points: rows, summary } = seriesMetrics(points, 1);
  assert.equal(rows[0].closurePct, 0);
  radii.forEach((r, i) => {
    const expected = 100 * (1 - (r * r) / (180 * 180));
    assert.ok(Math.abs(rows[i].closurePct - expected) < 6, `t${i}: ${rows[i].closurePct} vs ${expected}`);
    assert.ok(Math.abs(rows[i].t0RegionClosurePct - expected) < 6, `t0 region t${i}: ${rows[i].t0RegionClosurePct}`);
  });
  assert.ok(rows[1].ratePctPerH > 0);

  // wound area at time 0 and its drop over time
  const a0 = rows[0].woundAreaPx;
  assert.ok(Math.abs(a0 / (Math.PI * 180 * 180) - 1) < 0.08, `time-0 area ${a0}`);
  rows.forEach((row, i) => {
    assert.equal(row.woundAreaT0Px, a0, 'every row carries the time-0 area');
    assert.equal(row.areaReductionPx, a0 - row.woundAreaPx);
    assert.ok(Math.abs(row.areaReductionPct - 100 * (1 - row.woundAreaPx / a0)) < 1e-9);
    assert.ok(Math.abs(row.areaReductionPct - 100 * (1 - (radii[i] * radii[i]) / (180 * 180))) < 6, `drop t${i}: ${row.areaReductionPct}`);
    // pixel size 1 µm → mm² = px · 1e-6
    assert.ok(Math.abs(row.woundAreaT0Mm2 - a0 * 1e-6) < 1e-12);
    assert.ok(Math.abs(row.areaReductionMm2 - row.areaReductionPx * 1e-6) < 1e-12);
  });
  assert.equal(rows[0].areaReductionPct, 0);
  assert.ok(rows[3].areaReductionPct > rows[2].areaReductionPct && rows[2].areaReductionPct > rows[1].areaReductionPct);
  assert.equal(summary.baselineWoundAreaPx, a0);
  assert.equal(summary.finalWoundAreaPx, rows[3].woundAreaPx);
  assert.equal(summary.finalAreaReductionPx, a0 - rows[3].woundAreaPx);
  assert.equal(summary.finalAreaReductionPct, rows[3].areaReductionPct);
  assert.ok(Math.abs(summary.finalAreaReductionMm2 - (a0 - rows[3].woundAreaPx) * 1e-6) < 1e-12);

  assert.equal(summary.n, 4);
  assert.equal(summary.analysed, 4);
  assert.ok(summary.finalClosurePct > 90);
  assert.ok(summary.t50Hours > 24 && summary.t50Hours < 48, `t50 ${summary.t50Hours}`);
  assert.equal(summary.flagged, 0);

  // reversed order: the wound grows → negative closure + flag
  const grown = seriesMetrics(points.slice().reverse().map((p, i) => ({ ...p, time: hours[i], hours: hours[i] })));
  assert.ok(grown.summary.finalClosurePct < -100);
  assert.ok(grown.points[1].qc.includes('wound_grew'));
  assert.ok(grown.points[3].areaReductionPct < -100, 'a growing wound gives a negative drop');
  assert.ok(grown.points[3].areaReductionPx < 0);
  assert.equal(grown.points[0].woundAreaT0Mm2, null, 'no pixel size → no mm²');
  assert.equal(grown.points[3].areaReductionMm2, null);
  assert.equal(grown.summary.t50Hours, null);

  // missing results are carried through as gaps
  const gaps = seriesMetrics([{ time: 0, hours: 0, result: null }, points[1], points[2]]);
  assert.equal(gaps.points[0].analysed, false);
  assert.equal(gaps.points[1].closurePct, 0);
  assert.equal(gaps.points[2].woundAreaT0Px, gaps.points[1].woundAreaPx, 'time 0 = first analysed image');

  // no wound at time 0 → the drop is undefined, not a division by zero
  const none = syntheticWell({ size: 800, wellRadius: 370, woundRadius: 0 });
  const empty = seriesMetrics([{ time: 0, hours: 0, result: analyzeClassical(none.data, none.width, none.height).result }, points[1]]);
  assert.equal(empty.points[1].woundAreaT0Px, 0);
  assert.equal(empty.points[1].areaReductionPct, null);
  assert.equal(empty.points[1].areaReductionPx, null);
  assert.equal(empty.summary.finalAreaReductionPct, null);
  assert.equal(gaps.summary.analysed, 2);

  assert.equal(slope([0, 1, 2], [1, 3, 5]), 2);
  assert.equal(slope([1], [1]), null);
});

test('csv: header, quoting, skipped rows', () => {
  const img = syntheticWell({ size: 800, wellRadius: 370, woundRadius: 120 });
  const result = analyzeClassical(img.data, img.width, img.height).result;
  const m = seriesMetrics([{ time: 0, hours: 0, result }, { time: 24, hours: 24, result: null }], 2.5);
  const csv = buildCsv([{ label: 'B1', plate: 'plate "A", run 2', well: 'B1', site: '1', timeUnit: 'h',
    rows: m.points.map((p, i) => ({ ...p, fileName: `img, ${i}.jpg` })) }]);
  assert.ok(csv.startsWith('\ufeff'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 2, 'the unanalysed row is skipped');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.ok(lines[1].includes('"plate ""A"", run 2"'));
  assert.ok(lines[1].includes('"img, 0.jpg"'));
  assert.ok(lines[1].endsWith(',auto,classical,'));
  const col = (name) => lines[1].split(',').at(CSV_COLUMNS.indexOf(name) - CSV_COLUMNS.length); // from the end: no quoted commas there
  assert.equal(Number(col('wound_area_t0_px')), m.points[0].woundAreaPx);
  assert.equal(Number(col('area_reduction_px')), 0);
  assert.equal(Number(col('area_reduction_pct')), 0);
  assert.ok(Math.abs(Number(col('wound_area_t0_mm2')) - m.points[0].woundAreaPx * 6.25e-6) < 1e-3);
});
