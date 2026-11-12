// Batch runner: feeds images to the worker pool, reuses cached results,
// reports progress, supports pause / cancel.

import { paramsKey } from './core/pipeline.js';
import { autoKey, manualKey, dbGetMany, dbPut } from './db.js';
import { state, setResult, emit } from './state.js';

const LOOKUP_CHUNK = 500;

export class Batch {
  /**
   * @param {WorkerPool} pool
   * @param {Array<{series:object, item:object}>} work
   * @param {{engine:{kind:string,key?:string}, engineId:string, params:object, force?:boolean}} opts
   */
  constructor(pool, work, opts) {
    this.pool = pool;
    this.work = work;
    this.opts = opts;
    this.total = work.length;
    this.done = 0;
    this.cached = 0;
    this.errors = [];
    this.active = 0;
    this.next = 0;
    this.paused = false;
    this.cancelled = false;
    this.computeMs = 0;
    this.computed = 0;
    this.startedAt = 0;
    this.lastEmit = 0;
  }

  progress(force = false) {
    const now = performance.now();
    if (!force && now - this.lastEmit < 120) return;
    this.lastEmit = now;
    const elapsed = (now - this.startedAt) / 1000;
    const rate = this.computed > 0 && elapsed > 0 ? this.computed / elapsed : 0;
    const left = this.total - this.done;
    emit('progress', {
      done: this.done, total: this.total, cached: this.cached, errors: this.errors.length,
      rate, etaSeconds: rate > 0 ? left / rate : null, paused: this.paused,
    });
  }

  /** Fill in results that are already in the cache; returns the items still to compute. */
  async applyCache() {
    const pKey = paramsKey(this.opts.params, this.opts.engineId);
    const todo = [];
    for (let i = 0; i < this.work.length; i += LOOKUP_CHUNK) {
      if (this.cancelled) break;
      const chunk = this.work.slice(i, i + LOOKUP_CHUNK);
      const manual = await dbGetMany(chunk.map((w) => manualKey(w.item.file)));
      const auto = this.opts.force ? chunk.map(() => undefined) : await dbGetMany(chunk.map((w) => autoKey(w.item.file, pKey)));
      chunk.forEach((w, k) => {
        // A hand-corrected mask always wins over a fresh automatic result.
        const hit = manual[k] || auto[k];
        if (hit && hit.rle) {
          setResult(w.series, w.item, hit);
          this.done++;
          this.cached++;
        } else {
          todo.push(w);
        }
      });
      this.progress();
    }
    return todo;
  }

  async run() {
    this.startedAt = performance.now();
    state.running = true;
    emit('batch-start', { total: this.total });
    this.progress(true);
    const todo = await this.applyCache();
    emit('results');
    // The clock for the rate starts after the cache lookup.
    this.startedAt = performance.now();
    const pKey = paramsKey(this.opts.params, this.opts.engineId);

    await new Promise((resolve) => {
      const finishIfIdle = () => {
        if (this.active === 0 && (this.cancelled || this.next >= todo.length)) resolve();
      };
      const pump = () => {
        while (!this.paused && !this.cancelled && this.active < this.pool.size && this.next < todo.length) {
          const w = todo[this.next++];
          this.active++;
          w.item.status = 'running';
          this.pool.run({ type: 'analyze', file: w.item.file, params: this.opts.params, engine: this.opts.engine })
            .then((res) => {
              setResult(w.series, w.item, res.result);
              this.computeMs += res.timing.decode + res.timing.analyse;
              this.computed++;
              dbPut(autoKey(w.item.file, pKey), res.result);
            })
            .catch((err) => {
              if (err.message === 'CANCELLED') { w.item.status = w.item.result ? 'done' : 'new'; return; }
              w.item.status = 'error';
              w.item.error = err.message;
              this.errors.push({ name: w.item.name, message: err.message });
            })
            .finally(() => {
              this.active--;
              this.done++;
              this.progress();
              emit('item-done', w);
              pump();
              finishIfIdle();
            });
        }
      };
      this.pump = pump;
      pump();
      finishIfIdle();
    });

    state.running = false;
    const seconds = (performance.now() - this.startedAt) / 1000;
    const summary = {
      total: this.total, done: this.done, cached: this.cached, computed: this.computed, errors: this.errors,
      cancelled: this.cancelled, seconds, msPerImage: this.computed ? (seconds * 1000) / this.computed : 0,
    };
    this.progress(true);
    emit('results');
    emit('batch-end', summary);
    return summary;
  }

  pause() { this.paused = true; this.progress(true); }

  resume() { this.paused = false; this.progress(true); this.pump?.(); }

  cancel() {
    this.cancelled = true;
    this.paused = false;
    this.pool.clearQueue();
  }
}
