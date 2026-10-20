// The SSH view (W3, SSH mode in 0.9.2): one workspace tab with three sections chosen in the side panel (SshNav): Hosty (group
// tiles, host cards by group), Klucze (identities and key tiles) and Znane hosty (trusted host keys). A details pane on the
// right shows a host, key or identity only while one is chosen; with nothing chosen the tiles use the whole width. Opened by
// the SSH rail tile, the palette, "Edytuj host" and "Wszystkie hosty…" (Add and cell menus). It stays mounted while its tab is
// open; the pane is "active" only while the view is on screen (D4: typed secrets go).
// Host cards work like Termius: a click picks the card, a double-click or Enter connects, the pencil opens the editor.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { activeProject, activeTab, duplicateSshHost, updateSshHost } from '../../../../shared/state';
import { existingSelection, filterHosts, groupHosts, parseFoldedGroups, userAtEndpoint, type SshHost } from '../../../../shared/ssh';
import { identityCredential, identityCredentialText } from '../../../../shared/sshIdentity';
import {
  cardKeyConnects, clickedDetail, ctrlPick, detailKey, groupTiles, hostCardDetail, hostsInGroup, hostTileState, liveDetail, liveGroupFilter, newKeyDetail, paneDetail, paneEscape, paneLeaves,
  showGroupHeadings, showGroupRow, toggleGroupFilter, visibleSelection, type NewKeyMode, type PaneScreen, type SshDetail,
} from '../../../../shared/sshView';
import type { MessageKey } from '../../../../shared/i18n';
import { showTerminalTabs } from '../../files';
import { useI18n } from '../../i18n';
import { askChoice, askText, getS, setUi, update, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { confirmRemoveSshHost, openHostInCell, openHostsAsGrid, showSshDetail } from '../../ssh';
import { openMenu, openMenuAt, type MenuItem } from '../ContextMenu';
import { IChevron, IEdit, IKey, IPlus, IServer, IX } from '../icons';
import { HostEditor } from './HostEditor';
import { IdentityEditor } from './IdentityEditor';
import { KeyEditor } from './KeyEditor';
import { IIdentity } from './sshIcons';
import { KnownHostsView } from './KnownHostsView';
import { NewKeyEditor } from './NewKeyEditor';
import { PaneActive, PaneDirty, paneGuardOff, withoutPaneGuard } from './paneVisibility';
import { SshNav } from './SshNav';
import { SftpView } from '../sftp/SftpView';
import { openSftp } from '../../sftp';
import './ssh.css';

const FOLD_KEY = 'mc-ssh-groups-v1';
const shortType = (type: string) => type.replace('ssh-', '').replace('ecdsa-sha2-nist', 'ecdsa-');
const STATE_LABEL = { connected: 'połączono', connecting: 'łączenie…', error: 'błąd połączenia', idle: 'rozłączono' } as const;

/** "Nowy klucz > mode": always that mode, also when a new-key pane is already open (it is replaced by a fresh one). */
const newKey = (mode: NewKeyMode) => showSshDetail(newKeyDetail(useSshStore.getState().detail, mode));
const newKeyItems = (tr: (key: MessageKey) => string): MenuItem[] => [
  { label: tr('Wygeneruj klucz'), onClick: () => newKey('generate') },
  { label: tr('Importuj z pliku'), onClick: () => newKey('file') },
  { label: tr('Wklej klucz'), onClick: () => newKey('paste') },
];

export function SshView() {
  const { tr } = useI18n();
  const hosts = useStore((st) => st.s.sshHosts);
  const identities = useStore((st) => st.s.sshIdentities);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  const collapsed = useStore((st) => st.s.sidebarCollapsed);
  const viewActive = useSshStore((st) => st.viewActive);
  const vault = useSshStore((st) => st.vault);
  const storedDetail = useSshStore((st) => st.detail);
  const section = useSshStore((st) => st.section);
  const keys = vault?.keys ?? [];
  const detail = paneDetail(section, liveDetail(storedDetail, hosts, keys.map((k) => k.id), identities.map((i) => i.id)));

  /** Unsaved changes reported by the pane's editors (useReportDirty). */
  const dirty = useRef(new Map<string, boolean>());
  const reportDirty = useCallback((id: string, value: boolean) => { if (value) dirty.current.set(id, true); else dirty.current.delete(id); }, []);
  const askDiscard = async () => await askChoice(tr('Odrzucić niezapisane zmiany?'), '', [{ label: tr('Odrzuć zmiany'), value: 'yes', danger: true }]) === 'yes';
  /** Connecting shows the grid (the view keeps its pane in the background): host key and password prompts appear in the cell. */
  const connect = (hostId: string, target: 'cell' | 'tab') => { showTerminalTabs(); void openHostInCell(hostId, target); };
  const askRef = useRef(askDiscard);
  askRef.current = askDiscard;
  /**
   * 0.9.3: another tile, another section or closing the SSH tab never drops unsaved edits of the pane silently. The change is
   * undone at once and asked about; "Odrzuć zmiany" applies it, "Anuluj" keeps the item and its edits. Going to the background
   * (a grid, a file, Settings, connect, open as grid) does not ask: the pane and its drafts stay (typed secrets go, D4).
   */
  useEffect(() => {
    let asking = false;
    type Screen = PaneScreen & { viewActive: boolean; selectedHosts: string[] };
    // The pane's item; with the tab closed also the tab and whether it was in front.
    const screen = (st: Screen, closed: boolean): Partial<Screen> => ({
      section: st.section, detail: st.detail, selectedHosts: st.selectedHosts, ...(closed ? { viewOpen: st.viewOpen, viewActive: st.viewActive } : {}),
    });
    // A deleted host, key or identity is not an edit to keep (its editor asked before deleting).
    const shownLive = (st: PaneScreen & { vault: { keys: Array<{ id: string }> } | null }) =>
      liveDetail(paneDetail(st.section, st.detail), getS().sshHosts, (st.vault?.keys ?? []).map((k) => k.id), getS().sshIdentities.map((i) => i.id)) !== null;
    return useSshStore.subscribe((st, prev) => {
      if (paneGuardOff() || !dirty.current.size || !paneLeaves(prev, st) || !shownLive(prev)) return;
      const closed = !st.viewOpen;
      const wanted = screen(st, closed);
      withoutPaneGuard(() => useSshStore.setState(screen(prev, closed)));
      if (asking) return;
      asking = true;
      void askRef.current().then((yes) => { asking = false; if (yes) withoutPaneGuard(() => useSshStore.setState(wanted)); });
    });
  }, []);
  /**
   * The pane closes (X, Esc in the pane, a second click on its tile): the tiles get the whole width back and the focus goes to
   * the tile that was shown. Unsaved changes are never dropped silently: the user is asked first.
   */
  const closePane = async () => {
    const shown = detail;
    if (dirty.current.size && !await askDiscard()) return;
    // Another item may have been chosen while the question was open.
    if (useSshStore.getState().detail !== storedDetail) return;
    withoutPaneGuard(() => showSshDetail(null));
    if (!shown || shown.kind === 'newKey') return;
    const selector = shown.kind === 'host' ? (shown.hostId ? `.ssh-tile[data-host-id="${shown.hostId}"]` : null)
      : shown.kind === 'identity' ? (shown.identityId ? `.ssh-tile[data-identity-id="${shown.identityId}"]` : null)
        : `.ssh-tile[data-key-id="${shown.keyId}"]`;
    if (selector) requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
  };
  const onPaneKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !paneEscape(true, detail)) return;
    e.preventDefault();
    e.stopPropagation();
    void closePane();
  };
  /** Esc clears the multi-selection; with nothing selected it is left to the rest of the app. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !useSshStore.getState().selectedHosts.length) return;
    e.preventDefault();
    e.stopPropagation();
    useSshStore.setState({ selectedHosts: [] });
  };

  // The SFTP section (0.9.8) is its own two-pane screen; once shown it stays mounted, so its folders and selection survive a
  // visit to another section.
  const sftp = section === 'sftp';
  const [sftpSeen, setSftpSeen] = useState(sftp);
  useEffect(() => { if (sftp) setSftpSeen(true); }, [sftp]);
  return (
    <>
    {sftpSeen && <div className="sftp-host" style={{ display: sftp ? 'flex' : 'none' }}><SftpView compactNav={collapsed} /></div>}
    <div className="ssh-view" style={sftp ? { display: 'none' } : undefined}>
      <div className="ssh-view-main" onKeyDown={onKeyDown}>
        {/* With the side panel folded the view itself offers the sections. */}
        {collapsed && <SshNav compact />}
        {vault?.storage === 'unavailable' && <div className="ssh-banner-warn">{tr('Szyfrowanie systemowe jest niedostępne - klucze i hasła są trzymane tylko do zamknięcia aplikacji')}</div>}
        <div id="ssh-section" role="tabpanel" className="ssh-view-body" aria-label={tr(section === 'hosts' ? 'Hosty' : section === 'keys' ? 'Klucze' : section === 'sftp' ? 'SFTP' : 'Znane hosty')}>
          {section === 'hosts' && <HostsSection detail={detail} onConnect={connect} />}
          {section === 'keys' && <KeysSection detail={detail} onClosePane={closePane} />}
          {section === 'knownHosts' && <KnownHostsView />}
        </div>
      </div>
      {detail && (
        <aside className="ssh-view-detail" aria-label={tr('Szczegóły')} onKeyDown={onPaneKeyDown}>
          <button type="button" className="btn ghost icon ssh-detail-close" aria-label={tr('Zamknij szczegóły')} title={tr('Zamknij szczegóły')} onClick={() => void closePane()}><IX /></button>
          <PaneDirty.Provider value={reportDirty}>
            <PaneActive.Provider value={viewActive && !settingsActive}>
              <DetailPane key={detailKey(detail)} detail={detail} onConnect={connect} />
            </PaneActive.Provider>
          </PaneDirty.Provider>
        </aside>
      )}
    </div>
    </>
  );
}

