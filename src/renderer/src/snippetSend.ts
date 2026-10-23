// Snippets with variables (1.0.6): before a snippet is pasted, the user fills its {{variables}} in a small dialog (the last values
// prefilled) and the built-ins are worked out for each target cell: {{project}}, {{path}}, {{branch}}, {{date}}, {{clipboard}}.
import { tr } from './i18n';
import { findCell, upsertSnippet } from '../../shared/state';
import type { Cell, Snippet } from '../../shared/types';
import {
  fillSnippetVars, hasSnippetVars, initialSnippetValues, rememberSnippetValues, resolveSnippetBuiltins, snippetBuiltinsUsed, snippetUserVars,
} from '../../shared/snippetVars';
import { askSnippetValues, getS, update } from './store';

/** Notes are pasted as they are (a dragged note comes as a snippet with the note's id); snippets only when they hold a variable. */
export const snippetNeedsValues = (snippet: Snippet): boolean =>
  hasSnippetVars(snippet.text) && !getS().notes.some((note) => note.id === snippet.id);

/** The current branch of a cell's folder: what git reports for its worktree or the project, else what the cell knows. */
async function cellBranch(projectId: string, cell: Cell): Promise<string> {
  try {
    const refs = await window.mc.git.branches(projectId, cell.worktree ? { worktree: cell.worktree.path } : {});
    if (refs.ok) {
      const current = refs.data.find((ref) => ref.current && !ref.remote);
      if (current) return current.name;
    }
  } catch { /* no git, or not a repository */ }
  return cell.worktree?.branch ?? '';
}

/**
 * The text to paste into each of `cellIds` with every variable filled; null when the user cancelled the dialog. Cells that went
 * away while the dialog was open are left out.
 */
export async function fillSnippetForCells(snippet: Snippet, cellIds: readonly string[]): Promise<Map<string, string> | null> {
  const vars = snippetUserVars(snippet.text);
  let entered: Record<string, string> = {};
  if (vars.length) {
    const stored = getS().snippets.find((item) => item.id === snippet.id);
    const initial = initialSnippetValues(vars, stored?.values ?? snippet.values);
    const values = await askSnippetValues(
      tr('Wstaw snippet „{name}”', { name: snippet.name || tr("Snippet") }), snippet.text,
      vars.map((v) => ({ name: v.name, value: initial[v.name], ...(v.default !== undefined ? { fallback: v.default } : {}) })),
      [...snippetBuiltinsUsed(snippet.text)],
    );
    if (!values) return null;
    entered = values;
    update((st) => {
      const current = st.snippets.find((item) => item.id === snippet.id);
      if (!current) return st;
      const kept = rememberSnippetValues(current.values, entered, current.text);
      return kept === current.values ? st : upsertSnippet(st, { ...current, values: kept ?? {} });
    });
  }
  let clipboard: Promise<string> | null = null;
  const readClipboard = () => (clipboard ??= window.mc.clipboardRead());
  const branches = new Map<string, Promise<string>>();
  const out = new Map<string, string>();
  for (const id of cellIds) {
    const found = findCell(getS(), id);
    if (!found) continue;
    const path = found.cell.worktree?.path ?? found.project.path;
    const builtins = await resolveSnippetBuiltins(snippet.text, {
      project: found.project.name,
      path,
      branch: () => {
        if (!branches.has(path)) branches.set(path, cellBranch(found.project.id, found.cell));
        return branches.get(path)!;
      },
      clipboard: readClipboard,
    });
    out.set(id, fillSnippetVars(snippet.text, { ...entered, ...builtins }));
  }
  return out;
}
