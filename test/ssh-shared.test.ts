import { describe, expect, it } from 'vitest';
import {
  storageLabel, readOnlyStoreNote, knownHostsLocked, knownHostsDescription, READ_ONLY_VAULT_HINT, addressProblem, applySshSnapshot, draftErrorKey, hostsUsingKey, labelFieldValue, newKeyProblem, broadcastTargets, enterSubmitsPrompt, isSshCell, promptNeedsToast, restoredPromptToasts, sshCellVisible, sshHeaderName, filterHosts, groupHosts, hostEndpoint, knownHostId, normalizeSshHosts, normalizeTags, parseFoldedGroups, sshGridName, toggleSelection,
  broadcastProblem, broadcastRowState, broadcastSend, ptyHostRestartToast, pushHistory, resumesConversation, sshCellsOfTab, cellSourcePatch, cellSourceValue, currentBroadcastResult, connectingBanner, existingSelection, parseCellSource, sanitizeServerText, sshCellStart, sshErrorText, sshModeReset, sshPhaseLabel, sshSpecName, sshSessionEnded, stampBroadcastResults, startupInput, startupProblem, userAtEndpoint, validateHostDraft,
  type SshHost, type SshSessionState,
} from '../src/shared/ssh';
import { cellDrawColor, CELL_COLORS } from '../src/shared/state';
import { sshMessages } from '../src/shared/sshMessages';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const host = (n: number, patch: Partial<SshHost> = {}): SshHost => ({ id: ID(n), label: `h${n}`, address: `h${n}.example`, port: 22, username: 'deploy', createdAt: 1, updatedAt: 1, ...patch });
const session = (cellId: string, phase: SshSessionState['phase'], extra: Partial<SshSessionState> = {}): SshSessionState => ({ cellId, hostId: ID(1), phase, since: 0, ...extra });

describe('host normalization', () => {
  it('keeps valid hosts, fills defaults and clamps fields', () => {
    const [h] = normalizeSshHosts([{ id: ID(1), label: '  web  ', address: 'WEB.Example.COM', port: 0, username: ' deploy ', tags: ['Prod', 'prod', ' a b ', 'x'.repeat(30)], group: ' eu ', color: '#ABCDEF', keyId: 'not-a-uuid', extra: 1 }]);
    expect(h).toEqual({ id: ID(1), label: 'web', address: 'web.example.com', port: 22, username: 'deploy', group: 'eu', tags: ['prod', 'a-b'], color: '#ABCDEF', createdAt: 0, updatedAt: 0 });
  });

  it('drops junk, bad ids, bad addresses and duplicates', () => {
    const hosts = normalizeSshHosts([null, 5, { id: 'x' }, { id: ID(2), address: 'a b', username: 'u' }, host(3), host(3, { label: 'dup' }), { ...host(4), username: '' }]);
    expect(hosts.map((h) => h.id)).toEqual([ID(3)]);
    expect(normalizeSshHosts('nope')).toEqual([]);
  });

  it('falls back to the address as label and keeps IPv6 literals without brackets', () => {
    expect(normalizeSshHosts([{ ...host(1), label: '', address: '[FE80::1]' }])[0]).toMatchObject({ label: 'fe80::1', address: 'fe80::1' });
  });

  it('refuses a startup command with control characters when loading', () => {
    expect(normalizeSshHosts([{ ...host(1), startupCommand: 'ls\u001b[2J' }])[0].startupCommand).toBeUndefined();
    expect(normalizeSshHosts([{ ...host(1), startupCommand: 'cd /srv\n\tls' }])[0].startupCommand).toBe('cd /srv\n\tls');
  });
});

