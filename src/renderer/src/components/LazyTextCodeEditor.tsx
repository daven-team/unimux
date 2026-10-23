// The code editor of notes and snippets, loaded with its languages on first use (CodeMirror stays out of the startup bundle).
import { lazy, Suspense } from 'react';
import type { TextCodeEditorProps } from './TextCodeEditor';
import './codeText.css';

const Editor = lazy(() => import('./TextCodeEditor'));

export function LazyTextCodeEditor(props: TextCodeEditorProps) {
  return <Suspense fallback={<div className={`text-code-editor loading ${props.className ?? ''}`} />}><Editor {...props} /></Suspense>;
}
