import { useEffect, useRef } from 'react';
import { registerEditorFocus, treeOpen } from '../files';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { c, cpp, java, csharp } from '@codemirror/legacy-modes/mode/clike';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { minimalChange } from '../../../shared/textDiff';
import './file-workspace.css';

/** .env files: `# comments`, `export KEY=value`, quoted values and ${VAR} references. */
const dotenv = StreamLanguage.define<{ value: boolean }>({
  startState: () => ({ value: false }),
  token(stream, state) {
    if (stream.sol()) state.value = false;
    if (!state.value) {
      if (stream.eatSpace()) return null;
      if (stream.peek() === '#') { stream.skipToEnd(); return 'comment'; }
      if (stream.match(/^export\s+/)) return 'keyword';
      if (stream.match(/^[A-Za-z_][\w.-]*/)) return 'propertyName';
      if (stream.eat('=')) { state.value = true; return 'operator'; }
      stream.next();
      return 'invalid';
    }
    if (stream.eatSpace()) return null;
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      let escaped = false;
      for (let ch = stream.next(); ch != null; ch = stream.next()) {
        if (ch === quote && !escaped) break;
        escaped = quote === '"' && ch === '\\' && !escaped;
      }
      return 'string';
    }
    if (stream.match(/^\$\{[^}]*\}|^\$[A-Za-z_]\w*/)) return 'variableName';
    if (stream.peek() === '#' && stream.pos > 0 && /\s/.test(stream.string[stream.pos - 1] ?? '')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^-?\d+(\.\d+)?(?=\s|$)/)) return 'number';
    if (stream.match(/^(true|false|null)(?=\s|$)/i)) return 'bool';
    stream.next();
    return 'string';
  },
  languageData: { commentTokens: { line: '#' } },
});

function languageForFile(path: string): Extension {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env') || name === '.envrc') return dotenv;
  const extension = path.split('.').pop()?.toLowerCase();
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'].includes(extension ?? '')) {
    return javascript({ typescript: ['ts', 'mts', 'cts', 'tsx'].includes(extension!), jsx: ['jsx', 'tsx'].includes(extension!) });
  }
  switch (extension) {
    case 'json': case 'jsonc': return json();
    case 'css': return css();
    case 'html': case 'htm': case 'svg': return html();
    case 'md': case 'markdown': return markdown();
    case 'py': case 'pyw': return python();
    case 'yaml': case 'yml': return StreamLanguage.define(yaml);
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    case 'ps1': case 'psm1': case 'psd1': return StreamLanguage.define(powerShell);
    case 'go': return StreamLanguage.define(go);
    case 'rs': return StreamLanguage.define(rust);
    case 'c': case 'h': return StreamLanguage.define(c);
    case 'cpp': case 'hpp': case 'cc': return StreamLanguage.define(cpp);
    case 'java': return StreamLanguage.define(java);
    case 'cs': return StreamLanguage.define(csharp);
    case 'sql': return StreamLanguage.define(standardSQL);
    case 'toml': return StreamLanguage.define(toml);
    case 'env': case 'properties': case 'ini': case 'cfg': case 'conf': return dotenv;
    default: return [];
  }
}

export const colors = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: '#c4a1ef' },
  { tag: [tags.string, tags.regexp], color: '#a6c993' },
  { tag: [tags.number, tags.bool, tags.null], color: '#e5b77e' },
  { tag: [tags.comment], color: '#777d72', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#d9c58f' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#80c9bb' },
  { tag: [tags.propertyName, tags.attributeName], color: '#a1c5e7' },
  { tag: [tags.tagName], color: '#d69c8a' },
  { tag: [tags.operator, tags.punctuation], color: '#b9b9b9' },
  { tag: [tags.heading], color: '#d9c58f', fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: '#80c9bb', textDecoration: 'underline' },
  { tag: [tags.invalid], color: '#ef8e8e' },
]));
export const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: '#d6d6d6', fontSize: 'calc(13px * var(--file-zoom, 1))' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, Menlo, monospace', lineHeight: '1.7' },
  '.cm-content': { padding: '12px 0', caretColor: '#eeeeee' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: '#777d88', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '42px', padding: '0 10px 0 8px' },
  '.cm-activeLineGutter': { backgroundColor: '#ffffff04', color: '#bcbcbc' },
  '.cm-activeLine': { backgroundColor: '#ffffff04' },
  '.cm-cursor': { borderLeftColor: '#e6e6e6' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#ffffff20' },
  '.cm-matchingBracket': { backgroundColor: '#ffffff18', outline: '1px solid #ffffff30' },
  '.cm-panels, .cm-tooltip': { backgroundColor: '#202020', color: '#d6d6d6', borderColor: '#393939' },
  '.cm-searchMatch': { backgroundColor: '#bda35a30' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#bda35a55' },
}, { dark: true });

export function CodeEditor({ id, path, text, wrap, onChange }: { id: string; path: string; text: string; wrap: boolean; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const wrapping = useRef(new Compartment());
  /** The text the editor reported last: when it comes back as `text`, the editor already shows it (no second toString). */
  const emitted = useRef<string | null>(null);
  useEffect(() => {
    emitted.current = null;
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: text, extensions: [
      basicSetup, theme, colors, languageForFile(path), indentUnit.of('  '), keymap.of([indentWithTab]),
      EditorView.contentAttributes.of({ 'aria-label': path, spellcheck: 'false' }),
      wrapping.current.of(wrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of(update => { if (update.docChanged) { const value = update.state.doc.toString(); emitted.current = value; changed.current(value); } }),
    ] }) });
    view.current = editor;
    // Opening or renaming a file from the Files panel keeps the keyboard in the tree (F2, Delete, Ctrl+C...), unless it was opened with Enter.
    if (treeOpen.keyboard || !(treeOpen.hold || document.activeElement?.closest?.('.project-explorer'))) editor.focus();
    treeOpen.keyboard = false;
    return () => { view.current = null; editor.destroy(); };
  }, [path]);
  // A double click on the file in the tree when its editor is already on screen (files.ts focusFileEditor).
  useEffect(() => registerEditorFocus(id, () => view.current?.focus()), [id]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || text === emitted.current) return;
    // Only the changed middle is replaced (a file rewritten on disk): the cursor and the scroll position stay where they were.
    const current = editor.state.doc.toString();
    if (current !== text) editor.dispatch({ changes: minimalChange(current, text) });
  }, [text]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap]);
  return <div ref={host} className="code-editor file-workspace-code" />;
}
