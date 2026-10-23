// Icons of the detached windows (1.0.6): a tab going out into its own window, and coming back in.
const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
/** A window with an arrow leaving it (move to a new window). */
export const IPopOut = () => <Svg><path d="M9.5 2.5h4v4M13.5 2.5 8 8" /><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></Svg>;
/** An arrow going into a window (attach back). */
export const IAttachBack = () => <Svg><path d="M2.5 13.5 8 8M8 12V8H4" /><path d="M6.5 2.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1.5" /></Svg>;
