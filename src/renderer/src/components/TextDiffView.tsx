// Read-only diff of the file on disk against the editor text (a save conflict). Same look as the Git diff view; loaded on demand.
import { useMemo } from 'react';
import { lineDiff } from '../../../shared/textDiff';
import { useI18n } from '../i18n';
import './gitPanel.css';

export default function TextDiffView({ disk, editor, path }: { disk: string; editor: string; path: string }) {
  const { tr } = useI18n();
  const lines = useMemo(() => lineDiff(disk, editor), [disk, editor]);
  const width = String(Math.max(...lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)), 1)).length;
  return (
    <div className="git-diff-view file-conflict-diff" aria-label={tr('Różnice: dysk i edytor')}>
      <div className="git-diff-path muted" title={path}><span className="git-diff-source">{tr('- na dysku, + w edytorze')}</span>{' · '}{path}</div>
      {!lines.length ? <div className="git-diff-message muted">{tr('Brak różnic do pokazania.')}</div> : (
        <div className="git-diff" role="table" aria-label={tr('Różnice: dysk i edytor')} style={{ ['--ln' as string]: `${width}ch` }}>
          {lines.map((line, i) => (
            <div key={i} className={`git-diff-line ${line.kind}`} role="row">
              <span className="ln" aria-hidden>{line.oldNo ?? ''}</span>
              <span className="ln" aria-hidden>{line.newNo ?? ''}</span>
              <span className="sign" aria-hidden>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}</span>
              <span className="code">{line.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
