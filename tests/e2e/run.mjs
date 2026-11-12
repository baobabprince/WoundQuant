#!/usr/bin/env node
// End-to-end test in a real (headless) Chrome:  npm run test:e2e
//
// Needs a Chrome/Chromium binary: set CHROME_PATH, or have one in a usual
// location. Exercises the example data through loading, analysis with both
// engines, manual correction, the result cache, exports and analytics events.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from '../../tools/serve.mjs';

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal uncompressed 16-bit greyscale TIFF using only a narrow part of the range (like a camera). */
function grey16Tiff(rgba, w, h) {
  const entries = [[256, 3, w], [257, 3, h], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 3, h], [279, 4, w * h * 2]];
  const dataOffset = 8 + 2 + entries.length * 12 + 4;
  const buf = Buffer.alloc(dataOffset + w * h * 2);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, value], i) => {
    const o = 10 + i * 12;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(1, o + 4);
    if (tag === 273) buf.writeUInt32LE(dataOffset, o + 8);
    else if (type === 3) buf.writeUInt16LE(value, o + 8);
    else buf.writeUInt32LE(value, o + 8);
  });
  for (let i = 0; i < w * h; i++) buf.writeUInt16LE(500 + rgba[i * 4] * 12, dataOffset + i * 2);
  return buf;
}

const executablePath = findChrome();
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH=/path/to/chrome and run again.');
  process.exit(2);
}

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-e2e-'));
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const extraArgs = (process.env.CHROME_ARGS || '--no-sandbox --disable-gpu').split(' ').filter(Boolean);
const browser = await puppeteer.launch({ executablePath, headless: 'shell', args: extraArgs });
const steps = [];
let failed = false;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    steps.push(`ok    ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed = true;
    steps.push(`FAIL  ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForDownload(pattern, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = fs.readdirSync(downloads).find((f) => pattern.test(f) && !f.endsWith('.crdownload'));
    if (hit) return path.join(downloads, hit);
    await wait(200);
  }
  throw new Error('download did not arrive: ' + pattern);
}

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

const seriesState = () => page.evaluate(() => window.__wq.state.series.map((s) => ({
  label: s.label,
  items: s.items.map((i) => ({ status: i.status, error: i.error, source: i.result && i.result.source, engine: i.result && i.result.engine, wound: i.result && i.result.counts.wound, well: i.result && i.result.counts.well })),
})));
const waitIdle = () => page.waitForFunction(() => !window.__wq.state.running && window.__wq.state.series.every((s) => s.items.every((i) => i.result || i.status === 'error')), { timeout: 300000 });
const events = () => page.evaluate(() => window.__wqAnalyticsLog.map((e) => ({ name: e.name, data: e.data, sent: e.sent })));
const closureOf = (items) => 100 * (1 - (items.at(-1).wound / items.at(-1).well) / (items[0].wound / items[0].well));

let classical;

await step('page loads in English without errors', async () => {
  await page.goto(base + '?analytics=debug&lang=en', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__wq);
  assert.equal(await page.$eval('html', (el) => el.dir), 'ltr');
  assert.equal(await page.$eval('#btnRun', (el) => el.disabled), true);
  assert.equal(await page.$eval('#cardReview', (el) => el.hidden), true);
});

await step('example images load and are grouped into wells', async () => {
  await page.click('#btnExamples');
  await page.waitForFunction(() => window.__wq.state.imageCount === 12, { timeout: 60000 });
  const s = await seriesState();
  assert.deepEqual(s.map((x) => x.label), ['B1', 'B8', 'C6']);
  assert.ok(s.every((x) => x.items.length === 4));
  assert.match(await page.$eval('#loadSummary', (el) => el.textContent), /12 images · 3 series/);
});

