// Small icons of the host and identity editors, drawn like components/icons.tsx (16px grid, 1.8 stroke).
import type { ReactNode } from 'react';

const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IUser = () => <Svg><circle cx="8" cy="5.5" r="2.7" /><path d="M2.8 13.6c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4" /></Svg>;
export const IPassword = () => <Svg><rect x="1.8" y="4" width="12.4" height="8" rx="2" /><path d="M5 8h.01M8 8h.01M11 8h.01" strokeWidth="2.4" /></Svg>;
export const IEye = () => <Svg><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.8" /></Svg>;
export const IEyeOff = () => <Svg><path d="M6.2 4c.6-.1 1.2-.2 1.8-.2 4 0 6.2 4.2 6.2 4.2s-.6 1.1-1.7 2.2M4.3 5.2C2.7 6.3 1.8 8 1.8 8S4 12.2 8 12.2c1.2 0 2.3-.4 3.2-.9" /><path d="M2.5 2.5l11 11" /></Svg>;
export const IIdentity = () => <Svg><rect x="1.8" y="3" width="12.4" height="10" rx="1.8" /><circle cx="5.8" cy="7.2" r="1.4" /><path d="M3.8 11c.4-1.1 1.1-1.6 2-1.6s1.6.5 2 1.6M9.5 6.5h2.8M9.5 9h2.2" /></Svg>;
