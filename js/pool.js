// Worker pool: spreads jobs over several analysis workers and keeps one
// extra worker free for interactive requests (previews) during a batch.

const WORKER_URL = new URL('./worker.js', import.meta.url);

class Slot {
  constructor(onCrash) {
    this.onCrash = onCrash;
    this.pending = new Map();
    this.busy = false;
    this.modelKey = null;
    this.seq = 0;
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(WORKER_URL, { type: 'module' });
    this.modelKey = null;
    this.worker.onmessage = (ev) => {
      const { id, ok, error, ...rest } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(rest); else p.reject(new Error(error));
    };
    this.worker.onerror = (ev) => {
      // The worker died (script error, out of memory…): fail its jobs, start a fresh one.
      const err = new Error('WORKER_CRASHED' + (ev && ev.message ? ': ' + ev.message : ''));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      try { this.worker.terminate(); } catch { /* ignore */ }
      this.spawn();
      this.onCrash?.(err);
    };
  }

  call(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  terminate() {
    for (const p of this.pending.values()) p.reject(new Error('CANCELLED'));
    this.pending.clear();
    this.worker.terminate();
  }
}

export function defaultPoolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  // Leave a core for the page itself; more than 6 workers rarely helps
  // (memory bandwidth) and every worker holds a full-resolution image.
  return Math.max(1, Math.min(6, cores - 1));
}

export class WorkerPool {
  constructor(size = defaultPoolSize()) {
    this.size = size;
    this.slots = Array.from({ length: size }, () => new Slot());
    this.interactive = new Slot();
    this.queue = [];
    this.model = null; // { key, bytes }
  }

  /** Make an ONNX model available; workers load it lazily before their first job. */
  setModel(key, bytes) {
    this.model = { key, bytes };
  }

  async ensureModel(slot, engine) {
    if (!engine || engine.kind !== 'model' || slot.modelKey === engine.key) return;
    if (!this.model || this.model.key !== engine.key) throw new Error('MODEL_NOT_AVAILABLE');
    await slot.call({ type: 'model', key: this.model.key, bytes: this.model.bytes });
    slot.modelKey = engine.key;
  }

  /** Queue a batch job (analyze / sample). */
  run(msg) {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, resolve, reject });
      this.pump();
    });
  }

  pump() {
    for (const slot of this.slots) {
      if (!this.queue.length) return;
      if (slot.busy) continue;
      const job = this.queue.shift();
      slot.busy = true;
      this.ensureModel(slot, job.msg.engine)
        .then(() => slot.call(job.msg))
        .then(job.resolve, job.reject)
        .finally(() => { slot.busy = false; this.pump(); });
    }
  }

  /** Run right away on the dedicated interactive worker (previews, single re-analysis). */
  async runInteractive(msg) {
    await this.ensureModel(this.interactive, msg.engine);
    return this.interactive.call(msg);
  }

  /** Drop jobs that have not started yet. */
  clearQueue() {
    const dropped = this.queue.splice(0);
    for (const job of dropped) job.reject(new Error('CANCELLED'));
    return dropped.length;
  }

  terminate() {
    this.clearQueue();
    for (const s of this.slots) s.terminate();
    this.interactive.terminate();
  }
}
