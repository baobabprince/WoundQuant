// Usage analytics through Umami (cookieless, no personal data).
//
// The rest of the app only calls track(name, data). This module decides
// whether anything is sent at all:
//   • no websiteId in config.js      → nothing is loaded, track() is a no-op
//   • visitor opted out in the footer → Umami's own "umami.disabled" switch
//   • tracker blocked / offline       → events are dropped silently
//
// Privacy rule enforced here: event data may only hold short strings, numbers
// and booleans. Callers pass counts and settings — never file names, paths or
// anything read from an image.

const OPT_OUT_KEY = 'umami.disabled'; // the key Umami's tracker itself checks
const MAX_QUEUE = 50;
const MAX_LOG = 200;

const cfg = (typeof window !== 'undefined' && window.WOUNDQUANT_CONFIG && window.WOUNDQUANT_CONFIG.analytics) || {};
const queue = [];
const log = [];
let state = 'off'; // off | loading | ready | failed
const debug = typeof location !== 'undefined' && /[?&]analytics=debug\b/.test(location.search);

if (typeof window !== 'undefined') window.__wqAnalyticsLog = log;

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function isConfigured() {
  return typeof cfg.websiteId === 'string' && cfg.websiteId.trim() !== '';
}

export function isOptedOut() {
  return !!storageGet(OPT_OUT_KEY);
}

export function setOptOut(optOut) {
  try {
    if (optOut) localStorage.setItem(OPT_OUT_KEY, '1'); else localStorage.removeItem(OPT_OUT_KEY);
  } catch { /* storage unavailable: nothing to remember */ }
  if (optOut) queue.length = 0;
  else if (state === 'off') initAnalytics();
}

function hostAllowed() {
  const domains = Array.isArray(cfg.domains) ? cfg.domains.filter(Boolean) : [];
  return domains.length === 0 || domains.includes(location.hostname);
}

function doNotTrack() {
  if (cfg.respectDoNotTrack === false) return false;
  const dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
  return dnt === '1' || dnt === 'yes';
}

/** Will events from this page actually be sent? */
export function isActive() {
  return isConfigured() && hostAllowed() && !isOptedOut() && !doNotTrack();
}

function sanitize(data) {
  if (!data || typeof data !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000; }
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 100);
  }
  return out;
}

function send(name, data) {
  try {
    if (data) window.umami.track(name, data); else window.umami.track(name);
  } catch { /* analytics must never break the app */ }
}

function flush() {
  while (queue.length) {
    const [name, data] = queue.shift();
    send(name, data);
  }
}

/** Load the Umami tracker (once). Safe to call when analytics is not configured. */
export function initAnalytics() {
  if (state !== 'off' || !isActive()) return;
  state = 'loading';
  const s = document.createElement('script');
  s.defer = true;
  s.src = cfg.scriptUrl || 'https://cloud.umami.is/script.js';
  s.dataset.websiteId = cfg.websiteId.trim();
  if (cfg.hostUrl) s.dataset.hostUrl = cfg.hostUrl;
  if (Array.isArray(cfg.domains) && cfg.domains.length) s.dataset.domains = cfg.domains.join(',');
  if (cfg.respectDoNotTrack !== false) s.dataset.doNotTrack = 'true';
  // The app keeps its settings out of the URL, but a shared link might carry
  // a query string; page views are recorded without it.
  s.dataset.excludeSearch = 'true';
  s.onload = () => {
    if (window.umami && typeof window.umami.track === 'function') { state = 'ready'; flush(); }
    else { state = 'failed'; queue.length = 0; }
  };
  s.onerror = () => { state = 'failed'; queue.length = 0; };
  document.head.appendChild(s);
}

/**
 * Record a usage event.
 * @param {string} name  snake_case, ≤ 50 characters (Umami limit)
 * @param {Object<string, string|number|boolean>} [data]
 */
export function track(name, data) {
  const clean = sanitize(data);
  const entry = { name: String(name).slice(0, 50), data: clean, at: Date.now(), sent: false };
  if (isActive() && state !== 'failed') {
    entry.sent = true;
    if (state === 'ready') send(entry.name, clean);
    else if (queue.length < MAX_QUEUE) queue.push([entry.name, clean]);
  }
  log.push(entry);
  if (log.length > MAX_LOG) log.shift();
  if (debug) console.debug('[analytics]', entry.name, clean || '', entry.sent ? '' : '(not sent)');
}

/** For the footer notice. */
export function analyticsStatus() {
  return { configured: isConfigured(), active: isActive(), optedOut: isOptedOut(), state };
}