describe('host drafts', () => {
  const draft = { label: '', address: 'example.com', port: '', username: 'me', group: '', tags: [], startupCommand: '', reconnectOnStart: false };
  it('accepts a minimal draft with port 22 and the address as label', () => {
    expect(validateHostDraft(draft)).toEqual({ ok: true, value: { label: 'example.com', address: 'example.com', port: 22, username: 'me' } });
  });
  it('reports each bad field with a message key', () => {
    const r = validateHostDraft({ ...draft, address: 'example.com:2222', port: '70000', username: 'a b', startupCommand: 'x\u0007' });
    expect(r).toEqual({ ok: false, errors: { address: 'Port wpisz w polu Port', port: 'Nieprawidłowy port', username: 'Podaj nazwę użytkownika', startupCommand: 'Polecenie zawiera znaki sterujące' } });
    expect(validateHostDraft({ ...draft, address: '' })).toMatchObject({ ok: false, errors: { address: 'Podaj adres hosta' } });
    expect(validateHostDraft({ ...draft, address: 'bad host' })).toMatchObject({ ok: false, errors: { address: 'Nieprawidłowy adres hosta' } });
    expect(validateHostDraft({ ...draft, startupCommand: 'x'.repeat(8 * 1024 + 1) })).toMatchObject({ ok: false, errors: { startupCommand: 'Polecenie startowe jest za długie' } });
  });
  it('accepts IPv4, IPv6 (bracketed or not) and ports with spaces around', () => {
    for (const address of ['10.0.0.5', '::1', '[2001:db8::7]', 'fe80::1%eth0']) expect(validateHostDraft({ ...draft, address }).ok, address).toBe(true);
    expect(validateHostDraft({ ...draft, port: ' 2222 ' })).toMatchObject({ ok: true, value: { port: 2222 } });
    expect(addressProblem('-oProxyCommand=x')).toBe('invalid');
  });
});

describe('endpoints and known host ids', () => {
  it('uses the OpenSSH forms', () => {
    expect(knownHostId('example.com', 22)).toBe('example.com');
    expect(knownHostId('example.com', 2222)).toBe('[example.com]:2222');
    expect(knownHostId('::1', 2222)).toBe('[::1]:2222');
    expect(hostEndpoint('::1', 22)).toBe('::1');
    expect(hostEndpoint('::1', 2200)).toBe('[::1]:2200');
    expect(hostEndpoint('example.com', 2200)).toBe('example.com:2200');
    expect(userAtEndpoint(host(1, { port: 2200 }))).toBe('deploy@h1.example:2200');
  });
});

describe('search and groups', () => {
  const hosts = [host(1, { label: 'web-1', group: 'prod', tags: ['eu'] }), host(2, { label: 'db', group: 'prod' }), host(3, { label: 'pi' }), host(4, { label: 'api', group: 'dev' })];
  it('groups by name with "no group" last and hosts by label', () => {
    expect(groupHosts(hosts).map((g) => [g.name, g.hosts.map((h) => h.label)])).toEqual([['dev', ['api']], ['prod', ['db', 'web-1']], [null, ['pi']]]);
  });
  it('filters over label, address, user, group and tags', () => {
    expect(filterHosts(hosts, 'eu').map((h) => h.label)).toEqual(['web-1']);
    expect(filterHosts(hosts, 'dev').map((h) => h.label)).toEqual(['api']);
    expect(filterHosts(hosts, '')).toHaveLength(4);
  });
});

describe('startup input', () => {
  it('normalizes newlines, drops trailing blank lines and ends with Enter', () => {
    expect(startupInput('cd /srv\r\nls -la\n\n  \n')).toBe('cd /srv\rls -la\r');
    expect(startupInput('one')).toBe('one\r');
    expect(startupInput('\tindented')).toBe('\tindented\r');
  });
  it('refuses ESC, other controls, empty text and oversize text', () => {
    expect(startupInput('ls\u001b[31m')).toBeNull();
    expect(startupInput('a\u0003')).toBeNull();
    expect(startupInput('\n\n')).toBeNull();
    expect(startupInput(undefined)).toBeNull();
    expect(startupInput('x'.repeat(8 * 1024 + 1))).toBeNull();
    expect(startupProblem('ok\n')).toBeNull();
  });
});

