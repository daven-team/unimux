import { useEffect, useMemo, useRef, type MouseEvent, type RefObject } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { openFile } from '../files';
import { usePreviewFind } from './previewFind';
import { useCodeHighlight } from '../useCodeHighlight';
import { resolveCodeLanguage, type CodeLanguage } from '../../../shared/codeLanguages';
import './markdown.css';

export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

export function externalMarkdownUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/**
 * Code blocks with tools (notes, 1.0.6): highlighted in the language of their fence when `highlight` is given, with the language
 * named and a copy button (`.md-code-copy`, handled by MarkdownPreview) above the code.
 */
export interface MarkdownCodeTools { copyLabel: string; highlight?: (text: string, language: CodeLanguage) => string }

const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>';
const CODE_CLASS = /^language-[\w#+.-]{1,40}$/;

/** Wraps each code block in `.md-code` with a bar (its language, a copy button) and highlights the code when it can. */
function addCodeTools(fragment: DocumentFragment, tools: MarkdownCodeTools): void {
  fragment.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement!;
    const info = Array.from(code.classList).find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? '';
    const language = resolveCodeLanguage(info);
    if (language && tools.highlight) {
      code.innerHTML = tools.highlight(code.textContent ?? '', language);
      code.classList.add('code-hl');
    }
    const box = document.createElement('div');
    box.className = 'md-code';
    const bar = document.createElement('div');
    bar.className = 'md-code-bar';
    const label = document.createElement('span');
    label.className = 'md-code-lang';
    label.textContent = info;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'md-code-copy';
    copy.title = tools.copyLabel;
    copy.setAttribute('aria-label', tools.copyLabel);
    copy.innerHTML = COPY_ICON;
    bar.append(label, copy);
    pre.replaceWith(box);
    box.append(bar, pre);
  });
}

export function renderMarkdown(text: string, codeTools?: MarkdownCodeTools): string {
  // The language of a fenced block (class="language-ts") survives the sanitizer; any other class does not.
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'class' && node.nodeName === 'CODE' && CODE_CLASS.test(data.attrValue)) data.forceKeepAttr = true;
  });
  // Marked parses Markdown; DOMPurify is the boundary for untrusted file HTML.
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }), {
      ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 's', 'a', 'img',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'details', 'summary', 'kbd', 'sup', 'sub'],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'start', 'align', 'type', 'checked', 'disabled'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
  } finally { DOMPurify.removeHook('uponSanitizeAttribute'); }
  const slugs = new Map<string, number>();
  fragment.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
    const slug = (heading.textContent ?? '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    const count = slugs.get(slug) ?? 0;
    slugs.set(slug, count + 1);
    heading.id = `markdown-${slug}${count ? `-${count}` : ''}`;
  });
  fragment.querySelectorAll('input').forEach((input) => {
    if (input.type !== 'checkbox') { input.remove(); return; }
    input.disabled = true;
    input.setAttribute('aria-label', input.parentElement?.textContent?.trim() || 'Markdown task');
  });
  // The app CSP does not permit remote or arbitrary local image loads. Keep the
  // descriptive image text visible and make HTTP(S) images explicit links.
  fragment.querySelectorAll('img').forEach((image) => {
    const label = image.alt || image.title || 'Image';
    const href = externalMarkdownUrl(image.getAttribute('src') ?? '');
    const replacement = document.createElement(href ? 'a' : 'em');
    replacement.textContent = label;
    if (href) replacement.setAttribute('href', href);
    image.replaceWith(replacement);
  });
  if (codeTools) addCodeTools(fragment, codeTools);
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

function projectLinkPath(href: string, path: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
  try {
    const target = decodeURIComponent(href.split(/[?#]/)[0]).replace(/\\/g, '/');
    if (!target || target.startsWith('/')) return null;
    const parts = path.split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    return parts.join('/') || null;
  } catch { return null; }
}

/** Opens the find widget of the file tab on screen (Ctrl+F outside the text, see FileEditor.tsx); set by the editor or the preview. */
export type FileFinder = RefObject<((replace: boolean) => void) | null>;

export function MarkdownPreview({ text, projectId, path, finder, codeTools }: {
  text: string; projectId: string; path: string; finder?: FileFinder;
  /** Code blocks get a copy button and, once the languages loaded, colours (the note preview). */
  codeTools?: { copyLabel: string };
}) {
  const highlighter = useCodeHighlight(!!codeTools);
  const copyLabel = codeTools?.copyLabel;
  const html = useMemo(() => renderMarkdown(text, copyLabel === undefined ? undefined : { copyLabel, highlight: highlighter?.highlightHtml }),
    [text, copyLabel, highlighter]);
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const find = usePreviewFind(article, scroller, html);
  useEffect(() => {
    if (!finder) return;
    finder.current = () => find.open();
    return () => { finder.current = null; };
  }, [finder, find.open]);
  const followLink = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const copy = (event.target as Element).closest('.md-code-copy');
    if (copy) {
      if (event.button !== 0) return;
      const code = copy.closest('.md-code')?.querySelector('pre > code');
      // Marked ends the code of a block with a line break; the copy does not.
      window.mc.clipboardWrite((code?.textContent ?? '').replace(/\r?\n$/, ''));
      copy.classList.add('copied');
      window.setTimeout(() => copy.classList.remove('copied'), 1200);
      return;
    }
    const anchor = (event.target as Element).closest('a');
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      try {
        const id = `markdown-${decodeURIComponent(href.slice(1))}`;
        Array.from(event.currentTarget.querySelectorAll('[id]')).find((element) => element.id === id)?.scrollIntoView({ block: 'start' });
      } catch { /* Invalid fragment. */ }
      return;
    }
    const external = externalMarkdownUrl(href);
    if (external) { window.mc.openExternal(external); return; }
    const relative = projectLinkPath(href, path);
    // A tab outside the projects (projectId '') has no project to resolve a relative link in.
    if (relative && projectId) void openFile(projectId, relative);
  };
  return <div className="markdown-preview-host find-host" onKeyDown={find.onKeyDown}>
    <div ref={scroller} className="markdown-preview-scroll" tabIndex={0}>
      <article ref={article} className="markdown-preview" aria-label={path} onClick={followLink} onAuxClick={followLink}
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
    {find.widget}
  </div>;
}
