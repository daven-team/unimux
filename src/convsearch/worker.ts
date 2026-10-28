// The conversation search thread (1.0.9): main starts it on the first search and ends it after a while without one. Its built
// file is read by main and run as an eval'd worker (like the DB Host's SQLite thread), so it only uses built-in modules and
// code bundled into it.
import { parentPort, workerData } from 'worker_threads';
import { ConvIndexer } from './indexer';
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
