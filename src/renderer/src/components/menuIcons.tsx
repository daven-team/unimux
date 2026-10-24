// Menu icons (1.0.7) the other sets do not have, drawn like components/icons.tsx (16px grid, 1.8 stroke, 14px).
import type { ReactNode } from 'react';

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const ICopy = () => <Svg><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></Svg>;
export const IDuplicate = () => <Svg><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5M9.5 7.8v3.4M7.8 9.5h3.4" /></Svg>;
export const IScissors = () => <Svg><circle cx="4.5" cy="11.5" r="2" /><circle cx="11.5" cy="11.5" r="2" /><path d="M6 10 12.5 2.5M10 10 3.5 2.5" /></Svg>;
export const ITrash = () => <Svg><path d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" /></Svg>;
export const IMoveUp = () => <Svg><path d="M8 13V3.5M4 7.5l4-4 4 4" /></Svg>;
export const IMoveDown = () => <Svg><path d="M8 3v9.5M4 8.5l4 4 4-4" /></Svg>;
export const IRefresh = () => <Svg><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" /></Svg>;
/** Open in the code editor (Cursor, VS Code). */
export const ICodeEditor = () => <Svg><rect x="2" y="2.5" width="12" height="11" rx="1.6" /><path d="M6.5 6.5 4.8 8.2l1.7 1.7M9.5 6.5l1.7 1.7-1.7 1.7" /></Svg>;
/** A panel width brought back to its default. */
export const IWidth = () => <Svg><path d="M2.5 3v10M13.5 3v10M5 8h6M6.5 6 5 8l1.5 2M9.5 6 11 8l-1.5 2" /></Svg>;
export const IEyeOff = () => <Svg><path d="M6.2 4c.6-.1 1.2-.2 1.8-.2 4 0 6.2 4.2 6.2 4.2s-.6 1.1-1.7 2.2M4.1 5.1C2.6 6.2 1.8 8 1.8 8s2.2 4.2 6.2 4.2c1.3 0 2.4-.4 3.3-1M2.5 2.5l11 11" /></Svg>;
export const IEye = () => <Svg><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.8" /></Svg>;
export const IPaste = () => <Svg><rect x="3.5" y="3" width="9" height="11" rx="1.5" /><path d="M6 3V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V3M6 7.5h4M6 10.5h2.5" /></Svg>;
export const ICommit = () => <Svg><circle cx="8" cy="8" r="2.5" /><path d="M1.5 8h4M10.5 8h4" /></Svg>;
export const IDiff = () => <Svg><path d="M5 2.5v6M2 5.5h6M2.5 12h5.5" /><rect x="9.5" y="2.5" width="4" height="11" rx="1" /></Svg>;
export const IUndo = () => <Svg><path d="M3 6.5h7a3.5 3.5 0 0 1 0 7H6M5.5 4 3 6.5 5.5 9" /></Svg>;
