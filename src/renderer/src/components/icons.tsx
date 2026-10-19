import type { ReactNode } from 'react';
import brandIcon from '../../../../resources/icon-64.png';

const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const ICheck = () => <Svg><path d="M3 8.5l3.2 3.2L13 4.8" /></Svg>;
export const IPlus = () => <Svg><path d="M8 3v10M3 8h10" /></Svg>;
export const IX = () => <Svg size={12}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
export const IMax = () => <Svg size={12}><rect x="3" y="3" width="10" height="10" rx="1.5" /></Svg>;
export const IRestore = () => <Svg size={12}><rect x="3" y="5" width="8" height="8" rx="1.5" /><path d="M6 3h6.5A.5.5 0 0 1 13 3.5V10" /></Svg>;
export const IRestart = () => <Svg size={12}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" /></Svg>;
export const IGrid = () => <Svg><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></Svg>;
export const IHistory = () => <Svg><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 3v2.5H5" /><path d="M8 5.5V8l2 1.5" /></Svg>;
export const ISettings = () => <Svg><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></Svg>;
export const IFolder = () => <Svg><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></Svg>;
export const IFile = () => <Svg><path d="M9.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" /><path d="M9 2v4h4M5.5 9h5M5.5 11.5h3" /></Svg>;
export const ICollapse = () => <Svg><rect x="2" y="5" width="9" height="9" rx="1.5" /><path d="M5 2h8a1 1 0 0 1 1 1v8M4.5 9.5h4" /></Svg>;
export const IGrip = () => <Svg size={12}><path d="M5 4h.01M10 4h.01M5 8h.01M10 8h.01M5 12h.01M10 12h.01" strokeWidth="2.5" /></Svg>;
export const ISnippet = () => <Svg><path d="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4M9.5 3l-3 10" /></Svg>;
export const ISidebar = () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></Svg>;
export const ICollapseAll = () => <Svg><path d="M4 3.5l4 3.5 4-3.5M4 12.5L8 9l4 3.5" /></Svg>;
export const IExpandAll = () => <Svg><path d="M4 7l4-3.5L12 7M4 9l4 3.5L12 9" /></Svg>;
export const ISearch = () => <Svg><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></Svg>;
export const IEdit = () => <Svg size={12}><path d="M10.5 2.5l3 3L6 13H3v-3z" /></Svg>;
export const IBranch = () => <Svg size={11}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></Svg>;
export const IChangelog = () => <Svg><path d="M3 3.5h10M3 8h10M3 12.5h6" /><path d="M12 10.5v4M10 12.5h4" /></Svg>;
export const ICloud = () => <Svg size={12}><path d="M4.5 12.5a3 3 0 0 1-.4-5.97 4 4 0 0 1 7.7 1.07A2.5 2.5 0 0 1 11.5 12.5z" /></Svg>;
export const ITag = () => <Svg size={11}><path d="M8.6 2H13a1 1 0 0 1 1 1v4.4a1 1 0 0 1-.3.7l-5.6 5.6a1 1 0 0 1-1.4 0L2.3 9.3a1 1 0 0 1 0-1.4l5.6-5.6a1 1 0 0 1 .7-.3z" /><path d="M11 5h.01" /></Svg>;
export const IMore = () => <Svg><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.6" /></Svg>;
export const IServer = () => <Svg><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" /><rect x="2.5" y="9" width="11" height="4.5" rx="1.2" /><path d="M5 4.75h.01M5 11.25h.01" strokeWidth="2" /></Svg>;
export const IKey = () => <Svg><circle cx="5.5" cy="10.5" r="3" /><path d="M7.6 8.4 13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2" /></Svg>;
export const IShield = () => <Svg><path d="M8 1.8 13 3.8v3.8c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6V3.8z" /><path d="m5.8 8 1.6 1.6 2.9-3" /></Svg>;
export const IChevron = () => <Svg size={10}><path d="M4 6l4 4 4-4" /></Svg>;
// SFTP view (0.9.8): path bar and transfers.
export const IArrowLeft = () => <Svg><path d="M13 8H3M7 4L3 8l4 4" /></Svg>;
export const IArrowRight = () => <Svg><path d="M3 8h10M9 4l4 4-4 4" /></Svg>;
export const IArrowUp = () => <Svg><path d="M8 13V3M4 7l4-4 4 4" /></Svg>;
export const IUpload = () => <Svg><path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></Svg>;
export const IDownload = () => <Svg><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></Svg>;
export const IHome = () => <Svg><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" /></Svg>;
export const IDrive = () => <Svg><rect x="2" y="5" width="12" height="6" rx="1.5" /><path d="M11 8h.01" strokeWidth="2.4" /></Svg>;
export const ILink = () => <Svg size={10}><path d="M6.5 9.5l3-3M5 8l-1.5 1.5a2.1 2.1 0 0 0 3 3L8 11M11 8l1.5-1.5a2.1 2.1 0 0 0-3-3L8 5" /></Svg>;

/** Supplied brand artwork, shared with the installer and update splash. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <img src={brandIcon} width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ flex: 'none', display: 'block', objectFit: 'contain' }} />
  );
}

// Toolbar icons drawn on a 24px grid (crisp at 18px).
const T = ({ children }: { children: ReactNode }) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
export const TGrid = () => (
  <T>
    <rect width="7" height="7" x="3" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="3" rx="1.5" />
    <rect width="7" height="7" x="14" y="14" rx="1.5" /><rect width="7" height="7" x="3" y="14" rx="1.5" />
  </T>
);
export const TPlus = () => <T><path d="M12 5v14M5 12h14" /></T>;
export const THistory = () => (
  <T><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></T>
);
export const TProjects = () => (
  <T><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></T>
);
export const TFiles = () => (
  <T><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M8 13h8M8 17h5" /></T>
);
/** Familiar source-control branch mark. */
export const TGit = () => (
  <T><circle cx="6" cy="4" r="2" /><circle cx="6" cy="20" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 6v12M18 10c0 6-12 3-12 8" /></T>
);
/** A terminal prompt. */
export const TTerminal = () => <T><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></T>;
export const TSnippet = () => <T><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></T>;
export const TSidebar = () => <T><rect width="18" height="18" x="3" y="3" rx="2.5" /><path d="M9 3v18" /></T>;
export const TSettings = () => (
  <T>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </T>
);

/** Compact, bold plus for pill buttons. */
export const IPlusBold = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
