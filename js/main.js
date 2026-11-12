// WoundQuant — user interface wiring.

import { t, fmt, setLang, getLang, detectLang } from './i18n.js';
import { initAnalytics, track, analyticsStatus, setOptOut } from './analytics.js';
import { WorkerPool, defaultPoolSize } from './pool.js';
import { Batch } from './batch.js';
import { Viewer } from './viewer.js';
import { Charts } from './charts.js';
import { exportResultsCsv, exportSummaryCsv, exportTrainingSet, downloadBlob } from './exporter.js';
import { DEFAULT_PARAMS, normalizeParams, paramsKey, summarizeLabels } from './core/pipeline.js';
import { rleDecode, rleEncode } from './core/rle.js';
import { imageMetrics } from './core/metrics.js';
import { manualKey, autoKey, dbPut, dbDelete } from './db.js';
import {
  state, on, emit, saveSettings, addFiles, clearFiles, allItems, currentSeries, currentItem, metricsOf,
  invalidateMetrics, setResult, select, timeLabel, isImageFile, APP_VERSION,
} from './state.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_SIZE = 1400;
const PREVIEW_CACHE = 10;

let pool = null;
let batch = null;
let viewer = null;
let charts = null;
let models = [];            // bundled models from models/manifest.json
let customModel = null;     // { key, name, bytes }
let loadedModelKey = null;  // key currently handed to the pool
let settingsDirty = false;  // settings changed since the last run
let hasRun = false;
let listTimer = 0;
let toastTimer = 0;
const previews = new Map();  // item → { bitmap, width, height }
let previewBusy = false;
let previewWanted = null;
let viewToken = 0;
const editedThisSession = new WeakSet();
const session = { seriesOpened: 0, edits: 0, startedAt: Date.now() };

// ---- helpers ---------------------------------------------------------------

function toast(text, ms = 3500) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function getPool() {
  if (!pool) pool = new WorkerPool(defaultPoolSize());
  return pool;
}

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function engineSelection() {
  const v = state.settings.engine;
  if (v === 'classical') return { kind: 'classical', id: 'classical' };
  if (v === 'custom') return customModel ? { kind: 'model', key: customModel.key, id: 'model:' + customModel.key } : null;
  const m = models.find((x) => 'model:' + x.id === v);
  return m ? { kind: 'model', key: m.id, id: 'model:' + m.id, manifest: m } : { kind: 'classical', id: 'classical' };
}

