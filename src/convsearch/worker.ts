// The conversation search thread (1.0.9): main starts it on the first search and ends it after a while without one. Its built
// file is read by main and run as an eval'd worker (like the DB Host's SQLite thread), so it only uses built-in modules and
// code bundled into it.
import { parentPort, workerData } from 'worker_threads';
import { ConvIndexer } from './indexer';
import { locateSession, readExport } from './exporter';
import type { ConvExportData, ConvExportSource } from '../shared/convExport';
import type { ConvWorkerData, ConvWorkerReply, ConvWorkerRequest } from './protocol';

const data = workerData as ConvWorkerData;
const indexer = new ConvIndexer({ claudeRoots: data.claudeRoots, codexRoots: data.codexRoots, cacheFile: data.cacheFile });
const port = parentPort!;
const reply = (m: ConvWorkerReply) => port.postMessage(m);

port.on('message', (m: ConvWorkerRequest) => {
  void (async () => {
    try {
      if (m.t === 'search') {
        await indexer.load();
        // The first search waits for nothing: it answers from what is indexed and says that a pass is running.
        void indexer.refresh().catch(() => undefined);
        reply({ t: 'reply', id: m.id, result: indexer.search(m.query) });
      } else if (m.t === 'transcript') {
        await indexer.load();
        reply({ t: 'reply', id: m.id, result: await indexer.transcript(m.file) });
      } else if (m.t === 'export') {
        await indexer.load();
        reply({ t: 'reply', id: m.id, result: await exportOf(m.source) });
      } else if (m.t === 'stats') {
        reply({ t: 'reply', id: m.id, result: { ...indexer.stats, files: indexer.size(), indexing: indexer.indexing, heapUsed: process.memoryUsage().heapUsed } });
      } else if (m.t === 'shutdown') {
        if (indexer.dirty && !indexer.indexing) await indexer.save();
        reply({ t: 'reply', id: m.id, result: true });
      }
    } catch (error) {
      reply({ t: 'reply', id: m.id, error: String((error as Error)?.stack ?? error).slice(0, 2000) });
    }
  })();
});

/** 1.1.1: a conversation for the Markdown export: a file the index knows, or the newest transcript of a cell's session. */
async function exportOf(source: ConvExportSource): Promise<ConvExportData> {
  const failed = (error: string, cli: 'claude' | 'codex' = 'claude'): ConvExportData =>
    ({ ok: false, error, cli, id: '', title: '', cwd: '', startedAt: 0, updatedAt: 0, items: [], capped: false });
  let file: string | null = null;
  let cli: 'claude' | 'codex';
  if ('file' in source) {
    const known = indexer.cliOf(source.file);
    if (!known) return failed('unknown');
    file = source.file;
    cli = known;
  } else {
    cli = source.cli;
    file = indexer.fileOf(cli, source.id) ?? await locateSession(cli, source.id, data);
    if (!file) return failed('not-found', cli);
  }
  try { return await readExport(file, cli); } catch (error) { return failed(String((error as Error)?.message ?? error), cli); }
}
