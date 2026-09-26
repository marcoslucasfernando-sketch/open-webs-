import { newId } from './util.js';

// Trabajos en segundo plano en el propio proceso. En producción: cola persistente (BullMQ/Redis o pg-boss)
// con la misma interfaz (ver docs/ARQUITECTURA.md).
export class JobRunner {
  constructor({ store, maxLogs = 400 } = {}) {
    this.jobs = new Map();
    this.store = store;
    this.maxLogs = maxLogs;
  }

  start(kind, meta, fn) {
    const job = { id: newId('job'), kind, ...meta, status: 'running', logs: [], startedAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    const log = (msg) => {
      job.logs.push({ at: new Date().toISOString(), msg: String(msg) });
      if (job.logs.length > this.maxLogs) job.logs.splice(0, job.logs.length - this.maxLogs);
    };
    job.promise = (async () => {
      try {
        job.result = await fn(log, job);
        job.status = 'done';
      } catch (err) {
        job.status = 'error';
        job.error = err.message;
        log(`ERROR: ${err.message}`);
      } finally {
        job.finishedAt = new Date().toISOString();
        this.store?.put('jobs', job.id, this.view(job));
      }
    })();
    return job;
  }

  get(id) {
    const job = this.jobs.get(id) || this.store?.get('jobs', id);
    return job ? this.view(job) : null;
  }

  view(job) {
    const { promise, result, ...rest } = job;
    return { ...rest, result: result && typeof result === 'object' ? summarize(result) : result };
  }
}

function summarize(result) {
  const json = JSON.stringify(result);
  return json.length > 20_000 ? { summary: 'resultado grande: consulta el recurso correspondiente' } : result;
}
