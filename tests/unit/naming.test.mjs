import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileName, groupIntoSeries, naturalCompare } from '../../js/core/naming.js';

test('IncuCyte export names', () => {
  const p = parseFileName('EXP3 plate1 after burn_B1_1_06d12h00m.jpg');
  assert.equal(p.pattern, 'incucyte');
  assert.equal(p.plate, 'EXP3 plate1 after burn');
  assert.equal(p.well, 'B1');
  assert.equal(p.site, '1');
  assert.equal(p.hours, 156);
  const q = parseFileName('VID123_H12_4_00d02h30m.tif');
  assert.deepEqual([q.plate, q.well, q.site, q.hours], ['VID123', 'H12', '4', 2.5]);
});

test('well numbers are normalised (B01 == B1)', () => {
  assert.equal(parseFileName('p_B01_1_00d00h00m.png').seriesKey, parseFileName('p_B1_1_01d00h00m.png').seriesKey);
});

test('generic time tokens', () => {
  assert.equal(parseFileName('scratch_A3_24h.png').hours, 24);
  assert.equal(parseFileName('scratch_A3_24h.png').well, 'A3');
  assert.equal(parseFileName('exp-C7-1.5hr.jpg').hours, 1.5);
  assert.equal(parseFileName('wellD4_day2.jpg').hours, 48);
  assert.equal(parseFileName('plate_02d06h_E5.tif').hours, 54);
  const f = parseFileName('G2_t007.png');
  assert.deepEqual([f.well, f.frame, f.hours], ['G2', 7, null]);
});

test('different time points of one well share a series key', () => {
  const a = parseFileName('scratch_A3_0h.png');
  const b = parseFileName('scratch_A3_24h.png');
  assert.equal(a.seriesKey, b.seriesKey);
  assert.notEqual(a.seriesKey, parseFileName('scratch_A4_0h.png').seriesKey);
});

test('unrecognised names fall back to one series per folder, natural order', () => {
  const files = ['img10.png', 'img2.png', 'img1.png'].map((name) => ({ name, dir: 'run1' }));
  const series = groupIntoSeries(files);
  assert.equal(series.length, 1);
  assert.equal(series[0].timeUnit, 'frame');
  assert.deepEqual(series[0].items.map((i) => i.file.name), ['img1.png', 'img2.png', 'img10.png']);
  assert.deepEqual(series[0].items.map((i) => i.time), [0, 1, 2]);
});

test('grouping sorts wells in plate order and time ascending', () => {
  const names = [
    'P_B10_1_00d00h00m.jpg', 'P_B2_1_01d00h00m.jpg', 'P_B2_1_00d00h00m.jpg',
    'P_A1_1_00d12h00m.jpg', 'P_A1_1_00d00h00m.jpg', 'P_B10_1_00d06h00m.jpg',
  ];
  const series = groupIntoSeries(names.map((name) => ({ name })));
  assert.deepEqual(series.map((s) => s.label), ['A1', 'B2', 'B10']);
  assert.deepEqual(series[0].items.map((i) => i.time), [0, 12]);
  assert.equal(series[0].timeUnit, 'h');
});

test('same well in two folders stays separate and gets a distinguishing label', () => {
  const series = groupIntoSeries([
    { name: 'X_A1_1_00d00h00m.jpg', dir: 'plate1' },
    { name: 'X_A1_1_00d00h00m.jpg', dir: 'plate2' },
  ]);
  assert.equal(series.length, 2);
  assert.notEqual(series[0].label, series[1].label);
});

test('several sites of a well are labelled', () => {
  const series = groupIntoSeries([{ name: 'P_A1_1_00d00h00m.jpg' }, { name: 'P_A1_2_00d00h00m.jpg' }]);
  assert.deepEqual(series.map((s) => s.label), ['A1 · 1', 'A1 · 2']);
});

test('naturalCompare', () => {
  assert.ok(naturalCompare('a2', 'a10') < 0);
});
