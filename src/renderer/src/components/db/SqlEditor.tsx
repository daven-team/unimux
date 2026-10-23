// The SQL editor of a database tab (1.0.0): CodeMirror 6 with the PostgreSQL dialect of @codemirror/lang-sql (keywords and,
// when the tree loaded them, table names complete), Mod+Enter runs the statement under the cursor or the selection,
// Mod+Shift+Enter the whole script. Read-only for the DDL viewer.
import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { MariaSQL, MySQL, PostgreSQL, sql, type SQLDialect, type SQLNamespace } from '@codemirror/lang-sql';
import { colors, theme } from '../CodeEditor';
import { minimalChange } from '../../../../shared/textDiff';

export interface SqlRunRequest { kind: 'auto' | 'script'; text: string; from: number; to: number; cursor: number }
export interface SqlEditorApi { focus(): void; request(kind: 'auto' | 'script'): SqlRunRequest; markError(from: number, to: number): void; select(from: number, to: number): void }

const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = Decoration.mark({ class: 'cm-db-error' });
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setError)) deco = e.value && e.value.to > e.value.from ? Decoration.set([errorMark.range(e.value.from, e.value.to)]) : Decoration.none;
    if (tr.docChanged) deco = Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const requestOf = (view: EditorView, kind: 'auto' | 'script'): SqlRunRequest => {
  const s = view.state;
  const range = s.selection.main;
  return { kind, text: s.doc.toString(), from: range.from, to: range.to, cursor: range.head };
};

/** The keywords and quoting the editor highlights: the connection's (MySQL and MariaDB since 1.0.5). */
export type SqlEditorDialect = 'postgres' | 'mysql' | 'mariadb';
const DIALECTS: Record<SqlEditorDialect, SQLDialect> = { postgres: PostgreSQL, mysql: MySQL, mariadb: MariaSQL };

export function SqlEditor({ text, onChange, onRun, readOnly = false, schema, label, onApi, dialect = 'postgres' }: {
  text: string; onChange?: (text: string) => void; onRun?: (req: SqlRunRequest) => void; readOnly?: boolean;
  schema?: SQLNamespace; label: string; onApi?: (api: SqlEditorApi | null) => void; dialect?: SqlEditorDialect;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const run = useRef(onRun);
  run.current = onRun;
  const language = useRef(new Compartment());
  const emitted = useRef<string | null>(null);
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: text, extensions: [
      // Mod+Enter / Mod+Shift+Enter first, so the default "insert blank line" binding never takes them.
      keymap.of([
        { key: 'Mod-Enter', preventDefault: true, run: (v) => { run.current?.(requestOf(v, 'auto')); return true; } },
        { key: 'Mod-Shift-Enter', preventDefault: true, run: (v) => { run.current?.(requestOf(v, 'script')); return true; } },
      ]),
      basicSetup, theme, colors, indentUnit.of('  '), keymap.of([indentWithTab]), errorField,
      language.current.of(sql({ dialect: DIALECTS[dialect], upperCaseKeywords: true, ...(schema ? { schema } : {}) })),
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
      EditorView.updateListener.of((u) => { if (u.docChanged) { const value = u.state.doc.toString(); emitted.current = value; changed.current?.(value); } }),
    ] }) });
    view.current = editor;
    onApi?.({
      focus: () => editor.focus(),
      request: (kind) => requestOf(editor, kind),
      markError: (from, to) => editor.dispatch({ effects: setError.of({ from, to }), selection: EditorSelection.cursor(from), scrollIntoView: true }),
      select: (from, to) => editor.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true }),
    });
    if (!readOnly) editor.focus();
    return () => { onApi?.(null); view.current = null; editor.destroy(); };
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(sql({ dialect: DIALECTS[dialect], upperCaseKeywords: true, ...(schema ? { schema } : {}) })) });
  }, [schema, dialect]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || text === emitted.current) return;
    const current = editor.state.doc.toString();
    if (current !== text) editor.dispatch({ changes: minimalChange(current, text) });
  }, [text]);
  return <div ref={host} className="code-editor db-sql-editor" />;
}
