// Real-app SSH checks: node scripts/verify-ssh-ui.mjs [part ...]   (npm run build first)
// With no argument every part runs. Screenshots: D:\Projekty\_shots\ssh-*.png
// SSH_CHECK_LANGUAGE=en runs a part with the English UI (the `cell` part uses the TEXT table; screenshots get an -en suffix).
// Only the local test server (scripts/ssh-test-server.mjs on 127.0.0.1) is used; scratch dirs are deleted afterwards.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import ssh2 from 'ssh2';
import { join } from 'node:path';
import { childPids, connected, connectWithPassword, killTree, LANGUAGE, launchApp, sleep, scratchRoot, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

if (!existsSync('out/main/index.js')) throw new Error('Build first: npm run build');
/** Expression: the xterm buffer text of every cell of the active tab, in cell order (what the terminal really shows, not a screenshot). */
const CELL_BUFFERS = `(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId);
  return t.cells.map((c) => { const b = window.__mc.terminals.entries.get(c.id)?.term.buffer.active; if (!b) return ''; let text = ''; for (let i = 0; i < b.length; i++) text += (b.getLine(i)?.translateToString(true) ?? '') + '\\n'; return text; }); })()`;
const hasLine = (index, line) => `${CELL_BUFFERS}[${index}].split('\\n').some((l) => l.trim() === ${JSON.stringify(line)})`;
/** UI texts the checks click on or wait for, per language of SSH_CHECK_LANGUAGE (only the `cell` part is language-aware). */
const TEXT = {
  pl: { connecting: 'łączenie z', connect: 'Połącz', trust: 'Zaufaj i zapisz', disconnect: 'Rozłącz', reconnect: 'Połącz ponownie', crashed: 'Proces terminali został uruchomiony ponownie', crashedShort: 'Proces terminali', restartToast: 'Proces terminali się zrestartował', resumeToast: 'wznawiam rozmowy' },
  en: { connecting: 'connecting to', connect: 'Connect', trust: 'Trust and save', disconnect: 'Disconnect', reconnect: 'Reconnect', crashed: 'The terminal process was restarted', crashedShort: 'The terminal process', restartToast: 'The terminal process restarted', resumeToast: 'resuming conversations' },
}[LANGUAGE];
if (!TEXT) throw new Error(`SSH_CHECK_LANGUAGE=${LANGUAGE} has no TEXT entry`);
const PARTS = {
  /** Task 8: a prepared SSH cell shows "Połącz", the host key card, the password prompt, then the session. */
  async cell() {
    const server = await startTestServer();
    const root = scratchRoot('cell');
    try {
      const host = testHost(server.port);
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] }));
      const app = await launchApp(root);
      try {
        // D5: a restored SSH cell never connects by itself.
        await app.until(`document.querySelector('.ssh-card button')?.textContent === ${JSON.stringify(TEXT.connect)}`, 'connect card');
        await app.screenshot('ssh-cell-idle.png');
        await app.click('.ssh-card button', TEXT.connect);
        await app.until(`!!document.querySelector('.ssh-fingerprint')`, 'host key card');
        const shown = await app.evaluate(`document.querySelector('.ssh-fingerprint').textContent`);
        if (!shown.includes(server.fingerprint)) throw new Error(`fingerprint mismatch: ${shown} vs ${server.fingerprint}`);
        await app.screenshot('ssh-hostkey-new.png');
        await app.click('.ssh-card button', TEXT.trust);
        await connectWithPassword(app, server.password, { save: true });
        await connected(app, 1);
        // W4: the connecting notice comes before the server greeting in the terminal buffer.
        await app.until(`(() => { const t = ${CELL_BUFFERS}[0]; const a = t.indexOf(${JSON.stringify(TEXT.connecting)}); const b = t.indexOf('unimux test server'); return a >= 0 && b > a; })()`, 'connecting notice before the greeting');
        const chip = await app.evaluate(`document.querySelector('.cell-head .ssh-host')?.textContent`);
        if (chip !== host.label) throw new Error(`header chip shows "${chip}", expected the host label`);
        await app.screenshot('ssh-cell-connected.png');
        // I2: a remote program switches on the alternate screen and mouse tracking (the echo shell echoes the escape sequences).
        const term = `(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId); return window.__mc.terminals.entries.get(t.cells[0].id).term; })()`;
        await app.evaluate(`(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId); window.__mc.terminals.post({ t: 'write', id: t.cells[0].id, data: 'echo \x1b[?1049h\x1b[?1000h\x1b[?1h' }); return true; })()`);
        await app.until(`${term}.buffer.active.type === 'alternate' && ${term}.modes.mouseTrackingMode !== 'none'`, 'remote TUI modes on');
        // R11: after "Rozłącz" a bar sits at the bottom of the cell and the last output stays readable.
        await app.click('.cell-head .ssh-host');
        await app.click('.menu .menu-item', TEXT.disconnect);
        await app.until(`document.querySelector('.ssh-bar button')?.textContent === ${JSON.stringify(TEXT.reconnect)} && !document.querySelector('.ssh-card')`, 'disconnected bar');
        // I2: the end of the session left the alternate screen and switched mouse tracking and app cursor keys off.
        await app.until(`${term}.buffer.active.type === 'normal' && ${term}.modes.mouseTrackingMode === 'none' && !${term}.modes.applicationCursorKeysMode`, 'modes reset after the session ended');
        await app.screenshot('ssh-cell-closed.png');
        // R13: "Połącz ponownie" keeps the screen; the host key is known and the password saved, so no prompt comes up.
        await app.click('.ssh-bar button', TEXT.reconnect);
        await connected(app, 1);
        await app.screenshot('ssh-cell-reconnected.png');
        // D5 after a Pty Host crash: the cell ends in the error bar and never connects by itself; "Połącz ponownie" works.
        const hosts = childPids(app.pid, 'node.mojom.NodeService');
        if (hosts.length !== 1) throw new Error(`expected one Pty Host process, found ${hosts.length}`);
        killTree(hosts[0]);
        await app.until(`document.querySelector('.ssh-bar.error')?.textContent.includes(${JSON.stringify(TEXT.crashed)})`, 'crash bar');
        // D1: only an SSH cell was live, so the toast does not promise resumed conversations.
        await app.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent === ${JSON.stringify(TEXT.restartToast)})`, 'restart toast without resuming');
        if (await app.evaluate(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(${JSON.stringify(TEXT.resumeToast)}))`)) throw new Error('the crash toast promises resumed conversations');
        await sleep(3000);
        const after = await app.evaluate(`[!!document.querySelector('.ssh-bar.error'), !!document.querySelector('.ssh-card'), document.querySelector('.status-text.ssh')?.textContent ?? '']`);
        if (!after[0] || after[1] || !after[2].includes(TEXT.crashedShort)) throw new Error(`unexpected state after the crash: ${JSON.stringify(after)}`);
        await app.screenshot('ssh-cell-after-crash.png');
        await app.click('.ssh-bar button', TEXT.reconnect);
        await connected(app, 1);
      } finally { await app.close(); }
      for (const file of ['state.json', 'ssh/vault.json', 'ssh/known_hosts.json']) {
        const path = join(root, 'data', file);
        if (existsSync(path) && readFileSync(path, 'utf8').includes(server.password)) throw new Error(`${file} contains the test password`);
      }
      if (!existsSync(join(root, 'data', 'ssh', 'known_hosts.json'))) throw new Error('host key was not saved');
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 9, W3: new host from the palette in the SSH view's details pane, save and connect; generate a key and copy its public key; import by drop and by paste. */
  async editors() {
    const server = await startTestServer();
    const root = scratchRoot('editors');
    try {
      writeState(root, sshState({ projectPath: join(root, 'project') }));
      // Two throwaway keys for the import paths (never the user's ~/.ssh): one dropped as a file, one pasted.
      const dropped = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'dropped@check' });
      const pasted = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: 'pasted@check' });
      const keyFile = join(root, 'id_dropped');
      writeFileSync(keyFile, dropped.private);
      const app = await launchApp(root);
      try {
        const palette = async (title) => {
          await app.click('button[aria-label="Szukaj wszędzie"]'); // the title bar button that opens the palette
          await app.until(`!!document.querySelector('.palette input')`, 'palette');
          await app.setValue('.palette input', title);
          await app.until(`document.querySelector('.palette-item.sel .ptitle')?.textContent === ${JSON.stringify(title)}`, `palette entry ${title}`);
          await app.press('Enter');
        };
        const D = '.ssh-view-detail';
        const fieldValues = () => app.evaluate(`[...document.querySelectorAll('${D} [data-field]')].map((e) => e.value).join('|')`);
        const hidden = `getComputedStyle(document.querySelector('.ssh-workspace')).display === 'none'`;
        const showGrid = () => app.evaluate(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
        await palette('SSH: nowy host');
        await app.until(`!!document.querySelector('${D} [data-field=address]') && !!document.querySelector('.workspace-tabs .ssh-tab.active')`, 'host form in the SSH view');
        await app.setValue(`${D} [data-field=label]`, 'local test');
        await app.setValue(`${D} [data-field=address]`, '127.0.0.1');
        // A half-filled host form survives Settings in front (the view stays mounted).
        await app.click('button[aria-label="Ustawienia"]');
        await app.until(hidden, 'settings in front');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`!!document.querySelector('${D} [data-field=address]') && !(${hidden})`, 'host form after settings');
        if (await fieldValues() !== 'local test|127.0.0.1|22|') throw new Error(`host form lost its input: ${await fieldValues()}`);
        await app.setValue(`${D} [data-field=port]`, String(server.port));
        await app.setValue(`${D} [data-field=username]`, 'alice');
        await app.screenshot('ssh-host-editor.png');
        await app.click(`${D} .ssh-editor button`, 'Zapisz i połącz');
        await app.until(`!!document.querySelector('.cell .ssh-fingerprint')`, 'host key prompt in the new cell');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password);
        await connected(app, 1);
        // Back in the view: the pane edits the saved host and its tile shows it connected.
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`document.querySelector('${D} h2')?.textContent === 'local test' && !!document.querySelector('.ssh-tile .ssh-state.connected')`, 'saved host with a connected tile');
        await app.screenshot('ssh-view-host.png');
        // D4: a typed passphrase does not survive the view going to the background; the label does.
        await app.click('.ssh-view-head button', 'Nowy klucz');
        await app.click('.menu [role=menuitem]', 'Wygeneruj klucz');
        await app.until(`!!document.querySelector('${D} .ssh-segmented')`, 'new key form');
        await app.setValue(`${D} [data-field=newKeyLabel]`, 'check key');
        await app.setValue(`${D} input[type=password]`, 'typed-secret');
        await showGrid();
        await app.until(hidden, 'grid in front');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`document.querySelector('${D} [data-field=newKeyLabel]')?.value === 'check key'`, 'label kept');
        if (await app.evaluate(`[...document.querySelectorAll('${D} input[type=password]')].some((e) => e.value)`)) throw new Error('a hidden pane still held a typed secret');
        await app.screenshot('ssh-newkey-editor.png');
        await app.click(`${D} .ssh-editor button.primary`, 'Wygeneruj klucz');
        await app.until(`!!document.querySelector('${D} .ssh-public')`, 'key with its public key', 60000);
        const pub = await app.evaluate(`document.querySelector('${D} .ssh-public').textContent`);
        if (!/^ssh-ed25519 \S+ unimux@/.test(pub)) throw new Error(`unexpected public key: ${pub}`);
        await app.click(`${D} .ssh-editor button`, 'Kopiuj klucz publiczny');
        await app.screenshot('ssh-key-editor.png');
        // Drag and drop of a private key file onto the drop zone; the draft survives a grid in front.
        await palette('SSH: nowy klucz');
        await app.click(`${D} .ssh-segmented button`, 'Importuj z pliku');
        await app.until(`!!document.querySelector('${D} .ssh-drop')`, 'drop zone');
        const box = await app.evaluate(`(() => { const r = document.querySelector('${D} .ssh-drop').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const data = { items: [], files: [keyFile], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await app.cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
        await app.until(`document.querySelector('${D} .ssh-facts dd')?.textContent === 'ssh-ed25519'`, 'dropped key draft');
        await showGrid();
        await app.until(hidden, 'grid in front again');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`document.querySelector('${D} .ssh-public')?.textContent.includes('dropped@check')`, 'draft kept after the grid');
        await app.click(`${D} .ssh-editor button.primary`, 'Zapisz');
        await app.until(`document.querySelector('${D} .ssh-public')?.textContent.includes('dropped@check') && !document.querySelector('${D} .ssh-segmented')`, 'dropped key stored');
        // Pasted private key text.
        await palette('SSH: nowy klucz');
        await app.click(`${D} .ssh-segmented button`, 'Wklej klucz');
        await app.until(`!!document.querySelector('${D} .ssh-editor textarea')`, 'paste form');
        await app.setValue(`${D} .ssh-editor textarea`, pasted.private);
        await app.click(`${D} .ssh-editor button.primary`, 'Dalej');
        await app.until(`document.querySelector('${D} .ssh-facts dd')?.textContent === 'ecdsa-sha2-nistp256'`, 'pasted key draft');
        await app.click(`${D} .ssh-editor button.primary`, 'Zapisz');
        await app.until(`document.querySelector('${D} .ssh-public')?.textContent.includes('pasted@check') && !document.querySelector('${D} .ssh-segmented')`, 'pasted key stored');
        const keys = await app.evaluate(`window.mc.ssh.vaultInfo().then((v) => v.keys.map((k) => k.label))`);
        if (keys.length !== 3) throw new Error(`expected 3 keys in the vault, found ${JSON.stringify(keys)}`);
      } finally { await app.close(); }
      const vault = readFileSync(join(root, 'data', 'ssh', 'vault.json'), 'utf8');
      if (vault.includes('PRIVATE KEY') || vault.includes(server.password)) throw new Error('vault.json contains plain secrets');
      const state = readFileSync(join(root, 'data', 'state.json'), 'utf8');
      if (!state.includes('"local test"') || state.includes('PRIVATE KEY') || state.includes(server.password)) throw new Error('state.json: host missing or a secret leaked');
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 9 fix: with no project at all, the palette still opens the SSH view and a host can be saved. */
  async editorsNoProject() {
    const root = scratchRoot('editors-noproject');
    try {
      writeState(root, { version: 1, settings: { language: 'pl' }, sshHosts: [], projects: [], activeProjectId: null });
      const app = await launchApp(root);
      try {
        const A = '.ssh-view-detail';
        for (const title of ['SSH: nowy klucz', 'SSH: nowy host']) {
          await app.click('button[aria-label="Szukaj wszędzie"]');
          await app.until(`!!document.querySelector('.palette input')`, 'palette');
          await app.setValue('.palette input', title);
          await app.until(`document.querySelector('.palette-item.sel .ptitle')?.textContent === ${JSON.stringify(title)}`, `palette entry ${title}`);
          await app.press('Enter');
        }
        await app.until(`!!document.querySelector('${A} [data-field=address]')`, 'host editor without a project');
        await app.setValue(`${A} [data-field=address]`, 'example.invalid');
        await app.setValue(`${A} [data-field=username]`, 'bob');
        await app.click(`${A} .ssh-editor button.primary`, 'Zapisz');
        await app.until(`document.querySelector('${A} h2')?.textContent === 'example.invalid'`, 'host saved without a project');
        await app.screenshot('ssh-editor-no-project.png');
        await sleep(2500); // state.json is written debounced
      } finally { await app.close(); }
      if (!readFileSync(join(root, 'data', 'state.json'), 'utf8').includes('"example.invalid"')) throw new Error('host not stored');
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 10, W3: the SSH tile opens the SSH view, hosts are tiles by group and searchable, folding, details and multi-select work, a group opens as a 3-cell grid.
   *  0.9.2 polish: no "Bez grupy" tile and no local shells, the details pane only while a host is chosen, search narrows the selection. */
  async panel() {
    const server = await startTestServer();
    const root = scratchRoot('ssh-panel');
    try {
      const hosts = [testHost(server.port, { label: 'web-1', group: 'lab' }), testHost(server.port, { label: 'web-2', group: 'lab' }), testHost(server.port, { label: 'web-3', group: 'lab' }), testHost(server.port, { label: 'pi' })];
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts }));
      const app = await launchApp(root);
      try {
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-view') && !!document.querySelector('.workspace-tabs .ssh-tab.active')`, 'SSH view in the main area');
        if (await app.evaluate(`!!document.querySelector('.side-panel .ssh-tile')`)) throw new Error('hosts are still listed in the left panel');
        // The SSH tile is a pressed toggle, not a second selected tab; in SSH mode no panel tile is selected (the side panel shows
        // the SSH navigation). Behind Settings the SSH tile is not pressed and the open panel's tile is selected again.
        const railState = `(() => { const t = document.querySelector('.rail-tiles [aria-label="SSH"]'); return [t.getAttribute('aria-pressed'), t.hasAttribute('aria-selected'), document.querySelectorAll('.rail-tiles [aria-selected=true]').length].join('|'); })()`;
        if (await app.evaluate(railState) !== 'true|false|0') throw new Error(`rail state with the view in front: ${await app.evaluate(railState)}`);
        await app.click('button[aria-label="Ustawienia"]');
        await app.until(`${railState} === 'false|false|1'`, 'SSH tile not pressed behind Settings');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`${railState} === 'true|false|0'`, 'SSH tile pressed again');
        const heads = await app.evaluate(`[...document.querySelectorAll('.ssh-group-head .grow')].map((e) => e.textContent)`);
        if (JSON.stringify(heads) !== JSON.stringify(['lab', 'Bez grupy'])) throw new Error(`groups: ${heads}`);
        if (await app.evaluate(`!!document.querySelector('.ssh-local, .terminal-source') || document.querySelector('.ssh-view').textContent.includes('Lokalne powłoki')`)) throw new Error('local shells are still listed in Hosty');
        // Nothing chosen: no details pane, the tiles use the whole width.
        if (await app.evaluate(`!!document.querySelector('.ssh-view-detail') || document.querySelector('.ssh-view-main').getBoundingClientRect().width !== document.querySelector('.ssh-view').getBoundingClientRect().width`)) throw new Error('a details pane is shown with nothing chosen');
        // Group tiles: the counts (no "Bez grupy" tile), and a click filters to that group (a second click shows every host again).
        const groupTiles = await app.evaluate(`[...document.querySelectorAll('.ssh-group-tile')].map((e) => e.textContent).join('|')`);
        if (groupTiles !== 'Wszystkie4|lab3') throw new Error(`group tiles: ${groupTiles}`);
        await app.click('.ssh-group-tile[data-group="lab"]');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 3 && document.querySelector('.ssh-group-tile[data-group="lab"]').getAttribute('aria-pressed') === 'true'`, 'filtered to the lab group');
        await app.click('.ssh-group-tile[data-group="lab"]');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 4`, 'group filter off');
        await app.screenshot('ssh-view.png');
        // Search narrows the tiles.
        await app.setValue('.ssh-view-head .ssh-search', 'pi');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 1`, 'search narrows the tiles');
        await app.setValue('.ssh-view-head .ssh-search', '');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 4`, 'all hosts back');
        // Folding a group hides its tiles and is remembered.
        await app.click('.ssh-group-head', 'lab');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 1 && !!document.querySelector('.ssh-group-head .chev-right')`, 'folded group');
        if (await app.evaluate(`localStorage.getItem('mc-ssh-groups-v1')`) !== '["lab"]') throw new Error('fold state not stored');
        await app.click('.ssh-group-head', 'lab');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 4`, 'expanded group');
        // A click shows the host in the details pane with its two actions.
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1' && [...document.querySelectorAll('.ssh-detail-actions button')].map((b) => b.textContent).join('|') === 'Połącz|Otwórz w nowym gridzie'`, 'host details');
        await app.screenshot('ssh-view-details.png');
        // Ctrl+click selects; the bar counts the selection and clears it.
        await app.evaluate(`(() => { for (const tile of [...document.querySelectorAll('.ssh-tile[data-host-id]')].filter((t) => /web-1|pi/.test(t.textContent))) tile.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); return true; })()`);
        await app.until(`document.querySelectorAll('.ssh-tile.selected').length === 2 && document.querySelector('.ssh-open-grid')?.textContent === 'Otwórz jako siatkę (2)'`, 'two hosts selected');
        await app.screenshot('ssh-view-selected.png');
        if (await app.evaluate(`[...document.querySelectorAll('.ssh-tile[aria-pressed=true]')].length + '|' + document.querySelector('.ssh-tile[aria-current=true]')?.textContent.includes('web-1')`) !== '2|true') throw new Error('aria-pressed / aria-current of the tiles');
        // Typing in the search keeps only the selected hosts that stay visible: the grid button counts what is shown.
        await app.setValue('.ssh-view-head .ssh-search', 'pi');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 1 && document.querySelector('.ssh-open-grid')?.textContent === 'Otwórz jako siatkę (1)'`, 'search narrowed the selection');
        await app.setValue('.ssh-view-head .ssh-search', '');
        await app.until(`document.querySelectorAll('.ssh-tile[data-host-id]').length === 4 && document.querySelectorAll('.ssh-tile.selected').length === 1`, 'the hidden host stays unselected');
        await app.click('.ssh-view-selection button', 'Wyczyść zaznaczenie');
        await app.until(`!document.querySelector('.ssh-open-grid') && !document.querySelector('.ssh-tile.selected')`, 'selection cleared');
        // Esc clears a selection too (focus on a tile).
        await app.evaluate(`(() => { const t = [...document.querySelectorAll('.ssh-tile[data-host-id]')].find((e) => e.textContent.includes('pi')); t.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); t.focus(); return true; })()`);
        await app.until(`document.querySelectorAll('.ssh-tile.selected').length === 1`, 'one host selected');
        await app.press('Escape');
        await app.until(`!document.querySelector('.ssh-tile.selected') && document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1'`, 'Esc cleared the selection, details kept');
        // The pane closes: Esc with the focus in it, a second click on the shown tile, the X. Each time the tiles get the whole width back.
        const paneGone = `!document.querySelector('.ssh-view-detail') && document.querySelector('.ssh-view-main').getBoundingClientRect().width === document.querySelector('.ssh-view').getBoundingClientRect().width`;
        await app.evaluate(`document.querySelector('.ssh-view-detail [data-field=label]').focus()`);
        await app.press('Escape');
        await app.until(`${paneGone} && document.activeElement?.dataset.hostId === document.querySelector('.ssh-tile[data-host-id]')?.dataset.hostId`, 'Esc in the pane closed it, focus back on the tile');
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1'`, 'pane open again');
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(paneGone, 'a second click on the shown tile closed the pane');
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`!!document.querySelector('.ssh-view-detail .ssh-detail-close')`, 'pane with its X');
        await app.click('.ssh-view-detail .ssh-detail-close');
        await app.until(paneGone, 'the X closed the pane');
        // "Nowy klucz > mode" always switches an open new-key pane to that mode, also after the mode was changed inside it.
        // Nowy klucz from Hosty switches to Klucze (the key forms belong there); Klucze has its own Nowy klucz button.
        const pickKey = async (mode) => { await app.click('.ssh-view-main .ssh-view-actions button', 'Nowy klucz'); await app.click('.menu [role=menuitem]', mode); };
        await pickKey('Wklej klucz');
        await app.until(`!!document.querySelector('.ssh-view-detail .ssh-editor textarea')`, 'paste mode');
        await app.click('.ssh-view-detail .ssh-segmented button', 'Wygeneruj klucz');
        await app.until(`!document.querySelector('.ssh-view-detail .ssh-editor textarea')`, 'generate chosen in the pane');
        await pickKey('Wklej klucz');
        await app.until(`!!document.querySelector('.ssh-view-detail .ssh-editor textarea')`, 'paste mode again from the header');
        await pickKey('Importuj z pliku');
        await app.until(`!!document.querySelector('.ssh-view-detail .ssh-drop')`, 'file mode from the header');
        if (await app.evaluate(`document.querySelector('.ssh-nav-item.on')?.dataset.section`) !== 'keys') throw new Error('a new key did not switch to Klucze');
        await app.click('.ssh-nav-item[data-section="hosts"]');
        await app.until(`!!document.querySelector('.ssh-view-group') && !document.querySelector('.ssh-view-detail .ssh-drop')`, 'back in Hosty, the new-key draft dropped');
        // A group opens as an SSH-only grid named after it; the SSH tab stays open.
        await app.evaluate(`(() => { const group = [...document.querySelectorAll('.ssh-view-group')].find((g) => g.querySelector('.ssh-group-head')?.textContent.includes('lab')); group.querySelector('.ssh-group-open').click(); return true; })()`);
        await app.until(`document.querySelectorAll('.cell .ssh-fingerprint').length === 3`, 'host key prompt in all three cells');
        await app.until(`document.querySelector('.workspace-tabs .grid-tab.active .label')?.textContent === 'lab' && !!document.querySelector('.workspace-tabs .ssh-tab')`, 'tab named after the group, SSH tab kept');
        await app.screenshot('ssh-group-grid.png');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** 0.9.2 SSH mode: the side panel shows Hosty, Klucze, Znane hosty and a disabled SFTP while the SSH view is in front; Projects brings the normal panel back. */
  async sshMode() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-mode');
    const shot = (name) => app.screenshot(`092-ssh-mode-${name}.png`);
    let app;
    try {
      const hosts = [testHost(server.port, { label: 'web-1', group: 'lab' }), testHost(server.port, { label: 'web-2', group: 'lab' }), testHost(server.port, { label: 'db', group: 'prod' }), testHost(server.port, { label: 'pi' })];
      // The side panel starts folded; one grid tab (an idle SSH cell) and one file in the project.
      const state = sshState({ projectPath: join(root, 'project'), hosts, cells: [hosts[3].id] });
      state.sidebarCollapsed = true;
      writeState(root, state);
      writeFileSync(join(root, 'project', 'notes.txt'), 'notes\n');
      writeKnownHost(root, server);
      app = await launchApp(root);
      try {
        // A roomy window first (the narrow one comes at the end).
        await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        const navState = `[...document.querySelectorAll('.side-panel .ssh-nav-item')].map((b) => b.dataset.section + (b.disabled ? ':off' : '') + (b.classList.contains('on') ? ':on' : '')).join('|')`;
        const folded = `window.__mc.useStore.getState().s.sidebarCollapsed === true`;
        const sshHidden = `getComputedStyle(document.querySelector('.ssh-workspace')).display === 'none'`;
        const showGrid = () => app.evaluate(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
        // Entering SSH mode from the tile keeps a folded side panel folded: the view shows its sections as a row instead.
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-view .ssh-tile[data-host-id]') && !document.querySelector('.side-panel') && !!document.querySelector('.ssh-view-main .ssh-nav.compact') && ${folded}`, 'SSH mode with the side panel still folded');
        await showGrid();
        await app.until(`${sshHidden} && ${folded}`, 'left SSH mode, the fold unchanged');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`!!document.querySelector('.ssh-nav.compact') && ${folded}`, 'SSH mode from its tab, still folded');
        // In SSH mode the SSH tile unfolds the side panel (and folds it again later).
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-view .ssh-tile[data-host-id]') && !!document.querySelector('.side-panel .ssh-nav')`, 'SSH mode with its navigation in the side panel');
        if (await app.evaluate(navState) !== 'hosts:on|keys|knownHosts|sftp:off') throw new Error(`side panel entries: ${await app.evaluate(navState)}`);
        if (!(await app.evaluate(`document.querySelector('.ssh-nav-item[data-section="sftp"]').textContent.includes('wkrótce')`))) throw new Error('SFTP lacks the coming-soon note');
        if (await app.evaluate(`!!document.querySelector('.side-panel .project-list, #sidebar-projects')`)) throw new Error('the projects panel is still shown in SSH mode');
        // The disabled SFTP entry cannot be chosen.
        await app.click('.ssh-nav-item[data-section="sftp"]');
        await app.until(`${navState} === 'hosts:on|keys|knownHosts|sftp:off'`, 'SFTP not selectable');
        await app.until(`document.querySelectorAll('.ssh-group-tile').length === 3 && !document.querySelector('.ssh-view-detail')`, 'group tiles, no details pane');
        await shot('hosts');
        // Klucze: the empty state, then a generated key as a tile with its editor.
        await app.click('.ssh-nav-item[data-section="keys"]');
        await app.until(`!!document.querySelector('.ssh-view-main .ssh-empty') && !document.querySelector('.ssh-view-head')`, 'empty Klucze');
        await shot('keys-empty');
        const generated = await app.evaluate(`window.mc.ssh.generateKey({ label: 'deploy', type: 'ed25519', savePassphrase: false })`);
        if (!generated.ok) throw new Error(`key generation failed: ${JSON.stringify(generated)}`);
        await app.until(`document.querySelectorAll('.ssh-key-tile').length === 1`, 'key tile');
        await app.click('.ssh-key-tile', 'deploy');
        await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'deploy' && !!document.querySelector('.ssh-view-detail .ssh-public')`, 'key editor');
        if (!(await app.evaluate(`document.querySelector('.ssh-key-tile').textContent.includes('SHA256:')`))) throw new Error('the key tile shows no fingerprint');
        await shot('keys');
        // A host link in the key editor would switch back to Hosty; Znane hosty lists the trusted test server.
        await app.click('.ssh-nav-item[data-section="knownHosts"]');
        await app.until(`document.querySelectorAll('.ssh-known-row').length === 1 && !document.querySelector('.ssh-view-detail')`, 'known hosts list without a details pane');
        const row = await app.evaluate(`document.querySelector('.ssh-known-row').textContent`);
        if (!row.includes(server.fingerprint) || !row.includes(String(server.port))) throw new Error(`known host row: ${row}`);
        await shot('known-hosts');
        // Keyboard: arrows move through the enabled entries only.
        await app.evaluate(`document.querySelector('.ssh-nav-item.on').focus()`);
        await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await app.until(`document.querySelector('.ssh-nav-item.on')?.dataset.section === 'hosts' && document.activeElement?.dataset.section === 'hosts'`, 'ArrowDown wraps past the disabled SFTP entry');
        // Folded side panel: the SSH tile folds it, the view offers the sections itself.
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!document.querySelector('.side-panel') && !!document.querySelector('.ssh-view-main .ssh-nav.compact')`, 'compact sections in the folded state');
        await app.click('.ssh-view-main .ssh-nav.compact .ssh-nav-item', 'Klucze');
        await app.until(`document.querySelectorAll('.ssh-key-tile').length === 1`, 'Klucze from the compact row');
        await shot('collapsed');
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.side-panel .ssh-nav') && !document.querySelector('.ssh-nav.compact')`, 'side panel back');
        await app.click('.ssh-nav-item[data-section="hosts"]');
        // A narrow window (1100x700) with the side panel open.
        await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1'`, 'host details in the narrow window');
        const overflow = await app.evaluate(`(() => { const m = document.querySelector('.ssh-view-main'); return m.scrollWidth > m.clientWidth + 1; })()`);
        if (overflow) throw new Error('the host column overflows in a narrow window');
        await shot('narrow');
        // Leaving SSH mode: the Projects tile brings the normal side panel and the grid back; the SSH tab stays.
        await app.click('.rail-tiles [aria-label="Projekty"]');
        await app.until(`!document.querySelector('.ssh-nav') && !!document.querySelector('#sidebar-projects') && getComputedStyle(document.querySelector('.ssh-workspace')).display === 'none' && !!document.querySelector('.workspace-tabs .ssh-tab')`, 'normal side panel back');
        const rail = await app.evaluate(`[document.querySelector('.rail-tiles [aria-label="SSH"]').getAttribute('aria-pressed'), document.querySelector('.rail-tiles [aria-label="Projekty"]').getAttribute('aria-selected')].join('|')`);
        if (rail !== 'false|true') throw new Error(`rail after leaving SSH mode: ${rail}`);
        // The SSH tab brings SSH mode back on the section that was chosen; a grid tab ends it again.
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`document.querySelector('.side-panel .ssh-nav-item.on')?.dataset.section === 'hosts'`, 'SSH mode again from its tab');
        await shot('back');
        // "Pokaż w panelu plików" on a file tab ends SSH mode and reveals the file in the Files panel.
        await showGrid();
        await app.click('.rail-tiles [aria-label="Pliki"]');
        await app.until(`!!document.querySelector('.file-entry[data-path="notes.txt"]')`, 'file in the Files panel');
        await app.click('.file-entry[data-path="notes.txt"]');
        await app.until(`!!document.querySelector('.workspace-tabs .file-tab')`, 'file tab');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`!!document.querySelector('.side-panel .ssh-nav')`, 'SSH mode before the reveal');
        await app.evaluate(`document.querySelector('.workspace-tabs .file-tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 50 }))`);
        await app.click('.menu .menu-item', 'Pokaż w panelu plików');
        await app.until(`!document.querySelector('.side-panel .ssh-nav') && !!document.querySelector('#sidebar-files .file-entry[data-path="notes.txt"]') && ${sshHidden}`, 'file revealed, SSH mode ended');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** 0.9.2 polish: the details pane only while something is chosen, the calmer Hosty, "Pokaż klucz prywatny" and "Zastąp klucz prywatny". */
  async polish() {
    const root = scratchRoot('polish');
    const shot = (name) => app.screenshot(`092-polish-${name}.png`);
    let app;
    try {
      const hosts = [testHost(2222, { label: 'web-1', group: 'lab' }), testHost(2222, { label: 'web-2', group: 'lab' }), testHost(2222, { label: 'db', group: 'prod' }), testHost(2222, { label: 'pi' }), testHost(2222, { label: 'nas' })];
      // One grid tab with an idle SSH cell (it never connects by itself, D5), so the view can go to the background.
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts, cells: [hosts[4].id] }));
      // A throwaway key for the replacement (never a real key of anybody).
      const replacement = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'replacement@check' });
      const parsed = ssh2.utils.parseKey(replacement.public);
      const newFingerprint = `SHA256:${createHash('sha256').update((Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
      app = await launchApp(root);
      try {
        await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        const fullWidth = `!document.querySelector('.ssh-view-detail') && document.querySelector('.ssh-view-main').getBoundingClientRect().width === document.querySelector('.ssh-view').getBoundingClientRect().width`;
        const showGrid = () => app.evaluate(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`document.querySelectorAll('.ssh-view .ssh-tile[data-host-id]').length === 5 && ${fullWidth}`, 'Hosty at full width without a pane');
        const tiles = await app.evaluate(`[...document.querySelectorAll('.ssh-group-tile')].map((e) => e.textContent).join('|')`);
        if (tiles !== 'Wszystkie5|lab2|prod1') throw new Error(`group tiles: ${tiles}`);
        const heads = await app.evaluate(`[...document.querySelectorAll('.ssh-group-head .grow')].map((e) => e.textContent).join('|')`);
        if (heads !== 'lab|prod|Bez grupy') throw new Error(`group headings: ${heads}`);
        if (await app.evaluate(`document.querySelector('.ssh-broadcast-open').textContent`) !== 'Wysyłanie masowe (1)') throw new Error('bulk send button label');
        await shot('hosts-empty');
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1' && document.querySelector('.ssh-view-main').getBoundingClientRect().width < document.querySelector('.ssh-view').getBoundingClientRect().width`, 'pane next to the tiles');
        await shot('host-selected');
        await app.click('.ssh-view-detail .ssh-detail-close');
        await app.until(fullWidth, 'pane closed by its X');
        // Unsaved edits are never dropped silently: Esc and a second click ask; "Anuluj" keeps the edit, "Odrzuć zmiany" closes.
        const discardAsked = `[...document.querySelectorAll('.modal-foot button')].some((b) => b.textContent === 'Odrzuć zmiany')`;
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`!!document.querySelector('.ssh-view-detail [data-field=label]')`, 'host form');
        await app.setValue('.ssh-view-detail [data-field=label]', 'web-1 edited');
        await app.press('Escape');
        await app.until(discardAsked, 'Esc asks before dropping the edit');
        await app.click('.modal-foot button', 'Anuluj');
        await app.until(`!document.querySelector('.modal-foot') && document.querySelector('.ssh-view-detail [data-field=label]')?.value === 'web-1 edited'`, 'edit kept after Anuluj');
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(discardAsked, 'a second click asks too');
        await app.click('.modal-foot button', 'Odrzuć zmiany');
        await app.until(fullWidth, 'pane closed after discarding');
        // 0.9.3: another tile or another section with unsaved edits asks too; "Anuluj" keeps the item and the edit.
        const labelIs = (v) => `document.querySelector('.ssh-view-detail [data-field=label]')?.value === ${JSON.stringify(v)}`;
        const noModal = `!document.querySelector('.modal-foot')`;
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(labelIs('web-1'), 'host form for the switch');
        await app.setValue('.ssh-view-detail [data-field=label]', 'web-1 edited');
        await app.click('.ssh-tile[data-host-id]', 'web-2');
        await app.until(discardAsked, 'another tile asks before dropping the edit');
        await app.click('.modal-foot button', 'Anuluj');
        await app.until(`${noModal} && ${labelIs('web-1 edited')} && document.querySelector('.ssh-tile.current')?.textContent.includes('web-1')`, 'Anuluj keeps the item and the edit');
        await app.click('.ssh-nav-item[data-section="keys"]');
        await app.until(discardAsked, 'another section asks too');
        await app.click('.modal-foot button', 'Anuluj');
        await app.until(`${noModal} && ${labelIs('web-1 edited')} && document.querySelector('.ssh-nav-item.on')?.dataset.section === 'hosts'`, 'Anuluj keeps the section');
        await app.click('.ssh-tile[data-host-id]', 'web-2');
        await app.until(discardAsked, 'asked again');
        await app.click('.modal-foot button', 'Odrzuć zmiany');
        await app.until(`${noModal} && ${labelIs('web-2')}`, 'the other tile after discarding');
        // A clean form switches without a question.
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`${noModal} && ${labelIs('web-1')}`, 'clean form switched silently');
        // The view going to the background (a grid tab) does not ask and keeps the edit, as in 0.9.2.
        const sshShown = `getComputedStyle(document.querySelector('.ssh-workspace')).display !== 'none'`;
        await app.setValue('.ssh-view-detail [data-field=label]', 'web-1 edited');
        await showGrid();
        await app.until(`${noModal} && !(${sshShown})`, 'grid in front without a question');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`${noModal} && ${sshShown} && ${labelIs('web-1 edited')}`, 'back in the view with the edit');
        // Closing the SSH tab drops the item: it asks; "Anuluj" keeps the tab, the item and the edit.
        await app.click('.workspace-tabs .ssh-tab .x');
        await app.until(discardAsked, 'closing the SSH tab asks');
        await app.click('.modal-foot button', 'Anuluj');
        await app.until(`${noModal} && ${sshShown} && ${labelIs('web-1 edited')} && !!document.querySelector('.workspace-tabs .ssh-tab.active')`, 'Anuluj keeps the SSH tab with the edit');
        await app.click('.workspace-tabs .ssh-tab .x');
        await app.until(discardAsked, 'closing asks again');
        await app.click('.modal-foot button', 'Odrzuć zmiany');
        await app.until(`${noModal} && !document.querySelector('.workspace-tabs .ssh-tab')`, 'SSH tab closed after discarding');
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`${sshShown} && ${fullWidth}`, 'back in the view, the discarded pane closed');
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(labelIs('web-1'), 'clean host form again');
        await app.click('.ssh-view-detail .ssh-detail-close');
        await app.until(fullWidth, 'pane closed after the switch checks');
        // A clean form closes without a question.
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`document.querySelector('.ssh-view-detail [data-field=label]')?.value === 'web-1'`, 'clean host form');
        await app.evaluate(`document.querySelector('.ssh-view-detail [data-field=label]').focus()`);
        await app.press('Escape');
        await app.until(`${fullWidth} && !document.querySelector('.modal-foot')`, 'clean form closed by Esc without asking');
        // "Nowy host" opens the pane too.
        await app.click('.ssh-view-actions button', 'Nowy host');
        await app.until(`!!document.querySelector('.ssh-view-detail [data-field=address]')`, 'new host form in the pane');
        await app.click('.ssh-view-detail .ssh-detail-close');
        await app.until(fullWidth, 'new host form closed');
        // Klucze: a generated key; the pane only after a click on its tile.
        const generated = await app.evaluate(`window.mc.ssh.generateKey({ label: 'deploy', type: 'ed25519', savePassphrase: false })`);
        if (!generated.ok) throw new Error(`key generation failed: ${JSON.stringify(generated)}`);
        await app.click('.ssh-nav-item[data-section="keys"]');
        await app.until(`document.querySelectorAll('.ssh-key-tile').length === 1 && ${fullWidth}`, 'Klucze at full width');
        const openKey = async () => { await app.click('.ssh-key-tile', 'deploy'); await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'deploy' && !!document.querySelector('.ssh-view-detail .ssh-reveal')`, 'key editor'); };
        const revealed = `document.querySelector('.ssh-view-detail .ssh-private-text')?.value ?? ''`;
        const reveal = async () => {
          await app.click('.ssh-view-detail .ssh-reveal');
          await app.until(`[...document.querySelectorAll('.modal-foot button')].some((b) => b.textContent === 'Pokaż')`, 'reveal confirmation');
          await app.click('.modal-foot button', 'Pokaż');
          await app.until(`${revealed}.includes('BEGIN OPENSSH PRIVATE KEY')`, 'private key shown');
        };
        await openKey();
        // Cancelling the confirmation shows nothing.
        await app.click('.ssh-view-detail .ssh-reveal');
        await app.until(`!!document.querySelector('.modal-foot')`, 'confirmation');
        await app.click('.modal-foot button', 'Anuluj');
        await sleep(300);
        if (await app.evaluate(`!!document.querySelector('.ssh-view-detail .ssh-private-text')`)) throw new Error('the key was shown without the confirmation');
        await reveal();
        const stored = await app.evaluate(`window.mc.ssh.revealPrivateKey(${JSON.stringify(generated.key.id)}).then((r) => r.privateKey)`);
        if (await app.evaluate(revealed) !== stored) throw new Error('the shown text is not the stored key');
        await shot('keys-revealed');
        await app.click('.ssh-view-detail .ssh-hide');
        await app.until(`!document.querySelector('.ssh-view-detail .ssh-private-text')`, 'Ukryj klucz hides it');
        // A section change drops it (the pane closes); the key reopened shows no text.
        await reveal();
        await app.click('.ssh-nav-item[data-section="hosts"]');
        await app.until(`!!document.querySelector('.ssh-view .ssh-tile[data-host-id]') && !document.querySelector('.ssh-private-text')`, 'section change cleared it');
        await app.click('.ssh-nav-item[data-section="keys"]');
        await openKey();
        if (await app.evaluate(`!!document.querySelector('.ssh-private-text')`)) throw new Error('the private key came back after a section change');
        // The view in the background drops it too.
        await reveal();
        await showGrid();
        await app.until(`getComputedStyle(document.querySelector('.ssh-workspace')).display === 'none'`, 'grid in front');
        await app.click('.workspace-tabs .ssh-tab');
        await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'deploy' && !document.querySelector('.ssh-private-text')`, 'hidden pane cleared it');
        // Esc in the pane closes it and drops the text.
        await reveal();
        await app.evaluate(`document.querySelector('.ssh-view-detail .ssh-private-text').focus()`);
        await app.press('Escape');
        await app.until(`${fullWidth} && !document.querySelector('.ssh-private-text')`, 'Esc closed the pane with the key');
        // "Zastąp klucz prywatny" with a fresh test key: the fingerprint changes and the editor says the public key is different.
        await openKey();
        const before = await app.evaluate(`document.querySelector('.ssh-view-detail .ssh-fingerprint').textContent`);
        await app.click('.ssh-view-detail .ssh-replace');
        await app.until(`!!document.querySelector('.ssh-replace-form textarea')`, 'replace form');
        await app.setValue('.ssh-replace-form textarea', replacement.private);
        await app.click('.ssh-replace-form button.primary');
        await app.until(`[...document.querySelectorAll('.modal-foot button')].some((b) => b.textContent === 'Zastąp klucz')`, 'replace confirmation');
        await app.click('.modal-foot button', 'Zastąp klucz');
        await app.until(`document.querySelector('.ssh-view-detail .ssh-fingerprint')?.textContent === ${JSON.stringify(newFingerprint)}`, 'fingerprint of the replacement');
        if (before === newFingerprint) throw new Error('the fingerprint did not change');
        await app.until(`document.querySelector('.ssh-view-detail .ssh-banner-warn[role=status]')?.textContent.includes('authorized_keys') && !document.querySelector('.ssh-replace-form') && document.querySelector('.ssh-key-tile').textContent.includes(${JSON.stringify(newFingerprint)})`, 'public key change reported, tile updated');
        if (!(await app.evaluate(`document.querySelector('.ssh-view-detail .ssh-public').textContent.includes('replacement@check')`))) throw new Error('public key not updated');
        await shot('key-replaced');
        // A narrow window (1100x700): Hosty with and without the pane.
        await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
        await app.click('.ssh-nav-item[data-section="hosts"]');
        await sleep(400);
        await shot('narrow-empty');
        await app.click('.ssh-tile[data-host-id]', 'web-1');
        await app.until(`document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1'`, 'host details in the narrow window');
        if (await app.evaluate(`(() => { const m = document.querySelector('.ssh-view-main'); return m.scrollWidth > m.clientWidth + 1; })()`)) throw new Error('the host column overflows in a narrow window');
        // Narrow: the search has its own line, the buttons sit under it; the Snippets panel is open next to the pane.
        const layout = await app.evaluate(`(() => { const s = document.querySelector('.ssh-view-head .ssh-search').getBoundingClientRect(); const b = document.querySelector('.ssh-view-head .ssh-view-actions button').getBoundingClientRect(); return [b.top >= s.bottom, /snippety/i.test(document.body.innerText), Math.round(document.querySelector('.ssh-view-detail').getBoundingClientRect().width)]; })()`);
        if (!layout[0] || !layout[1] || layout[2] < 260) throw new Error(`narrow layout: ${JSON.stringify(layout)}`);
        await shot('narrow');
        await app.screenshot('092-final-narrow.png');
        await sleep(2500); // state.json is written debounced
      } finally { await app.close(); }
      for (const file of ['state.json', 'ssh/vault.json']) {
        const text = readFileSync(join(root, 'data', file), 'utf8');
        if (text.includes('PRIVATE KEY') || text.includes(replacement.private.split('\n')[1])) throw new Error(`${file} contains private key text`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 11: a saved preset with three SSH cells opens from the palette and connects; the grid dialog lists hosts. */
  async grid() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-grid');
    try {
      const host = testHost(server.port, { label: 'lab' });
      const state = sshState({ projectPath: join(root, 'project'), hosts: [host] });
      state.presets = [{ id: 'preset-ssh', name: 'SSH lab x3', layout: { cols: 3, rows: 1, areas: [0, 1, 2].map((i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) },
        cells: [0, 1, 2].map(() => ({ profileId: 'shell', worktree: false, sshHostId: host.id })) }];
      writeState(root, state);
      const app = await launchApp(root);
      try {
        await app.click('button[aria-label="Szukaj wszędzie"]');
        await app.setValue('.palette input', 'SSH lab x3');
        await app.press('Enter');
        await app.until(`document.querySelectorAll('.cell .ssh-fingerprint').length === 3`, 'one shared host key card in three cells');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await app.until(`document.querySelectorAll('.cell .ssh-card').length === 0`, 'all three connected');
        // Every cell's terminal buffer holds the connected notice and the server greeting (nothing lost to the shared prompt or an early write).
        const buffers = CELL_BUFFERS;
        await app.until(`${buffers}.length === 3 && ${buffers}.every((t) => t.includes('połączono') && t.includes('unimux test server') && t.includes('$'))`, 'every cell shows the connected notice and the server greeting');
        await app.screenshot('ssh-grid-preset.png');
        // Typing into each cell reaches its own session and the echo comes back.
        for (let i = 0; i < 3; i++) {
          await app.evaluate(`(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId); window.__mc.terminals.focus(t.cells[${i}].id); return true; })()`);
          await app.insertText(`echo ok${i}`);
          await app.press('Enter');
          await app.until(`${buffers}[${i}].split('\\n').some((l) => l.trim() === 'ok${i}')`, `cell ${i + 1} echoes its command`);
        }
        await app.screenshot('ssh-grid-preset-echo.png');
        await app.click('button[title^="Nowy grid"]');
        await app.until(`!!document.querySelector('.grid-dialog')`, 'grid dialog');
        await app.click('.cell-table .select');
        await app.screenshot('ssh-grid-dialog.png');
        // M4: choosing a host keeps the cell name empty (the header shows the label once and follows renames).
        await app.click('.select-popup .select-option', 'lab');
        await app.until(`document.querySelector('.pc .nm')?.textContent === 'lab' && document.querySelector('.cell-table input.input').value === ''`, 'host chosen, name left empty');
        const tabs = await app.evaluate(`window.__mc.useStore.getState().s.projects[0].tabs.length`);
        await app.click('.modal-foot button.white');
        // A missing agent CLI in the other cells only arms the banner on the first click.
        if (await app.evaluate(`!!document.querySelector('.grid-dialog')`)) await app.click('.modal-foot button.white');
        await app.until(`window.__mc.useStore.getState().s.projects[0].tabs.length === ${tabs + 1}`, 'grid opened');
        const named = await app.evaluate(`(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId); return t.cells.filter((c) => c.ssh).map((c) => c.name ?? null); })()`);
        if (!named.length || named.some((n) => n !== null)) throw new Error(`grid-dialog SSH cells: ${JSON.stringify(named)}`);
        await app.screenshot('ssh-grid-dialog-opened.png');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** W3: a normal grid adds SSH cells from "Dodaj" and from a cell's menu, like choosing a profile. */
  async gridAdd() {
    const server = await startTestServer();
    const root = scratchRoot('ssh-gridadd');
    try {
      const hosts = [testHost(server.port, { label: 'web-1', group: 'lab' }), testHost(server.port, { label: 'pi' })];
      const state = sshState({ projectPath: join(root, 'project'), hosts });
      const tab = { id: randomUUID(), name: 'Dev', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }, cells: [{ id: randomUUID(), profileId: 'shell' }] };
      state.projects[0].tabs = [tab];
      state.projects[0].activeTabId = tab.id;
      writeState(root, state);
      const app = await launchApp(root);
      const menuHas = (text) => `[...document.querySelectorAll('.menu .menu-label, .menu .menu-item')].some((e) => e.textContent.includes(${JSON.stringify(text)}))`;
      /** Exact label match: the cell menu has many items and "pi" is a substring of some. */
      const clickExact = (label) => app.evaluate(`(() => { const el = [...document.querySelectorAll('.menu .menu-item')].find((e) => (e.firstChild?.textContent ?? e.textContent) === ${JSON.stringify(label)}); if (!el) throw new Error('menu item not found: ' + ${JSON.stringify(label)}); el.click(); return true; })()`);
      try {
        await app.until(`document.querySelectorAll('.cell').length === 1`, 'one shell cell');
        await app.click('.tb-add');
        await app.until(menuHas('web-1') + ` && ` + menuHas('Komórka SSH'), 'SSH section with the hosts in the Dodaj menu');
        await app.screenshot('091-grid-add-menu.png');
        await clickExact('web-1');
        await app.until(`document.querySelectorAll('.cell').length === 2 && document.querySelectorAll('.cell .cell-head .ssh-host').length === 1`, 'an SSH cell joined the grid');
        await app.evaluate(`(() => { const head = document.querySelector('.cell .cell-head'); head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 60 })); return true; })()`);
        await app.until(menuHas('Dodaj komórkę SSH'), 'SSH section in the cell menu');
        await app.screenshot('091-grid-add-cell-menu.png');
        await clickExact('pi');
        await app.until(`document.querySelectorAll('.cell').length === 3 && document.querySelectorAll('.cell .cell-head .ssh-host').length === 2`, 'a second SSH cell');
        await app.screenshot('091-grid-add-cells.png');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 12: a 3-cell grid opened from the 'lab' group, one command broadcast to all three (read from each terminal buffer), then one disconnected cell is disabled and skipped. */
  async broadcast() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-broadcast');
    try {
      const hosts = ['web-1', 'web-2', 'web-3'].map((label) => testHost(server.port, { label, group: 'lab' }));
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts }));
      writeKnownHost(root, server);
      const app = await launchApp(root);
      try {
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-view .ssh-tile[data-host-id]')`, 'host tiles');
        await app.click('.ssh-view-group .ssh-group-open');
        await connected(app, 3);
        await app.until(`${CELL_BUFFERS}.length === 3 && ${CELL_BUFFERS}.every((t) => t.includes('połączono') && t.includes('$'))`, 'three cells with a prompt');
        // "Wysyłanie masowe" in the SSH view's header targets the active grid.
        const showGrid = () => app.evaluate(`[...document.querySelectorAll('.workspace-tabs .grid-tab')].find((t) => t.textContent.includes('lab')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
        await app.click('.workspace-tabs .ssh-tab');
        await app.click('.ssh-view-head .ssh-broadcast-open', 'Wysyłanie masowe (3)');
        await app.until(`document.querySelector('.ssh-broadcast .modal-head h3')?.textContent.startsWith('Wysyłanie masowe: jedno polecenie do wielu sesji')`, 'bulk send dialog title');
        await app.until(`!!document.querySelector('.ssh-broadcast textarea')`, 'broadcast dialog');
        await app.until(`document.querySelectorAll('.ssh-targets li').length === 3 && document.querySelectorAll('.ssh-targets li.disabled').length === 0 && [...document.querySelectorAll('.ssh-targets input')].every((i) => i.checked)`, 'three connected cells, all checked');
        if (await app.evaluate(`document.querySelector('.ssh-broadcast .modal-foot .btn.white').disabled`) !== true) throw new Error('send button is enabled for an empty command');
        await app.setValue('.ssh-broadcast textarea', 'echo hi');
        await app.until(`document.querySelector('.ssh-broadcast .modal-foot .btn.white').textContent === 'Wyślij do 3' && !document.querySelector('.ssh-broadcast .modal-foot .btn.white').disabled`, 'send button counts three');
        await app.click('.ssh-broadcast .modal-foot .btn.white');
        await app.until(`[...document.querySelectorAll('.ssh-target-state')].filter((e) => e.textContent === 'wysłano').length === 3`, 'sent to three');
        // The terminals themselves print the output (L23): "hi" on its own line in every cell.
        for (let i = 0; i < 3; i++) await app.until(hasLine(i, 'hi'), `cell ${i + 1} printed hi`);
        if (await app.evaluate(`document.querySelector('.ssh-broadcast textarea').value`) !== '') throw new Error('the text was not cleared after sending');
        await app.screenshot('ssh-broadcast-sent.png');
        // The dialog stays open; Arrow Up in the empty field recalls the command.
        await app.evaluate(`document.querySelector('.ssh-broadcast textarea').focus()`);
        await app.press('ArrowUp');
        await app.until(`document.querySelector('.ssh-broadcast textarea').value === 'echo hi'`, 'history recall');
        // An escape sequence is refused and disables sending.
        await app.setValue('.ssh-broadcast textarea', 'ls \u001b[A');
        await app.until(`!!document.querySelector('.ssh-broadcast [role=alert]') && document.querySelector('.ssh-broadcast .modal-foot .btn.white').disabled`, 'control characters refused');
        await app.press('Escape');
        await app.until(`!document.querySelector('.ssh-broadcast')`, 'dialog closed by Escape');
        // Disconnect the first cell through its host chip menu.
        await showGrid();
        await app.until(`getComputedStyle(document.querySelector('.ssh-workspace')).display === 'none'`, 'grid in front');
        await app.click('.cell-head .ssh-host');
        await app.click('.menu .menu-item', 'Rozłącz');
        await app.until(`document.querySelectorAll('.cell .ssh-bar').length === 1`, 'first cell disconnected');
        await app.click('.workspace-tabs .ssh-tab');
        await app.click('.ssh-view-head .ssh-broadcast-open', 'Wysyłanie masowe');
        await app.until(`document.querySelectorAll('.ssh-targets li').length === 3 && document.querySelectorAll('.ssh-targets li.disabled').length === 1`, 'disconnected cell disabled in the dialog');
        const reason = await app.evaluate(`document.querySelector('.ssh-targets li.disabled .ssh-target-state').textContent`);
        if (reason !== 'rozłączono') throw new Error(`disabled row reason: ${reason}`);
        await app.setValue('.ssh-broadcast textarea', 'echo again');
        await app.until(`document.querySelector('.ssh-broadcast .modal-foot .btn.white').textContent === 'Wyślij do 2'`, 'send button counts two');
        await app.screenshot('ssh-broadcast-disabled.png');
        await app.press('Enter', 2); // Ctrl+Enter sends
        await app.until(`[...document.querySelectorAll('.ssh-target-state')].filter((e) => e.textContent === 'wysłano').length === 2`, 'sent to the two connected cells');
        await app.until(`${hasLine(1, 'again')} && ${hasLine(2, 'again')}`, 'cells 2 and 3 printed again');
        if (await app.evaluate(hasLine(0, 'again'))) throw new Error('the disconnected cell received the command');
        await app.press('Escape');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 13: Settings > SSH shows the storage and the known host, and removes it. */
  async settings() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-settings');
    try {
      writeState(root, sshState({ projectPath: join(root, 'project') }));
      writeKnownHost(root, server);
      const app = await launchApp(root);
      try {
        await app.click('button[aria-label="Ustawienia"]');
        await app.until(`!!document.querySelector('.settings-nav [role=tab]')`, 'settings page');
        await app.click('.settings-nav [role=tab]', 'SSH');
        await app.until(`!!document.querySelector('.ssh-known')`, 'known hosts table');
        const storage = await app.evaluate(`document.querySelector('.settings-content').textContent`);
        if (!/Szyfrowanie: (Windows \(DPAPI\)|pęk kluczy macOS)/.test(storage)) throw new Error('storage line missing');
        if (storage.includes('tylko do odczytu:')) throw new Error('a healthy store is shown as read-only');
        if (!storage.includes(join(root, 'data', 'ssh', 'known_hosts.json'))) throw new Error('known hosts file path missing');
        await app.screenshot('ssh-settings.png');
        await app.click('.ssh-known button', 'Usuń');
        await app.until(`document.querySelector('.settings-content').textContent.includes('Brak znanych hostów')`, 'known host removed');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 13 (a)-(c): a vault and a known hosts file of a newer format open read-only; Settings says so, shows both paths, and neither file is touched. */
  async settingsReadOnly() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-settings-ro');
    try {
      writeState(root, sshState({ projectPath: join(root, 'project') }));
      writeKnownHost(root, server);
      const vaultFile = join(root, 'data', 'ssh', 'vault.json'), hostsFile = join(root, 'data', 'ssh', 'known_hosts.json');
      writeFileSync(vaultFile, '{"version":99,"keys":[],"passwords":[]}');
      const damaged = readFileSync(hostsFile, 'utf8').replace('"version":1', '"version":99'); // newer format: the entry is listed, nothing can change
      writeFileSync(hostsFile, damaged);
      const app = await launchApp(root);
      try {
        await app.click('button[aria-label="Ustawienia"]');
        await app.until(`!!document.querySelector('.settings-nav [role=tab]')`, 'settings page');
        await app.click('.settings-nav [role=tab]', 'SSH');
        await app.until(`document.querySelectorAll('.settings-content .ssh-banner-warn').length === 2`, 'two read-only notes');
        const text = await app.evaluate(`document.querySelector('.settings-content').textContent`);
        for (const needle of ['Sejf SSH jest tylko do odczytu', vaultFile, 'Lista znanych hostów jest tylko do odczytu', hostsFile, 'Zaufaj i zapisz', 'Zastąp zapisany klucz']) {
          if (!text.includes(needle)) throw new Error(`Settings text misses: ${needle}`);
        }
        if (!(await app.evaluate(`[...document.querySelectorAll('.ssh-known button')].every((b) => b.disabled)`))) throw new Error('remove buttons are enabled on a read-only store');
        await app.screenshot('ssh-settings-readonly.png');
      } finally { await app.close(); }
      if (readFileSync(vaultFile, 'utf8') !== '{"version":99,"keys":[],"passwords":[]}') throw new Error('the vault file was modified');
      if (readFileSync(hostsFile, 'utf8') !== damaged) throw new Error('the known hosts file was modified');
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Spec 14: after a restart of the app the cell shows "Połącz" (D5); a new host key on the same port gives the red card (incl. the changed host key, L13). */
  async restart() {
    let server = await startTestServer();
    const root = scratchRoot('ssh-restart');
    const passwords = [server.password];
    try {
      const host = testHost(server.port);
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] }));
      let app = await launchApp(root);
      try {
        await app.click('.ssh-card button', 'Połącz');
        await app.until(`!!document.querySelector('.ssh-fingerprint')`, 'host key');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password, { save: true });
        await connected(app, 1);
        await sleep(2500); // state.json is written debounced
      } finally { await app.close(); }
      app = await launchApp(root);
      try {
        await app.until(`document.querySelector('.ssh-card button')?.textContent === 'Połącz'`, 'not restored after restart');
        await app.screenshot('ssh-after-restart.png');
      } finally { await app.close(); }
      const port = server.port;
      server.stop();
      await sleep(500); // the port is free again
      server = await startTestServer(['--port', String(port)]);
      passwords.push(server.password);
      if (server.port !== port) throw new Error('test server did not come back on the same port');
      app = await launchApp(root);
      try {
        await app.click('.ssh-card button', 'Połącz');
        await app.until(`!!document.querySelector('.ssh-card.danger')`, 'changed host key card');
        const shown = await app.evaluate(`document.querySelector('.ssh-card.danger').textContent`);
        if (!shown.includes(server.fingerprint)) throw new Error('the red card does not show the new fingerprint');
        await app.until(`document.querySelector('.ssh-card.danger button.danger')?.disabled === true`, 'replace disabled until confirmed');
        await app.screenshot('ssh-hostkey-changed.png');
        await app.click('.ssh-card.danger button', 'Rozłącz');
        await app.until(`!!document.querySelector('.ssh-bar.error')`, 'hostKeyChanged bar');
        await app.screenshot('ssh-hostkey-changed-refused.png');
      } finally { await app.close(); }
      const files = ['state.json', 'ssh/vault.json', 'ssh/known_hosts.json'].map((f) => join(root, 'data', f)).filter(existsSync);
      if (files.length !== 3) throw new Error(`expected state, vault and known hosts files, found ${files.length}`);
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const secret of [...passwords, 'PRIVATE KEY']) if (text.includes(secret)) throw new Error(`${file} contains a secret`);
      }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /**
   * 0.9.6 F3: "Łącz ponownie po uruchomieniu aplikacji" set in the host form reconnects the host's cell when the app starts
   * again (not after a reload); a host without it stays idle. "Połącz ponownie wszystkie SSH" (tab menu, palette) connects
   * only the idle, ended or failed SSH cells and is hidden while none is left.
   */
  async reconnectOnStart() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('reconnect');
    try {
      const on = testHost(server.port, { label: 'auto-host' });
      const off = testHost(server.port, { label: 'manual-host' });
      writeKnownHost(root, server);
      const state = sshState({ projectPath: join(root, 'project'), hosts: [on, off], cells: [on.id, off.id] });
      writeState(root, state);
      const [autoCell, manualCell] = state.projects[0].tabs[0].cells.map((c) => c.id);
      const cellIs = (cellId, what) => {
        const cell = `document.querySelector('.cell[data-cell-id="${cellId}"]')`;
        if (what === 'connected') return `(() => { const c = ${cell}; return !!c && !c.querySelector('.ssh-card') && !c.querySelector('.ssh-bar') && !c.querySelector('.status-text.ssh'); })()`;
        if (what === 'card') return `${cell}?.querySelector('.ssh-card button')?.textContent === 'Połącz'`;
        return `!!${cell}?.querySelector('.ssh-bar')`; // ended
      };
      const tabMenu = async () => {
        await app.evaluate(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 40 }))`);
        await app.until(`!!document.querySelector('.menu .menu-item')`, 'tab menu');
        const items = await app.evaluate(`[...document.querySelectorAll('.menu .menu-item')].map((e) => e.textContent)`);
        return items;
      };
      const closeMenu = () => app.press('Escape');
      let app = await launchApp(root);
      try {
        // Option off everywhere: D5, both cells wait for "Połącz".
        await app.until(`${cellIs(autoCell, 'card')} && ${cellIs(manualCell, 'card')}`, 'both cells idle at the first start');
        // "Połącz ponownie wszystkie SSH" is offered (two idle cells) and connects both.
        if (!(await tabMenu()).includes('Połącz ponownie wszystkie SSH')) throw new Error('tab menu lacks "Połącz ponownie wszystkie SSH" with idle cells');
        await app.screenshot('ssh-reconnect-all-menu.png');
        await app.click('.menu .menu-item', 'Połącz ponownie wszystkie SSH');
        await app.until(`${cellIs(autoCell, 'connected')} && ${cellIs(manualCell, 'connected')}`, 'reconnect all connected both cells');
        if ((await tabMenu()).includes('Połącz ponownie wszystkie SSH')) throw new Error('"Połącz ponownie wszystkie SSH" still offered with every cell connected');
        await closeMenu();
        // One cell ends: the palette offers the action and it connects only that one.
        await app.evaluate(`window.mc.killCell(${JSON.stringify(manualCell)}), true`);
        await app.until(cellIs(manualCell, 'ended'), 'manual cell ended');
        await app.click('button[aria-label="Szukaj wszędzie"]');
        await app.until(`!!document.querySelector('.palette input')`, 'palette');
        await app.setValue('.palette input', 'SSH: połącz ponownie wszystkie');
        await app.until(`document.querySelector('.palette-item.sel .ptitle')?.textContent === 'SSH: połącz ponownie wszystkie'`, 'palette entry');
        await app.press('Enter');
        await app.until(`${cellIs(autoCell, 'connected')} && ${cellIs(manualCell, 'connected')}`, 'palette reconnected the ended cell');
        const notices = await app.evaluate(`${CELL_BUFFERS}.map((t) => t.split('\\n').filter((l) => l.includes('łączenie z')).length)`);
        if (notices[0] !== 1 || notices[1] !== 2) throw new Error(`connecting notices per cell: ${notices} (the connected cell must not be touched)`);
        // The option in the host form of the SSH view.
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`document.querySelectorAll('.ssh-view .ssh-tile[data-host-id]').length === 2`, 'host tiles');
        await app.click('.ssh-tile[data-host-id]', 'auto-host');
        await app.until(`!!document.querySelector('.ssh-view-detail [data-field=reconnectOnStart]')`, 'reconnect option in the host form');
        if (await app.evaluate(`document.querySelector('.ssh-view-detail [data-field=reconnectOnStart]').checked`)) throw new Error('the option is on by default');
        await app.click('.ssh-view-detail [data-field=reconnectOnStart]');
        await app.evaluate(`document.querySelector('.ssh-view-detail [data-field=reconnectOnStart]').scrollIntoView({ block: 'center' }), true`);
        await app.screenshot('ssh-reconnect-option.png');
        await app.click('.ssh-view-detail .ssh-editor button.primary', 'Zapisz');
        await app.until(`window.__mc.useStore.getState().s.sshHosts.find((h) => h.label === 'auto-host')?.reconnectOnStart === true`, 'option saved');
        await app.evaluate(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
        // A renderer reload is not an app start: both sessions end first, and after the reload nothing connects by itself.
        await app.evaluate(`(window.mc.killCell(${JSON.stringify(autoCell)}), window.mc.killCell(${JSON.stringify(manualCell)}), true)`);
        await app.until(`${cellIs(autoCell, 'ended')} && ${cellIs(manualCell, 'ended')}`, 'both ended before the reload');
        await sleep(2500); // state.json is written debounced
        await app.cdp('Page.reload');
        await app.until(`!!document.querySelector('.app .workspace-tabs') && !!document.querySelector('.cell[data-cell-id="${autoCell}"] .cell-head .ssh-host')`, 'app after the reload');
        await sleep(3000);
        if (await app.evaluate(cellIs(autoCell, 'connected'))) throw new Error('the cell connected by itself after a renderer reload');
      } finally { await app.close(); }
      if (!JSON.parse(readFileSync(join(root, 'data', 'state.json'), 'utf8')).sshHosts.find((h) => h.id === on.id)?.reconnectOnStart) throw new Error('state.json lacks the option');
      // App start with the same data dir: the host with the option connects by itself, the other one waits for "Połącz".
      app = await launchApp(root);
      try {
        await app.until(cellIs(autoCell, 'connected'), 'auto cell reconnected at app start');
        await app.until(`${CELL_BUFFERS}[0].includes('łączenie z')`, 'connecting notice in the auto cell');
        await sleep(2500);
        if (!(await app.evaluate(cellIs(manualCell, 'card')))) throw new Error('the cell of the host without the option did not stay idle');
        await app.screenshot('ssh-reconnect-at-start.png');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** D8: with MC_SSH_NO_SAFESTORAGE=1 the banner shows, a saved password works for the session, nothing secret is written. */
  async noSafeStorage() {
    const server = await startTestServer();
    const root = scratchRoot('ssh-nosafe');
    try {
      const host = testHost(server.port);
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] }));
      const app = await launchApp(root, { MC_SSH_NO_SAFESTORAGE: '1' });
      try {
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-view .ssh-banner-warn')`, 'unavailable banner');
        await app.screenshot('ssh-no-safestorage.png');
        // Back to the grid with the SSH cell (grid tabs select on mousedown).
        await app.evaluate(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
        await app.until(`getComputedStyle(document.querySelector('.ssh-workspace')).display === 'none'`, 'grid in front');
        await app.click('.ssh-card button', 'Połącz');
        await app.until(`!!document.querySelector('.ssh-fingerprint')`, 'host key');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password, { save: true });
        await connected(app, 1);
        // The password is kept in memory for the session: a reconnect does not ask again.
        await app.click('.cell-head .ssh-host');
        await app.click('.menu .menu-item', 'Rozłącz');
        await app.until(`document.querySelector('.ssh-bar button')?.textContent === 'Połącz ponownie'`, 'disconnected bar');
        await app.click('.ssh-bar button', 'Połącz ponownie');
        await connected(app, 1);
        await sleep(2500); // state.json is written debounced
      } finally { await app.close(); }
      if (existsSync(join(root, 'data', 'ssh', 'vault.json'))) throw new Error('vault.json written although safeStorage was unavailable');
      if (readFileSync(join(root, 'data', 'state.json'), 'utf8').includes(server.password)) throw new Error('state.json contains the password');
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PARTS);
for (const name of wanted) {
  if (!PARTS[name]) throw new Error(`unknown part ${name}`);
  process.stdout.write(`-- ${name}\n`);
  await PARTS[name]();
  process.stdout.write(`OK ${name}\n`);
}