/** An empty section: what it is for and the first step. */
function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <div className="ssh-empty">
      <span className="ssh-empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      <div className="ssh-empty-actions">{children}</div>
    </div>
  );
}

function HostsSection({ detail, onConnect }: { detail: SshDetail | null; onConnect: (hostId: string, target: 'cell' | 'tab') => void }) {
  const { tr } = useI18n();
  const hosts = useStore((st) => st.s.sshHosts);
  const projects = useStore((st) => st.s.projects);
  const activeGrid = useStore((st) => activeTab(activeProject(st.s)));
  const sessions = useSshStore((st) => st.sessions);
  const selectedIds = useSshStore((st) => st.selectedHosts);
  const selected = useMemo(() => existingSelection(selectedIds, hosts), [selectedIds, hosts]);
  const cells = useMemo(() => projects.flatMap((p) => p.tabs.flatMap((t) => t.cells)), [projects]);
  const [query, setQuery] = useState('');
  /** The card a plain click picked (highlighted; Enter connects it). A deleted host simply matches no card. */
  const [picked, setPicked] = useState<string | null>(null);
  const [chosenGroup, setGroup] = useState<string | null>(null);
  const [folded, setFolded] = useState<string[]>(() => parseFoldedGroups(localStorage.getItem(FOLD_KEY)));
  const searching = !!query.trim();
  const tiles = groupTiles(hosts);
  const group = liveGroupFilter(chosenGroup, hosts);
  const groups = groupHosts(filterHosts(hostsInGroup(hosts, group), query), !searching);
  const headings = showGroupHeadings(hosts);
  const sshInGrid = activeGrid?.cells.filter((c) => c.ssh).length ?? 0;

  const toggleFold = (key: string) => {
    const next = folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key];
    setFolded(next);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* the folding of this session stays */ }
  };
  const renameGroup = async (name: string) => {
    const next = (await askText(tr('Zmień nazwę grupy'), name))?.trim();
    if (next === undefined || next === name) return;
    update((s) => s.sshHosts.filter((h) => h.group === name).reduce((acc, h) => updateSshHost(acc, h.id, { group: next || undefined }), s));
  };
  /** A different group filter clears the selection, so "Otwórz jako siatkę (n)" never counts hosts that are not shown. */
  const chooseGroup = (next: string | null) => {
    if (next === group) return;
    setGroup(next);
    useSshStore.setState({ selectedHosts: [] });
  };
  /** Typing in the search keeps only the selected hosts that stay visible ("Otwórz jako siatkę (n)" never counts hidden ones). */
  const search = (next: string) => {
    setQuery(next);
    const visible = filterHosts(hostsInGroup(hosts, group), next);
    useSshStore.setState((st) => {
      const kept = visibleSelection(st.selectedHosts, visible);
      return kept.length === st.selectedHosts.length ? {} : { selectedHosts: kept };
    });
  };
  const openGrid = (ids: string[]) => { showTerminalTabs(); void openHostsAsGrid(ids); useSshStore.setState({ selectedHosts: [] }); };
  const groupMenu = (e: MouseEvent, name: string | null, ids: string[]) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: tr('Otwórz jako siatkę'), onClick: () => openGrid(ids) },
      ...(name ? [{ label: tr('Zmień nazwę grupy'), onClick: () => void renameGroup(name) }] : []),
    ]);
  };
  /** A click only picks the card (Termius): the editor opens from the pencil, a double-click or Enter connects. */
  const clickTile = (e: MouseEvent, h: SshHost) => {
    if (e.ctrlKey || e.metaKey) { useSshStore.setState((st) => ({ selectedHosts: ctrlPick(st.selectedHosts, picked, h.id) })); setPicked(h.id); return; }
    setPicked(h.id);
    if (useSshStore.getState().selectedHosts.length) useSshStore.setState({ selectedHosts: [] });
  };
  const tileKeyDown = (e: KeyboardEvent, h: SshHost) => {
    if (cardKeyConnects(e)) { e.preventDefault(); setPicked(h.id); onConnect(h.id, 'cell'); return; }
    if (e.key === 'Escape' && picked && !useSshStore.getState().selectedHosts.length) setPicked(null);
  };
  const editHost = (hostId: string) => { setPicked(hostId); showSshDetail({ kind: 'host', hostId }); };
  const hostMenu = (e: MouseEvent, h: SshHost) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: tr('Połącz w aktywnej siatce'), onClick: () => onConnect(h.id, 'cell') },
      { label: tr('Otwórz w nowym gridzie'), onClick: () => onConnect(h.id, 'tab') },
      { label: tr('Otwórz SFTP'), onClick: () => openSftp({ hostId: h.id }) },
      { sep: true },
      { label: tr('Edytuj'), onClick: () => editHost(h.id) },
      { label: tr('Duplikuj'), onClick: () => update((s) => duplicateSshHost(s, h.id)) },
      { label: tr('Kopiuj adres'), onClick: () => window.mc.clipboardWrite(userAtEndpoint(h)) },
      { sep: true },
      { label: tr('Usuń'), danger: true, onClick: () => void confirmRemoveSshHost(h.id) },
    ]);
  };
  const broadcast = () => {
    const project = activeProject(getS());
    if (project && activeGrid) setUi({ modal: { kind: 'broadcast', projectId: project.id, tabId: activeGrid.id } });
  };

  return (
    <>
      <div className="ssh-view-titlebar"><h2 className="ssh-view-title">{tr('Hosty')}</h2></div>
      <div className="ssh-view-head">
        <input className="input ssh-search" placeholder={tr('Szukaj hostów...')} aria-label={tr('Szukaj hostów...')} value={query} onChange={(e) => search(e.target.value)} />
        <div className="ssh-view-actions">
          <button className="btn primary" onClick={() => showSshDetail({ kind: 'host' })}><IPlus />{tr('Nowy host')}</button>
          <button className="btn" onClick={(e) => openMenuAt(e.currentTarget, newKeyItems(tr))}>{tr('Nowy klucz')} <IChevron /></button>
          <button className="btn ssh-broadcast-open" disabled={!sshInGrid} onClick={broadcast}>{tr('Wysyłanie masowe ({count})', { count: sshInGrid })}</button>
        </div>
      </div>
      {selected.length > 0 && (
        <div className="ssh-view-selection">
          <span>{tr('Zaznaczono {count}', { count: selected.length })}</span>
          <button className="btn small primary ssh-open-grid" onClick={() => openGrid(selected)}>{tr('Otwórz jako siatkę ({count})', { count: selected.length })}</button>
          <button className="btn small ghost" onClick={() => useSshStore.setState({ selectedHosts: [] })}>{tr('Wyczyść zaznaczenie')}</button>
        </div>
      )}
      {!hosts.length ? (
        <EmptyState icon={<IServer />} title={tr('Nie masz jeszcze hostów')} text={tr('Zapisz adres, użytkownika i sposób logowania, a potem łącz się jednym kliknięciem w dowolnej siatce.')}>
          <button className="btn primary" onClick={() => showSshDetail({ kind: 'host' })}><IPlus />{tr('Nowy host')}</button>
        </EmptyState>
      ) : (
        <>
          {showGroupRow(tiles) && (
            <section className="ssh-view-section" aria-label={tr('Grupy')}>
              <div className="ssh-group-tiles">
                <button className={`ssh-group-tile${group === null ? ' on' : ''}`} aria-pressed={group === null} aria-label={tr('{name}, hosty: {count}', { name: tr('Wszystkie'), count: hosts.length })} onClick={() => chooseGroup(null)}>
                  <span className="ssh-group-tile-name">{tr('Wszystkie')}</span>
                  <span className="ssh-group-tile-count" aria-hidden="true">{hosts.length}</span>
                </button>
                {tiles.map((t) => {
                  const name = t.name;
                  return (
                    <button key={t.key} className={`ssh-group-tile${group === t.key ? ' on' : ''}`} data-group={t.key} aria-pressed={group === t.key}
                      aria-label={tr('{name}, hosty: {count}', { name, count: t.count })}
                      title={tr('Pokaż tylko grupę {name}', { name })} onClick={() => chooseGroup(toggleGroupFilter(group, t.key))}
                      onContextMenu={(e) => groupMenu(e, t.name, hostsInGroup(hosts, t.key).map((h) => h.id))}>
                      <span className="ssh-group-tile-name">{name}</span>
                      <span className="ssh-group-tile-count" aria-hidden="true">{t.count}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          <section className="ssh-view-section" aria-label={tr('Hosty')}>
            {!groups.length ? <p className="ssh-view-none">{tr('Nic nie znaleziono.')}</p> : groups.map((g) => {
              const key = g.name ?? '';
              const open = !headings || !folded.includes(key) || searching;
              const ids = g.hosts.map((h) => h.id);
              return (
                <div key={key} className="ssh-view-group">
                  {headings && <div className="ssh-group-bar">
                    <button className="ssh-group-head" aria-expanded={open} title={tr(open ? 'Zwiń grupę' : 'Rozwiń grupę')} onClick={() => toggleFold(key)} onContextMenu={(e) => groupMenu(e, g.name, ids)}>
                      <span className={open ? 'chev-down' : 'chev-right'}><IChevron /></span>
                      <span className="grow">{g.name ?? tr('Bez grupy')}</span>
                      <span className="muted">{g.hosts.length}</span>
                    </button>
                    <button className="btn small ghost ssh-group-open" onClick={() => openGrid(ids)}>{tr('Otwórz jako siatkę')}</button>
                  </div>}
                  {open && (
                    <div className="ssh-tiles ssh-host-cards">
                      {g.hosts.map((h) => {
                        const state = hostTileState(h.id, cells, sessions);
                        const current = detail?.kind === 'host' && detail.hostId === h.id;
                        const chosen = selected.includes(h.id);
                        return (
                          <div key={h.id} className="ssh-host-card">
                            <button className={`ssh-tile ssh-host-tile${chosen ? ' selected' : ''}${current ? ' current' : ''}${picked === h.id ? ' picked' : ''}`} data-host-id={h.id}
                              aria-current={current ? 'true' : undefined} aria-pressed={chosen}
                              onClick={(e) => clickTile(e, h)} onDoubleClick={() => onConnect(h.id, 'cell')} onKeyDown={(e) => tileKeyDown(e, h)} onContextMenu={(e) => hostMenu(e, h)}
                              title={`${userAtEndpoint(h)} · ${tr(STATE_LABEL[state])}\n${tr('Dwuklik lub Enter: połącz')}`}>
                              <span className={`ssh-host-icon${h.color ? '' : ' uncolored'}`} style={h.color ? { background: h.color } : undefined} aria-hidden="true">
                                <IServer />
                                <span className={`ssh-state ${state}`} />
                              </span>
                              <span className="ssh-host-text">
                                <span className="ssh-tile-name">{h.label}</span>
                                <span className="ssh-tile-detail">{hostCardDetail(h)}</span>
                              </span>
                              <span className="sr-only">{tr(STATE_LABEL[state])}</span>
                            </button>
                            <button type="button" className="ssh-host-edit" aria-label={`${tr('Edytuj host')}: ${h.label}`} title={tr('Edytuj host')} onClick={() => editHost(h.id)}><IEdit /></button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </>
      )}
    </>
  );
}

/** The Klucze section is the keychain: identities (a user name with an optional key and password) above the vault keys. */
function KeysSection({ detail, onClosePane }: { detail: SshDetail | null; onClosePane: () => Promise<void> }) {
  const { tr } = useI18n();
  const vault = useSshStore((st) => st.vault);
  const identities = useStore((st) => st.s.sshIdentities);
  const keys = vault?.keys ?? [];
  const keyIds = keys.map((k) => k.id);
  const sortedIdentities = useMemo(() => [...identities].sort((a, b) => a.label.localeCompare(b.label)), [identities]);
  const toggle = (e: MouseEvent, clicked: SshDetail) => {
    if (e.detail > 1) return;
    const next = clickedDetail(detail, clicked);
    if (next) showSshDetail(next); else void onClosePane();
  };
  return (
    <>
      <div className="ssh-view-titlebar">
        <h2 className="ssh-view-title">{tr('Klucze')}</h2>
        <div className="ssh-view-actions">
          <button className="btn ssh-new-identity" onClick={() => showSshDetail({ kind: 'identity' })}><IPlus />{tr('Nowa tożsamość')}</button>
          <button className="btn primary ssh-new-key" onClick={(e) => openMenuAt(e.currentTarget, newKeyItems(tr))}><IPlus />{tr('Nowy klucz')} <IChevron /></button>
        </div>
      </div>
      <section className="ssh-view-section" aria-label={tr('Tożsamości')}>
        <h3 className="ssh-view-subtitle">{tr('Tożsamości')}</h3>
        {!sortedIdentities.length ? <p className="ssh-view-none">{tr('Brak tożsamości')}</p> : (
          <div className="ssh-tiles">
            {sortedIdentities.map((i) => {
              const current = detail?.kind === 'identity' && detail.identityId === i.id;
              return (
                <button key={i.id} className={`ssh-tile ssh-identity-tile${current ? ' current' : ''}`} data-identity-id={i.id} aria-current={current ? 'true' : undefined}
                  onClick={(e) => toggle(e, { kind: 'identity', identityId: i.id })} title={`${i.label} · ${i.username}`}>
                  <span className="ssh-identity-icon" aria-hidden="true"><IIdentity /></span>
                  <span className="ssh-host-text">
                    <span className="ssh-tile-name">{i.label}</span>
                    <span className="ssh-tile-detail">{i.username} · {tr(identityCredentialText(identityCredential(i, vault?.savedIdentityPasswords ?? [], keyIds)))}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
      {keys.length > 0 && <h3 className="ssh-view-subtitle">{tr('Klucze')}</h3>}
      {!keys.length ? (
        <EmptyState icon={<IKey />} title={tr('Nie masz jeszcze kluczy')} text={tr('Wygeneruj nowy klucz albo dodaj istniejący z pliku lub jako wklejony tekst. Klucz publiczny skopiujesz potem do authorized_keys na serwerze.')}>
          <button className="btn primary" onClick={() => newKey('generate')}>{tr('Wygeneruj klucz')}</button>
          <button className="btn" onClick={() => newKey('file')}>{tr('Importuj z pliku')}</button>
          <button className="btn" onClick={() => newKey('paste')}>{tr('Wklej klucz')}</button>
        </EmptyState>
      ) : (
        <section className="ssh-view-section" aria-label={tr('Klucze')}>
          <div className="ssh-tiles">
            {keys.map((k) => {
              const current = detail?.kind === 'key' && detail.keyId === k.id;
              return (
                <button key={k.id} className={`ssh-tile ssh-key-tile${current ? ' current' : ''}`} data-key-id={k.id} aria-current={current ? 'true' : undefined}
                  onClick={(e) => toggle(e, { kind: 'key', keyId: k.id })} title={k.fingerprint}>
                  <span className="ssh-tile-name">{k.label}{k.locked ? ' !' : ''}</span>
                  <span className="ssh-tile-detail"><span className="ssh-key-type">{shortType(k.type)}</span>{k.fingerprint}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function DetailPane({ detail, onConnect }: { detail: SshDetail; onConnect: (hostId: string, target: 'cell' | 'tab') => void }) {
  const { tr } = useI18n();
  if (detail.kind === 'host') {
    const hostId = detail.hostId;
    return (
      <>
        {hostId && (
          <div className="ssh-detail-actions">
            <button className="btn primary" onClick={() => onConnect(hostId, 'cell')}>{tr('Połącz')}</button>
            <button className="btn" onClick={() => onConnect(hostId, 'tab')}>{tr('Otwórz w nowym gridzie')}</button>
            <button className="btn" onClick={() => openSftp({ hostId })}>{tr('Otwórz SFTP')}</button>
          </div>
        )}
        <HostEditor paneId={detailKey(detail)} hostId={hostId} />
      </>
    );
  }
  if (detail.kind === 'key') return <KeyEditor keyId={detail.keyId} />;
  if (detail.kind === 'identity') return <IdentityEditor identityId={detail.identityId} />;
  return <NewKeyEditor initialMode={detail.mode} />;
}
