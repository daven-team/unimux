// The Markdown export of a conversation (1.1.1), on the conversation search thread: finds the transcript of a session (or
// takes an indexed file) and reads it whole into ConvExportData, streaming its lines and stopping at the export limits.
import { open, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { ConvCli } from '../shared/convSearch';
import { EXPORT_LIMITS, toolDetail, type ConvExportData, type ConvExportItem } from '../shared/convExport';
import { feedExportLine, newMeta, readLines } from './parse';

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The newest transcript file of a session in the CLI folders (Claude: projects/<folder>/<id>.jsonl, Codex: rollout-…-<id>.jsonl). */
export async function locateSession(cli: ConvCli, id: string, roots: { claudeRoots: string[]; codexRoots: string[] }): Promise<string | null> {
  if (!SESSION_ID.test(id)) return null;
  const found: Array<{ file: string; mtimeMs: number }> = [];
  const consider = async (file: string) => {
    try { const st = await stat(file); if (st.isFile()) found.push({ file, mtimeMs: st.mtimeMs }); } catch { /* not there */ }
  };
  if (cli === 'claude') {
    for (const root of roots.claudeRoots) {
      const base = join(root, 'projects');
      let dirs: string[] = [];
      try { dirs = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      await Promise.all(dirs.map((d) => consider(join(base, d, `${id}.jsonl`))));
    }
  } else {
    const suffix = `-${id}.jsonl`;
    const walk = async (dir: string, depth: number): Promise<void> => {
      let items;
      try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (it.isDirectory() && depth < 4) await walk(join(dir, it.name), depth + 1);
        else if (it.isFile() && it.name.startsWith('rollout-') && it.name.endsWith(suffix)) await consider(join(dir, it.name));
      }
    };
    for (const root of roots.codexRoots) await walk(join(root, 'sessions'), 0);
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0]?.file ?? null;
}

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160);

/** Reads a whole transcript for the export (tool calls as one-line summaries, no tool output, no reasoning). */
export async function readExport(file: string, cli: ConvCli, limits: { docChars: number; messageChars: number; items: number } = EXPORT_LIMITS): Promise<ConvExportData> {
  const meta = newMeta();
  const items: ConvExportItem[] = [];
  let total = 0;
  let capped = false;
  const room = (n: number) => {
    if (capped) return false;
    if (total + n > limits.docChars || items.length >= limits.items) { capped = true; return false; }
    total += n;
    return true;
  };
  const fh = await open(file, 'r');
  let size: number | undefined;
  try {
    size = (await fh.stat()).size;
    await readLines(fh, 0, (buf, s, e) => feedExportLine(cli, meta, buf, s, e, (role, text, ts) => {
      const cut = text.length > limits.messageChars;
      const kept = cut ? text.slice(0, limits.messageChars) : text;
      if (!room(kept.length)) return;
      items.push(cut ? { kind: 'msg', role, text: kept, ts, cut } : { kind: 'msg', role, text: kept, ts });
    }, (name, input, ts) => {
      const detail = toolDetail(name, input);
      if (!room(name.length + detail.length)) return;
      items.push({ kind: 'tool', name: name.slice(0, 80), detail, ts });
    }), undefined, size);
  } finally {
    await fh.close();
  }
  return {
    ok: true, cli, id: meta.id ?? '', cwd: meta.cwd, title: clip(meta.custom ?? meta.ai ?? meta.prompt ?? ''),
    ...(meta.model ? { model: meta.model } : {}),
    startedAt: meta.firstTs, updatedAt: meta.lastTs, items, capped,
  };
}
