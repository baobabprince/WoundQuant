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
   */
  update(current, others, selectedItem) {
    const xOf = (p) => (current.timeUnit === 'h' && p.hours !== null ? p.hours : p.time);
    this.indexMap = [];
    const closure = [];
    const area = [];
    const radius = [];
    current.points.forEach((p, i) => {
      if (!p.analysed) return;
      this.indexMap.push(i);
      closure.push({ x: xOf(p), y: p.closurePct });
      area.push({ x: xOf(p), y: p.woundPct });
      radius.push(i === selectedItem ? 7 : 3.5);
    });
    const main = (data, color) => ({
      data, borderColor: color, backgroundColor: color, borderWidth: 2.5, pointRadius: radius,
      pointHoverRadius: 7, tension: 0, spanGaps: true, order: 0,
    });
    const faint = (key) => others.slice(0, MAX_BACKGROUND_SERIES).map((pts) => ({
      data: pts.filter((p) => p.analysed && p[key] !== null).map((p) => ({ x: xOf(p), y: p[key] })),
      borderColor: FAINT, borderWidth: 1, pointRadius: 0, pointHitRadius: 0, tension: 0, order: 1,
    }));
    const xTitle = current.timeUnit === 'h' ? t('axisHours') : t('axisFrame');

    this.closure.data.datasets = [main(closure, ACCENT), ...faint('closurePct')];
    this.closure.options.scales.x.title.text = xTitle;
    this.closure.options.scales.y.title.text = t('axisClosure');
    this.closure.options.scales.y.suggestedMin = 0;
    this.closure.options.scales.y.suggestedMax = 100;
    this.closure.update();

    this.area.data.datasets = [main(area, WOUND), ...faint('woundPct')];
    this.area.options.scales.x.title.text = xTitle;
    this.area.options.scales.y.title.text = t('axisWound');
    this.area.options.scales.y.suggestedMin = 0;
    this.area.update();
  }
}
