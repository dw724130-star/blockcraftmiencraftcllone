// Pool of module Web Workers that each host a headless World (see world-worker.js).
// Offloads chunk generation, chunk meshing and LOD tile building from the main thread.
// Exposes the same LOD-facing API as LodWorkerPool (enqueue / inFlight / readyResults / prunePending / clearQueue)
// so World's LOD scheduler works unchanged, plus gen/mesh request queues for chunk streaming.

const VERSION = new URL(import.meta.url).search;
const PRI_GEN = 0;
const PRI_MESH = 1;
const PRI_LOD = 2;

export class WorldWorkerPool {
  constructor(initMsg, count = 3) {
    this.useWorkers = true;
    this.ready = false;
    this.failed = false;
    this.disposed = false;
    this.workers = [];
    this.queues = [[], [], []];
    this._nextId = 1;
    this._jobs = new Map(); // id -> job

    // LOD-compatible surface
    this.inFlight = new Set();
    this.readyResults = [];
    // Chunk streaming surface
    this.genResults = [];
    this.meshResults = [];
    this.genPending = new Set(); // chunk keys with a gen job queued or running
    this.onFail = null;

    this._readyCount = 0;
    this._startedAt = performance.now();
    let url;
    try {
      url = new URL('./world-worker.js' + VERSION, import.meta.url);
    } catch {
      this._fail('no URL support');
      return;
    }
    for (let i = 0; i < count; i++) {
      let w;
      try {
        w = new Worker(url, { type: 'module' });
      } catch {
        this._fail('module workers unsupported');
        return;
      }
      w._busy = 0;
      w._ready = false;
      w._jobIds = new Set();
      w.onmessage = (e) => this._onMessage(w, e.data);
      w.onerror = (ev) => {
        if (!w._ready) this._fail('worker failed to load: ' + ((ev && ev.message) || ''));
      };
      w.postMessage({ type: 'init', ...initMsg });
      this.workers.push(w);
    }
    // Old browsers silently fail module workers: give up gracefully and let World fall back.
    this._readyTimer = setTimeout(() => {
      if (!this.ready && !this.disposed) this._fail('worker init timeout');
    }, 12000);
  }

  _fail(reason) {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.useWorkers = false;
    try { console.warn('[BlockCraft] World workers unavailable, using main-thread fallback:', reason); } catch {}
    const lostGen = Array.from(this.genPending);
    this.dispose();
    if (this.onFail) this.onFail(lostGen);
  }

  _onMessage(w, d) {
    if (this.disposed) return;
    if (d.type === 'ready') {
      w._ready = true;
      this._readyCount++;
      if (!this.ready) {
        this.ready = true;
        clearTimeout(this._readyTimer);
      }
      this._pump();
      return;
    }
    if (d.type === 'fatal') {
      w._dead = true;
      if (this.workers.every((x) => x._dead)) this._fail(d.message);
      return;
    }
    const job = this._jobs.get(d.id);
    if (job) {
      this._jobs.delete(d.id);
      w._jobIds.delete(d.id);
      w._busy = Math.max(0, w._busy - 1);
    }
    if (d.type === 'gen') {
      this.genPending.delete(job ? job.ckey : null);
      this.genResults.push(d);
    } else if (d.type === 'mesh') {
      this.meshResults.push(d);
    } else if (d.type === 'lod') {
      this.inFlight.delete(d.key);
      this.readyResults.push(d);
    } else if (d.type === 'error') {
      if (job) {
        if (job.type === 'gen') {
          this.genPending.delete(job.ckey);
          this.genResults.push({ type: 'gen', failed: true, cx: job.cx, cz: job.cz });
        } else if (job.type === 'lod') {
          this.inFlight.delete(job.key);
        } else if (job.type === 'mesh') {
          this.meshResults.push({ type: 'mesh', failed: true, cx: job.cx, cz: job.cz, seq: job.seq });
        }
      }
      try { console.warn('[BlockCraft] worker job failed:', d.job, d.message); } catch {}
    }
    this._pump();
  }

  _submit(pri, job, transfer = null) {
    if (this.disposed || this.failed) return false;
    job.id = this._nextId++;
    job._transfer = transfer;
    this.queues[pri].push(job);
    this._pump();
    return true;
  }

  _pump() {
    if (!this.ready) return;
    for (const w of this.workers) {
      if (!w._ready || w._dead) continue;
      // 2 jobs in flight per worker keeps them busy across the postMessage round trip.
      while (w._busy < 2) {
        const job = this.queues[0].shift() || this.queues[1].shift() || this.queues[2].shift();
        if (!job) return;
        const transfer = job._transfer;
        job._transfer = null;
        this._jobs.set(job.id, job);
        w._jobIds.add(job.id);
        w._busy++;
        const { _transfer, ...msg } = job;
        try {
          w.postMessage(msg, transfer || []);
        } catch {
          w._busy--;
          this._jobs.delete(job.id);
        }
      }
    }
  }

  get queuedCount() {
    return this.queues[0].length + this.queues[1].length + this.queues[2].length;
  }

  // ---- Chunk streaming ----
  requestGen(cx, cz, ckey) {
    if (this.genPending.has(ckey)) return true;
    if (!this._submit(PRI_GEN, { type: 'gen', cx, cz, ckey })) return false;
    this.genPending.add(ckey);
    return true;
  }

  cancelGenOutside(keep) {
    const q = this.queues[PRI_GEN];
    let w = 0;
    for (let i = 0; i < q.length; i++) {
      const j = q[i];
      if (keep(j.cx, j.cz)) q[w++] = j;
      else this.genPending.delete(j.ckey);
    }
    q.length = w;
  }

  requestMesh(payload, transfer) {
    return this._submit(PRI_MESH, { type: 'mesh', ...payload }, transfer);
  }

  get meshQueued() {
    return this.queues[PRI_MESH].length;
  }

  broadcast(msg) {
    if (this.disposed || this.failed) return;
    for (const w of this.workers) {
      try { w.postMessage({ ...msg, id: 0 }); } catch {}
    }
  }

  // ---- LodWorkerPool-compatible API ----
  enqueue(job) {
    if (this.disposed || this.failed || this.inFlight.has(job.key)) return;
    this.inFlight.add(job.key);
    this._submit(PRI_LOD, { type: 'lod', key: job.key, rx: job.rx, rz: job.rz, tier: job.tier });
  }

  prunePending(activeKeys) {
    const q = this.queues[PRI_LOD];
    let w = 0;
    for (let i = 0; i < q.length; i++) {
      const job = q[i];
      if (activeKeys.has(job.key)) q[w++] = job;
      else this.inFlight.delete(job.key);
    }
    q.length = w;
  }

  clearQueue() {
    for (const job of this.queues[PRI_LOD]) this.inFlight.delete(job.key);
    this.queues[PRI_LOD].length = 0;
    this.readyResults.length = 0;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._readyTimer);
    for (const w of this.workers) {
      try { w.terminate(); } catch {}
    }
    this.workers.length = 0;
    for (const q of this.queues) q.length = 0;
    this._jobs.clear();
    this.inFlight.clear();
    this.genPending.clear();
  }
}