describe('session texts', () => {
  const ctx = { host: 'h1.example', endpoint: 'h1.example:2200' };
  it('maps every error code to a message', () => {
    expect(sshErrorText('dns', ctx)).toEqual({ key: 'Nie znaleziono hosta {host}', params: { host: 'h1.example' } });
    expect(sshErrorText('refused', ctx)).toEqual({ key: 'Połączenie odrzucone ({endpoint})', params: { endpoint: 'h1.example:2200' } });
    expect(sshErrorText('unknown', ctx)).toEqual({ key: 'Nieznany błąd SSH' });
  });
  it('labels phases and prompts for the header', () => {
    expect(sshPhaseLabel(session('c', 'connecting'))).toEqual({ key: 'łączenie…' });
    expect(sshPhaseLabel(session('c', 'connected'))).toBeNull();
    expect(sshPhaseLabel(session('c', 'authenticating'), { id: 'p', kind: 'password', user: 'u', endpoint: 'e', canSave: true, retry: false })).toEqual({ key: 'czeka na hasło' });
    expect(sshPhaseLabel(session('c', 'error', { error: 'timeout' }), undefined, ctx)).toEqual({ key: 'Przekroczono czas połączenia' });
  });
  it('has no bracketed status lines for the terminal any more: the cell card says what a session does (1.0.5)', () => {
    expect(Object.keys(sshMessages).filter((k) => k.startsWith('[SSH'))).toEqual([]);
  });
  it('decides what a mounted SSH cell does', () => {
    expect(sshCellStart({ alive: true, connectOnMount: true })).toBe('attach');
    expect(sshCellStart({ alive: false, connectOnMount: true })).toBe('connect');
    expect(sshCellStart({ alive: false, connectOnMount: false })).toBe('idle');
  });
});

describe('broadcast targets', () => {
  it('checks connected cells and disables the rest with a reason', () => {
    const cells = ['a', 'b', 'c', 'd'].map((cellId) => ({ cellId, label: cellId, endpoint: 'e' }));
    const rows = broadcastTargets(cells, { a: session('a', 'connected'), b: session('b', 'connecting'), c: session('c', 'authenticating') },
      { c: { id: 'p', kind: 'password', user: 'u', endpoint: 'e', canSave: false, retry: false } });
    expect(rows.map((r) => [r.cellId, r.enabled, r.checked, r.reason])).toEqual([
      ['a', true, true, undefined], ['b', false, false, 'łączenie…'], ['c', false, false, 'czeka na hasło'], ['d', false, false, 'rozłączono'],
    ]);
  });
});

