// Icons of the Notes panel and the note tab (1.0.7), drawn like the others in icons.tsx (16 px grid, round strokes).
import type { ReactNode } from 'react';

const Svg = ({ children, size = 14, fill = false }: { children: ReactNode; size?: number; fill?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** A push pin; `on` fills its head. */
export const IPin = ({ on = false, size = 13 }: { on?: boolean; size?: number }) => (
  <Svg size={size}>
    <path d="M6 2.5h4l-.6 3.6 2.1 2.4H4.5l2.1-2.4z" fill={on ? 'currentColor' : 'none'} />
    <path d="M8 8.5v5" />
  </Svg>
);
export const ISort = () => <Svg><path d="M4.5 3v10M2.5 11l2 2 2-2M9 4h4.5M9 8h3.2M9 12h2" /></Svg>;
export const IChecklist = ({ size = 12 }: { size?: number }) => <Svg size={size}><path d="M2.5 4l1.3 1.3L6 3M2.5 10l1.3 1.3L6 9M8.5 4.5h5M8.5 10.5h5" /></Svg>;
export const IOpenTab = () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.6" /><path d="M2 6h12M9 9.5l2-2M8.5 7.5h2.5V10" /></Svg>;
export const IPanelRight = () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.6" /><path d="M10 3v10" /></Svg>;
export const ICalendar = () => <Svg><rect x="2.5" y="3.5" width="11" height="10" rx="1.6" /><path d="M2.5 7h11M5.5 2v3M10.5 2v3" /></Svg>;
export const IPeople = () => <Svg><circle cx="6" cy="6" r="2.2" /><path d="M2 13c.4-2.2 2-3.4 4-3.4s3.6 1.2 4 3.4M10.5 4.2a2 2 0 0 1 0 3.8M12 9.8c1 .5 1.8 1.6 2 3.2" /></Svg>;
export const INoteBlank = () => <Svg><path d="M4 2h5.5L12.5 5v8.5a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-11A.5.5 0 0 1 4 2z" /><path d="M9.5 2v3h3" /></Svg>;
export const ICapture = () => <Svg><path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2M5.5 8h5M8 5.5v5" /></Svg>;
export const IImport = () => <Svg><path d="M8 2.5v7M5 6.5l3 3 3-3M3 11v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V11" /></Svg>;
export const IHash = ({ size = 11 }: { size?: number }) => <Svg size={size}><path d="M6 2.5l-1.5 11M11.5 2.5l-1.5 11M3 6h10.5M2.5 10H13" /></Svg>;