await step('classical analysis of the batch', async () => {
  await page.click('#btnRun');
  await waitIdle();
  classical = await seriesState();
  for (const s of classical) for (const i of s.items) assert.equal(i.status, 'done', `${s.label}: ${i.error}`);
  const b1 = closureOf(classical[0].items);
  const c6 = closureOf(classical[2].items);
  assert.ok(b1 > 60 && b1 < 90, `B1 closure ${b1}`);
  assert.ok(c6 > 60 && c6 < 90, `C6 closure ${c6}`);
  assert.ok(closureOf(classical[1].items) < 0, 'B8 does not close');
  await page.waitForFunction(() => document.querySelectorAll('#seriesList li').length === 3);
  assert.match(await page.$eval('#mWoundPct', (el) => el.textContent), /^\d+\.\d%$/);
});

await step('a series whose wound grows is marked as unreliable', async () => {
  await page.click('#seriesList li:nth-child(2)');
  await page.waitForFunction(() => !document.getElementById('seriesWarning').hidden);
  await page.click('#seriesList li:nth-child(1)');
  await page.waitForFunction(() => document.getElementById('seriesWarning').hidden);
});

await step('second run comes from the result cache', async () => {
  await page.click('#btnRun');
  await waitIdle();
  await page.waitForFunction(() => window.__wqAnalyticsLog.filter((e) => e.name === 'analysis_finished').length === 2);
  const last = (await events()).filter((e) => e.name === 'analysis_finished').at(-1);
  assert.equal(last.data.cached, 12);
  assert.equal(last.data.computed, 0);
});

await step('time slider and keyboard move through the series', async () => {
  await page.focus('#viewCanvas');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.__wq.state.selected.item === 1);
  assert.match(await page.$eval('#timeLabel', (el) => el.textContent), /3 d/);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.__wq.state.selected.item === 0);
});

await step('brush correction changes the numbers and is stored as manual', async () => {
  await page.waitForFunction(() => document.getElementById('viewerMessage').hidden, { timeout: 30000 });
  await page.keyboard.press('b');
  const box = await (await page.$('#viewCanvas')).boundingBox();
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.82; // cells below the wound of B1
  await page.mouse.move(x - 40, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__wq.state.series[0].items[0].result.source === 'manual');
  const after = await seriesState();
  assert.ok(after[0].items[0].wound > classical[0].items[0].wound, 'painted cells count as wound');
  assert.equal(await page.$eval('#btnUndo', (el) => el.disabled), false);
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await page.waitForFunction((n) => window.__wq.state.series[0].items[0].result.counts.wound === n, {}, classical[0].items[0].wound);
  // paint again and leave it for the persistence check
  await page.mouse.move(x - 40, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 8 });
  await page.mouse.up();
  await wait(800); // debounce of the IndexedDB write
});

await step('polygon tool adds an area', async () => {
  const before = (await seriesState())[0].items[0].wound;
  await page.keyboard.press('p');
  const box = await (await page.$('#viewCanvas')).boundingBox();
  const pts = [[0.2, 0.45], [0.26, 0.45], [0.26, 0.55], [0.2, 0.55]];
  for (const [fx, fy] of pts) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => window.__wq.state.series[0].items[0].result.counts.wound > n, {}, before);
  await page.keyboard.press('v');
  await wait(800);
});

await step('exports: results CSV, summary CSV, training ZIP', async () => {
  await page.click('#btnCsv');
  const csv = fs.readFileSync(await waitForDownload(/^woundquant_results_.*\.csv$/), 'utf8');
  const lines = csv.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines.length, 13);
  assert.ok(lines[0].startsWith('series,plate,well,site,file,time,'));
  assert.ok(lines[1].includes(',manual,'), 'the corrected image is marked manual');
  await page.click('#btnSummaryCsv');
  const summary = fs.readFileSync(await waitForDownload(/^woundquant_summary_.*\.csv$/), 'utf8');
  assert.equal(summary.trim().split('\r\n').length, 4);
  await page.click('#btnTraining');
  await page.waitForSelector('#dlgTraining[open]');
  assert.match(await page.$eval('#trainManualLabel', (el) => el.textContent), /1/);
  await page.click('#btnTrainingOk');
  const zip = fs.readFileSync(await waitForDownload(/^woundquant_training_.*\.zip$/));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 4, 'image + label + meta + readme');
  assert.ok(zip.includes(Buffer.from('"source":"manual"')));
});

