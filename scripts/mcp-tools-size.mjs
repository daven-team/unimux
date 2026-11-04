// Size of the MCP tool definitions each role pays for in every conversation (tools/list payload and server instructions).
// Usage: node scripts/mcp-tools-size.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'unimux-tools-size-'));
try {
  const out = join(dir, 'tools.mjs');
  await build({ stdin: { contents: "export { toolsForRole, mcpInstructions } from './src/main/mcpTools';", resolveDir: resolve('.'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: out, external: ['electron'], logLevel: 'silent' });
  const { toolsForRole, mcpInstructions } = await import(pathToFileURL(out).href);
  for (const role of ['worker', 'coordinator']) {
    const tools = toolsForRole(role);
    const instructions = mcpInstructions(role, { cellId: 'c1', name: 'Agent', project: 'Project' });
    console.log(`${role}: ${tools.length} tools, tools/list ${JSON.stringify({ tools }).length} chars, instructions ${instructions.length} chars (${tools.map((t) => t.name).join(', ')})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
