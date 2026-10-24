// Real Electron workspace checks, run by capture-readme.mjs --verify against disposable data.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function verifyWorkspaceUI({ cdp, evaluate, click, key, until, project, screenshot }) {
  // The rail tile of the open panel collapses it, so only click when Files is not the shown panel yet.
  const openFilesPanel = async () => { if (!(await evaluate("document.querySelector('#files-view')?.getAttribute('aria-selected') === 'true'"))) await click('#files-view'); };
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  await until(() => evaluate('Array.from(document.querySelectorAll(".brand-mark img")).length > 0 && Array.from(document.querySelectorAll(".brand-mark img")).every(img => img.complete && img.naturalWidth === 64 && img.naturalHeight === 64)'), 'bundled brand icon loads at its intended resolution');
  assert.equal(await evaluate('document.querySelectorAll(".titlebar .tab").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll(".workspace-tabs .tab").length >= 2'), true);
  assert.equal(await evaluate('document.querySelectorAll(".sidebar .list-drag-grip, .explorer-foot").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll(".project[draggable=true]").length'), 3);
  // 1.0.7 card header: the name and the muted details share one baseline (the details are smaller on purpose).
  assert.ok(await evaluate(`(() => {
    const head = document.querySelector('.cell-head');
    const name = head?.querySelector('.cell-name');
    const meta = head?.querySelector('.cell-meta .meta-item');
    if (!name) return false;
    if (!meta) return true;
    const center = (el) => { const r = el.getBoundingClientRect(); return r.y + r.height / 2; };
    return Math.abs(center(name) - center(meta)) < 2;
  })()`), 'cell name and details are aligned in the card header');
  assert.equal(await evaluate('document.querySelectorAll(".brand .brand-version").length'), 0);
  await until(() => evaluate(`document.querySelector('.statusbar .sb-version')?.textContent === ${JSON.stringify(`v${version}`)}`), 'running version in footer');
  assert.ok(await evaluate('!document.querySelector(".statusbar").textContent.toLowerCase().includes("unimux")'), 'footer omits brand name');
  assert.ok(await evaluate('[...document.querySelectorAll(".project")].every(row => !/[\\\\/]/.test(row.textContent))'), 'projects show names without path rows');
  assert.ok(await evaluate('(() => { const add = document.querySelector(".project-add-inline"); const rows = [...document.querySelectorAll(".project")]; return !!add && rows.every(row => row.getBoundingClientRect().bottom <= add.getBoundingClientRect().top); })()'), 'add project follows the project list');
  await evaluate('document.querySelector(".rpanel .search").focus()');
  await cdp('Input.insertText', { text: '__no_matching_snippet__' });
  await until(() => evaluate('!!document.querySelector(".snippet-empty")'), 'snippet empty search state');
  await screenshot('snippets-empty');
  assert.ok(await evaluate('(() => { const search = document.querySelector(".rpanel .search").getBoundingClientRect(); const empty = document.querySelector(".snippet-empty").getBoundingClientRect(); return Math.abs(search.left-empty.left) < 1 && Math.abs(search.right-empty.right) < 1 && empty.top >= search.bottom; })()'), 'empty snippet message aligns with search field');
  await evaluate(`(() => {
    const input = document.querySelector('.rpanel .search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => evaluate('document.querySelectorAll(".snippet").length === 3'), 'snippet search cleared');
  await click('.brand-trigger');
  await until(() => evaluate('document.querySelector(".brand").classList.contains("fx")'), 'brand effect');
  // Since 0.8.0 the update check is the version button in the status bar (the brand has no menu any more).
  await click('.statusbar .sb-version');
  await until(() => evaluate('!!document.querySelector(".sb-muted")'), 'visible dev update status');
  const handle = await evaluate('(() => { const r = document.querySelector(".panel-resize.edge-sidebar").getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+120}; })()');
  assert.ok(await evaluate(`document.elementFromPoint(${handle.x}, ${handle.y})?.classList.contains('panel-resize')`), 'resize hit target');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...handle });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 45, y: handle.y, button: 'left', buttons: 1 });
  await until(() => evaluate('document.documentElement.classList.contains("panel-resizing")'), 'resize start');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 45, y: handle.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 200 });
  await until(() => evaluate('!document.documentElement.classList.contains("panel-resizing") && !document.querySelector(".panel-resize.dragging")'), 'resize cleanup');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel-resize"), "::after").backgroundColor'), 'rgb(129, 161, 193)', 'the resize line is the steel blue of the selection (1.0.7)');
  await openFilesPanel();
  await until(() => evaluate('!!document.querySelector(".file-entry[title=src]")'), 'file tree');
  assert.equal(await evaluate('!!document.querySelector(".files-panel .project-add-inline")'), false, 'Files panel omits Add project');
  assert.ok(await evaluate('[...document.querySelectorAll(".file-entry:not(.folder)")].every(row => !row.querySelector(".tree-chevron") && row.querySelector(".file-type-icon"))'), 'files have type icons without an empty chevron');
  await evaluate('document.querySelector(".file-entry[title=src]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 130, clientY: 140 }))');
  await until(() => evaluate('!!document.querySelector(".menu")'), 'folder context menu');
  assert.equal(await evaluate('[...document.querySelectorAll(".menu-item")].some(item => item.textContent.includes("Open in editor") || item.textContent.includes("Preview file"))'), false, 'folders cannot open as editor files');
  assert.ok(await evaluate('[...document.querySelectorAll(".menu-item .kbd")].every(hint => getComputedStyle(hint).borderTopWidth === "0px")'), 'context shortcuts use plain text');
  await screenshot('folder-menu');
  await key('Escape', 'Escape');
  // Children load asynchronously; their absence does not mean an open folder is collapsed.
  if (await evaluate('document.querySelector(".file-entry[title=src]")?.getAttribute("aria-expanded") !== "true"')) await click('.file-entry[title=src]');
  await until(() => evaluate('!!document.querySelector(".file-entry[title=" + JSON.stringify("src/catalog.mjs") + "]")'), 'expanded source tree');
  await click('.file-entry[title="src/catalog.mjs"]');
  await until(() => evaluate('!!document.querySelector(".file-editor .cm-content")'), 'editor');
  assert.equal(await evaluate('!!document.querySelector(".grid-tab .tab-type-icon svg") && !!document.querySelector(".file-tab .tab-type-icon svg")'), true);
  assert.ok(await evaluate('[...document.querySelectorAll(".cm-lineNumbers .cm-gutterElement")].some(el => el.textContent === "1")'), 'line numbers');
  assert.ok(await evaluate('new Set([...document.querySelectorAll(".cm-line span")].map(el => getComputedStyle(el).color)).size >= 3'), 'syntax colors');
  assert.ok(await evaluate('(() => { const toolbar = document.querySelector(".file-editor-toolbar"); const centers = [...toolbar.children].map(el => { const r = el.getBoundingClientRect(); return r.y+r.height/2; }); return Math.max(...centers)-Math.min(...centers) < 1; })()'), 'aligned editor toolbar');
  const openSettings = async () => {
    await click('.titlebar button[title="Settings"]');
    await until(() => evaluate('!!document.querySelector(".settings-tab.active") && !!document.querySelector(".settings-page")'), 'settings workspace tab');
    assert.equal(await evaluate('document.querySelectorAll(".overlay, .modal").length'), 0, 'settings opens without a modal');
    assert.equal(await evaluate('document.querySelectorAll(".workspace-tabs .tab.active").length'), 1, 'only settings tab is active');
    assert.equal(await evaluate('document.querySelector(".terminal-workspace").style.display'), 'none');
  };
  await openSettings();
  const visualCards = () => evaluate(`[...document.querySelectorAll('.workspace-tabs .tab')].sort((a,b) => a.getBoundingClientRect().left-b.getBoundingClientRect().left).map(el => el.dataset.workspaceId)`);
  const dragCard = async (source, target, after) => {
    await evaluate(`window.cardTransfer = new DataTransfer(); [...document.querySelectorAll('[data-workspace-id]')].find(el => el.dataset.workspaceId === ${JSON.stringify(source)}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.cardTransfer }));`);
    await until(() => evaluate(`!!document.querySelector('[data-dragging]')`), 'card drag started');
    await evaluate(`var el = [...document.querySelectorAll('[data-workspace-id]')].find(el => el.dataset.workspaceId === ${JSON.stringify(target)}); var bounds = el.getBoundingClientRect(); var x = ${after} ? bounds.right-2 : bounds.left+2; el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.cardTransfer, clientX: x }));`);
    await until(() => evaluate(`!!document.querySelector('[data-drop]')`), 'card insertion indicator');
    await evaluate(`var el = [...document.querySelectorAll('[data-workspace-id]')].find(el => el.dataset.workspaceId === ${JSON.stringify(target)}); var bounds = el.getBoundingClientRect(); el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.cardTransfer, clientX: ${after} ? bounds.right-2 : bounds.left+2 }));`);
    await until(() => evaluate(`!document.querySelector('[data-dragging], [data-drop]')`), 'card drag cleanup');
  };
  const initialCards = await visualCards();
  const fileCard = initialCards.find(id => id.startsWith('file:'));
  const grids = initialCards.filter(id => id.startsWith('grid:'));
  await dragCard(fileCard, grids[0], false);
  assert.ok((await visualCards()).indexOf(fileCard) < (await visualCards()).indexOf(grids[0]), 'file can move before a grid');
  // Behind the last card (the git capture leaves a diff tab open beside the source file, so a file may follow the grids).
  await dragCard('settings', (await visualCards()).filter(id => id !== 'settings').at(-1), true);
  assert.equal((await visualCards()).at(-1), 'settings', 'settings can move behind grids and files');
  await dragCard(grids[0], fileCard, false);
  const movedCards = await visualCards();
  assert.ok(movedCards.indexOf(grids[0]) < movedCards.indexOf(fileCard), 'grid can move before a file');
  // 1.0.0: the order is global and lives in state.json: main's state has exactly the order the strip shows after the drop.
  await until(() => evaluate(`window.mc.loadSnapshot().then((snap) => JSON.stringify(snap.state.workspaceOrder) === ${JSON.stringify(JSON.stringify(movedCards))})`), 'mixed order saved in the state');
  await screenshot('workspace-card-reorder');
  await screenshot('settings-general');
  await click('.settings-nav button', 'Terminal');
  await until(() => evaluate('!!document.querySelector("#settings-shell")'), 'terminal settings layout');
  assert.ok(await evaluate('(() => { const rows = [...document.querySelectorAll(".settings-card > .setting-row")]; return rows.length >= 3 && rows.every((row, index) => index === 0 || row.getBoundingClientRect().top >= rows[index - 1].getBoundingClientRect().bottom); })()'), 'terminal settings are separate rows');
  await screenshot('settings-terminal');
  await click('#settings-shell');
  await until(() => evaluate('!!document.querySelector(".select-popup")'), 'shell menu');
  assert.ok(await evaluate('[...document.querySelectorAll(".select-option-label")].every(label => label.scrollWidth <= label.clientWidth)'), 'shell options fit without wrapping');
  await screenshot('settings-shell-menu');
  await key('Escape', 'Escape');
  assert.ok(await evaluate('(() => { const page = document.querySelector(".settings-page").getBoundingClientRect(); const nav = document.querySelector(".settings-nav").getBoundingClientRect(); const content = document.querySelector(".settings-content").getBoundingClientRect(); return nav.left - page.left >= 24 && nav.top - page.top >= 36 && content.left - nav.right >= 24 && page.right - content.right >= 24 && getComputedStyle(document.querySelector(".settings-card")).borderTopWidth === "0px"; })()'), 'settings have outer margins, top space and a borderless card');
  const sectionLabels = await evaluate('[...document.querySelectorAll(".settings-nav button")].map(button => button.textContent.trim())');
  assert.equal(sectionLabels.length, 6); // SSH joined in 0.9.0; 1.0.7 folded Updates into General and AI accounts into Agents
  for (const label of sectionLabels) {
    await click('.settings-nav button', label);
    await until(() => evaluate(`document.querySelector('.settings-content h2')?.textContent === ${JSON.stringify(label)}`), `settings section ${label}`);
    assert.equal(await evaluate('document.querySelectorAll(".settings-nav button[role=tab][aria-selected=true]").length'), 1);
    assert.ok(await evaluate('!!document.querySelector(".settings-content input, .settings-content .styled-select, .settings-content button")'), 'settings section provides controls');
    if (label === 'Notifications and sounds') {
      assert.ok(await evaluate('document.querySelectorAll(".alert-event-row input[role=switch]").length === 3 && [...document.querySelectorAll(".alert-event-row")].every(row => row.querySelector(".styled-select") && row.querySelector(".alert-test"))'), 'event rows keep the notification switch, the sound select and the test button');
      assert.ok(await evaluate('[...document.querySelectorAll(".settings-card input[role=switch]")].every(input => { const r = input.getBoundingClientRect(); return r.width === 28 && r.height === 16; })'), 'switch tracks retain their dimensions');
      await screenshot('settings-notifications');
    }
    if (label === 'Agents') {
      const before = await evaluate('document.querySelector("#settings-ai-usage").checked');
      await click('#settings-ai-usage');
      await until(() => evaluate(`document.querySelector('#settings-ai-usage').checked === ${!before}`), 'AI usage toggle');
      await click('#settings-ai-usage');
    }
    if (label === 'Agents') await screenshot('settings-profiles');
  }
  await click('.file-tab');
  await until(() => evaluate('!!document.querySelector(".file-tab.active") && !!document.querySelector(".file-editor .cm-content") && !document.querySelector(".settings-page")?.getClientRects().length'), 'return from settings to file');
  await openSettings();
  assert.equal(await evaluate('document.querySelector(".settings-content h2").textContent'), sectionLabels.at(-1), 'settings remembers its section after returning from file');
  await evaluate('document.querySelector(".grid-tab").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))');
  await until(() => evaluate('!!document.querySelector(".grid-tab.active") && document.querySelector(".terminal-workspace").style.display === "flex" && !document.querySelector(".settings-page")?.getClientRects().length'), 'return from settings to grid');
  await openSettings();
  assert.equal(await evaluate('document.querySelector(".settings-content h2").textContent'), sectionLabels.at(-1), 'settings remembers its section after returning from grid');
  assert.equal(await evaluate('document.querySelectorAll(".settings-tab").length'), 1, 'reopening settings reuses its tab');
  await click('.settings-tab .x');
  await until(() => evaluate('!document.querySelector(".settings-tab") && !!document.querySelector(".grid-tab.active")'), 'closing settings restores grid');
  assert.deepEqual(await visualCards(), movedCards.filter(id => id !== 'settings'), 'closing settings preserves the other card positions');
  await click('.file-tab');
  await until(() => evaluate('!!document.querySelector(".file-editor .cm-content")'), 'return to editor after settings checks');
  const gridTabsBeforeClose = await evaluate('document.querySelectorAll(".grid-tab").length');
  await openSettings();
  await key('W', 'KeyW', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin', shiftKey: true });
  await until(() => evaluate('!document.querySelector(".settings-tab") && !!document.querySelector(".file-tab.active") && !!document.querySelector(".file-editor .cm-content")'), 'settings close shortcut restores file');
  assert.equal(await evaluate('document.querySelectorAll(".grid-tab").length'), gridTabsBeforeClose, 'closing settings does not close a background grid');
  const path = join(project, 'src', 'catalog.mjs');
  const original = readFileSync(path, 'utf8');
  const setText = async text => {
    await evaluate('document.querySelector(".cm-content").focus()');
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers });
    await cdp('Input.insertText', { text });
  };
  await setText(original + '\n// Saved from workspace smoke\n');
  await until(() => evaluate('!!document.querySelector(".file-dirty")'), 'dirty marker');
  await key('s', 'KeyS', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin' });
  await until(() => readFileSync(path, 'utf8').includes('Saved from workspace smoke'), 'editor persisted save');
  await until(() => evaluate('!document.querySelector(".file-dirty")'), 'saved marker');
  await setText(original + '\n// Undo probe\n');
  await key('z', 'KeyZ', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin' });
  await until(() => evaluate('!document.querySelector(".cm-content").textContent.includes("Undo probe")'), 'editor undo');
  await setText(original + '\n// Unsaved protected draft\n');
  await click('.file-tab .x');
  await until(() => evaluate('!!document.querySelector(".overlay")'), 'styled dirty close dialog');
  await click('.modal-foot button', 'Cancel');
  assert.equal(await evaluate('!!document.querySelector(".file-editor .cm-content")'), true);
  writeFileSync(path, original + '\n// External disk change\n');
  await key('s', 'KeyS', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin' });
  await until(() => evaluate('document.querySelector(".file-editor").textContent.includes("changed")'), 'external write conflict');
  assert.equal(readFileSync(path, 'utf8'), original + '\n// External disk change\n');
  await evaluate('window.__workspaceReloadProbe = true');
  await cdp('Page.reload');
  await until(async () => {
    try { return await evaluate('!window.__workspaceReloadProbe && !!window.mc && !!document.querySelector(".file-tab .file-dirty")'); }
    catch { return false; } // The old JavaScript context disappears during reload.
  }, 'restored draft after reload');
  assert.deepEqual(await visualCards(), movedCards.filter(id => id !== 'settings'), 'mixed card order survives reload');
  await click('.file-tab');
  await until(() => evaluate('document.querySelector(".cm-content")?.textContent.includes("Unsaved protected draft")'), 'draft text restored');
  await click('.file-tab .x');
  await until(() => evaluate('!!document.querySelector(".overlay")'), 'discard dialog');
  await click('.modal-foot button', 'Discard');
  await until(() => evaluate('!document.querySelector(".file-tab")'), 'file close returns to grid');
  assert.equal(await evaluate('document.querySelector(".terminal-workspace").style.display'), 'flex');
  await openFilesPanel();
  await until(() => evaluate(`!!document.querySelector('.file-entry[title="README.md"]')`), 'Markdown file in project explorer');
  await click('.file-entry[title="README.md"]');
  await until(() => evaluate('!!document.querySelector(".markdown-preview")'), 'Markdown opens in preview by default');
  assert.equal(await evaluate('document.querySelector(".markdown-view-toggle button[aria-pressed=true]").textContent'), 'Preview');
  assert.equal(await evaluate('!!document.querySelector(".file-editor .cm-content")'), false, 'preview renders document instead of source editor');
  assert.ok(await evaluate('(() => { const article = document.querySelector(".markdown-preview"); return !!article.querySelector("h1") && article.querySelectorAll("h2").length >= 3 && article.querySelectorAll("table tbody tr").length === 3 && !!article.querySelector("blockquote") && article.querySelector("pre code").textContent.includes("findProducts") && article.querySelectorAll("input[type=checkbox][disabled]").length === 3 && article.querySelectorAll("input[type=checkbox][checked]").length === 2; })()'), 'Markdown headings, table, quote, fenced code and task lists render');
  assert.ok(await evaluate('(() => { const article = document.querySelector(".markdown-preview"); return !article.querySelector("script, iframe, object, embed") && [...article.querySelectorAll("*")].every(el => [...el.attributes].every(attr => !/^on/i.test(attr.name) && !(/^href$|^src$/i.test(attr.name) && /^javascript:/i.test(attr.value)))) && window.__markdownInjected !== true; })()'), 'Markdown removes executable HTML and JavaScript URLs');
  await screenshot('markdown-preview');
  await click('.markdown-preview a[href="#project-checks"]');
  assert.ok(await evaluate('(() => { const viewport = document.querySelector(".markdown-preview-scroll").getBoundingClientRect(); const target = document.querySelector("#markdown-project-checks").getBoundingClientRect(); return target.top >= viewport.top && target.top < viewport.bottom && document.querySelector(".file-editor").getAttribute("aria-label") === "README.md"; })()'), 'Markdown fragment navigates inside preview');
  await click('.markdown-preview a[href="src/catalog.mjs"]');
  await until(() => evaluate('document.querySelector(".file-editor")?.getAttribute("aria-label") === "src/catalog.mjs" && !!document.querySelector(".cm-content")'), 'relative Markdown link opens project source');
  await click('.file-tab[title^="README.md"]');
  await until(() => evaluate('!!document.querySelector(".markdown-preview")'), 'return to Markdown preview');
  await click('.markdown-view-toggle button', 'Edit source');
  await until(() => evaluate('!!document.querySelector(".file-editor .cm-content")'), 'Markdown source toggle');
  await screenshot('markdown-source');
  const readmePath = join(project, 'README.md');
  const readmeOriginal = readFileSync(readmePath, 'utf8');
  await setText(readmeOriginal + '\n## Unsaved preview update\n\nThis draft is visible before saving.\n');
  await until(() => evaluate(`!!document.querySelector('.file-tab[title^="README.md"] .file-dirty')`), 'Markdown source creates protected draft');
  await click('.markdown-view-toggle button', 'Preview');
  await until(() => evaluate('document.querySelector("#markdown-unsaved-preview-update")?.textContent === "Unsaved preview update"'), 'Markdown preview reflects unsaved source');
  assert.equal(readFileSync(readmePath, 'utf8'), readmeOriginal, 'preview leaves draft unsaved on disk');
  await click('.file-tab[title^="README.md"] .x');
  await until(() => evaluate('!!document.querySelector(".overlay")'), 'Markdown preview protects draft on close');
  await click('.modal-foot button', 'Cancel');
  await until(() => evaluate('!document.querySelector(".overlay") && !!document.querySelector("#markdown-unsaved-preview-update")'), 'cancel preserves Markdown preview draft');
  await click('.file-tab[title^="README.md"] .x');
  await until(() => evaluate('!!document.querySelector(".overlay")'), 'Markdown discard confirmation');
  await click('.modal-foot button', 'Discard');
  await until(() => evaluate(`!document.querySelector('.file-tab[title^="README.md"]')`), 'Markdown draft discarded');
  assert.equal(readFileSync(readmePath, 'utf8'), readmeOriginal, 'discard keeps original Markdown file');
  console.log('Workspace UI verified: settings tab/sections/grid/file navigation, aligned snippet empty state, project names and add placement, footer version, distinct grid/file tabs, aligned toolbar, line numbers, syntax colors, undo, project dragging, update menu, neutral resize cleanup, editor save/conflict/close and draft recovery, safe Markdown rendering, fragment/project links, source/preview toggles and draft protection.');
}