await step('manual correction survives a reload and a new run', async () => {
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__wq);
  await page.click('#btnExamples');
  await page.waitForFunction(() => window.__wq.state.imageCount === 12, { timeout: 60000 });
  await page.click('#btnRun');
  await waitIdle();
  const s = await seriesState();
  assert.equal(s[0].items[0].source, 'manual');
  assert.equal(s[0].items[1].source, 'auto');
  assert.ok(s[0].items[0].wound > classical[0].items[0].wound);
});

await step('reset to automatic restores the classical result', async () => {
  await page.waitForFunction(() => !document.getElementById('btnResetMask').disabled);
  await page.click('#btnResetMask');
  await page.waitForFunction(() => window.__wq.state.series[0].items[0].result.source === 'auto', { timeout: 60000 });
  assert.equal((await seriesState())[0].items[0].wound, classical[0].items[0].wound);
});

await step('neural-network engine runs in the browser and roughly agrees', async () => {
  const options = await page.$$eval('#selEngine option', (els) => els.map((e) => e.value));
  const model = options.find((v) => v.startsWith('model:'));
  assert.ok(model, 'a bundled model is listed in models/manifest.json');
  await page.select('#selEngine', model);
  await page.click('#btnRun');
  await waitIdle();
  const s = await seriesState();
  for (const x of s) for (const i of x.items) { assert.equal(i.status, 'done', `${x.label}: ${i.error}`); assert.equal(i.engine, model); }
  const b1 = closureOf(s[0].items);
  const c6 = closureOf(s[2].items);
  assert.ok(b1 > 50 && b1 < 95, `B1 closure with the model ${b1}`);
  assert.ok(c6 > 50 && c6 < 95, `C6 closure with the model ${c6}`);
  console.log('      closure B1/C6: classical', closureOf(classical[0].items).toFixed(1), closureOf(classical[2].items).toFixed(1), '· model', b1.toFixed(1), c6.toFixed(1));
  await page.select('#selEngine', 'classical');
});

await step('a user-supplied ONNX model can be loaded and used', async () => {
  await page.select('#selEngine', 'custom');
  await (await page.$('#inModel')).uploadFile(path.join(repoRoot, 'models', 'woundquant-bootstrap-v0.onnx'));
  await page.waitForFunction(() => /MB/.test(document.getElementById('customModelHelp').textContent));
  await page.click('#btnRun');
  await waitIdle();
  const s = await seriesState();
  assert.ok(s.every((x) => x.items.every((i) => i.status === 'done' && i.engine.startsWith('model:custom-'))), JSON.stringify(s[0].items[0]));
  await page.select('#selEngine', 'classical');
});

await step('TIFF files (8-bit RGB and 16-bit grey) without a time in the name', async () => {
  const require = createRequire(import.meta.url);
  const UTIF = require('utif');
  const { syntheticWell } = await import('../unit/helpers.mjs');
  const dir = path.join(downloads, 'tiff');
  fs.mkdirSync(dir);
  const files = [];
  [150, 110, 60].forEach((radius, i) => {
    const img = syntheticWell({ size: 800, wellRadius: 370, woundRadius: radius, seed: i + 1 });
    const file = path.join(dir, `scan_${i + 1}.tif`);
    if (i < 2) fs.writeFileSync(file, Buffer.from(UTIF.encodeImage(new Uint8Array(img.data.buffer), 800, 800)));
    else fs.writeFileSync(file, grey16Tiff(img.data, 800, 800));
    files.push(file);
  });
  await (await page.$('#inputFiles')).uploadFile(...files);
  await page.waitForFunction(() => window.__wq.state.imageCount === 15);
  assert.match(await page.$eval('#loadNote', (el) => (el.hidden ? '' : el.textContent)), /3 files/);
  await page.click('#btnRun');
  await waitIdle();
  const s = (await seriesState()).find((x) => x.items.length === 3);
  assert.ok(s, 'the three TIFFs form one series');
  s.items.forEach((it, i) => {
    assert.equal(it.status, 'done', it.error);
    const expected = Math.PI * [150, 110, 60][i] ** 2; // 800 px images: one grid cell per pixel
    assert.ok(Math.abs(it.wound / expected - 1) < 0.12, `tiff ${i}: wound ${it.wound} vs ${expected}`);
  });
});

