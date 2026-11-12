// Image viewer with result overlay and manual correction tools.
//
// World coordinates are full-resolution image pixels. The label map lives on
// the analysis grid (one cell = S × S image pixels) and is edited in place.

import { LABEL } from './core/segment.js';

const MAX_UNDO = 20;

export class Viewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onEdit:Function, onUndoChange:Function, onPolygon:Function}} hooks
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.bitmap = null;
    this.imgW = 1;
    this.imgH = 1;
    this.labels = null;
    this.gw = 0;
    this.gh = 0;
    this.S = 1;
    this.overlay = document.createElement('canvas');
    this.overlayDirty = true;
    this.showOverlay = true;
    this.tool = 'pan';
    this.brush = 40; // diameter in image pixels
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.fitted = true;
    this.undoStack = [];
    this.polygon = [];
    this.pointer = null;
    this.drag = null;
    this.frame = 0;
    this.spaceDown = false;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => { this.pointer = null; this.requestRender(); });
    canvas.addEventListener('dblclick', (e) => { if (this.tool === 'polygon') { e.preventDefault(); this.closePolygon(); } });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  // ---- content ------------------------------------------------------------

  setImage(bitmap, imgW, imgH) {
    const sizeChanged = imgW !== this.imgW || imgH !== this.imgH;
    // Never keep a pending frame that would draw a bitmap its owner is about to close.
    if (!bitmap && this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
    this.bitmap = bitmap;
    this.imgW = imgW || 1;
    this.imgH = imgH || 1;
    if (sizeChanged || this.fitted) this.fit();
    this.requestRender();
  }

  /** @param {Uint8Array|null} labels  edited in place by the tools */
  setLabels(labels, gw, gh, S) {
    this.labels = labels;
    this.gw = gw || 0;
    this.gh = gh || 0;
    this.S = S || 1;
    this.undoStack = [];
    this.polygon = [];
    this.overlayDirty = true;
    this.hooks.onUndoChange?.(false);
    this.hooks.onPolygon?.(0);
    this.requestRender();
  }

  setOverlayVisible(v) { this.showOverlay = v; this.requestRender(); }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'polygon' && this.polygon.length) { this.polygon = []; this.hooks.onPolygon?.(0); }
    this.canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    this.requestRender();
  }

  setBrush(diameter) { this.brush = diameter; this.requestRender(); }

  // ---- view ---------------------------------------------------------------

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssW = rect.width || 1;
    this.cssH = rect.height || 1;
    if (this.fitted) this.fit(); else this.requestRender();
  }

  fit() {
    this.scale = Math.min(this.cssW / this.imgW, this.cssH / this.imgH);
    this.ox = (this.cssW - this.imgW * this.scale) / 2;
    this.oy = (this.cssH - this.imgH * this.scale) / 2;
    this.fitted = true;
    this.requestRender();
  }

  zoomBy(factor, cx = this.cssW / 2, cy = this.cssH / 2) {
    const min = Math.min(this.cssW / this.imgW, this.cssH / this.imgH) * 0.5;
    const max = 8;
    const next = Math.max(min, Math.min(max, this.scale * factor));
    const wx = (cx - this.ox) / this.scale;
    const wy = (cy - this.oy) / this.scale;
    this.scale = next;
    this.ox = cx - wx * next;
    this.oy = cy - wy * next;
    this.fitted = false;
    this.requestRender();
  }

  toWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return { cx, cy, x: (cx - this.ox) / this.scale, y: (cy - this.oy) / this.scale };
  }

  // ---- pointer ------------------------------------------------------------

  onWheel(e) {
    e.preventDefault();
    const p = this.toWorld(e);
    this.zoomBy(Math.exp(-e.deltaY * 0.0015), p.cx, p.cy);
  }

  onDown(e) {
    const p = this.toWorld(e);
    this.pointer = p;
    const panning = this.tool === 'pan' || e.button === 1 || e.button === 2 || this.spaceDown;
    if (panning) {
      this.drag = { kind: 'pan', cx: p.cx, cy: p.cy, ox: this.ox, oy: this.oy };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (!this.labels || e.button !== 0) return;
    if (this.tool === 'polygon') {
      // Clicking near the first vertex closes the outline.
      if (this.polygon.length >= 3) {
        const f = this.polygon[0];
        if (Math.hypot(f.x - p.x, f.y - p.y) * this.scale < 10) { this.closePolygon(); return; }
      }
      // A double-click arrives as two clicks; ignore the duplicate vertex.
      const last = this.polygon[this.polygon.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) * this.scale > 3) this.polygon.push({ x: p.x, y: p.y });
      this.hooks.onPolygon?.(this.polygon.length);
      this.requestRender();
      return;
    }
    this.pushUndo();
    this.drag = { kind: 'paint', x: p.x, y: p.y, changed: false };
    this.canvas.setPointerCapture(e.pointerId);
    this.paint(p.x, p.y, p.x, p.y);
  }

  onMove(e) {
    const p = this.toWorld(e);
    this.pointer = p;
    if (this.drag && this.drag.kind === 'pan') {
      this.ox = this.drag.ox + (p.cx - this.drag.cx);
      this.oy = this.drag.oy + (p.cy - this.drag.cy);
      this.fitted = false;
    } else if (this.drag && this.drag.kind === 'paint') {
      this.paint(this.drag.x, this.drag.y, p.x, p.y);
      this.drag.x = p.x;
      this.drag.y = p.y;
    }
    this.requestRender();
  }

  onUp(e) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
    if (drag.kind === 'paint') {
      if (drag.changed) this.hooks.onEdit?.(this.tool);
      else this.dropUndo();
    }
  }

  // ---- editing ------------------------------------------------------------

  pushUndo() {
    this.undoStack.push(this.labels.slice());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.hooks.onUndoChange?.(true);
  }

  dropUndo() {
    this.undoStack.pop();
    this.hooks.onUndoChange?.(this.undoStack.length > 0);
  }

  undo() {
    if (this.polygon.length) { this.polygon.pop(); this.hooks.onPolygon?.(this.polygon.length); this.requestRender(); return; }
    const prev = this.undoStack.pop();
    if (!prev || !this.labels) return;
    this.labels.set(prev);
    this.overlayDirty = true;
    this.hooks.onUndoChange?.(this.undoStack.length > 0);
    this.hooks.onEdit?.('undo');
    this.requestRender();
  }

  /** Paint a thick line from (x0,y0) to (x1,y1), world coordinates. */
  paint(x0, y0, x1, y1) {
    const r = Math.max(0.5, this.brush / 2 / this.S);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / this.S / Math.max(1, r / 2)));
    let changed = false;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (this.stamp((x0 + (x1 - x0) * t) / this.S, (y0 + (y1 - y0) * t) / this.S, r)) changed = true;
    }
    if (changed) {
      this.drag.changed = true;
      this.overlayDirty = true;
      this.requestRender();
    }
  }

  stamp(gx, gy, r) {
    const { labels, gw, gh } = this;
    const erase = this.tool === 'eraser';
    const r2 = r * r;
    let changed = false;
    const y0 = Math.max(0, Math.floor(gy - r));
    const y1 = Math.min(gh - 1, Math.ceil(gy + r));
    const x0 = Math.max(0, Math.floor(gx - r));
    const x1 = Math.min(gw - 1, Math.ceil(gx + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - gx;
        const dy = y + 0.5 - gy;
        if (dx * dx + dy * dy > r2) continue;
        const p = y * gw + x;
        const v = labels[p];
        if (v === LABEL.OUTSIDE) continue;
        const next = erase ? LABEL.CELLS : LABEL.WOUND;
        if (v !== next) { labels[p] = next; changed = true; }
      }
    }
    return changed;
  }

  closePolygon() {
    const pts = this.polygon;
    this.polygon = [];
    this.hooks.onPolygon?.(0);
    if (pts.length < 3 || !this.labels) { this.requestRender(); return; }
    this.pushUndo();
    const { labels, gw, gh, S } = this;
    let changed = false;
    // Even-odd scanline fill at cell centres.
    for (let y = 0; y < gh; y++) {
      const wy = (y + 0.5) * S;
      const xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i];
        const b = pts[j];
        if ((a.y > wy) !== (b.y > wy)) xs.push(a.x + ((wy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] / S - 0.5));
        const xb = Math.min(gw - 1, Math.floor(xs[k + 1] / S - 0.5));
        for (let x = xa; x <= xb; x++) {
          const p = y * gw + x;
          if (labels[p] !== LABEL.OUTSIDE && labels[p] !== LABEL.WOUND) { labels[p] = LABEL.WOUND; changed = true; }
        }
      }
    }
    if (changed) { this.overlayDirty = true; this.hooks.onEdit?.('polygon'); } else this.dropUndo();
    this.requestRender();
  }

  cancelPolygon() {
    if (!this.polygon.length) return false;
    this.polygon = [];
    this.hooks.onPolygon?.(0);
    this.requestRender();
    return true;
  }

  // ---- drawing ------------------------------------------------------------

  rebuildOverlay() {
    const { labels, gw, gh } = this;
    this.overlay.width = gw;
    this.overlay.height = gh;
    const octx = this.overlay.getContext('2d');
    const img = octx.createImageData(gw, gh);
    const d = img.data;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const p = y * gw + x;
        const v = labels[p];
        const q = p * 4;
        if (v === LABEL.CELLS) continue;
        if (v === LABEL.OUTSIDE) { d[q] = 8; d[q + 1] = 12; d[q + 2] = 18; d[q + 3] = 150; continue; }
        const edge = x === 0 || y === 0 || x === gw - 1 || y === gh - 1 ||
          labels[p - 1] !== v || labels[p + 1] !== v || labels[p - gw] !== v || labels[p + gw] !== v ||
          labels[p - gw - 1] !== v || labels[p - gw + 1] !== v || labels[p + gw - 1] !== v || labels[p + gw + 1] !== v;
        if (v === LABEL.WOUND) { d[q] = 239; d[q + 1] = 68; d[q + 2] = 68; d[q + 3] = edge ? 255 : 64; }
        else { d[q] = 245; d[q + 1] = 158; d[q + 2] = 11; d[q + 3] = edge ? 255 : 40; }
      }
    }
    octx.putImageData(img, 0, 0);
    this.overlayDirty = false;
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  render() {
    const { ctx, canvas } = this;
    const dpr = canvas.width / this.cssW;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1016';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawScene(ctx, this.ox, this.oy, this.scale);

    // Tool feedback (never part of saved images).
    if (this.polygon.length) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#38bdf8';
      ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
      ctx.beginPath();
      this.polygon.forEach((p, i) => {
        const x = this.ox + p.x * this.scale;
        const y = this.oy + p.y * this.scale;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      if (this.pointer) ctx.lineTo(this.pointer.cx, this.pointer.cy);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#38bdf8';
      for (const p of this.polygon) {
        ctx.beginPath();
        ctx.arc(this.ox + p.x * this.scale, this.oy + p.y * this.scale, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.pointer && this.labels && (this.tool === 'brush' || this.tool === 'eraser') && !(this.drag && this.drag.kind === 'pan')) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.tool === 'brush' ? '#fca5a5' : '#e2e8f0';
      ctx.beginPath();
      ctx.arc(this.pointer.cx, this.pointer.cy, Math.max(2, (this.brush / 2) * this.scale), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawScene(ctx, ox, oy, scale) {
    if (this.bitmap) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.bitmap, ox, oy, this.imgW * scale, this.imgH * scale);
    }
    if (this.labels && this.showOverlay) {
      if (this.overlayDirty) this.rebuildOverlay();
      // Keep outlines crisp when zoomed in, smooth when reduced.
      ctx.imageSmoothingEnabled = scale * this.S < 2;
      ctx.drawImage(this.overlay, ox, oy, this.gw * this.S * scale, this.gh * this.S * scale);
    }
  }

  /** Image + overlay at a fixed size, independent of the current zoom. */
  async toPngBlob(maxSize = 1600) {
    const scale = Math.min(1, maxSize / Math.max(this.imgW, this.imgH));
    const c = document.createElement('canvas');
    c.width = Math.round(this.imgW * scale);
    c.height = Math.round(this.imgH * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    this.drawScene(ctx, 0, 0, scale);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }
}
