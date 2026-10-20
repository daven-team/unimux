// The empty state of a side panel, the way Cursor draws them: short sentences at the top of the panel (not centred, no big
// icon), an action that fits a sentence as a link inside it, the main action as a full-width primary button.
import { Fragment, type HTMLAttributes, type ReactNode } from 'react';
import './panelEmpty.css';

/** Holds the paragraphs (`<p>`) and the button (`btn primary`, stretched to the panel width) of an empty panel. */
export function PanelEmpty({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`panel-empty ${className ?? ''}`} {...rest}>{children}</div>;
}

/**
 * An action inside a sentence, drawn as a link: reached with Tab, run with a click, Enter or Space. An inline element (not a
 * <button>, which never breaks) so a long link wraps with the sentence; no href, so nothing can open it as a page.
 * `label` names it when the text alone is too short.
 */
export function EmptyLink({ onClick, label, children }: { onClick: () => void; label?: string; children: ReactNode }) {
  return (
    <a className="panel-empty-link" role="button" tabIndex={0} title={label} aria-label={label} onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>{children}</a>
  );
}

/** A translated sentence with elements put at its {name} tokens, so a link stays where each language places it. */
export function fillTokens(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).filter(Boolean).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={i}>{name !== undefined && Object.hasOwn(parts, name) ? parts[name] : piece}</Fragment>;
  });
}