await step('analytics: events are recorded, nothing is sent, no file names leak', async () => {
  const log = await events();
  const names = new Set(log.map((e) => e.name));
  for (const n of ['app_ready', 'files_added', 'analysis_started', 'analysis_finished', 'engine_changed', 'mask_reset']) assert.ok(names.has(n), 'missing event ' + n);
  assert.ok(log.every((e) => e.sent === false), 'no website ID configured → nothing leaves the browser');
  const text = JSON.stringify(log);
  assert.ok(!/\.jpg|EXP3|burn/i.test(text), 'event data must not contain file names');
  const external = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((u) => !u.startsWith(location.origin)));
  assert.deepEqual(external, [], 'no third-party requests');
});

await step('Hebrew interface is right-to-left', async () => {
  await page.click('#btnLang');
  assert.equal(await page.$eval('html', (el) => el.dir), 'rtl');
  assert.equal(await page.$eval('html', (el) => el.lang), 'he');
  assert.match(await page.$eval('#btnRun', (el) => el.textContent), /[\u0590-\u05ff]/);
  if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
});

await step('analytics switched on: Umami tracker is loaded, events flow, opt-out stops them', async () => {
  const p2 = await browser.newPage();
  await p2.setRequestInterception(true);
  let trackerRequests = 0;
  p2.on('request', (req) => {
    const url = req.url();
    if (url.endsWith('/config.js')) {
      req.respond({ contentType: 'text/javascript', body: `window.WOUNDQUANT_CONFIG = { analytics: { websiteId: 'test-id', scriptUrl: 'https://umami.invalid/script.js', domains: ['127.0.0.1'], respectDoNotTrack: true } };` });
    } else if (url === 'https://umami.invalid/script.js') {
      trackerRequests++;
      // Stand-in for the real tracker: same public API, records instead of sending.
      req.respond({ contentType: 'text/javascript', body: `window.__sent = []; window.umami = { track: function () { if (!localStorage.getItem('umami.disabled')) window.__sent.push([].slice.call(arguments)); } };` });
    } else req.continue();
  });
  await p2.goto(base + '?lang=en', { waitUntil: 'networkidle0' });
  await p2.waitForFunction(() => window.__sent && window.__sent.some((e) => e[0] === 'app_ready'), { timeout: 10000 });
  const tag = await p2.$eval('script[data-website-id]', (el) => ({ id: el.dataset.websiteId, domains: el.dataset.domains, dnt: el.dataset.doNotTrack }));
  assert.deepEqual(tag, { id: 'test-id', domains: '127.0.0.1', dnt: 'true' });
  assert.equal(await p2.$eval('#btnOptOut', (el) => el.hidden), false);
  assert.match(await p2.$eval('#analyticsNotice', (el) => el.textContent), /anonymous usage statistics/);
  await p2.click('#btnLang');
  await p2.waitForFunction(() => window.__sent.some((e) => e[0] === 'language_changed' && e[1].lang === 'he'));
  await p2.click('#btnOptOut');
  const before = await p2.evaluate(() => window.__sent.length);
  await p2.click('#btnLang');
  await wait(300);
  assert.equal(await p2.evaluate(() => window.__sent.length), before, 'nothing is sent after opting out');
  assert.equal(await p2.evaluate(() => localStorage.getItem('umami.disabled')), '1');
  // and the choice holds on the next visit: the tracker is not even requested
  await p2.reload({ waitUntil: 'networkidle0' });
  await p2.waitForFunction(() => window.__wq);
  assert.equal(trackerRequests, 1);
  assert.equal(await p2.$('script[data-website-id]'), null);
  await p2.evaluate(() => localStorage.removeItem('umami.disabled'));
  await p2.close();
});

await step('no script errors during the whole session', async () => {
  assert.equal(problems.length, 0, problems.join(' | '));
});

await browser.close();
server.close();
fs.rmSync(downloads, { recursive: true, force: true });
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
