// The list of recently used tabs while Ctrl+Tab is held (1.1.1, renderer/tabSwitcher.ts): icons and names, newest first, the
// chosen one marked. It shows only after a short hold; a quick tap switches without it.
import { useEffect } from 'react';
import { gridTabLabels, parseWorkspaceKey } from '../../../shared/workspaceOrder';
import { stripTabColor } from '../../../shared/tabStrip';
import { describeLayout } from '../../../shared/layout';
import { useFileStore } from '../files';
import { useI18n } from '../i18n';
import { useStore } from '../store';
import { commitTabSwitch, startTabTracking, useTabSwitcher } from '../tabSwitcher';
import { FileIcon } from './FileIcon';
import { IDatabase, ITable, TGrid, TNote, TSettings } from './icons';
import './tabSwitcher.css';

export function TabSwitcher() {
  const { tr } = useI18n();
  useEffect(() => startTabTracking(), []);
  const visible = useTabSwitcher((st) => st.visible);
  const order = useTabSwitcher((st) => st.order);
  const index = useTabSwitcher((st) => st.index);
  const projects = useStore((st) => st.s.projects);
  const documents = useFileStore((st) => (visible ? st.documents : null));
  if (!visible || !order.length) return null;
  const labels = gridTabLabels(projects);
  const rows = order.map((key) => {
    const target = parseWorkspaceKey(key);
    if (target?.kind === 'settings') return { key, icon: <TSettings />, name: tr('Ustawienia'), place: '', color: null };
    if (target?.kind === 'grid') {
      const project = projects.find((p) => p.tabs.some((t) => t.id === target.id));
      const tab = project?.tabs.find((t) => t.id === target.id);
      return { key, icon: <TGrid />, name: labels.get(target.id) ?? tab?.name ?? '?', place: [project?.name, tab ? describeLayout(tab.layout) : ''].filter(Boolean).join(' · '), color: stripTabColor({ project }) };
    }
    const doc = target?.kind === 'file' ? documents?.find((d) => d.id === target.id) : undefined;
    const project = doc?.projectId ? projects.find((p) => p.id === doc.projectId) : undefined;
    const icon = doc?.redis ? <IDatabase /> : doc?.db ? <ITable /> : doc?.note ? <TNote /> : <FileIcon name={doc?.name ?? ''} />;
    return { key, icon, name: doc?.name ?? '?', place: [project?.name, doc && !doc.db && !doc.redis && !doc.note ? doc.relativePath : ''].filter(Boolean).join(' · '), color: stripTabColor({ project }) };
  });
  return (
    <div className="tabsw-overlay" role="presentation">
      <div className="tabsw-panel" role="listbox" aria-label={tr('Ostatnio używane karty')}>
        <div className="tabsw-head muted">{tr('Ostatnio używane karty')}</div>
        {rows.map((row, i) => (
          <div key={row.key} role="option" aria-selected={i === index} data-tab-key={row.key} className={`tabsw-row ${i === index ? 'on' : ''}`}
            style={row.color ? ({ '--tabsw-color': row.color } as React.CSSProperties) : undefined}
            onMouseDown={(e) => { e.preventDefault(); commitTabSwitch(row.key); }}>
            <span className={`tabsw-chip ${row.color ? '' : 'none'}`} aria-hidden="true" />
            <span className="tabsw-icon" aria-hidden="true">{row.icon}</span>
            <span className="tabsw-name">{row.name}</span>
            {row.place && <span className="tabsw-place muted">{row.place}</span>}
          </div>
        ))}
        <div className="tabsw-foot muted">{tr('Puść klawisz, aby przejść · Esc anuluje')}</div>
      </div>
    </div>
  );
}
