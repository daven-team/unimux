import { changeAgentRole } from '../agentRoles';
import { cellLabel } from '../../../shared/agentWork';
import { shortcutText, titleWithShortcut, useShortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { propsEqualWithStyle } from '../../../shared/renderEquality';
import { errorPhrase, failureLabel } from '../../../shared/alerts';
import { failedExit, statusText } from '../../../shared/statusDetail';
import { cellDrawColor, getProfile, PROJECT_COLORS, updateCell } from '../../../shared/state';
import { missingCardCli } from '../../../shared/cliStatus';
import { cellShell, shownProfileName } from '../../../shared/profiles';
import { sshHeaderName, sshPhaseLabel, userAtEndpoint } from '../../../shared/ssh';
import { resolveSshTheme } from '../../../shared/sshThemes';
import { useSshStore } from '../sshStore';
import { useSshConnectStore } from '../sshConnectStore';
import { disconnectCell, openSshView, reconnectCell, sshContext, sshHostMenuItems } from '../ssh';
import { SshCellCard } from './ssh/SshCellCard';
import { SshAutocomplete } from './ssh/SshAutocomplete';
import { openSftp } from '../sftp';
import { profileOptionLabel } from '../cliUi';
import { CliMissingCard } from './CliMissingCard';
import type { Cell } from '../../../shared/types';
import {
  changeCellProfile, ensureStarted, ensureTerminal, removeCell, renameCell, restartCell, sendSnippet, setCellColor, toggleMaximize,
} from '../actions';
import { PATH_MIME, type DropTarget } from '../../../shared/pathDrop';
import type { PathMode } from '../../../shared/types';
import { addDroppedFilesToCell, addPathsToCell, cellDropFormat, cellRefusesPaths, readDroppedPaths } from '../pathDrop';
import { setUi, toast, update, useStore } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { TerminalFind } from '../terminals/terminalFind';
import { useBlink } from '../blink';
import { openMenu, openMenuAt, type MenuItem } from './ContextMenu';
import { IBranch, IMax, IMore, IPrompt, IRestart, IRestore, IX } from './icons';
import { ProviderIcon } from './ProviderIcons';
import { hostInitials } from './ssh/SshConnectCard';
import { CellFoot } from './CellFoot';
import './terminalCell.css';

export const SNIPPET_MIME = 'application/x-mc-snippet';



/** Memoized: the grid re-renders a cell only when its cell object, slot, style values or drag props changed. */
export const CellView = memo(function CellView({ cell, index, style, maximized, dragSource, onHeadPointerDown }: {
  cell: Cell; index: number; style: CSSProperties; maximized: boolean;
  /** This cell is being dragged to another slot. */
  dragSource?: boolean;
  /** Present when the header may start a drag (more than one cell, not maximized). */
  onHeadPointerDown?: (e: React.PointerEvent<HTMLElement>, cell: Cell) => void;
}) {
  const { tr, errorText } = useI18n();
  useShortcutText(); // the shortcut in the tooltips follows the settings
  const bodyRef = useRef<HTMLDivElement>(null);
  const profiles = useStore((st) => st.s.profiles);
  const profile = useStore((st) => getProfile(st.s, cell.profileId));
  // The shell the terminal runs (recorded at its start), not the one Settings would start now.
  const shell = useStore((st) => cellShell(cell, st.s.settings.shell));
  const profileName = shownProfileName(profile, shell, tr);
  const status = useStore((st) => st.ui.statuses[cell.id] ?? 'idle');
  useBlink(status === 'working');
  const failure = useStore((st) => st.ui.failures[cell.id]);
  // The short reason of the status ("czeka na zgodę: Bash", "praca: Edit", "kod wyjścia 1"), see shared/statusDetail.ts.
  const statusDetail = useStore((st) => st.ui.statusDetails[cell.id]);
  const statusLabel = statusText(status, failure !== undefined ? 'error' : undefined, statusDetail, failure);
  const focused = useStore((st) => st.ui.focusedCellId === cell.id);
  const mcpInfo = useStore((st) => st.ui.mcpInfo);
  const error = useStore((st) => st.ui.cellErrors[cell.id]);
  const epoch = useStore((st) => st.ui.epoch);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const held = useStore((st) => st.ui.heldCells[cell.id] === true);
  // An SSH cell stays SSH whatever its profile says (R5): no CLI card, no profile, role or path mode choices.
  const ssh = cell.ssh;
  const host = useStore((st) => (ssh ? st.s.sshHosts.find((h) => h.id === ssh.hostId) : undefined));
  const sshSession = useSshStore((st) => st.sessions[cell.id]);
  const sshPrompt = useSshStore((st) => st.prompts[cell.id]);
  // A cancelled attempt ends like a closed session; the header says what the card says ("Anulowano").
  const sshCancelled = useSshConnectStore((st) => !!ssh && st.attempts[cell.id]?.cancelled === true && sshSession?.phase !== 'connected');
  const phaseLabel = ssh ? (sshCancelled && !sshPrompt ? { key: 'Anulowano' as const } : sshPhaseLabel(sshSession, sshPrompt, sshContext(ssh.hostId))) : null;
  // SSH cells draw in their colour theme: the host's own, else the one of Settings > SSH (local terminals keep the app look).
  const sshThemeSetting = useStore((st) => (ssh ? st.s.settings.sshTheme : undefined));
  const sshTheme = ssh ? resolveSshTheme(host?.theme, sshThemeSetting) : undefined;
  // 1.0.4: an SSH cell takes its host's colour (Hosty) unless the user gave the cell its own.
  const color = cellDrawColor(cell, host);
  // The card replaces the terminal only while the cell is held; a running terminal is never hidden by a late "missing".
  const lackingCli = ssh ? null : missingCardCli(profile, cliStatus, held);
  const sessionTitle = useStore((st) => (cell.session ? st.ui.sessionTitles[cell.session.id] : undefined));
  const [drop, setDrop] = useState(false);
  /** A file or folder from the Files tree is over the cell (blocked: the cell is not running and would refuse it). */
  const [pathDrop, setPathDrop] = useState<{ blocked: boolean; target: DropTarget } | null>(null);
  const [editing, setEditing] = useState(false);
  const [floodHint, setFloodHint] = useState(false);

  // The terminal stopped feeding a shell with the mouse reports it was echoing (see termReset.ts).
  useEffect(() => terminals.onMouseFlood((id) => { if (id === cell.id) setFloodHint(true); }), [cell.id]);

  useEffect(() => {
    const el = bodyRef.current!;
    // Attach (and fit) before starting so the pty is spawned with the cell's real size.
    ensureTerminal(cell.id);
    terminals.attach(cell.id, el);
    ensureStarted(cell.id, true);
    return () => terminals.detach(cell.id, el);
  }, [cell.id, epoch]);

  // After the attach above (the terminal exists by then); a theme changed in the settings or on the host repaints at once.
  useEffect(() => { terminals.setTheme(cell.id, sshTheme?.colors, sshTheme?.minimumContrastRatio); }, [cell.id, epoch, sshTheme]);

  const markFocused = () => {
    setUi({ focusedCellId: cell.id });
  };

  // The card's title: the user's name, else the conversation title, else the profile (an SSH cell: else the host's name).
  const shownName = ssh
    ? sshHeaderName(cell.name) || host?.label || tr('Host usunięty')
    : cellLabel(cell, sessionTitle && cell.session ? { [cell.session.id]: sessionTitle } : {}, profileName);
  /** The profile shows among the details only when the title is not already it. */
  const metaProfile = !ssh && shownName !== profileName;
  // A non-zero exit code (the last command, the CLI, the process) is an error in the dot and the pill alike (1.0.7).
  const exitFailed = failedExit(statusDetail);
  const dotClass = `${status}${(status === 'waiting' && failure !== undefined) || exitFailed ? ' error' : ''}`;

  const sshItems = (): MenuItem[] => [
    { label: tr('Połącz ponownie'), onClick: () => void reconnectCell(cell.id) },
    { label: tr('Rozłącz'), onClick: () => disconnectCell(cell.id) },
    // 0.9.8: the SFTP view on this host, in the folder the shell last reported (OSC 7 / 9;9), else the login folder.
    ...(host && sshSession?.phase === 'connected' ? [{ label: tr('Otwórz SFTP tutaj'), onClick: () => openSftp({ hostId: host.id, path: terminals.remoteCwd(cell.id) }) }] : []),
    ...(host ? [{ label: tr('Edytuj host'), onClick: () => openSshView({ kind: 'host', hostId: host.id }) }] : []),
    ...(host ? [{ label: tr('Kopiuj adres'), onClick: () => window.mc.clipboardWrite(userAtEndpoint(host)) }] : []),
  ];

  const profileItems = (): MenuItem[] => [
    { header: tr("Zmień profil (nowa rozmowa)") },
    // The current profile is marked and named as the header names it (the shell it really runs, 1.0.7).
    ...profiles.map((p) => ({ label: p.id === profile.id && profile.cli === 'shell' ? profileName : profileOptionLabel(p, cliStatus, tr), hint: p.id === profile.id ? '✓' : undefined, onClick: () => changeCellProfile(cell.id, p.id) })),
  ];

  const restartItems = (): MenuItem[] => ssh ? sshItems() : [
    ...(cell.session ? [{ label: tr("Uruchom ponownie i wznów rozmowę"), onClick: () => restartCell(cell.id, 'resume') }] : []),
    { label: profile.cli === 'shell' ? tr("Uruchom ponownie") : tr("Nowa rozmowa"), onClick: () => restartCell(cell.id, 'new') },
  ];

  /** What a shell cell inserts for dropped files: detected from the agent running in it, or forced by the user. */
  const pathModeItems = (): MenuItem[] => {
    const choose = (mode: PathMode | undefined) => () => update((s) => updateCell(s, cell.id, { pathMode: mode }));
    const mark = (mode: PathMode | undefined) => (cell.pathMode === mode ? '✓' : undefined);
    return [
      { header: tr("Wstawianie ścieżek") },
      { label: tr("Automatycznie (wykryj Claude lub Codex)"), hint: mark(undefined), onClick: choose(undefined) },
      { label: tr("Claude: @ścieżka"), hint: mark('claude'), onClick: choose('claude') },
      { label: tr("Codex: zwykła ścieżka"), hint: mark('codex'), onClick: choose('codex') },
      { label: tr("Powłoka: ścieżka w cudzysłowie"), hint: mark('shell'), onClick: choose('shell') },
    ];
  };

  const dropLabel = (target: DropTarget) => tr(target === 'claude' ? 'Upuść: @ścieżka (Claude)' : target === 'codex' ? 'Upuść: ścieżka (Codex)' : 'Upuść: ścieżka w cudzysłowie (powłoka)');

  /** Every action of the cell: the header's context menu and its "more" button. */
  const menuItems = (): MenuItem[] => [
    { label: tr("Zmień nazwę"), onClick: () => setEditing(true) },
    ...(cell.name ? [{ label: tr("Przywróć nazwę automatyczną"), onClick: () => renameCell(cell.id, '') }] : []),
    { header: tr("Kolor") },
    { colors: PROJECT_COLORS, onPick: (c: string) => setCellColor(cell.id, c) },
    // Only a colour the cell shows: an automatic accent behind the host's colour has nothing to remove.
    ...(cell.color && color === cell.color ? [{ label: tr("Usuń kolor"), onClick: () => setCellColor(cell.id, undefined) }] : []),
    { sep: true },
    ...restartItems(),
    ...(!ssh && profile.cli === 'shell' ? [{ sep: true as const }, ...pathModeItems()] : []),
    ...(!ssh && profile.cli !== 'shell' ? [
      { label: cell.muted ? tr("Włącz alerty tej komórki") : tr("Wycisz alerty tej komórki"), onClick: () => update((s) => updateCell(s, cell.id, { muted: cell.muted ? undefined : true })) },
    ] : []),
    { label: maximized ? tr("Przywróć siatkę") : tr("Maksymalizuj"), onClick: () => toggleMaximize(cell.id), hint: shortcutText('cell.maximize') || undefined },
    { label: tr("Zresetuj terminal"), onClick: () => { terminals.resetInput(cell.id); setFloodHint(false); toast(tr("Terminal zresetowany - historia została zachowana.")); } },
    ...(!ssh ? [{ sep: true as const }, ...profileItems()] : []),
    ...(!ssh && profile.cli !== 'shell' ? [
      { sep: true as const },
      { label: tr('Bez MCP'), onClick: () => { void changeAgentRole(cell.id, null); } },
      { label: tr('Koordynator'), onClick: () => { void changeAgentRole(cell.id, 'coordinator'); } },
      { label: tr('Wykonawca'), onClick: () => { void changeAgentRole(cell.id, 'worker'); } },
    ] : []),
    { sep: true },
    ...sshHostMenuItems('Dodaj komórkę SSH'),
    { sep: true },
    { label: tr("Zamknij komórkę"), danger: true, onClick: () => void removeCell(cell.id) },
  ];

  const headerMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, menuItems());
  };

  return (
    <div
      data-cell-id={cell.id}
      data-status={status === 'waiting' && failure !== undefined ? 'error' : status}
      className={`cell terminal-cell ${focused ? 'focused' : ''} ${drop ? 'drop' : ''} ${color ? 'colored' : ''} ${dragSource ? 'drag-source' : ''}`}
      style={color ? { ...style, ['--cc' as string]: color } : style}
      onMouseDownCapture={markFocused}
      onFocusCapture={markFocused}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PATH_MIME) || e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          const blocked = cellRefusesPaths(cell.id);
          const target = cellDropFormat(cell.id)?.target ?? 'shell';
          if (pathDrop?.blocked !== blocked || pathDrop.target !== target) setPathDrop({ blocked, target });
          return;
        }
        if (!e.dataTransfer.types.includes(SNIPPET_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDrop(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDrop(false);
        setPathDrop(null);
      }}
      onDrop={(e) => {
        setDrop(false);
        setPathDrop(null);
        if (!e.dataTransfer.types.includes(PATH_MIME) && e.dataTransfer.files.length) {
          e.preventDefault();
          void addDroppedFilesToCell(cell.id, [...e.dataTransfer.files]);
          return;
        }
        const paths = e.dataTransfer.types.includes(PATH_MIME) ? e.dataTransfer.getData(PATH_MIME) : '';
        if (paths) {
          e.preventDefault();
          const parsed = readDroppedPaths(paths);
          if (parsed) void addPathsToCell(cell.id, parsed.items, parsed.rejected, parsed.cut);
          else toast(tr('Nie udało się dodać ścieżki.'), 'error');
          return;
        }
        const raw = e.dataTransfer.getData(SNIPPET_MIME);
        if (!raw) return;
        e.preventDefault();
        sendSnippet(JSON.parse(raw), { cellId: cell.id });
      }}
    >
      <div
        className={`cell-head ${onHeadPointerDown ? 'draggable' : ''}`}
        title={onHeadPointerDown ? tr('Przeciągnij za pasek, aby zamienić komórki miejscami') : undefined}
        onPointerDown={onHeadPointerDown && ((e) => onHeadPointerDown(e, cell))}
        onContextMenu={headerMenu}
        onDoubleClick={(e) => (e.target as HTMLElement).closest('button,.cell-name,input') || toggleMaximize(cell.id)}
      >
        <div className="cell-heading">
          {/* The cell's icon (its agent, a shell, or the SSH host's chip) opens the profile or host menu; the status dot sits on it. */}
          {ssh ? (
            <button type="button" className="cell-icon ssh-host" onClick={(e) => openMenuAt(e.currentTarget, sshItems())} title={host ? userAtEndpoint(host) : tr('Host usunięty')} aria-label={host?.label ?? tr('Host usunięty')}>
              <span className={`cell-icon-tile host${host?.color ? '' : ' uncolored'}`} style={host?.color ? { background: host.color } : undefined}>{hostInitials(host?.label ?? '?')}</span>
              <span className={`dot ${dotClass}`} />
            </button>
          ) : (
            <button type="button" className="cell-icon" onClick={(e) => openMenuAt(e.currentTarget, profileItems())} title={`${profileName}\n${tr("Zmień profil")}`} aria-label={`${tr("Zmień profil")}: ${profileName}`}>
              <span className="cell-icon-tile">{profile.cli === 'shell' ? <IPrompt /> : <ProviderIcon provider={profile.cli} size={14} />}</span>
              <span className={`dot ${dotClass}`} />
            </button>
          )}
          <span className="idx">{index + 1}</span>
          {editing ? (
            <input
              className="cell-name-input"
              autoFocus
              defaultValue={cell.name ?? sessionTitle ?? ''}
              placeholder={tr("Nazwa komórki")}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                renameCell(cell.id, e.target.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(false);
                e.stopPropagation();
              }}
            />
          ) : (
            <span className={`cell-name ${cell.name ? 'custom' : ''}`} title={`${shownName}\n${tr(cell.name ? 'Dwuklik: zmień nazwę' : 'Dwuklik: nadaj nazwę')}`} onDoubleClick={() => setEditing(true)}>
              {shownName}
            </span>
          )}
          {/* Muted details: the profile when the name is not it, the model, the worktree branch, user@host of an SSH cell. */}
          {!editing && (metaProfile || cell.model || cell.worktree || (ssh && host)) && <span className="cell-meta">
            {metaProfile && <span className="meta-item">{profileName}</span>}
            {cell.model && <span className="meta-item model" title={cell.model}>{cell.model}</span>}
            {cell.worktree && (
              <span className="meta-item branch" title={cell.worktree.path}><IBranch /><span>{cell.worktree.branch || cell.worktree.path}</span></span>
            )}
            {ssh && host && <span className="meta-item endpoint" title={userAtEndpoint(host)}>{userAtEndpoint(host)}</span>}
          </span>}
          {cell.muted && <span className="muted-mark" title={tr("Alerty tej komórki są wyciszone")} aria-label={tr("Alerty tej komórki są wyciszone")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0M3 3l18 18" /></svg>
          </span>}
        </div>
        {/* The status as a pill beside the actions: it never pushes the name away, the details give way first. */}
        {phaseLabel
          ? <span className="status-text ssh">{tr(phaseLabel.key, phaseLabel.params)}</span>
          : status === 'waiting' && failure !== undefined
          ? <span className="status-text error" title={tr(errorPhrase(failure))}>{tr(failureLabel(failure))}</span>
          : statusLabel && <span className={`status-text ${status}${exitFailed ? ' error' : ''}`} title={tr(statusLabel.key, statusLabel.params)}>{tr(statusLabel.key, statusLabel.params)}{status === 'working' ? '…' : ''}</span>}
        <span className="actions">
          {profile.cli !== 'shell' && !ssh && <button className={`mcp-control ${cell.role ?? 'disabled'} ${mcpInfo.connectedCellIds?.includes(cell.id) ? 'connected' : ''}`}
            aria-label={`${tr('Rola / MCP')}: ${tr(cell.role === 'coordinator' ? 'Koordynator' : cell.role === 'worker' ? 'Wykonawca' : 'Bez MCP')}`}
            title={`${tr(cell.role === 'coordinator' ? 'Koordynator' : cell.role === 'worker' ? 'Wykonawca' : 'Bez MCP')} · ${tr(cell.role ? mcpInfo.connectedCellIds?.includes(cell.id) ? 'MCP działa' : mcpInfo.configuredCellIds?.includes(cell.id) ? 'MCP skonfigurowane · oczekiwanie na agenta' : 'Wymaga restartu' : 'Rola / MCP')}`}
            onClick={(e) => openMenuAt(e.currentTarget, [
              { header: tr('Rola / MCP') },
              { label: tr('Koordynator'), hint: cell.role === 'coordinator' ? '✓' : undefined, onClick: () => void changeAgentRole(cell.id, 'coordinator') },
              { label: tr('Wykonawca'), hint: cell.role === 'worker' ? '✓' : undefined, onClick: () => void changeAgentRole(cell.id, 'worker') },
              { label: tr('Bez MCP'), hint: !cell.role ? '✓' : undefined, onClick: () => void changeAgentRole(cell.id, null) },
            ])}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {cell.role === 'coordinator' ? <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v6M5 17v-4h14v4" /></> : <><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />{!cell.role && <path d="m3 3 18 18" />}</>}
            </svg><span className="mcp-indicator" />
          </button>}
          <button className="restart" aria-label={tr("Uruchom ponownie")} title={tr("Uruchom ponownie")} onClick={(e) => {
            // One choice needs no menu (a shell, an agent without a conversation): the button restarts at once.
            const items = restartItems();
            if (items.length === 1 && 'onClick' in items[0]) items[0].onClick();
            else openMenuAt(e.currentTarget, items);
          }}><IRestart /></button>
          <button aria-label={tr('Więcej akcji')} title={tr('Więcej akcji')} onClick={(e) => openMenuAt(e.currentTarget, menuItems())}><IMore /></button>
          <button className="maximize" aria-label={maximized ? tr("Przywróć siatkę") : tr("Maksymalizuj")} title={titleWithShortcut(maximized ? tr("Przywróć siatkę") : tr("Maksymalizuj"), 'cell.maximize')} onClick={() => toggleMaximize(cell.id)}>
            {maximized ? <IRestore /> : <IMax />}
          </button>
          <button className="close" aria-label={tr("Zamknij komórkę")} title={tr("Zamknij komórkę")} onClick={() => void removeCell(cell.id)}><IX /></button>
        </span>
      </div>
      {/* The card's body: the terminal and everything drawn over it (the overlays are placed from its top, terminalCell.css). */}
      <div className="cell-main">
        <div className="cell-body" ref={bodyRef} style={lackingCli ? { visibility: 'hidden' } : sshTheme ? { ['--term-bg' as string]: sshTheme.colors.background } : undefined} />
        {!lackingCli && <TerminalFind cellId={cell.id} />}
        {pathDrop && <div className={`cell-path-drop ${pathDrop.blocked ? 'blocked' : ''}`} role="status">{pathDrop.blocked ? tr(ssh ? 'Ścieżki lokalne nie działają w sesji SSH' : 'Komórka nie jest uruchomiona') : dropLabel(pathDrop.target)}</div>}
        {drop && !pathDrop && <div className="cell-snippet-drop" role="status">{tr('Upuść, aby wkleić')}</div>}
        {lackingCli && <CliMissingCard cli={lackingCli} cellId={cell.id} onChangeProfile={(anchor) => openMenuAt(anchor, profileItems())} />}
        {ssh && <SshCellCard cellId={cell.id} host={host} session={sshSession} prompt={sshPrompt} />}
        {ssh && <SshAutocomplete cellId={cell.id} />}
        {floodHint && !error && (
          <div className="cell-hint" role="status">
            <span className="grow">{tr("Terminal wysyłał zdarzenia myszy do powłoki - zresetowano tryb")}</span>
            <button className="btn small" onClick={() => setFloodHint(false)}>{tr("Zamknij")}</button>
          </div>
        )}
        {error && (
          <div className="cell-error">
            <span className="grow">{errorText(error)}</span>
            <button className="btn small" onClick={() => restartCell(cell.id, cell.session ? 'resume' : 'new')}>{tr("Spróbuj ponownie")}</button>
          </div>
        )}
      </div>
      {/* The footer slot (1.0.7): a bar under the terminal inside the card, e.g. the SSH status bar; see CellFoot.tsx. */}
      <div className="cell-foot"><CellFoot cell={cell} /></div>
      <span className="cell-frame" aria-hidden="true" />
    </div>
  );
}, propsEqualWithStyle);
