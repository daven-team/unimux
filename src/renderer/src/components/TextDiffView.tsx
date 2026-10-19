// Read-only diff of the file on disk against the editor text (a save conflict). Same look as the Git diff view; loaded on demand.
import { useMemo } from 'react';
import { diffView } from '../../../shared/textDiff';
import { useI18n } from '../i18n';
import './gitPanel.css';

export default function TextDiffView({ disk, editor, path, remote = false }: { disk: string; editor: string; path: string; remote?: boolean }) {
  const { tr } = useI18n();
  const { lines, total, width } = useMemo(() => diffView(disk, editor), [disk, editor]);
  return (
    <div className="git-diff-view file-conflict-diff" aria-label={tr('Różnice: dysk i edytor')}>
      <div className="git-diff-path muted" title={path}><span className="git-diff-source">{remote ? tr('- na serwerze, + w edytorze') : tr('- na dysku, + w edytorze')}</span>{' · '}{path}</div>
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
          {total > lines.length && <div className="git-diff-message muted">{tr('Pokazano pierwsze {shown} z {total} linii różnic.', { shown: lines.length, total })}</div>}
        </div>
      )}
    </div>
  );
}
