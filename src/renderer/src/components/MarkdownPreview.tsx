import { useEffect, useMemo, useRef, type MouseEvent, type RefObject } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { openFile } from '../files';
import { usePreviewFind } from './previewFind';
import { useCodeHighlight } from '../useCodeHighlight';
import { resolveCodeLanguage, type CodeLanguage } from '../../../shared/codeLanguages';
import { noteImageName, splitTags } from '../../../shared/noteTools';
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

/**
 * Notes (1.0.7): `tasks` = how many tasks the note's text holds (shared/noteTools.ts noteTasks): when the preview shows as many
 * checkboxes, they can be clicked (each carries its index); `noteImages`: images saved with the notes stay images, loaded later;
 * `tags`: #tags outside code and links become chips (`.md-tag`, a click filters the notes). A note keeps its line breaks.
 */
export interface MarkdownNoteOptions { tasks?: number; noteImages?: boolean; tags?: boolean }

/** #tags in the text of a note's preview as chips; never inside code, a link or a heading's anchor. */
function markTags(fragment: DocumentFragment): void {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.includes('#') && !node.parentElement?.closest('code, pre, a, kbd')) texts.push(node as Text);
  }
  for (const text of texts) {
    const parts = splitTags(text.nodeValue ?? '');
    if (parts.length === 1 && typeof parts[0] === 'string') continue;
    text.replaceWith(...parts.map((part) => {
      if (typeof part === 'string') return part;
      const chip = document.createElement('span');
      chip.className = 'md-tag';
      chip.dataset.tag = part.tag;
      chip.textContent = part.raw;
      return chip;
    }));
  }
}

export function renderMarkdown(text: string, codeTools?: MarkdownCodeTools, note?: MarkdownNoteOptions): string {
  // The language of a fenced block (class="language-ts") survives the sanitizer; any other class does not.
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'class' && node.nodeName === 'CODE' && CODE_CLASS.test(data.attrValue)) data.forceKeepAttr = true;
  });
  // Marked parses Markdown; DOMPurify is the boundary for untrusted file HTML.
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false, breaks: !!note }), {
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
  fragment.querySelectorAll('input').forEach((input) => { if (input.type !== 'checkbox') input.remove(); });
  // An empty task (`- [ ]` with nothing after it) is no task for GFM; a note shows it as an empty checkbox to fill in.
  if (note?.tasks !== undefined) fragment.querySelectorAll('li').forEach((li) => {
    // A loose list wraps the item in a paragraph.
    const holder = li.childNodes.length === 1 && li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li;
    const m = holder.childNodes.length === 1 && holder.firstChild?.nodeType === Node.TEXT_NODE ? /^\s*\[([ xX])\]\s*$/.exec(holder.textContent ?? '') : null;
    if (!m) return;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = m[1] !== ' ';
    holder.replaceChildren(box);
  });
  const boxes = Array.from(fragment.querySelectorAll('input'));
  const clickable = note?.tasks !== undefined && note.tasks === boxes.length;
  boxes.forEach((input, index) => {
    input.disabled = !clickable;
    if (clickable) {
      input.dataset.task = String(index);
      input.closest('li')?.classList.add('md-task', ...(input.checked ? ['done'] : []));
      // The task's own words in one span (a done task is struck through, its nested list is not).
      const words = document.createElement('span');
      words.className = 'md-task-text';
      for (let node = input.nextSibling; node && !(node instanceof HTMLElement && /^(UL|OL|P|DIV|PRE|BLOCKQUOTE|TABLE)$/.test(node.tagName));) {
        const next: ChildNode | null = node.nextSibling;
        words.append(node);
        node = next;
      }
      input.after(words);
    }
    input.setAttribute('aria-label', input.parentElement?.textContent?.trim() || 'Markdown task');
  });
  // The app CSP does not permit remote or arbitrary local image loads. Keep the
  // descriptive image text visible and make HTTP(S) images explicit links.
  fragment.querySelectorAll('img').forEach((image) => {
    const saved = note?.noteImages ? noteImageName(image.getAttribute('src') ?? '') : null;
    if (saved) {
      // Read by MarkdownPreview from the data folder (a data: URL); no src until then.
      image.removeAttribute('src');
      image.dataset.noteImage = saved;
      image.className = 'note-image';
      return;
    }
    const label = image.alt || image.title || 'Image';
    const href = externalMarkdownUrl(image.getAttribute('src') ?? '');
    const replacement = document.createElement(href ? 'a' : 'em');
    replacement.textContent = label;
    if (href) replacement.setAttribute('href', href);
    image.replaceWith(replacement);
  });
  if (note?.tags) markTags(fragment);
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

export function MarkdownPreview({ text, projectId, path, finder, codeTools, note, onToggleTask, onTag, onDoubleClick }: {
  text: string; projectId: string; path: string; finder?: FileFinder;
  /** A note's preview (1.0.7): clickable tasks and its saved images. */
  note?: MarkdownNoteOptions;
  onToggleTask?: (index: number, checked: boolean) => void;
  onTag?: (tag: string) => void;
  onDoubleClick?: (e: MouseEvent<HTMLElement>) => void;
  /** Code blocks get a copy button and, once the languages loaded, colours (the note preview). */
  codeTools?: { copyLabel: string };
}) {
  const highlighter = useCodeHighlight(!!codeTools);
  const copyLabel = codeTools?.copyLabel;
  const tasks = note?.tasks;
  const noteImages = note?.noteImages;
  const tags = note?.tags;
  const html = useMemo(() => renderMarkdown(text, copyLabel === undefined ? undefined : { copyLabel, highlight: highlighter?.highlightHtml }, tasks === undefined && !noteImages && !tags ? undefined : { tasks, noteImages, tags }),
    [text, copyLabel, highlighter, tasks, noteImages, tags]);
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const find = usePreviewFind(article, scroller, html);
  useEffect(() => {
    if (!finder) return;
    finder.current = () => find.open();
    return () => { finder.current = null; };
  }, [finder, find.open]);
  useEffect(() => {
    if (!noteImages || !article.current) return;
    let live = true;
    article.current.querySelectorAll<HTMLImageElement>('img[data-note-image]').forEach((image) => {
      void loadNoteImage(image.dataset.noteImage!).then((url) => { if (live && url) image.src = url; else if (live) image.classList.add('missing'); });
    });
    return () => { live = false; };
  }, [html, noteImages]);
  const followLink = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const box = (event.target as Element).closest('input[data-task]') as HTMLInputElement | null;
    if (box) {
      if (event.button === 0) onToggleTask?.(Number(box.dataset.task), box.checked);
      return;
    }
    const chip = (event.target as Element).closest('.md-tag') as HTMLElement | null;
    if (chip) { if (event.button === 0) onTag?.(chip.dataset.tag ?? ''); return; }
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
      <article ref={article} className="markdown-preview" aria-label={path} onClick={followLink} onAuxClick={followLink} onDoubleClick={onDoubleClick}
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
    {find.widget}
  </div>;
}

/** Images of the notes read once per run (a data: URL; null when the file is gone). */
const noteImageCache = new Map<string, Promise<string | null>>();
export function loadNoteImage(name: string): Promise<string | null> {
  let found = noteImageCache.get(name);
  if (!found) { found = window.mc.notes.readImage(name).catch(() => null); noteImageCache.set(name, found); }
  return found;
}
