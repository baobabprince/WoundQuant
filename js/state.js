// Application state: loaded files grouped into series, results, settings.
// Plain data + small helpers; the UI modules subscribe to change events.

import { groupIntoSeries } from './core/naming.js';
import { seriesMetrics } from './core/metrics.js';
import { DEFAULT_PARAMS, normalizeParams } from './core/pipeline.js';
import { fileKey } from './db.js';

export const APP_VERSION = '2.0.0';
const SETTINGS_KEY = 'woundquant.settings.v2';
const IMAGE_RE = /\.(jpe?g|png|tiff?|bmp|webp)$/i;

export const state = {
  /** @type {Array<Series>} */
  series: [],
  imageCount: 0,
  selected: { series: -1, item: 0 },
  settings: loadSettings(),
  running: false,
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) fn(detail);
}

function loadSettings() {
  const base = { lang: null, pixelSizeUm: null, engine: 'classical', params: { ...DEFAULT_PARAMS }, showAllSeries: false, areaChart: 't0' };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...base, ...saved, params: normalizeParams(saved.params || {}) };
  } catch {
    return base;
  }
}

export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

export function isImageFile(file) {
  return IMAGE_RE.test(file.name) || /^image\//.test(file.type || '');
}

/**
 * Add files (replacing or extending the current set) and regroup into series.
 * @param {Array<{file:File, dir:string}>} entries
 * @returns {{added:number, total:number, series:number, unparsed:number, tiff:number}}
 */
export function addFiles(entries, { replace = false } = {}) {
  const existing = new Map();
  if (!replace) {
    for (const s of state.series) for (const it of s.items) existing.set(it.dir + '/' + fileKey(it.file), it);
  }
  let added = 0;
  for (const e of entries) {
    if (!isImageFile(e.file)) continue;
    const key = (e.dir || '') + '/' + fileKey(e.file);
    if (existing.has(key)) continue;
    existing.set(key, { file: e.file, dir: e.dir || '', name: e.file.name, result: null, status: 'new', error: null });
    added++;
  }
  const records = [...existing.values()];
  const grouped = groupIntoSeries(records);
  state.series = grouped.map((g) => ({
    key: g.key, label: g.label, plate: g.plate, well: g.well, site: g.site, folder: g.folder, timeUnit: g.timeUnit,
    items: g.items.map((it) => Object.assign(it.file, { time: it.time, hours: it.hours })),
    metrics: null,
  }));
  state.imageCount = records.length;
  state.selected = { series: state.series.length ? 0 : -1, item: 0 };
  const unparsed = state.series.filter((s) => s.timeUnit === 'frame').reduce((n, s) => n + s.items.length, 0);
  const tiff = records.filter((r) => /\.tiff?$/i.test(r.name)).length;
  emit('files');
  return { added, total: records.length, series: state.series.length, unparsed, tiff };
}

export function clearFiles() {
  state.series = [];
  state.imageCount = 0;
  state.selected = { series: -1, item: 0 };
  emit('files');
}

export function allItems() {
  const out = [];
  for (const s of state.series) for (const it of s.items) out.push(it);
  return out;
}

export function currentSeries() {
  return state.series[state.selected.series] || null;
}

export function currentItem() {
  const s = currentSeries();
  return s ? s.items[state.selected.item] || null : null;
}

/** Time-series metrics of a series (cached until one of its results changes). */
export function metricsOf(series) {
  if (!series.metrics) {
    series.metrics = seriesMetrics(
      series.items.map((it) => ({ time: it.time, hours: it.hours, result: it.result })),
      state.settings.pixelSizeUm,
    );
  }
  return series.metrics;
}

export function invalidateMetrics(series = null) {
  if (series) series.metrics = null;
  else for (const s of state.series) s.metrics = null;
}

export function setResult(series, item, result) {
  item.result = result;
  item.status = result ? 'done' : 'new';
  item.error = null;
  series.metrics = null;
}

export function seriesOfItem(item) {
  return state.series.find((s) => s.items.includes(item)) || null;
}

export function select(seriesIndex, itemIndex = 0) {
  if (seriesIndex < 0 || seriesIndex >= state.series.length) return;
  const s = state.series[seriesIndex];
  state.selected = { series: seriesIndex, item: Math.max(0, Math.min(s.items.length - 1, itemIndex)) };
  emit('select');
}

/** Short human label of a time point. */
export function timeLabel(series, item) {
  if (series.timeUnit === 'h' && item.hours !== null) {
    const h = item.hours;
    if (h >= 48 && Math.abs(h / 24 - Math.round(h / 24 * 2) / 2) < 1e-9) return `${h / 24} d`;
    return `${Number(h.toFixed(2))} h`;
  }
  return `#${item.time + 1}`;
}
