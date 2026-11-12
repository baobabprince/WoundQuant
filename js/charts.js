// Time-course charts (Chart.js): closure % and wound share of the well.

import { t } from './i18n.js';

const ACCENT = '#0f766e';
const WOUND = '#ef4444';
const FAINT = 'rgba(100, 116, 139, 0.28)';
const MAX_BACKGROUND_SERIES = 150;

function baseOptions(onPoint) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        filter: (item) => item.datasetIndex === 0,
        callbacks: { label: (c) => `${c.parsed.y.toFixed(1)}%` },
      },
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: '' }, grid: { color: '#eef1f4' } },
      y: { title: { display: true, text: '' }, grid: { color: '#eef1f4' } },
    },
    onClick: (ev, elements) => {
      const hit = elements.find((el) => el.datasetIndex === 0);
      if (hit) onPoint(hit.index);
    },
  };
}

export class Charts {
  /** @param {(pointIndex:number)=>void} onPoint  called with the index among analysed points */
  constructor(closureCanvas, areaCanvas, onPoint) {
    this.indexMap = [];
    const click = (i) => { if (this.indexMap[i] !== undefined) onPoint(this.indexMap[i]); };
    const Chart = window.Chart;
    this.closure = new Chart(closureCanvas, { type: 'line', data: { datasets: [] }, options: baseOptions(click) });
    this.area = new Chart(areaCanvas, { type: 'line', data: { datasets: [] }, options: baseOptions(click) });
  }

  /**
   * @param {{timeUnit:string, points:Array}} current   metrics of the selected series
   * @param {Array<Array>} others   points of other series (drawn faintly), may be empty
   * @param {number} selectedItem   index of the selected time point in the series
   * @param {{mode:'t0'|'abs'|'well', useMm2:boolean}} areaMode   units of the wound-area chart
   */
  update(current, others, selectedItem, areaMode = { mode: 'well', useMm2: false }) {
    // Wound area of a point in the chosen units (null = cannot be shown).
    const areaOf = (p) => {
      if (areaMode.mode === 't0') return p.areaReductionPct === null ? null : 100 - p.areaReductionPct;
      if (areaMode.mode === 'abs') return areaMode.useMm2 ? p.woundAreaMm2 : p.woundAreaPx;
      return p.woundPct;
    };
    const xOf = (p) => (current.timeUnit === 'h' && p.hours !== null ? p.hours : p.time);
    this.indexMap = [];
    const closure = [];
    const area = [];
    const radius = [];
    current.points.forEach((p, i) => {
      if (!p.analysed) return;
      this.indexMap.push(i);
      closure.push({ x: xOf(p), y: p.closurePct });
      area.push({ x: xOf(p), y: areaOf(p) });
      radius.push(i === selectedItem ? 7 : 3.5);
    });
    const main = (data, color) => ({
      data, borderColor: color, backgroundColor: color, borderWidth: 2.5, pointRadius: radius,
      pointHoverRadius: 7, tension: 0, spanGaps: true, order: 0,
    });
    const faint = (get) => others.slice(0, MAX_BACKGROUND_SERIES).map((pts) => ({
      data: pts.filter((p) => p.analysed && get(p) !== null).map((p) => ({ x: xOf(p), y: get(p) })),
      borderColor: FAINT, borderWidth: 1, pointRadius: 0, pointHitRadius: 0, tension: 0, order: 1,
    }));
    const xTitle = current.timeUnit === 'h' ? t('axisHours') : t('axisFrame');

    this.closure.data.datasets = [main(closure, ACCENT), ...faint((p) => p.closurePct)];
    this.closure.options.scales.x.title.text = xTitle;
    this.closure.options.scales.y.title.text = t('axisClosure');
    this.closure.options.scales.y.suggestedMin = 0;
    this.closure.options.scales.y.suggestedMax = 100;
    this.closure.update();

    const percent = areaMode.mode !== 'abs';
    this.area.data.datasets = [main(area, WOUND), ...faint(areaOf)];
    this.area.options.scales.x.title.text = xTitle;
    this.area.options.scales.y.title.text = areaMode.mode === 't0' ? t('axisWoundT0')
      : areaMode.mode === 'abs' ? t(areaMode.useMm2 ? 'axisWoundMm2' : 'axisWoundPx') : t('axisWound');
    this.area.options.scales.y.suggestedMax = areaMode.mode === 't0' ? 100 : undefined;
    this.area.options.plugins.tooltip.callbacks.label = (c) => (percent ? `${c.parsed.y.toFixed(1)}%`
      : areaMode.useMm2 ? `${c.parsed.y.toFixed(2)} mm²` : `${Math.round(c.parsed.y).toLocaleString('en-US')} px`);
    this.area.options.scales.y.suggestedMin = 0;
    this.area.update();
  }
}
