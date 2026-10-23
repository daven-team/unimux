// Read-only unified diff of one file (working tree, index, an untracked file or a commit), shown in an editor tab. Loaded on demand (lazy) from FileEditor.
import { useEffect, useMemo, useState } from 'react';
import { GIT_DIFF_LINES, parseUnifiedDiff, type GitDiffResult, type GitDiffSource } from '../../../shared/git';
import { useI18n } from '../i18n';
import { DiffLines } from './DiffLines';
import type { FileFinder } from './MarkdownPreview';
import './gitPanel.css';

interface Props { projectId: string; worktree?: string; source: GitDiffSource; path: string; oldPath?: string; hash?: string; finder?: FileFinder }

export default function GitDiffView({ projectId, worktree, source, path, oldPath, hash, finder }: Props) {
  const { tr, errorText } = useI18n();
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.mc.git.diff(projectId, { source, path, ...(oldPath ? { oldPath } : {}), ...(hash ? { hash } : {}), ...(worktree ? { worktree } : {}) })
      .then((r) => { if (cancelled) return; if (r.ok) setResult(r.data); else setError(r.error); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, worktree, source, path, oldPath, hash]);

  const parsed = useMemo(() => (result ? parseUnifiedDiff(result.text) : null), [result]);
  const sourceLabel = source === 'staged' ? tr('Do zatwierdzenia') : source === 'commit' ? tr('Commit {hash}', { hash: (hash ?? '').slice(0, 7) }) : source === 'untracked' ? tr('Nowy plik') : tr('Zmiany');
  const width = parsed ? String(Math.max(...parsed.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)), 1)).length : 1;

  return (
    <div className="git-diff-view" aria-label={tr('Zmiany w pliku')}>
      <div className="git-diff-path muted" title={path}><span className="git-diff-source">{sourceLabel}</span>{' · '}{oldPath && oldPath !== path ? `${oldPath} → ${path}` : path}</div>
      {!result && !error && <div className="git-diff-message muted">{tr('Wczytywanie…')}</div>}
      {error && <div className="git-diff-message error">{tr('Nie udało się wczytać zmian: {error}', { error: errorText(error) })}</div>}
      {result && parsed && (
        <>
          {(result.truncated || parsed.cut) && <div className="git-diff-notice">{tr('Diff jest zbyt duży - pokazano tylko jego początek ({count} wierszy).', { count: parsed.lines.length || GIT_DIFF_LINES })}</div>}
          {result.binary || parsed.binary ? (
            <div className="git-diff-message muted">{tr('Plik binarny - brak podglądu zmian.')}</div>
          ) : !parsed.lines.length ? (
            <div className="git-diff-message muted">{tr('Brak różnic do pokazania.')}</div>
          ) : (
            <DiffLines lines={parsed.lines} width={width} label={tr('Zmiany w pliku')} finder={finder} />
          )}
        </>
      )}
    </div>
  );
}
