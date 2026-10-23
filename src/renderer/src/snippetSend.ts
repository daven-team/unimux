// Snippets with variables (1.0.6): before a snippet is pasted, the user fills its {{variables}} in a small dialog (the last values
// prefilled) and the built-ins are worked out for each target cell: {{project}}, {{path}}, {{branch}}, {{date}}, {{clipboard}}.
import { tr } from './i18n';
import { findCell, upsertSnippet } from '../../shared/state';
import type { Cell, Snippet } from '../../shared/types';
import {
  fillSnippetVars, hasSnippetVars, initialSnippetValues, rememberSnippetValues, resolveSnippetBuiltins, snippetBuiltinsUsed, snippetUserVars,
} from '../../shared/snippetVars';
import { askSnippetValues, getS, toast, update } from './store';

/**
 * A branch name goes into a shell command line: git allows names like `x$(rm -rf ~)` or `a;b`, so only plain names are filled
 * in (letters, digits and . _ / - +); anything else stops the paste.
 */
const SAFE_BRANCH = /^[A-Za-z0-9._/+-]*$/;

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
  const builtinsUsed = snippetBuiltinsUsed(snippet.text);
  // The clipboard is never sent unseen (a snippet may come from an agent through automation): it is a field of the dialog,
  // prefilled with what the clipboard holds, so the user sees (and may change) exactly what goes into the terminal.
  const usesClipboard = builtinsUsed.has('clipboard');
  let entered: Record<string, string> = {};
  if (vars.length || usesClipboard) {
    const stored = getS().snippets.find((item) => item.id === snippet.id);
    const initial = initialSnippetValues(vars, stored?.values ?? snippet.values);
    const clipboardText = usesClipboard ? await window.mc.clipboardRead().catch(() => '') : '';
    const values = await askSnippetValues(
      tr('Wstaw snippet „{name}”', { name: snippet.name || tr("Snippet") }), snippet.text,
      [
        ...vars.map((v) => ({ name: v.name, value: initial[v.name], ...(v.default !== undefined ? { fallback: v.default } : {}) })),
        ...(usesClipboard ? [{ name: 'clipboard', value: clipboardText }] : []),
      ],
      [...builtinsUsed].filter((name) => name !== 'clipboard'),
    );
    if (!values) return null;
    entered = values;
    update((st) => {
      const current = st.snippets.find((item) => item.id === snippet.id);
      if (!current) return st;
      // The clipboard's text is not remembered with the snippet.
      const { clipboard: _clipboard, ...typed } = entered;
      const kept = rememberSnippetValues(current.values, typed, current.text);
      return kept === current.values ? st : upsertSnippet(st, { ...current, values: kept ?? {} });
    });
  }
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
      clipboard: async () => entered.clipboard ?? '',
    });
    if (builtins.branch !== undefined && !SAFE_BRANCH.test(builtins.branch)) {
      toast(tr('Nazwa gałęzi „{branch}” zawiera znaki, które powłoka mogłaby wykonać. Snippet nie został wklejony.', { branch: builtins.branch }), 'error');
      return null;
    }
    out.set(id, fillSnippetVars(snippet.text, { ...entered, ...builtins, ...(usesClipboard ? { clipboard: entered.clipboard ?? '' } : {}) }));
  }
  return out;
}
