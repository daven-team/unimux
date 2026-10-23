// Loads the languages of notes and snippets with code (codeHighlight.ts) once, on first use, outside the startup bundle.
import { useEffect, useState } from 'react';
import './components/codeText.css';

type CodeHighlight = typeof import('./codeHighlight');
let loaded: CodeHighlight | null = null;
let loading: Promise<CodeHighlight> | null = null;

export function loadCodeHighlight(): Promise<CodeHighlight> {
  loading ??= import('./codeHighlight').then((mod) => (loaded = mod));
  return loading;
}

/** The highlighter once its chunk arrived (null before, or when not `enabled`: callers show plain text meanwhile). */
export function useCodeHighlight(enabled = true): CodeHighlight | null {
  const [mod, setMod] = useState(loaded);
  useEffect(() => {
    if (mod || !enabled) return;
    let live = true;
    void loadCodeHighlight().then((m) => { if (live) setMod(m); }, () => { loading = null; });
    return () => { live = false; };
  }, [enabled]);
  return enabled ? mod : null;
}
