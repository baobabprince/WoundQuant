// CSV export (one row per image, long format — ready for R / pandas / Prism).

const COLUMNS = [
  ['series', (s) => s.label],
  ['plate', (s) => s.plate],
  ['well', (s) => s.well],
  ['site', (s) => s.site],
  ['file', (s, r) => r.fileName],
  ['time', (s, r) => r.time],
  ['time_unit', (s) => s.timeUnit],
  ['hours', (s, r) => r.hours],
  ['well_area_px', (s, r) => r.wellAreaPx],
  ['wound_area_px', (s, r) => r.woundAreaPx],
  ['cell_free_area_px', (s, r) => r.cellFreeAreaPx],
  ['well_area_mm2', (s, r) => r.wellAreaMm2, 4],
  ['wound_area_mm2', (s, r) => r.woundAreaMm2, 4],
  ['wound_eq_diameter_um', (s, r) => r.woundEqDiameterUm, 1],
  ['wound_pct_of_well', (s, r) => r.woundPct, 2],
  ['confluence_pct', (s, r) => r.confluencePct, 2],
  ['closure_pct', (s, r) => r.closurePct, 2],
  ['t0_region_closure_pct', (s, r) => r.t0RegionClosurePct, 2],
  ['rate_pct_per_h', (s, r) => r.ratePctPerH, 4],
  ['source', (s, r) => r.source],
  ['engine', (s, r) => r.engine],
  ['qc_flags', (s, r) => (r.qc || []).join(' ')],
];

function cell(value, digits) {
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return '';
  if (typeof value === 'number') {
    return digits === undefined ? String(value) : String(Number(value.toFixed(digits)));
  }
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * @param {Array<{label,plate,well,site,timeUnit,rows:Array<object>}>} series
 *   rows = seriesMetrics().points with a fileName added; unanalysed rows are skipped.
 */
export function buildCsv(series) {
  const lines = [COLUMNS.map((c) => c[0]).join(',')];
  for (const s of series) {
    for (const r of s.rows) {
      if (!r.analysed) continue;
      lines.push(COLUMNS.map(([, get, digits]) => cell(get(s, r), digits)).join(','));
    }
  }
  // BOM so Excel opens UTF-8 (Hebrew plate names) correctly.
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

export const CSV_COLUMNS = COLUMNS.map((c) => c[0]);