describe('server text', () => {
  it('strips escape sequences and controls, keeps newlines and tabs, caps the length', () => {
    expect(sanitizeServerText('Welcome\u001b[31m red\u001b[0m\r\n\tok\u0007\u001b]0;title\u0007!')).toBe('Welcome red\n\tok!');
    expect(sanitizeServerText('x'.repeat(5000))).toHaveLength(2048);
    expect(sanitizeServerText(42)).toBe('');
  });
  it('normalizes tags', () => {
    expect(normalizeTags(['A', 'a', '', 'b c', 7, ...'cdefghijk'.split('')])).toEqual(['a', 'b-c', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
});

describe('renderer helpers', () => {
  it('turns a sessions snapshot into lookups by cell', () => {
    const prompt = { id: 'p', kind: 'password' as const, user: 'u', endpoint: 'e', canSave: true, retry: false };
    expect(applySshSnapshot({ sessions: [session('a', 'connected'), session('b', 'authenticating')], prompts: [{ cellId: 'b', prompt }] }))
      .toEqual({ sessions: { a: session('a', 'connected'), b: session('b', 'authenticating') }, prompts: { b: prompt } });
  });
  it('toasts a new prompt only for a cell that is not visible (Review Focus 3)', () => {
    expect(promptNeedsToast({ visible: false, nextId: 'p1' })).toBe(true);
    expect(promptNeedsToast({ visible: false, previousId: 'p1', nextId: 'p1' })).toBe(false);
    expect(promptNeedsToast({ visible: true, nextId: 'p2' })).toBe(false);
  });
  it('recognizes SSH cells', () => {
    expect(isSshCell({ ssh: { hostId: 'h' } })).toBe(true);
    expect(isSshCell({})).toBe(false);
  });
  it('keeps a cell SSH whatever its profile says (R5)', () => {
    const cell = { ssh: { hostId: 'h' }, profileId: 'claude' };
    expect(isSshCell(cell)).toBe(true);
  });
});

describe('renderer helpers (fix round 1)', () => {
  const p = (id: string) => ({ id, kind: 'password' as const, user: 'u', endpoint: 'e', canSave: true, retry: false });
  it('announces prompts restored after a reload for hidden cells only', () => {
    expect(restoredPromptToasts({ a: p('1'), b: p('2') }, (cellId) => cellId === 'a')).toEqual(['b']);
    expect(restoredPromptToasts({}, () => false)).toEqual([]);
  });
  it('treats a cell as hidden while another cell of its tab is maximized', () => {
    const base = { inActiveTab: true, covered: false, cellId: 'a' };
    expect(sshCellVisible({ ...base, maximizedCellId: null })).toBe(true);
    expect(sshCellVisible({ ...base, maximizedCellId: 'a' })).toBe(true);
    expect(sshCellVisible({ ...base, maximizedCellId: 'b' })).toBe(false);
    expect(sshCellVisible({ ...base, covered: true, maximizedCellId: null })).toBe(false);
    expect(sshCellVisible({ ...base, inActiveTab: false, maximizedCellId: null })).toBe(false);
  });
  it('shows a cell name next to the host chip only when the user gave one', () => {
    expect(sshHeaderName(undefined)).toBeNull();
    expect(sshHeaderName('  ')).toBeNull();
    expect(sshHeaderName('db primary')).toBe('db primary');
  });
  it('submits a sign-in prompt on Enter only from its text fields', () => {
    expect(enterSubmitsPrompt({ tagName: 'INPUT', type: 'password' })).toBe(true);
    expect(enterSubmitsPrompt({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(enterSubmitsPrompt({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(enterSubmitsPrompt({ tagName: 'BUTTON', type: 'button' })).toBe(false);
  });
  it('never connects a cell after a Pty Host crash (D5): no alive pty and no connectOnMount mark', () => {
    expect(sshCellStart({ alive: false, connectOnMount: false })).toBe('idle');
  });
});

describe('key editors', () => {
  it('maps import errors and new key form problems to messages', () => {
    expect(draftErrorKey('ppkV3')).toBe('Klucz PuTTY w wersji 3 nie jest obsługiwany. Zapisz go w PuTTYgen jako OpenSSH.');
    expect(draftErrorKey('badPassphrase')).toBe('Nieprawidłowe hasło klucza');
    expect(draftErrorKey('cancelled')).toBeNull();
    // Any read-only vault (unreadable, damaged or newer): a generic text that points to Settings > SSH, never "newer version" alone.
    expect(draftErrorKey('readOnly')).toBe(READ_ONLY_VAULT_HINT);
    expect(READ_ONLY_VAULT_HINT).toMatch(/tylko do odczytu.*Ustawienia > SSH/);
    expect(READ_ONLY_VAULT_HINT).not.toMatch(/nowszej wersji/);
    expect(newKeyProblem({ label: '', passphrase: '', repeat: '' })).toBe('Podaj etykietę');
    expect(newKeyProblem({ label: 'k', passphrase: 'a', repeat: 'b' })).toBe('Hasła się różnią');
    expect(newKeyProblem({ label: 'k', passphrase: 'a', repeat: 'a' })).toBeNull();
    expect(hostsUsingKey([host(1, { keyId: 'k' }), host(2)], 'k').map((h) => h.id)).toEqual([ID(1)]);
  });
  it('follows the stored key label unless the user is typing in the field', () => {
    expect(labelFieldValue({ field: 'old', stored: 'renamed', focused: false })).toBe('renamed');
    expect(labelFieldValue({ field: 'typing', stored: 'renamed', focused: true })).toBe('typing');
  });
});

describe('panel helpers', () => {
  it('names a grid after a shared group or by count', () => {
    expect(sshGridName([host(1, { group: 'prod' }), host(2, { group: 'prod' })])).toEqual({ group: 'prod' });
    expect(sshGridName([host(1, { group: 'prod' }), host(2)])).toEqual({ count: 2 });
    expect(sshGridName([host(1)])).toEqual({ count: 1 });
  });
  it('toggles selection and reads folded groups defensively', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
    expect(parseFoldedGroups('["prod",""]')).toEqual(['prod', '']);
    expect(parseFoldedGroups('{"x":1}')).toEqual([]);
    expect(parseFoldedGroups('not json')).toEqual([]);
    expect(parseFoldedGroups(null)).toEqual([]);
  });
  it('drops selected ids of hosts that no longer exist', () => {
    expect(existingSelection([ID(1), ID(9), ID(2)], [host(1), host(2)])).toEqual([ID(1), ID(2)]);
    expect(existingSelection([ID(9)], [host(1)])).toEqual([]);
    expect(existingSelection([], [host(1)])).toEqual([]);
  });
});

describe('grid dialog cell sources', () => {
  it('round trips profiles and hosts through the select value', () => {
    expect(cellSourceValue({ profileId: 'claude' })).toBe('claude');
    expect(cellSourceValue({ profileId: 'shell', sshHostId: ID(1) })).toBe(`ssh:${ID(1)}`);
    expect(parseCellSource(`ssh:${ID(1)}`)).toEqual({ kind: 'ssh', hostId: ID(1) });
    expect(parseCellSource('codex')).toEqual({ kind: 'profile', profileId: 'codex' });
    expect(parseCellSource('ssh:')).toEqual({ kind: 'profile', profileId: 'ssh:' });
  });
});

describe('broadcast helpers', () => {
  it('refuses ESC and oversize text', () => {
    expect(broadcastProblem('uptime')).toBeNull();
    expect(broadcastProblem('line1\nline2\ttab')).toBeNull();
    expect(broadcastProblem('ls\u001b[A')).toBe('Polecenie zawiera znaki sterujące');
    expect(broadcastProblem('x'.repeat(64 * 1024 + 1))).toBe('Polecenie jest za długie');
  });
  it('keeps a short history without consecutive duplicates', () => {
    let h: string[] = [];
    for (const t of ['a', 'b', 'b', 'c']) h = pushHistory(h, t);
    expect(h).toEqual(['a', 'b', 'c']);
    for (let i = 0; i < 30; i++) h = pushHistory(h, `x${i}`);
    expect(h).toHaveLength(20);
    expect(h.at(-1)).toBe('x29');
    expect(pushHistory(h, '   ')).toBe(h);
  });
  it('lists the SSH cells of a tab with their host', () => {
    const tab = { id: 't', name: 'g', layout: { cols: 2, rows: 1, areas: [] }, cells: [{ id: 'a', profileId: 'shell', ssh: { hostId: ID(1) } }, { id: 'b', profileId: 'shell' }, { id: 'c', profileId: 'shell', name: 'mine', ssh: { hostId: ID(9) } }] };
    expect(sshCellsOfTab(tab as never, [host(1, { port: 2200 })])).toEqual([
      { cellId: 'a', label: 'h1', endpoint: 'deploy@h1.example:2200' },
      { cellId: 'c', label: 'mine', endpoint: '' },
    ]);
  });
});

describe('broadcast fix round', () => {
  it('refuses every C0 control except TAB, LF and CR', () => {
    for (const c of ['\u0003', '\u0004', '\u001b', '\u0000', '\u007f']) expect(broadcastProblem(`ls${c}`)).toBe('Polecenie zawiera znaki sterujące');
    expect(broadcastProblem('a\tb\nc\r\nd')).toBeNull();
  });
  it('writes only to connected cells and adds Enter only when asked', () => {
    const sessions = { a: session('a', 'connected'), b: session('b', 'closed'), c: session('c', 'connected') };
    const calls: Array<[string, string, boolean]> = [];
    const paste = (id: string, text: string, submit: boolean) => { calls.push([id, text, submit]); };
    expect(broadcastSend(['a', 'b', 'c'], sessions, 'uptime', false, paste)).toEqual({ a: 'sent', b: 'skipped', c: 'sent' });
    expect(calls).toEqual([['a', 'uptime', false], ['c', 'uptime', false]]);
    calls.length = 0;
    broadcastSend(['a'], sessions, 'uptime', true, paste);
    expect(calls).toEqual([['a', 'uptime', true]]);
  });
  it('shows the live reason instead of a stale "sent"', () => {
    expect(broadcastRowState({ enabled: true }, 'sent')).toBe('wysłano');
    expect(broadcastRowState({ enabled: false, reason: 'rozłączono' }, 'sent')).toBe('rozłączono');
    expect(broadcastRowState({ enabled: false, reason: 'rozłączono' }, 'skipped')).toBe('pominięto: rozłączono');
    expect(broadcastRowState({ enabled: true }, undefined)).toBeNull();
  });
});

describe('settings helpers', () => {
  it('names the secret storage', () => {
    expect(storageLabel('dpapi')).toBe('Szyfrowanie: Windows (DPAPI)');
    expect(storageLabel('keychain')).toBe('Szyfrowanie: pęk kluczy macOS');
    expect(storageLabel('unavailable')).toBe('Szyfrowanie: niedostępne');
  });

  it('locks Remove of known hosts while the status loads, never for good after a failed status call (0.9.2)', () => {
    const status = (knownHostsReadOnly: boolean) => ({ vaultFile: 'v.json', vaultReadOnly: false, knownHostsFile: 'k.json', knownHostsReadOnly });
    expect(knownHostsLocked(null, false)).toBe(true);
    expect(knownHostsLocked(null, true)).toBe(false);
    expect(knownHostsLocked(status(true), false)).toBe(true);
    expect(knownHostsLocked(status(false), false)).toBe(false);
    // Failed status: no path, so no read-only note either.
    expect(readOnlyStoreNote('knownHosts', knownHostsLocked(null, true), undefined)).toBeNull();
  });

  it('explains a read-only store only when it is one, and names what the user can do', () => {
    expect(readOnlyStoreNote('vault', false, 'v.json')).toBeNull();
    expect(readOnlyStoreNote('knownHosts', false, 'k.json')).toBeNull();
    // No path yet (status still loading or failed): no note with an empty {file}.
    expect(readOnlyStoreNote('vault', true, undefined)).toBeNull();
    expect(readOnlyStoreNote('knownHosts', true, '')).toBeNull();
    const vault = readOnlyStoreNote('vault', true, 'v.json') ?? '';
    expect(vault).toContain('{file}');
    expect(vault).toMatch(/nieczytelny.*nieprawidłowy format.*uszkodzony wpis.*nowszej wersji/);
    expect(vault).toMatch(/Nie można dodawać ani zmieniać kluczy i haseł/);
    expect(vault).toMatch(/nietknięty/);
    expect(vault).toMatch(/uruchom aplikację ponownie/);
    const hosts = readOnlyStoreNote('knownHosts', true, 'k.json') ?? '';
    expect(hosts).toContain('{file}');
    // Both ways of accepting a key (a new host and a changed key) apply to that one connection only.
    expect(hosts).toMatch(/Zaufaj i zapisz.*Zastąp zapisany klucz.*tylko dla tego jednego połączenia/);
    expect(hosts).toMatch(/uruchom aplikację ponownie/);
  });

  it('describes the known hosts file with its path only once the path is known', () => {
    expect(knownHostsDescription('k.json')).toContain('{file}');
    expect(knownHostsDescription(undefined)).not.toContain('{file}');
    expect(knownHostsDescription('')).not.toContain('{file}');
    expect(knownHostsDescription(undefined)).toMatch(/Zaufaj i zapisz/);
  });

  it('agrees with the read-only note: read-only accepts for this connection, an unexpected write failure refuses (M6)', () => {
    for (const text of [knownHostsDescription('k.json'), knownHostsDescription(undefined)]) {
      expect(text).toMatch(/tylko do odczytu, zaakceptowany klucz obowiązuje tylko dla tego jednego połączenia/);
      expect(text).toMatch(/nieoczekiwanie się nie uda.*odrzucane z ogólnym błędem/);
      expect(text).not.toMatch(/plik tylko do odczytu\)/);
    }
    expect(readOnlyStoreNote('knownHosts', true, 'k.json')).toMatch(/tylko dla tego jednego połączenia/);
  });
});

describe('SSH terminal mode reset (I2)', () => {
  it('switches off mouse, focus, paste and application cursor modes and leaves the alternate screen only when in it', () => {
    const inAlt = sshModeReset(true);
    expect(inAlt).toContain('\x1b[?1000;1002;1003;1005;1006;1015;1004;2004l');
    expect(inAlt).toContain('\x1b[?1l');
    expect(inAlt.endsWith('\x1b[?1049l')).toBe(true);
    expect(sshModeReset(false)).not.toContain('1049');
  });

  it('marks the end of a live session, not a phase change inside one', () => {
    expect(sshSessionEnded('connected', 'error')).toBe(true);
    expect(sshSessionEnded('authenticating', 'closed')).toBe(true);
    expect(sshSessionEnded('connecting', 'connected')).toBe(false);
    expect(sshSessionEnded('error', 'error')).toBe(false);
    expect(sshSessionEnded(undefined, 'idle')).toBe(false);
  });
});

describe('connectingBanner (M3)', () => {
  it('shows the sanitized banner while the session is being set up, never once connected or ended', () => {
    const banner = 'Authorized use only\x1b[31m!';
    for (const phase of ['connecting', 'verifying', 'authenticating'] as const) expect(connectingBanner({ phase, serverBanner: banner })).toBe(sanitizeServerText(banner));
    for (const phase of ['idle', 'connected', 'closed', 'error'] as const) expect(connectingBanner({ phase, serverBanner: banner })).toBeNull();
    expect(connectingBanner({ phase: 'connecting' })).toBeNull();
    expect(connectingBanner(undefined)).toBeNull();
  });
});

describe('cellSourcePatch and sshSpecName (M4)', () => {
  const hosts = [{ id: 'h1', label: 'web' }, { id: 'h2', label: 'db' }];
  it('choosing a host never copies its label into the name, a typed name stays', () => {
    expect(cellSourcePatch('ssh:h1', { profileId: 'claude', worktree: true, prompt: 'go', role: 'reviewer' } as never, hosts, 'shell'))
      .toEqual({ profileId: 'shell', sshHostId: 'h1', role: undefined, prompt: undefined, worktree: false });
    expect(cellSourcePatch('ssh:h1', { profileId: 'claude', worktree: false, name: 'backend' }, hosts, 'shell')).not.toHaveProperty('name');
  });

  it('a name that only echoed the previous host label goes away, also when switching to another host', () => {
    expect(cellSourcePatch('ssh:h2', { profileId: 'shell', worktree: false, sshHostId: 'h1', name: 'web' }, hosts, 'shell')).toMatchObject({ sshHostId: 'h2', name: undefined });
    expect(cellSourcePatch('claude', { profileId: 'shell', worktree: false, sshHostId: 'h1', name: 'web' }, hosts, 'shell')).toEqual({ profileId: 'claude', sshHostId: undefined, name: undefined });
    expect(cellSourcePatch('claude', { profileId: 'shell', worktree: false, sshHostId: 'h1', name: 'mine' }, hosts, 'shell')).toEqual({ profileId: 'claude', sshHostId: undefined });
  });

  it('openTab drops a name that only repeats the host label (older presets) and keeps a custom one', () => {
    expect(sshSpecName('web', { label: 'web' })).toBeUndefined();
    expect(sshSpecName('backend', { label: 'web' })).toBe('backend');
    expect(sshSpecName('web', undefined)).toBe('web');
    expect(sshSpecName(undefined, { label: 'web' })).toBeUndefined();
  });
});

describe('Pty Host restart toast (D1)', () => {
  it('promises resumed conversations only when a Claude or Codex cell was running', () => {
    expect(resumesConversation([{ ssh: true, cli: 'shell' }, { ssh: true, cli: 'shell' }])).toBe(false);
    expect(resumesConversation([{ ssh: false, cli: 'shell' }, undefined])).toBe(false);
    expect(resumesConversation([])).toBe(false);
    expect(resumesConversation([{ ssh: true, cli: 'shell' }, { ssh: false, cli: 'codex' }])).toBe(true);
    expect(resumesConversation([{ ssh: false, cli: 'claude' }])).toBe(true);
    expect(ptyHostRestartToast(true)).toBe('Proces terminali się zrestartował, wznawiam rozmowy');
    expect(ptyHostRestartToast(false)).toBe('Proces terminali się zrestartował');
  });
});

describe('broadcast results follow the session (D2)', () => {
  it('keeps a result while the session is unchanged and clears it once the phase changes', () => {
    const at = (phase: SshSessionState['phase'], since: number): SshSessionState => ({ cellId: 'a', hostId: 'h', phase, since });
    const stamped = stampBroadcastResults({ a: 'sent', b: 'skipped' }, { a: at('connected', 5) });
    expect(currentBroadcastResult(stamped.a, at('connected', 5))).toBe('sent');
    expect(currentBroadcastResult(stamped.a, at('closed', 9))).toBeUndefined();
    expect(currentBroadcastResult(stamped.a, at('connected', 12))).toBeUndefined(); // reconnected
    expect(currentBroadcastResult(stamped.b, undefined)).toBe('skipped');
    expect(currentBroadcastResult(stamped.b, { ...at('connecting', 3), cellId: 'b' })).toBeUndefined();
    expect(currentBroadcastResult(undefined, at('connected', 5))).toBeUndefined();
  });
});

describe('cell colour (1.0.4)', () => {
  it("draws an SSH cell in its host's colour unless the user gave the cell its own; other cells keep only their own", () => {
    const ref = { hostId: ID(1) };
    expect(cellDrawColor({ ssh: ref }, host(1, { color: '#ef4444' }))).toBe('#ef4444');
    expect(cellDrawColor({ ssh: ref, color: '#22c55e' }, host(1, { color: '#ef4444' }))).toBe('#22c55e');
    // The automatic accent of a new cell gives way to the host's colour, and shows again without one.
    expect(cellDrawColor({ ssh: ref, color: CELL_COLORS[0] }, host(1, { color: '#ef4444' }))).toBe('#ef4444');
    expect(cellDrawColor({ ssh: ref, color: CELL_COLORS[0] }, host(1))).toBe(CELL_COLORS[0]);
    expect(cellDrawColor({ color: CELL_COLORS[0] }, host(1, { color: '#ef4444' }))).toBe(CELL_COLORS[0]);
    expect(cellDrawColor({ ssh: ref }, host(1))).toBeUndefined();
    expect(cellDrawColor({ ssh: ref }, undefined)).toBeUndefined(); // a deleted host
    expect(cellDrawColor({}, host(1, { color: '#ef4444' }))).toBeUndefined();
    expect(cellDrawColor({ color: '#3b82f6' }, null)).toBe('#3b82f6');
  });
});
