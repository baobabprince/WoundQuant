// Exports: results CSV, per-series summary CSV, training set ZIP.

import { buildCsv } from './core/csv.js';
import { sampleId } from './core/dataset.js';
import { PIPELINE_VERSION } from './core/pipeline.js';
import { ZipWriter } from './zip.js';
import { state, metricsOf, APP_VERSION } from './state.js';

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** One row per analysed image. @returns {number} rows written */
export function exportResultsCsv() {
  let rows = 0;
  const series = state.series.map((s) => {
    const m = metricsOf(s);
    const out = m.points.map((p, i) => ({ ...p, fileName: s.items[i].name }));
    rows += out.filter((r) => r.analysed).length;
    return { label: s.label, plate: s.plate || s.folder, well: s.well, site: s.site, timeUnit: s.timeUnit, rows: out };
  });
  if (!rows) return 0;
  downloadBlob(new Blob([buildCsv(series)], { type: 'text/csv;charset=utf-8' }), `woundquant_results_${stamp()}.csv`);
  return rows;
}

function num(v, digits) {
  return v === null || v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toFixed(digits)));
}

/** One row per series (well). @returns {number} rows written */
export function exportSummaryCsv() {
  const head = ['series', 'plate', 'well', 'site', 'time_points', 'analysed', 'baseline_wound_pct_of_well',
    'wound_area_t0_px', 'wound_area_t0_mm2', 'final_wound_area_px', 'final_wound_area_mm2',
    'final_area_reduction_px', 'final_area_reduction_mm2', 'final_area_reduction_pct',
    'final_closure_pct', 'max_closure_pct', 'mean_rate_pct_per_h', 't50_hours', 'flagged_images', 'hand_corrected_images'];
  const lines = [head.join(',')];
  let rows = 0;
  const q = (s) => (/[",\n\r]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s ?? ''));
  for (const s of state.series) {
    const sm = metricsOf(s).summary;
    if (!sm.analysed) continue;
    rows++;
    lines.push([q(s.label), q(s.plate || s.folder), q(s.well), q(s.site), sm.n, sm.analysed, num(sm.baselineWoundPct, 2),
      num(sm.baselineWoundAreaPx, 0), num(sm.baselineWoundAreaMm2, 4), num(sm.finalWoundAreaPx, 0), num(sm.finalWoundAreaMm2, 4),
      num(sm.finalAreaReductionPx, 0), num(sm.finalAreaReductionMm2, 4), num(sm.finalAreaReductionPct, 2),
      num(sm.finalClosurePct, 2), num(sm.maxClosurePct, 2), num(sm.meanRatePctPerH, 4), num(sm.t50Hours, 1), sm.flagged,
      s.items.filter((it) => it.result && it.result.source === 'manual').length].join(','));
  }
  if (!rows) return 0;
  downloadBlob(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), `woundquant_summary_${stamp()}.csv`);
  return rows;
}

/**
 * Training set: network-input images + label masks (see js/core/dataset.js).
 * @param {WorkerPool} pool
 * @param {'manual'|'all'} which
 * @param {(done:number,total:number)=>void} onProgress
 * @returns {Promise<{samples:number, manual:number}>}
 */
export async function exportTrainingSet(pool, which, onProgress) {
  const picks = [];
  for (const s of state.series) {
    for (const it of s.items) {
      if (!it.result) continue;
      if (which === 'manual' && it.result.source !== 'manual') continue;
      picks.push({ s, it });
    }
  }
  if (!picks.length) return { samples: 0, manual: 0 };
  const zip = new ZipWriter();
  const meta = [];
  let done = 0;
  let index = 0;
  let cursor = 0;
  const params = state.settings.params;
  const workerCount = Math.min(pool.size, picks.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < picks.length) {
      const { s, it } = picks[cursor++];
      const r = it.result;
      const out = await pool.run({ type: 'sample', file: it.file, params, rle: r.rle, gw: r.gw, gh: r.gh });
      const id = sampleId(index++, it.name);
      zip.add(`images/${id}.png`, out.image);
      zip.add(`labels/${id}.png`, out.label);
      meta.push({ id, file: it.name, series: s.key, well: s.well, hours: it.hours, source: r.source, engine: r.engine,
        qc: r.qc, width: out.width, height: out.height, grid: [out.gw, out.gh], block: out.S, pipeline: PIPELINE_VERSION });
      onProgress?.(++done, picks.length);
    }
  }));
  meta.sort((a, b) => (a.id < b.id ? -1 : 1));
  zip.add('meta.jsonl', meta.map((m) => JSON.stringify(m)).join('\n') + '\n');
  zip.add('README.txt', [
    'WoundQuant training set',
    `exported ${new Date().toISOString()} · app ${APP_VERSION} · pipeline ${PIPELINE_VERSION}`,
    '',
    'images/<id>.png  RGB: R = mean grey, G = texture, B = relative texture (0 outside the growth area)',
    'labels/<id>.png  grey: 0 outside, 85 cells, 170 cell-free, 255 wound',
    'meta.jsonl       one JSON object per sample; source = "manual" marks hand-corrected masks',
    '',
    'Train with:  python ml/train.py --data <this zip> --id my-model --update-manifest',
    '',
  ].join('\n'));
  downloadBlob(zip.finish(), `woundquant_training_${stamp()}.zip`);
  return { samples: meta.length, manual: meta.filter((m) => m.source === 'manual').length };
}
