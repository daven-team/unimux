import { useMemo, type MouseEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { openFile } from '../files';
import './markdown.css';

export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

export function externalMarkdownUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function renderMarkdown(text: string): string {
  // Marked parses Markdown; DOMPurify is the boundary for untrusted file HTML.
  const fragment = DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 's', 'a', 'img',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'details', 'summary', 'kbd', 'sup', 'sub'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
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

export function MarkdownPreview({ text, projectId, path }: { text: string; projectId: string; path: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const followLink = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
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
  return <div className="markdown-preview-scroll" tabIndex={0}>
    <article className="markdown-preview" aria-label={path} onClick={followLink} onAuxClick={followLink}
      dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}
