// File-name parsing: which well / site / time point does an image belong to?
//
// Supported out of the box
//   IncuCyte export   "<plate>_<well>_<site>_<DD>d<HH>h<MM>m.jpg"
//   generic           a well token (A1…P48) and/or a time token
//                     (12h, 1.5hr, t003, day2, 02d06h30m) anywhere in the name
// Files without a recognisable time are ordered by natural sort within their
// folder and get a running frame index instead of hours.

const INCUCYTE = /^(?<prefix>.*?)[_\-\s](?<well>[A-P]\d{1,2})[_\-\s](?<site>\d{1,3})[_\-\s](?<d>\d{1,3})d(?<h>\d{1,2})h(?<m>\d{1,2})m$/i;
const DHM = /(?:^|[_\-\s.])(\d{1,3})d(\d{1,2})h(?:(\d{1,2})m)?(?=$|[_\-\s.])/i;
const HOURS = /(?:^|[_\-\s.])(\d+(?:\.\d+)?)\s?(?:h|hr|hrs|hours?)(?=$|[_\-\s.])/i;
const DAYS = /(?:^|[_\-\s.])(?:day|d)[_\-\s]?(\d+(?:\.\d+)?)(?=$|[_\-\s.])/i;
const FRAME = /(?:^|[_\-\s.])(?:t|tp|time|frame)[_\-\s]?(\d+)(?=$|[_\-\s.])/i;
const WELL = /(?:^|[_\-\s.])([A-P])(\d{1,2})(?=$|[_\-\s.])/i;
const SITE = /(?:^|[_\-\s.])(?:s|site|fov|pos)[_\-\s]?(\d+)(?=$|[_\-\s.])/i;

export function stripExtension(name) {
  return name.replace(/\.[^./\\]+$/, '');
}

function normWell(letter, num) {
  return letter.toUpperCase() + String(parseInt(num, 10));
}

/**
 * @param {string} fileName  base name (with or without extension)
 * @param {string} dir       folder path the file came from ('' if unknown)
 * @returns {{seriesKey:string, plate:string, well:string, site:string,
 *            hours:(number|null), frame:(number|null), pattern:string}}
 */
export function parseFileName(fileName, dir = '') {
  const base = stripExtension(fileName);
  let plate = '';
  let well = '';
  let site = '1';
  let hours = null;
  let frame = null;
  let pattern = 'none';
  let rest = base;

  const m = INCUCYTE.exec(base);
  if (m) {
    const g = m.groups;
    plate = g.prefix.trim();
    well = normWell(g.well[0], g.well.slice(1));
    site = String(parseInt(g.site, 10));
    hours = parseInt(g.d, 10) * 24 + parseInt(g.h, 10) + parseInt(g.m, 10) / 60;
    pattern = 'incucyte';
    rest = '';
  } else {
    let t;
    if ((t = DHM.exec(rest))) {
      hours = parseInt(t[1], 10) * 24 + parseInt(t[2], 10) + (t[3] ? parseInt(t[3], 10) / 60 : 0);
      pattern = 'time';
    } else if ((t = HOURS.exec(rest))) {
      hours = parseFloat(t[1]);
      pattern = 'time';
    } else if ((t = FRAME.exec(rest))) {
      frame = parseInt(t[1], 10);
      pattern = 'frame';
    } else if ((t = DAYS.exec(rest))) {
      hours = parseFloat(t[1]) * 24;
      pattern = 'time';
    }
    if (t) rest = (rest.slice(0, t.index) + '_' + rest.slice(t.index + t[0].length));
    const s = SITE.exec(rest);
    if (s) {
      site = String(parseInt(s[1], 10));
      rest = rest.slice(0, s.index) + '_' + rest.slice(s.index + s[0].length);
    }
    const wm = WELL.exec(rest);
    if (wm && parseInt(wm[2], 10) >= 1 && parseInt(wm[2], 10) <= 48) {
      well = normWell(wm[1], wm[2]);
      rest = rest.slice(0, wm.index) + '_' + rest.slice(wm.index + wm[0].length);
    }
    plate = rest.replace(/[_\-\s.]+/g, ' ').trim();
    // Without a time token the remaining text usually *is* the running
    // number, so it must not split one series into many.
    if (pattern === 'none') plate = well ? plate.replace(/\d+/g, '').trim() : '';
  }

  const folder = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const seriesKey = [folder, plate, well || '-', site].join('|');
  return { seriesKey, plate, well, site, hours, frame, pattern };
}

/** Natural-order comparison ("img2" < "img10"). */
export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Group parsed files into time series.
 * @param {Array<{name:string, dir?:string}>} files  any objects with name (+dir)
 * @returns {Array<{key:string, label:string, plate:string, well:string, site:string,
 *                  timeUnit:'h'|'frame', items:Array<{file:object, time:number, hours:(number|null)}>}>}
 */
export function groupIntoSeries(files) {
  const map = new Map();
  for (const file of files) {
    const info = parseFileName(file.name, file.dir || '');
    let s = map.get(info.seriesKey);
    if (!s) {
      s = { key: info.seriesKey, folder: file.dir || '', plate: info.plate, well: info.well, site: info.site, raw: [] };
      map.set(info.seriesKey, s);
    }
    s.raw.push({ file, info });
  }
  const folders = new Set([...map.values()].map((s) => s.folder));
  const plates = new Set([...map.values()].map((s) => s.plate));
  const out = [];
  for (const s of map.values()) {
    const timed = s.raw.every((r) => r.info.hours !== null);
    const framed = !timed && s.raw.every((r) => r.info.frame !== null);
    let items;
    if (timed) {
      items = s.raw.map((r) => ({ file: r.file, time: r.info.hours, hours: r.info.hours }));
      items.sort((a, b) => a.time - b.time || naturalCompare(a.file.name, b.file.name));
    } else if (framed) {
      items = s.raw.map((r) => ({ file: r.file, time: r.info.frame, hours: null }));
      items.sort((a, b) => a.time - b.time || naturalCompare(a.file.name, b.file.name));
    } else {
      items = s.raw.slice().sort((a, b) => naturalCompare(a.file.name, b.file.name))
        .map((r, i) => ({ file: r.file, time: i, hours: null }));
    }
    const siteCount = [...map.values()].filter((o) => o.folder === s.folder && o.plate === s.plate && o.well === s.well).length;
    let label = s.well || s.plate || s.folder.split('/').pop() || 'Series';
    if (siteCount > 1) label += ` · ${s.site}`;
    if (s.well) {
      // Only mention what actually differs between the loaded plates.
      const where = [];
      if (folders.size > 1 && s.folder) where.push(s.folder.split('/').pop());
      if (plates.size > 1 && s.plate) where.push(s.plate);
      if (where.length) label = `${where.join(' / ')} · ${label}`;
    }
    out.push({ key: s.key, label, plate: s.plate, well: s.well, site: s.site, folder: s.folder, timeUnit: timed ? 'h' : 'frame', items });
  }
  out.sort((a, b) => naturalCompare(a.folder + a.plate, b.folder + b.plate) || compareWells(a.well, b.well) || naturalCompare(a.site, b.site) || naturalCompare(a.label, b.label));
  return out;
}

function compareWells(a, b) {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
}
