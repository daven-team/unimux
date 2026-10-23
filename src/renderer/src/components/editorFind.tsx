// Find and replace inside the code editor: @codemirror/search keeps the query, the highlighting and the commands, its panel is
// our FindWidget (a React root inside CodeMirror's top panel, floated over the text by the theme in CodeEditor.tsx).
import { createRoot, type Root } from 'react-dom/client';
import { EditorSelection, Prec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type Panel, type ViewUpdate } from '@codemirror/view';
import { closeSearchPanel, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, searchPanelOpen, SearchQuery, setSearchQuery } from '@codemirror/search';
import { FIND_LIMIT, matchAtOrAfter, stepMatch } from '../../../shared/findText';
import { FindWidget, type FindToggles } from './FindWidget';

interface Matches { from: number[]; to: number[]; capped: boolean }

const queryOf = (spec: SearchQuery, change: Partial<Pick<SearchQuery, 'search' | 'caseSensitive' | 'wholeWord' | 'regexp' | 'replace'>>): SearchQuery =>
  new SearchQuery({ search: spec.search, caseSensitive: spec.caseSensitive, wholeWord: spec.wholeWord, regexp: spec.regexp, replace: spec.replace, literal: true, ...change });

/** Every match of the query (up to the limit); the regexp cursor skips empty matches itself. */
function collect(state: EditorState, query: SearchQuery): Matches {
  const result: Matches = { from: [], to: [], capped: false };
  if (!query.valid) return result;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (result.from.length >= FIND_LIMIT) { result.capped = true; break; }
    result.from.push(next.value.from);
    result.to.push(next.value.to);
  }
  return result;
}

const panels = new WeakMap<EditorView, FindPanel>();

class FindPanel implements Panel {
  readonly dom = document.createElement('div');
  readonly top = true;
  private readonly root: Root;
  private matches: Matches | null = null;
  private matchesFor: { doc: unknown; query: SearchQuery } | null = null;
  private replaceOpen = false;
  private focusFind = 1;
  private focusReplace = 0;
  /** Where typing searches from: the cursor when the widget opened or the match last stepped to. */
  private anchor: number;

  constructor(private readonly view: EditorView) {
    this.dom.className = 'cm-find-panel';
    this.anchor = view.state.selection.main.from;
    this.root = createRoot(this.dom);
    panels.set(view, this);
    this.render();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || getSearchQuery(update.state) !== getSearchQuery(update.startState)) this.render();
  }

  destroy(): void {
    panels.delete(this.view);
    // Unmounting while React may be rendering (a close from a click) is not allowed synchronously.
    queueMicrotask(() => this.root.unmount());
  }

  /** Ctrl+F while the widget is open: back into the find field (CodeMirror's openSearchPanel already took the selection). */
  focus(replace: boolean): void {
    if (replace && !this.view.state.readOnly) { this.replaceOpen = true; this.focusReplace++; } else this.focusFind++;
    this.render();
  }

  private current(): Matches {
    const query = getSearchQuery(this.view.state);
    const doc = this.view.state.doc;
    if (!this.matches || this.matchesFor?.doc !== doc || !this.matchesFor.query.eq(query)) {
      this.matches = collect(this.view.state, query);
      this.matchesFor = { doc, query };
    }
    return this.matches;
  }

  private select(index: number | null): void {
    const m = this.current();
    if (index === null || index >= m.from.length) return;
    this.anchor = m.from[index];
    const range = EditorSelection.range(m.from[index], m.to[index]);
    this.view.dispatch({ selection: EditorSelection.create([range]), effects: EditorView.scrollIntoView(range, { y: 'nearest', yMargin: 60, xMargin: 40 }), userEvent: 'select.search' });
  }

  private setQuery(change: Parameters<typeof queryOf>[1], jump: boolean): void {
    const query = queryOf(getSearchQuery(this.view.state), change);
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    // As in VS Code, typing jumps to the first match from where the search started; an empty or invalid query stays put.
    if (jump && query.valid) this.select(matchAtOrAfter(this.current().from.map((from, i) => [from, this.current().to[i]] as const), this.anchor));
    else this.render();
  }

  private step(dir: 1 | -1): void {
    const m = this.current();
    if (!m.from.length) return;
    const { from, to } = this.view.state.selection.main;
    const exact = m.from.findIndex((start, i) => start === from && m.to[i] === to);
    if (exact >= 0) { this.select(stepMatch(exact, m.from.length, dir)); return; }
    // The cursor is between matches: the next one after it, or the last one before it.
    const after = matchAtOrAfter(m.from.map((start, i) => [start, m.to[i]] as const), dir === 1 ? to : from);
    if (after === null) return;
    const before = m.from[after] >= from ? after - 1 : m.from.length - 1;
    this.select(dir === 1 ? after : (before + m.from.length) % m.from.length);
  }

  private render(): void {
    const view = this.view;
    const state = view.state;
    const spec = getSearchQuery(state);
    const m = this.current();
    const { from, to } = state.selection.main;
    const at = m.from.findIndex((start, i) => start === from && m.to[i] === to);
    const editable = !state.readOnly;
    this.root.render(
      <FindWidget
        query={spec.search}
        onQuery={(text) => this.setQuery({ search: text }, true)}
        toggles={{ caseSensitive: spec.caseSensitive, wholeWord: spec.wholeWord, regexp: spec.regexp }}
        onToggle={(name: keyof FindToggles) => this.setQuery({ [name]: !spec[name] }, true)}
        current={at >= 0 ? at : null}
        total={m.from.length}
        capped={m.capped}
        invalid={!!spec.search && spec.regexp && !spec.valid}
        onNext={() => this.step(1)}
        onPrev={() => this.step(-1)}
        onClose={() => { closeSearchPanel(view); view.focus(); }}
        replace={editable ? {
          open: this.replaceOpen,
          value: spec.replace,
          onValue: (value) => view.dispatch({ effects: setSearchQuery.of(queryOf(getSearchQuery(view.state), { replace: value })) }),
          onOpen: (open) => { this.replaceOpen = open; if (open) this.focusReplace++; else this.focusFind++; this.render(); },
          onReplace: () => { replaceNext(view); },
          onReplaceAll: () => { replaceAll(view); },
        } : undefined}
        focusFind={this.focusFind}
        focusReplace={this.focusReplace}
      />,
    );
  }
}

/** Opens the widget (with the selection as the query) or moves the keyboard back into it; `replace` also opens the replace row. */
export function openEditorFind(view: EditorView, replace = false): boolean {
  const wasOpen = searchPanelOpen(view.state);
  openSearchPanel(view);
  const panel = panels.get(view);
  if (panel && (wasOpen || replace)) panel.focus(replace);
  return true;
}

export function editorFind(): Extension {
  return [
    search({ top: true, literal: true, createPanel: (view) => new FindPanel(view), scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: 'nearest', yMargin: 60 }) }),
    // Before basicSetup's searchKeymap: Ctrl+F also refocuses an open widget, Ctrl+H (Cmd+Alt+F) opens it with the replace row.
    Prec.highest(keymap.of([
      { key: 'Mod-f', run: (view) => openEditorFind(view), preventDefault: true },
      { key: 'Mod-h', mac: 'Mod-Alt-f', run: (view) => openEditorFind(view, true), preventDefault: true },
    ])),
  ];
}
