// The CodeMirror languages of notes and snippets with code (1.0.6), loaded on demand (see useCodeHighlight.ts): the editor's
// language and a static highlighter for snippet cards and the code blocks of a note's Markdown preview.
import { StreamLanguage, type Language } from '@codemirror/language';
import { classHighlighter, highlightTree, styleTags, tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { c, cpp, java, csharp } from '@codemirror/legacy-modes/mode/clike';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { highlightRuns, resolveCodeLanguage, runsToHtml, type CodeLanguage, type HighlightRange } from '../../shared/codeLanguages';

/** A task box (`[x]`) styled like the list mark next to it; GFM tags it as an atom, which the editor paints as a keyword. */
const TASK_MARKER_PLAIN = { props: [styleTags({ TaskMarker: tags.processingInstruction })] };

const cache = new Map<CodeLanguage, Language | null>();

function build(id: CodeLanguage): Language | null {
  switch (id) {
    case 'text': return null;
    // Markdown highlights the code of a fenced block in the language named after the fence (```ts, ```sql, ```bash ...).
    // GFM (markdownLanguage): "- [x]" is a task marker, not a link (drawn like the list's "-", not as a keyword), and
    // tables and ~~strikes~~ are known (1.0.7).
    case 'markdown': return markdown({ base: markdownLanguage, extensions: [TASK_MARKER_PLAIN], codeLanguages: (info) => {
      const inner = resolveCodeLanguage(info);
      return inner && inner !== 'markdown' ? codeLanguage(inner) : null;
    } }).language;
    case 'typescript': return javascript({ typescript: true, jsx: true }).language;
    case 'javascript': return javascript({ jsx: true }).language;
    case 'json': return json().language;
    case 'css': return css().language;
    case 'html': return html().language;
    case 'python': return python().language;
    case 'shell': return StreamLanguage.define(shell);
    case 'powershell': return StreamLanguage.define(powerShell);
    case 'yaml': return StreamLanguage.define(yaml);
    case 'go': return StreamLanguage.define(go);
    case 'rust': return StreamLanguage.define(rust);
    case 'c': return StreamLanguage.define(c);
    case 'cpp': return StreamLanguage.define(cpp);
    case 'java': return StreamLanguage.define(java);
    case 'csharp': return StreamLanguage.define(csharp);
    case 'sql': return StreamLanguage.define(standardSQL);
    case 'toml': return StreamLanguage.define(toml);
  }
}

/** The language of an id (null for plain text); each one is built once. */
export function codeLanguage(id: CodeLanguage): Language | null {
  if (!cache.has(id)) cache.set(id, build(id));
  return cache.get(id) ?? null;
}

/** Above this size a text is shown without colours (a card or a code block never needs that much). */
const HIGHLIGHT_LIMIT = 100_000;

/** The text as HTML with `tok-*` classes (styled in codeHighlight.css), `marks` laid over it (snippet variables). */
export function highlightHtml(text: string, id: CodeLanguage, marks: readonly HighlightRange[] = []): string {
  const language = text.length <= HIGHLIGHT_LIMIT ? codeLanguage(id) : null;
  const ranges: HighlightRange[] = [];
  if (language) {
    try {
      highlightTree(language.parser.parse(text), classHighlighter, (from, to, cls) => { ranges.push({ from, to, cls }); });
    } catch { ranges.length = 0; }
  }
  return runsToHtml(highlightRuns(text, ranges, marks));
}
