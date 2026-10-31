// Main's side of the conversation search (1.0.9): the search thread is started on the first request (read from its built file
// and run as an eval'd worker, so it never depends on how worker threads resolve paths inside the asar) and ended after
// IDLE_MS without a request, after it saved its index. Nothing here reads transcripts: main only relays.
import { readFileSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
// Types only: anything main imports from the thread's modules would become a chunk the eval'd thread cannot load.
import type { ConvQuery, ConvSearchResult, ConvTranscript } from '../shared/convSearch';
import type { ConvExportData, ConvExportSource } from '../shared/convExport';
import type { ConvWorkerData, ConvWorkerReply, ConvWorkerRequest } from '../convsearch/protocol';

const IDLE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 60 * 1000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Request = ConvWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export interface ConvSearchClientOptions {
  /** The built worker file (out/main/convsearch.js). */
  workerFile: string;
  data: () => ConvWorkerData;
  log?: (message: string) => void;
}

export function createConvSearchClient(opts: ConvSearchClientOptions) {
  let worker: Worker | null = null;
  let source: string | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();
  let idle: NodeJS.Timeout | null = null;

  const failAll = (error: Error) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };

  const start = (): Worker => {
    if (worker) return worker;
    source ??= readFileSync(opts.workerFile, 'utf8');
    const w = new Worker(source, { eval: true, workerData: opts.data() });
    w.on('message', (m: ConvWorkerReply) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    w.on('error', (error) => { opts.log?.(`conversation search thread failed: ${error?.stack ?? error}`); });
    w.on('exit', () => { if (worker === w) worker = null; failAll(new Error('conversation search thread ended')); });
    worker = w;
    return w;
  };

  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { idle = null; void stop(); }, IDLE_MS);
    idle.unref?.();
  };

  function call<T>(req: Request, timeoutMs = TIMEOUT_MS): Promise<T> {
    const w = start();
    armIdle();
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('conversation search timed out')); }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      w.postMessage({ ...req, id });
    });
  }

  /** Lets the thread save its index, then ends it. */
  async function stop(): Promise<void> {
    const w = worker;
    if (!w) return;
    try { await call({ t: 'shutdown' }, 20000); } catch { /* ends anyway */ }
    if (worker === w) worker = null;
    await w.terminate().catch(() => undefined);
  }

  return {
    async search(query: ConvQuery): Promise<ConvSearchResult> {
      try { return await call<ConvSearchResult>({ t: 'search', query }); } catch (error) {
        return { hits: [], total: 0, conversations: 0, projects: [], indexing: null, tookMs: 0, error: String((error as Error)?.message ?? error) };
      }
    },
    async transcript(file: string): Promise<ConvTranscript> {
      try { return await call<ConvTranscript>({ t: 'transcript', file }); } catch (error) {
        return { ok: false, messages: [], capped: false, error: String((error as Error)?.message ?? error) };
      }
    },
    /** 1.1.1: a whole conversation for the Markdown export (read on the thread, never in main). */
    async exportData(source: ConvExportSource): Promise<ConvExportData> {
      try { return await call<ConvExportData>({ t: 'export', source }, 120_000); } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error), cli: 'claude', id: '', title: '', cwd: '', startedAt: 0, updatedAt: 0, items: [], capped: false };
      }
    },
    stats: () => call<Record<string, unknown>>({ t: 'stats' }),
    stop,
  };
}

/** Where the built thread lives next to main's own bundle. */
export const convWorkerFile = (dir: string) => join(dir, 'convsearch.js');

/** A query as it arrives over IPC, reduced to known fields of the right types. */
export function sanitizeQuery(raw: unknown): ConvQuery {
  const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out: ConvQuery = { text: typeof q.text === 'string' ? q.text.slice(0, 400) : '' };
  if (q.cli === 'claude' || q.cli === 'codex') out.cli = q.cli;
  if (q.role === 'user' || q.role === 'assistant') out.role = q.role;
  if (typeof q.project === 'string' && q.project) out.project = q.project.slice(0, 2000);
  const from = num(q.from), to = num(q.to), limit = num(q.limit);
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  if (limit !== undefined) out.limit = Math.max(1, Math.min(500, Math.floor(limit)));
  return out;
}

/** An export request as it arrives over IPC: a file path or a session of a known CLI with a plain id; null for anything else. */
export function sanitizeExportSource(raw: unknown): ConvExportSource | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof r.file === 'string' && r.file && r.file.length <= 4096) return { file: r.file };
  if ((r.cli === 'claude' || r.cli === 'codex') && typeof r.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(r.id)) return { cli: r.cli, id: r.id };
  return null;
}
