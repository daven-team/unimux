// Read-only diff of the file on disk against the editor text (a save conflict). Same look as the Git diff view; loaded on demand.
import { useMemo } from 'react';
import { diffView } from '../../../shared/textDiff';
import { useI18n } from '../i18n';
import { DiffLines } from './DiffLines';
import type { FileFinder } from './MarkdownPreview';
import './gitPanel.css';

export default function TextDiffView({ disk, editor, path, remote = false, finder }: { disk: string; editor: string; path: string; remote?: boolean; finder?: FileFinder }) {
  const { tr } = useI18n();
  const { lines, total, width } = useMemo(() => diffView(disk, editor), [disk, editor]);
  return (
    <div className="git-diff-view file-conflict-diff" aria-label={tr('Różnice: dysk i edytor')}>
      <div className="git-diff-path muted" title={path}><span className="git-diff-source">{remote ? tr('- na serwerze, + w edytorze') : tr('- na dysku, + w edytorze')}</span>{' · '}{path}</div>
      {!lines.length ? <div className="git-diff-message muted">{tr('Brak różnic do pokazania.')}</div> : (
        <DiffLines lines={lines} width={width} label={tr('Różnice: dysk i edytor')} finder={finder}>
          {total > lines.length && <div className="git-diff-message muted">{tr('Pokazano pierwsze {shown} z {total} linii różnic.', { shown: lines.length, total })}</div>}
        </DiffLines>
      )}
    </div>
  );
}
