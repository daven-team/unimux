import { describe, expect, it, vi } from 'vitest';
import { Server } from 'http';
import { startMcpHarness } from './helpers/mcpHarness';

// The MCP SDK is loaded on the first agent request, not when the server starts listening (0.9.4 startup).
const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock('@modelcontextprotocol/sdk/server/index.js', async (importOriginal) => {
  loaded.count++;
  return importOriginal();
});

describe('MCP SDK loading', () => {
  it('listens without the SDK and loads it on the first request', async () => {
    const h = await startMcpHarness(undefined, { rateLimit: false });
    try {
      expect(h.server.getInfo().running).toBe(true);
      expect(loaded.count).toBe(0);
      const response = await fetch(h.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${h.server.issueToken(h.worker.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(200);
      expect(loaded.count).toBe(1);
    } finally {
      await h.server.stop();
    }
  });

  it('a failed listen rejects (the app shows "MCP unavailable") and a retry starts the server', async () => {
    const h = await startMcpHarness(undefined, { rateLimit: false });
    try {
      await h.server.stop();
      const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
        queueMicrotask(() => this.emit('error', Object.assign(new Error('listen EACCES: permission denied 127.0.0.1'), { code: 'EACCES' })));
        return this;
      });
      await expect(h.server.start()).rejects.toThrow(/EACCES/);
      expect(h.server.getInfo().running).toBe(false);
      listen.mockRestore();
      await h.server.start();
      expect(h.server.getInfo().running).toBe(true);
      const response = await fetch(h.server.getInfo().url!, { method: 'POST', headers: { Authorization: `Bearer ${h.server.issueToken(h.worker.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      expect(response.status).toBe(200);
    } finally {
      await h.server.stop();
    }
  });

  it('a start while another start runs joins it: one server, one port', async () => {
    const h = await startMcpHarness(undefined, { rateLimit: false });
    try {
      await h.server.stop();
      await Promise.all([h.server.start(), h.server.start(), h.server.start()]);
      const url = h.server.getInfo().url;
      expect(h.server.getInfo().running).toBe(true);
      await h.server.start();
      expect(h.server.getInfo().url).toBe(url);
    } finally {
      await h.server.stop();
    }
  });
});