/** Hand the selected model's bytes to the pool (downloads bundled models once). */
async function ensureModelLoaded(engine) {
  if (engine.kind !== 'model' || loadedModelKey === engine.key) return;
  let bytes;
  if (customModel && customModel.key === engine.key) bytes = customModel.bytes;
  else {
    const res = await fetch(`models/${engine.manifest.file}`);
    if (!res.ok) throw new Error(`models/${engine.manifest.file}: HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  }
  getPool().setModel(engine.key, bytes);
  loadedModelKey = engine.key;
}

// ---- language & static texts ----------------------------------------------

function applyLanguage(lang) {
  setLang(lang);
  $('btnLang').textContent = t('langButton');
  renderEngineOptions();
  renderLoadSummary();
  renderRunState();
  renderAnalyticsNotice();
  renderSeriesList();
  renderCurrent();
}

function renderAnalyticsNotice() {
  const st = analyticsStatus();
  const btn = $('btnOptOut');
  if (!st.configured) {
    $('analyticsNotice').textContent = t('analyticsOff');
    btn.hidden = true;
    return;
  }
  $('analyticsNotice').textContent = st.optedOut ? t('analyticsOptedOut') : t('analyticsOn');
  btn.textContent = st.optedOut ? t('optIn') : t('optOut');
  btn.hidden = false;
}

// ---- file intake -----------------------------------------------------------

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Walk dropped folders (DataTransferItem entries) recursively. */
async function filesFromEntries(entries) {
  const out = [];
  const walk = async (entry, dir) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      if (isImageFile(file)) out.push({ file, dir });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns at most ~100 entries per call; loop until empty.
      for (;;) {
        const chunk = await readEntries(reader);
        if (!chunk.length) break;
        for (const child of chunk) await walk(child, dir ? `${dir}/${entry.name}` : entry.name);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

function ingest(entries, method, replace = false) {
  const res = addFiles(entries, { replace });
  if (!res.total) { toast(t('noteNoImages')); return; }
  hasRun = allItems().some((it) => it.result);
  track('files_added', { method, images: res.added, total: res.total, series: res.series, tiff: res.tiff, unparsed: res.unparsed });
}

function renderLoadSummary() {
  const n = state.imageCount;
  $('loadSummaryRow').hidden = n === 0;
  $('cardReview').hidden = n === 0;
  $('btnRun').disabled = n === 0 || state.running;
  if (!n) { $('loadNote').hidden = true; return; }
  let text = t('loadSummary', { images: n.toLocaleString('en-US'), series: state.series.length.toLocaleString('en-US') });
  const timed = state.series.filter((s) => s.timeUnit === 'h');
  if (timed.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of timed) { lo = Math.min(lo, s.items[0].hours); hi = Math.max(hi, s.items[s.items.length - 1].hours); }
    text += t('loadSummaryTime', { from: `${Number(lo.toFixed(1))} h`, to: `${Number(hi.toFixed(1))} h` });
  }
  $('loadSummary').textContent = text;
  const unparsed = state.series.filter((s) => s.timeUnit === 'frame').reduce((a, s) => a + s.items.length, 0);
  $('loadNote').hidden = unparsed === 0;
  if (unparsed) $('loadNote').textContent = t('noteUnparsed', { n: unparsed });
}

async function loadExamples() {
  const btn = $('btnExamples');
  btn.disabled = true;
  toast(t('loadingExamples'), 20000);
  try {
    const names = await (await fetch('examples/index.json')).json();
    const files = await Promise.all(names.map(async (name) => {
      const res = await fetch('examples/' + encodeURIComponent(name));
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const blob = await res.blob();
      // Fixed timestamp → the result cache recognises the examples next time.
      return { file: new File([blob], name, { type: blob.type || 'image/jpeg', lastModified: 0 }), dir: '' };
    }));
    ingest(files, 'examples', true);
    $('toast').hidden = true;
  } catch (err) {
    toast(t('examplesFailed'));
    track('error', { where: 'examples' });
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ---- engine & parameters ---------------------------------------------------

function renderEngineOptions() {
  const sel = $('selEngine');
  const opts = [['classical', t('engineClassical')]];
  for (const m of models) opts.push(['model:' + m.id, m.name || m.id]);
  opts.push(['custom', t('engineCustom')]);
  sel.replaceChildren(...opts.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
  if (!opts.some(([v]) => v === state.settings.engine)) state.settings.engine = 'classical';
  sel.value = state.settings.engine;
  const v = state.settings.engine;
  $('customModelField').hidden = v !== 'custom';
  let help;
  if (v === 'classical') help = t('engineHelpClassical');
  else if (v === 'custom') help = t('engineHelpCustom');
  else {
    const m = models.find((x) => 'model:' + x.id === v);
    const tr = (m && m.training) || {};
    const note = !m ? '' : !tr.hand_corrected
      ? t('engineHelpBootstrap', { n: tr.samples ?? '?' })
      : t('engineHelpTrained', { n: tr.samples, manual: tr.hand_corrected });
    help = t('engineHelpModel', { note });
  }
  $('engineHelp').textContent = help;
}

const PARAM_INPUTS = [
  ['pSensitivity', 'sensitivity', 'outSensitivity', (v) => (v > 0 ? '+' : '') + v.toFixed(1)],
  ['pMargin', 'wellMargin', 'outMargin', (v) => (v * 100).toFixed(1) + '%'],
  ['pIslands', 'fillIslandsFrac', 'outIslands', (v) => (v * 100).toFixed(1) + '%'],
  ['pMinRegion', 'minRegionFrac', 'outMinRegion', (v) => (v * 100).toFixed(1) + '%'],
];

function renderParams() {
  const p = state.settings.params;
  for (const [inputId, key, outId, format] of PARAM_INPUTS) {
    $(inputId).value = p[key];
    $(outId).textContent = format(Number(p[key]));
  }
  $('pWoundMode').value = p.woundMode;
  $('inPixelSize').value = state.settings.pixelSizeUm ?? '';
}

function paramChanged(key, value) {
  state.settings.params = normalizeParams({ ...state.settings.params, [key]: value });
  saveSettings();
  renderParams();
  markDirty();
  track('param_changed', { param: key, value: typeof value === 'number' ? value : String(value) });
}

function markDirty() {
  settingsDirty = hasRun;
  renderRunState();
}

function renderRunState() {
  const running = state.running;
  $('btnRun').hidden = running;
  $('btnRun').disabled = state.imageCount === 0;
  $('btnRun').textContent = hasRun ? t('rerun') : t('run');
  $('btnPause').hidden = !running;
  $('btnCancel').hidden = !running;
  $('btnPause').textContent = batch && batch.paused ? t('resume') : t('pause');
  $('runHint').textContent = t('runHintWorkers', { n: defaultPoolSize() });
  for (const id of ['selEngine', 'inModel', 'pSensitivity', 'pMargin', 'pIslands', 'pMinRegion', 'pWoundMode', 'btnResetParams', 'btnClear', 'btnExamples']) $(id).disabled = running;
}

// ---- analysis --------------------------------------------------------------

async function runAnalysis() {
  if (state.running || !state.imageCount) return;
  const engine = engineSelection();
  if (!engine) { toast(t('engineHelpCustom')); $('inModel').focus(); return; }
  const params = normalizeParams(state.settings.params);
  $('errorBox').hidden = true;
  // Busy from the first click: the model download below can take a moment.
  state.running = true;
  renderRunState();
  try {
    await ensureModelLoaded(engine);
  } catch (err) {
    state.running = false;
    renderRunState();
    toast(t('modelFailed', { msg: err.message }), 6000);
    track('error', { where: 'model_load' });
    return;
  }
  const work = [];
  for (const s of state.series) for (const it of s.items) work.push({ series: s, item: it });
  batch = new Batch(getPool(), work, { engine: { kind: engine.kind, key: engine.key }, engineId: engine.id, params });
  track('analysis_started', { images: work.length, series: state.series.length, engine: engine.kind === 'model' ? 'model' : 'classical', workers: getPool().size });
  const summary = await batch.run();
  batch = null;
  hasRun = true;
  settingsDirty = false;
  renderRunState();
  const flagged = state.series.reduce((n, s) => n + metricsOf(s).summary.flagged, 0);
  if (summary.cancelled) {
    toast(t('cancelledSummary', { done: summary.done, total: summary.total }));
    track('analysis_cancelled', { done: summary.done, total: summary.total });
  } else {
    toast(t('doneSummary', { n: summary.done, sec: fmt(summary.seconds, 1) }) + (summary.cached ? t('doneCached', { n: summary.cached }) : ''));
    track('analysis_finished', {
      images: summary.total, computed: summary.computed, cached: summary.cached, errors: summary.errors.length, flagged,
      seconds: Math.round(summary.seconds), ms_per_image: Math.round(summary.msPerImage),
      engine: engine.kind === 'model' ? 'model' : 'classical',
    });
  }
  if (summary.errors.length) {
    $('errorBox').hidden = false;
    $('errorSummary').textContent = t('errorsSummary', { n: summary.errors.length });
    $('errorList').replaceChildren(...summary.errors.slice(0, 200).map((e) => Object.assign(document.createElement('li'), { textContent: `${e.name} — ${e.message}` })));
    const kinds = new Set(summary.errors.map((e) => e.message.split(':')[0].slice(0, 40)));
    track('error', { where: 'analysis', count: summary.errors.length, kind: [...kinds].slice(0, 3).join(' | ') });
  }
}

function renderProgress(p) {
  $('progressWrap').hidden = false;
  const pct = p.total ? (100 * p.done) / p.total : 0;
  $('progressFill').style.width = pct.toFixed(1) + '%';
  $('progressBar').setAttribute('aria-valuenow', String(Math.round(pct)));
  let text = t('progress', { done: p.done.toLocaleString('en-US'), total: p.total.toLocaleString('en-US') });
  if (p.cached) text += t('progressCached', { n: p.cached.toLocaleString('en-US') });
  if (p.paused) text += t('progressPaused');
  else if (p.done < p.total) {
    if (p.rate > 0) text += t('progressRate', { rate: fmt(p.rate, 1) });
    if (p.etaSeconds !== null && p.etaSeconds > 2) text += t('progressEta', { eta: duration(p.etaSeconds) });
  }
  $('progressText').textContent = text;
}

// ---- series list -----------------------------------------------------------

function scheduleList() {
  if (listTimer) return;
  listTimer = setTimeout(() => { listTimer = 0; renderSeriesList(); renderCurrentNumbers(); }, state.running ? 700 : 30);
}

function renderSeriesList() {
  const list = $('seriesList');
  const filter = $('seriesFilter').value.trim().toLowerCase();
  const flaggedOnly = $('flaggedOnly').checked;
  const frag = document.createDocumentFragment();
  let shown = 0;
  state.series.forEach((s, index) => {
    const m = metricsOf(s).summary;
    if (filter && !s.label.toLowerCase().includes(filter)) return;
    if (flaggedOnly && !m.flagged) return;
    shown++;
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = String(index);
    li.setAttribute('aria-selected', index === state.selected.series ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.label;
    name.title = s.label;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const badge = (cls, text, title) => {
      const b = document.createElement('span');
      b.className = 'badge ' + cls;
      b.textContent = text;
      b.title = title;
      meta.appendChild(b);
    };
    if (s.items.some((it) => it.status === 'error')) badge('err', '✕', t('errorsSummary', { n: s.items.filter((it) => it.status === 'error').length }));
    if (s.items.some((it) => it.result && it.result.source === 'manual')) badge('manual', '✎', t('sourceManual'));
    if (m.flagged) badge('flag', '⚠ ' + m.flagged, t('flaggedOnly'));
    const value = document.createElement('span');
    value.textContent = m.finalClosurePct !== null ? fmt(m.finalClosurePct, 0) + '%' : m.analysed ? `${m.analysed}/${m.n}` : `${m.n}`;
    if (m.finalClosurePct !== null && m.finalClosurePct < -10) { value.className = 'unreliable'; value.title = t('seriesUnreliable'); }
    meta.appendChild(value);
    li.append(name, meta);
    frag.appendChild(li);
  });
  list.replaceChildren(frag);
  $('seriesCount').textContent = shown === state.series.length ? '' : t('seriesCount', { shown, total: state.series.length });
}

function highlightSelectedSeries() {
  for (const li of $('seriesList').children) {
    const sel = Number(li.dataset.index) === state.selected.series;
    li.setAttribute('aria-selected', sel ? 'true' : 'false');
    if (sel) li.scrollIntoView({ block: 'nearest' });
  }
}

// ---- current image ---------------------------------------------------------

function requestPreview(item) {
  if (previews.has(item)) return Promise.resolve(previews.get(item));
  return new Promise((resolve, reject) => {
    // Only the most recent request matters while the user scrubs the slider.
    if (previewWanted) previewWanted.reject(new Error('SUPERSEDED'));
    previewWanted = { item, resolve, reject };
    pumpPreview();
  });
}

async function pumpPreview() {
  if (previewBusy || !previewWanted) return;
  const job = previewWanted;
  previewWanted = null;
  previewBusy = true;
  try {
    const res = await getPool().runInteractive({ type: 'preview', file: job.item.file, maxSize: PREVIEW_SIZE });
    const entry = { bitmap: res.bitmap, width: res.width, height: res.height };
    previews.set(job.item, entry);
    while (previews.size > PREVIEW_CACHE) {
      const [oldest, old] = previews.entries().next().value;
      previews.delete(oldest);
      if (old.bitmap !== viewer.bitmap) old.bitmap.close?.();
    }
    job.resolve(entry);
  } catch (err) {
    job.reject(err);
  } finally {
    previewBusy = false;
    pumpPreview();
  }
}

function setViewerMessage(text) {
  $('viewerMessage').hidden = !text;
  $('viewerMessage').textContent = text || '';
}

/** Show the selected image: labels immediately, pixels when decoded. */
function renderCurrent() {
  const s = currentSeries();
  const it = currentItem();
  if (!viewer) return;
  const token = ++viewToken;
  if (!s || !it) {
    viewer.setLabels(null);
    viewer.setImage(null, 1, 1);
    return;
  }
  $('timeSlider').max = String(s.items.length - 1);
  $('timeSlider').value = String(state.selected.item);
  $('timeSlider').disabled = s.items.length < 2;
  $('timeLabel').textContent = `${timeLabel(s, it)}  (${state.selected.item + 1}/${s.items.length})`;
  $('fileLabel').textContent = (it.dir ? it.dir + '/' : '') + it.name;
  renderCurrentNumbers();

  const cached = previews.get(it);
  if (cached) {
    viewer.setImage(cached.bitmap, cached.width, cached.height);
    applyLabelsToViewer(it);
    setViewerMessage(it.result ? '' : state.running ? '' : t('viewerNotAnalysed'));
  } else {
    // Until the pixels arrive the previous image stays up, without an outline
    // that belongs to another time point.
    viewer.setLabels(null);
    $('btnResetMask').disabled = true;
    setViewerMessage(t('viewerLoading'));
    requestPreview(it).then((p) => {
      if (token !== viewToken) return;
      viewer.setImage(p.bitmap, p.width, p.height);
      applyLabelsToViewer(it);
      setViewerMessage(it.result || state.running ? '' : t('viewerNotAnalysed'));
    }).catch((err) => {
      if (token !== viewToken || err.message === 'SUPERSEDED') return;
      viewer.setImage(null, 1, 1);
      setViewerMessage(t('viewerError', { msg: err.message }));
    });
  }
}

function applyLabelsToViewer(it) {
  const r = it.result;
  if (r) viewer.setLabels(rleDecode(r.rle, r.gw * r.gh), r.gw, r.gh, r.S);
  else viewer.setLabels(null);
  $('btnResetMask').disabled = !(r && r.source === 'manual');
}

function engineName(id) {
  if (!id || id === 'classical') return t('engineNameClassical');
  const key = id.replace(/^model:/, '');
  const m = models.find((x) => x.id === key);
  return t('engineNameModel', { id: m ? m.name || m.id : key });
}

/** An area in mm² when the pixel size is known, otherwise in pixels. */
function areaText(px, mm2) {
  if (px === null || px === undefined) return '–';
  return mm2 !== null && mm2 !== undefined ? `${fmt(mm2, 2)} mm²` : `${Math.round(px).toLocaleString('en-US')} px`;
}

/** Metric cards, QC notes, series summary and charts of the selection. */
function renderCurrentNumbers() {
  const s = currentSeries();
  const it = currentItem();
  if (!s || !it || !charts) return;
  const metrics = metricsOf(s);
  const p = metrics.points[state.selected.item];
  const set = (id, text) => { $(id).textContent = text; };
  if (p && p.analysed) {
    set('mWoundArea', areaText(p.woundAreaPx, p.woundAreaMm2));
    set('mWoundPct', fmt(p.woundPct, 1) + '%');
    set('mAreaT0', areaText(p.woundAreaT0Px, p.woundAreaT0Mm2));
    set('mAreaDrop', p.areaReductionPct === null ? '–' : fmt(p.areaReductionPct, 1) + '%');
    set('mAreaDropAbs', p.areaReductionPx === null ? '' : areaText(p.areaReductionPx, p.areaReductionMm2));
    set('mClosure', p.closurePct === null ? '–' : fmt(p.closurePct, 1) + '%');
    set('mConfluence', fmt(p.confluencePct, 1) + '%');
    set('mT0Closure', p.t0RegionClosurePct === null ? '–' : fmt(p.t0RegionClosurePct, 1) + '%');
    set('mRate', p.ratePctPerH === null ? '–' : fmt(p.ratePctPerH, 2) + ' %/h');
    $('sourceLine').textContent = p.source === 'manual' ? t('sourceManual') : t('sourceAuto', { engine: engineName(p.engine) });
    $('qcList').replaceChildren(...p.qc.map((code) => Object.assign(document.createElement('li'), { textContent: t('qc_' + code) })));
  } else {
    for (const id of ['mWoundArea', 'mWoundPct', 'mAreaT0', 'mAreaDrop', 'mClosure', 'mConfluence', 'mT0Closure', 'mRate']) set(id, '–');
    set('mAreaDropAbs', '');
    $('sourceLine').textContent = it.status === 'error' ? `✕ ${it.error}` : '';
    $('qcList').replaceChildren();
  }
  const sm = metrics.summary;
  $('seriesSummary').textContent = sm.analysed && sm.baselineWoundPct !== null ? t('seriesSummaryLine', {
    base: fmt(sm.baselineWoundPct, 1),
    area0: areaText(sm.baselineWoundAreaPx, sm.baselineWoundAreaMm2),
    areaEnd: areaText(sm.finalWoundAreaPx, sm.finalWoundAreaMm2),
    drop: sm.finalAreaReductionPct === null ? '–' : fmt(sm.finalAreaReductionPct, 1),
    final: sm.finalClosurePct === null ? '–' : fmt(sm.finalClosurePct, 1),
    rate: sm.meanRatePctPerH === null ? '–' : fmt(sm.meanRatePctPerH, 2),
    t50: sm.t50Hours === null ? '–' : `${fmt(sm.t50Hours, 1)} h`,
  }) : '';
  let warning = '';
  if (sm.analysed && sm.baselineWoundAreaPx === 0) warning = t('seriesNoBaseline');
  else if (sm.finalClosurePct !== null && sm.finalClosurePct < -10) warning = t('seriesUnreliable');
  $('seriesWarning').hidden = !warning;
  $('seriesWarning').textContent = warning;
  const others = $('chkAllSeries').checked
    ? state.series.filter((o) => o !== s && o.timeUnit === s.timeUnit).map((o) => metricsOf(o).points)
    : [];
  charts.update({ timeUnit: s.timeUnit, points: metrics.points }, others, state.selected.item,
    { mode: state.settings.areaChart, useMm2: !!state.settings.pixelSizeUm });
}

// ---- manual correction -----------------------------------------------------

let saveTimer = 0;

function onMaskEdited(tool) {
  const s = currentSeries();
  const it = currentItem();
  if (!s || !it || !it.result) return;
  const r = it.result;
  const labels = viewer.labels;
  const summary = summarizeLabels(labels, r.gw, r.gh, { wellKind: r.well.kind });
  const next = { ...r, source: 'manual', threshold: null, counts: summary.counts, rimContact: summary.rimContact, qc: summary.qc, rle: rleEncode(labels) };
  setResult(s, it, next);
  $('btnResetMask').disabled = false;
  renderCurrentNumbers();
  scheduleList();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => dbPut(manualKey(it.file), next), 300);
  session.edits++;
  if (!editedThisSession.has(it)) {
    editedThisSession.add(it);
    track('mask_edited', { tool });
  }
}

async function resetMask() {
  const s = currentSeries();
  const it = currentItem();
  if (!s || !it || !it.result || it.result.source !== 'manual') return;
  const engine = engineSelection() || { kind: 'classical', id: 'classical' };
  const params = normalizeParams(state.settings.params);
  $('btnResetMask').disabled = true;
  try {
    await ensureModelLoaded(engine);
    const res = await getPool().runInteractive({ type: 'analyze', file: it.file, params, engine: { kind: engine.kind, key: engine.key } });
    clearTimeout(saveTimer);
    await dbDelete(manualKey(it.file));
    dbPut(autoKey(it.file, paramsKey(params, engine.id)), res.result);
    setResult(s, it, res.result);
    editedThisSession.delete(it);
    track('mask_reset');
    if (currentItem() === it && previews.has(it)) applyLabelsToViewer(it);
    if (currentItem() === it) renderCurrentNumbers();
    scheduleList();
  } catch (err) {
    $('btnResetMask').disabled = false;
    toast(String(err.message));
  }
}

// ---- exports ---------------------------------------------------------------

function openTrainingDialog() {
  const items = allItems().filter((it) => it.result);
  const manual = items.filter((it) => it.result.source === 'manual').length;
  if (!items.length) { toast(t('trainingNone')); return; }
  $('trainManualLabel').textContent = t('trainManual', { n: manual });
  $('trainAllLabel').textContent = t('trainAll', { n: items.length });
  const radios = document.querySelectorAll('input[name="trainWhich"]');
  radios[0].disabled = manual === 0;
  radios[manual === 0 ? 1 : 0].checked = true;
  $('dlgTraining').showModal();
}

async function runTrainingExport(which) {
  $('btnTraining').disabled = true;
  try {
    const res = await exportTrainingSet(getPool(), which, (done, total) => toast(t('trainingProgress', { done, total }), 60000));
    if (!res.samples) toast(t('trainingNone'));
    else {
      toast(t('trainingDone', { n: res.samples, manual: res.manual }));
      track('export', { kind: 'training_zip', samples: res.samples, manual: res.manual, which });
    }
  } catch (err) {
    toast(t('exportFailed', { msg: err.message }), 6000);
    track('error', { where: 'export_training' });
  } finally {
    $('btnTraining').disabled = false;
  }
}

// ---- wiring ----------------------------------------------------------------

function setTool(tool) {
  viewer.setTool(tool);
  for (const b of document.querySelectorAll('#toolGroup .tool')) b.classList.toggle('active', b.dataset.tool === tool);
  $('polygonHint').hidden = tool !== 'polygon';
}

function step(delta) {
  const s = currentSeries();
  if (!s) return;
  select(state.selected.series, state.selected.item + delta);
}

function stepSeries(delta) {
  const visible = [...$('seriesList').children].map((li) => Number(li.dataset.index));
  if (!visible.length) return;
  const pos = visible.indexOf(state.selected.series);
  const next = visible[Math.max(0, Math.min(visible.length - 1, (pos < 0 ? 0 : pos) + delta))];
  if (next !== state.selected.series) { select(next, 0); session.seriesOpened++; }
}

function bindEvents() {
  $('btnLang').addEventListener('click', () => {
    const next = getLang() === 'he' ? 'en' : 'he';
    state.settings.lang = next;
    saveSettings();
    applyLanguage(next);
    track('language_changed', { lang: next });
  });

  // Loading
  const dz = $('dropzone');
  $('btnPickFiles').addEventListener('click', (e) => { e.stopPropagation(); $('inputFiles').click(); });
  $('btnPickFolder').addEventListener('click', (e) => { e.stopPropagation(); $('inputFolder').click(); });
  $('btnExamples').addEventListener('click', (e) => { e.stopPropagation(); loadExamples(); });
  dz.addEventListener('click', () => $('inputFiles').click());
  dz.addEventListener('keydown', (e) => { if (e.target === dz && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('inputFiles').click(); } });
  $('inputFiles').addEventListener('change', (e) => {
    ingest([...e.target.files].map((file) => ({ file, dir: '' })), 'picker');
    e.target.value = '';
  });
  $('inputFolder').addEventListener('change', (e) => {
    ingest([...e.target.files].map((file) => ({ file, dir: (file.webkitRelativePath || '').split('/').slice(0, -1).join('/') })), 'folder');
    e.target.value = '';
  });
  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dz.classList.add('over'); } });
  }
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dz.classList.remove('over'); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dz.classList.remove('over');
    if (state.running) return;
    // Entries must be collected synchronously, before the first await.
    const entries = [...e.dataTransfer.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    const plain = [...e.dataTransfer.files];
    try {
      const files = entries.length ? await filesFromEntries(entries) : plain.map((file) => ({ file, dir: '' }));
      ingest(files, entries.some((en) => en.isDirectory) ? 'drop_folder' : 'drop');
    } catch (err) {
      console.error(err);
      ingest(plain.map((file) => ({ file, dir: '' })), 'drop');
    }
  });
  $('btnClear').addEventListener('click', () => { clearFiles(); hasRun = false; $('progressWrap').hidden = true; $('errorBox').hidden = true; });

  // Engine & parameters
  $('selEngine').addEventListener('change', (e) => {
    state.settings.engine = e.target.value;
    saveSettings();
    renderEngineOptions();
    markDirty();
    track('engine_changed', { engine: e.target.value === 'classical' ? 'classical' : e.target.value === 'custom' ? 'custom_model' : 'bundled_model' });
  });
  $('inModel').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const bytes = await file.arrayBuffer();
      customModel = { key: `custom-${file.name.replace(/\.onnx$/i, '')}-${file.size}`, name: file.name, bytes };
      $('customModelHelp').textContent = t('modelLoaded', { mb: fmt(file.size / 1e6, 1) });
      markDirty();
      track('model_uploaded', { size_kb: Math.round(file.size / 1024) });
    } catch (err) {
      $('customModelHelp').textContent = t('modelFailed', { msg: err.message });
    }
  });
  for (const [inputId, key, outId, format] of PARAM_INPUTS) {
    $(inputId).addEventListener('input', (e) => { $(outId).textContent = format(Number(e.target.value)); });
    $(inputId).addEventListener('change', (e) => paramChanged(key, Number(e.target.value)));
  }
  $('pWoundMode').addEventListener('change', (e) => paramChanged('woundMode', e.target.value));
  $('btnResetParams').addEventListener('click', () => {
    state.settings.params = { ...DEFAULT_PARAMS };
    saveSettings();
    renderParams();
    markDirty();
    track('params_reset');
  });
  $('inPixelSize').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    state.settings.pixelSizeUm = Number.isFinite(v) && v > 0 ? v : null;
    saveSettings();
    invalidateMetrics();
    renderCurrentNumbers();
    track('pixel_size_set', { set: state.settings.pixelSizeUm !== null });
  });
  $('advanced').addEventListener('toggle', (e) => { if (e.target.open) track('advanced_opened'); });

  // Run
  $('btnRun').addEventListener('click', runAnalysis);
  $('btnPause').addEventListener('click', () => {
    if (!batch) return;
    if (batch.paused) batch.resume(); else batch.pause();
    renderRunState();
    track(batch.paused ? 'analysis_paused' : 'analysis_resumed');
  });
  $('btnCancel').addEventListener('click', () => batch && batch.cancel());

  // Series list
  $('seriesList').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    select(Number(li.dataset.index), 0);
    session.seriesOpened++;
  });
  $('seriesFilter').addEventListener('input', renderSeriesList);
  $('flaggedOnly').addEventListener('change', (e) => { renderSeriesList(); track('filter_flagged', { on: e.target.checked }); });

  // Viewer
  for (const b of document.querySelectorAll('#toolGroup .tool')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('brushSize').addEventListener('input', (e) => viewer.setBrush(Number(e.target.value)));
  $('btnUndo').addEventListener('click', () => viewer.undo());
  $('btnResetMask').addEventListener('click', resetMask);
  $('chkOverlay').addEventListener('change', (e) => viewer.setOverlayVisible(e.target.checked));
  $('btnZoomIn').addEventListener('click', () => viewer.zoomBy(1.35));
  $('btnZoomOut').addEventListener('click', () => viewer.zoomBy(1 / 1.35));
  $('btnZoomFit').addEventListener('click', () => viewer.fit());
  $('btnSavePng').addEventListener('click', async () => {
    const it = currentItem();
    if (!it || !viewer.bitmap) return;
    downloadBlob(await viewer.toPngBlob(), it.name.replace(/\.[^.]+$/, '') + '_overlay.png');
    track('export', { kind: 'overlay_png' });
  });
  $('timeSlider').addEventListener('input', (e) => select(state.selected.series, Number(e.target.value)));
  $('btnPrev').addEventListener('click', () => step(-1));
  $('btnNext').addEventListener('click', () => step(1));
  $('selAreaChart').addEventListener('change', (e) => {
    state.settings.areaChart = e.target.value;
    saveSettings();
    renderCurrentNumbers();
    track('area_chart_mode', { mode: e.target.value });
  });
  $('chkAllSeries').addEventListener('change', (e) => { renderCurrentNumbers(); track('chart_all_series', { on: e.target.checked }); });

  // Exports
  $('btnCsv').addEventListener('click', () => {
    const rows = exportResultsCsv();
    toast(rows ? t('csvDone', { n: rows }) : t('csvNone'));
    if (rows) track('export', { kind: 'csv', rows });
  });
  $('btnSummaryCsv').addEventListener('click', () => {
    const rows = exportSummaryCsv();
    toast(rows ? t('csvDone', { n: rows }) : t('csvNone'));
    if (rows) track('export', { kind: 'summary_csv', rows });
  });
  $('btnTraining').addEventListener('click', openTrainingDialog);
  $('dlgTraining').addEventListener('close', (e) => {
    if (e.target.returnValue !== 'ok') return;
    runTrainingExport(document.querySelector('input[name="trainWhich"]:checked').value);
  });

  // Footer
  $('btnOptOut').addEventListener('click', () => {
    const st = analyticsStatus();
    if (!st.optedOut) track('analytics_opt_out');
    setOptOut(!st.optedOut);
    renderAnalyticsNotice();
  });

  // Keyboard
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') viewer.spaceDown = true;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable;
    if ($('dlgTraining').open || $('cardReview').hidden) return;
    if (typing && !(tag === 'input' && e.target.type === 'checkbox')) return;
    const rtl = document.documentElement.dir === 'rtl';
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); viewer.undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (viewer.tool === 'polygon' && viewer.polygon.length) {
      if (e.key === 'Enter') { e.preventDefault(); viewer.closePolygon(); return; }
      if (e.key === 'Escape') { e.preventDefault(); viewer.cancelPolygon(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); viewer.undo(); return; }
    }
    // Arrow keys follow the reading direction of the timeline.
    if (e.key === 'ArrowRight') { e.preventDefault(); step(rtl ? -1 : 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(rtl ? 1 : -1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); stepSeries(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); stepSeries(-1); }
    else if (key === 'b') setTool('brush');
    else if (key === 'e') setTool('eraser');
    else if (key === 'p') setTool('polygon');
    else if (key === 'v') setTool('pan');
    else if (key === 'o') { $('chkOverlay').checked = !$('chkOverlay').checked; viewer.setOverlayVisible($('chkOverlay').checked); }
    else if (key === '[' || key === ']') {
      const el = $('brushSize');
      el.value = String(Math.max(4, Math.min(200, Number(el.value) * (key === ']' ? 1.25 : 0.8))));
      viewer.setBrush(Number(el.value));
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') viewer.spaceDown = false; });

  // One summary of the review work per visit (sent when the tab is hidden).
  let summarySent = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || summarySent || !hasRun) return;
    summarySent = true;
    track('session_summary', { series_opened: session.seriesOpened, edits: session.edits, minutes: Math.round((Date.now() - session.startedAt) / 60000) });
  });
}

function bindState() {
  on('files', () => {
    viewer.setImage(null, 1, 1); // let go of the bitmap before it is closed
    for (const p of previews.values()) p.bitmap.close?.();
    previews.clear();
    renderLoadSummary();
    renderRunState();
    renderSeriesList();
    renderCurrent();
  });
  on('select', () => { highlightSelectedSeries(); renderCurrent(); });
  on('batch-start', () => { renderRunState(); $('progressWrap').hidden = false; });
  on('batch-end', () => { renderRunState(); renderSeriesList(); renderCurrent(); });
  on('progress', renderProgress);
  on('results', scheduleList);
  on('item-done', (w) => {
    scheduleList();
    if (w.item === currentItem() && previews.has(w.item)) { applyLabelsToViewer(w.item); setViewerMessage(''); }
  });
}

async function loadManifest() {
  try {
    const res = await fetch('models/manifest.json');
    if (res.ok) models = (await res.json()).models || [];
  } catch { /* no bundled models */ }
  renderEngineOptions();
}

function init() {
  $('appVersion').textContent = 'v' + APP_VERSION;
  const supported = typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function';
  viewer = new Viewer($('viewCanvas'), {
    onEdit: onMaskEdited,
    onUndoChange: (can) => { $('btnUndo').disabled = !can; },
    onPolygon: () => {},
  });
  viewer.setBrush(Number($('brushSize').value));
  charts = new Charts($('chartClosure'), $('chartArea'), (index) => select(state.selected.series, index));
  $('chkAllSeries').checked = false;
  if (!['t0', 'abs', 'well'].includes(state.settings.areaChart)) state.settings.areaChart = 't0';
  $('selAreaChart').value = state.settings.areaChart;
  bindEvents();
  bindState();
  renderParams();
  // ?lang=he|en in the address wins over the saved choice (handy for shared links).
  const urlLang = new URLSearchParams(location.search).get('lang');
  applyLanguage(detectLang(urlLang === 'he' || urlLang === 'en' ? urlLang : state.settings.lang));
  setTool('pan');
  if (!supported) {
    $('unsupported').hidden = false;
    $('btnRun').disabled = true;
    for (const id of ['btnPickFiles', 'btnPickFolder', 'btnExamples']) $(id).disabled = true;
  }
  initAnalytics();
  loadManifest().then(() => {
    track('app_ready', { version: APP_VERSION, lang: getLang(), cores: navigator.hardwareConcurrency || 0, workers: defaultPoolSize(), supported, models: models.length });
  });
  // Handy for support and automated tests.
  window.__wq = { state, emit, select, version: APP_VERSION };
}

init();
