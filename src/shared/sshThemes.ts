// Colour themes of SSH terminals (Settings > SSH, and per host): the registry, validation and which theme a cell draws with.
// Local shells and agent cells always keep the app look (THEME in TerminalManager.ts). No Node, DOM or xterm imports: the
// palette has the shape of xterm's ITheme, so the renderer hands it to `term.options.theme` as it is.

/** The xterm colours of one theme (`#rrggbb`, or `#rrggbbaa` for the selection). */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  /** Text colour inside the selection; without it selected text keeps its own colour. */
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The 16 ANSI colours, in the order of their SGR codes (30-37, then 90-97). */
export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies ReadonlyArray<keyof TerminalPalette>;

/** Stored in the settings and on hosts: never rename an id (a saved one that is no longer known reads as the default). */
export const SSH_THEME_IDS = [
  'unimux-dark', 'unimux-midnight', 'unimux-cyberpunk', 'unimux-fjord', 'unimux-lagoon', 'unimux-nightshade', 'unimux-daylight',
] as const;
export type SshThemeId = (typeof SSH_THEME_IDS)[number];

export interface SshTheme {
  id: SshThemeId;
  /** A product name, the same in every language. */
  name: string;
  colors: TerminalPalette;
  /**
   * xterm's `minimumContrastRatio` while the theme is on (1, xterm's default, when missing): at draw time every text colour
   * is darkened or lightened until it reaches this contrast with the cell behind it. A light theme needs it because its
   * `white` and `brightWhite` stay light (programs paint backgrounds with them), so text in them would vanish on the paper.
   */
  minimumContrastRatio?: number;
}

export const DEFAULT_SSH_THEME: SshThemeId = 'unimux-dark';

/** The value of a host's theme choice that follows Settings > SSH (never stored: such a host has no `theme`). */
export const FOLLOW_GLOBAL_THEME = 'default';

export const SSH_THEMES: readonly SshTheme[] = [
  {
    // The look every terminal had before themes (Campbell on the app background): the default.
    id: 'unimux-dark', name: 'Unimux Dark', colors: {
      background: '#0d0d0d', foreground: '#cccccc', cursor: '#cccccc', cursorAccent: '#0d0d0d',
      selectionBackground: '#264f78', selectionInactiveBackground: '#264f7880',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
  },
  {
    // Deep navy with soft pastels.
    id: 'unimux-midnight', name: 'Unimux Midnight', colors: {
      background: '#0f1424', foreground: '#d3dae8', cursor: '#5ab0ff', cursorAccent: '#0f1424',
      selectionBackground: '#2b3d63', selectionInactiveBackground: '#2b3d6380',
      black: '#1a2035', red: '#ff6b81', green: '#6fdc8c', yellow: '#f6c869', blue: '#5aa9ff', magenta: '#c49bff', cyan: '#45d4e6', white: '#c5cde0',
      brightBlack: '#6a7594', brightRed: '#ff8fa0', brightGreen: '#97ecae', brightYellow: '#ffdd8f', brightBlue: '#8cc4ff', brightMagenta: '#d8bdff', brightCyan: '#7fe6f2', brightWhite: '#f3f6fc',
    },
  },
  {
    // Near-black with hot pink text, scarlet red, a neon cyan cursor and acid yellow (the text stays lighter than red, so
    // errors and deleted lines still stand out).
    id: 'unimux-cyberpunk', name: 'Unimux Cyberpunk', colors: {
      background: '#140b12', foreground: '#ff9cbd', cursor: '#00f0d0', cursorAccent: '#140b12',
      selectionBackground: '#5c1a3a', selectionInactiveBackground: '#5c1a3a80', selectionForeground: '#ffe9f1',
      black: '#24121f', red: '#ff2e4d', green: '#21e6a1', yellow: '#ffe347', blue: '#2ab3ff', magenta: '#ff47d1', cyan: '#00f0d0', white: '#f5d0de',
      brightBlack: '#8a5a7c', brightRed: '#ff5c5c', brightGreen: '#66ffc4', brightYellow: '#fff27a', brightBlue: '#6fd0ff', brightMagenta: '#ff85e3', brightCyan: '#6bfff0', brightWhite: '#ffffff',
    },
  },
  {
    // Cool arctic slate with frosted blues.
    id: 'unimux-fjord', name: 'Unimux Fjord', colors: {
      background: '#2b303b', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2b303b',
      selectionBackground: '#465065', selectionInactiveBackground: '#46506599',
      black: '#3b4252', red: '#e0787f', green: '#a3be8c', yellow: '#ebcb8b', blue: '#88a8cc', magenta: '#c29bbb', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#7b88a1', brightRed: '#eb939a', brightGreen: '#b8d1a2', brightYellow: '#f2d9a6', brightBlue: '#a3bfde', brightMagenta: '#d3b3cd', brightCyan: '#a3d3df', brightWhite: '#eceff4',
    },
  },
  {
    // Deep teal water with warm, muted accents.
    id: 'unimux-lagoon', name: 'Unimux Lagoon', colors: {
      background: '#002b36', foreground: '#a3b3b3', cursor: '#d0c9b0', cursorAccent: '#002b36',
      selectionBackground: '#0b4a5a', selectionInactiveBackground: '#0b4a5a80',
      black: '#073642', red: '#f0504c', green: '#9ab31a', yellow: '#cf9f17', blue: '#3d9be0', magenta: '#e2508f', cyan: '#2fb3a8', white: '#eee8d5',
      brightBlack: '#6f878f', brightRed: '#ff7a73', brightGreen: '#b5cf3a', brightYellow: '#e6b83a', brightBlue: '#66b4ee', brightMagenta: '#f07aaf', brightCyan: '#54cfc4', brightWhite: '#fdf6e3',
    },
  },
  {
    // Dusky violet with candy-coloured accents.
    id: 'unimux-nightshade', name: 'Unimux Nightshade', colors: {
      background: '#272935', foreground: '#f6f6ef', cursor: '#f6f6ef', cursorAccent: '#272935',
      selectionBackground: '#44475a', selectionInactiveBackground: '#44475a99',
      black: '#21222c', red: '#ff5c57', green: '#5af78e', yellow: '#f3f99d', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f6f6ef',
      brightBlack: '#7282b5', brightRed: '#ff7a74', brightGreen: '#7dfaa5', brightYellow: '#f7fbb6', brightBlue: '#cfacfb', brightMagenta: '#ff97d4', brightCyan: '#a4effd', brightWhite: '#ffffff',
    },
  },
  {
    // A light theme: ink on warm paper; `white` stays light grey (programs use it as a background), and the contrast floor
    // keeps text printed in white or bright white readable.
    id: 'unimux-daylight', name: 'Unimux Daylight', minimumContrastRatio: 4.5, colors: {
      background: '#fafaf7', foreground: '#2a2f38', cursor: '#2a2f38', cursorAccent: '#fafaf7',
      selectionBackground: '#cfe0f7', selectionInactiveBackground: '#cfe0f799',
      black: '#2a2f38', red: '#c8293d', green: '#26803c', yellow: '#8f6200', blue: '#1f5fc4', magenta: '#9333b3', cyan: '#0d7a89', white: '#b9bcc2',
      brightBlack: '#666d7a', brightRed: '#d63a52', brightGreen: '#2b8a43', brightYellow: '#996b00', brightBlue: '#2f6fd6', brightMagenta: '#a145c2', brightCyan: '#0f8798', brightWhite: '#e8e9ec',
    },
  },
];

export const isSshThemeId = (value: unknown): value is SshThemeId => typeof value === 'string' && (SSH_THEME_IDS as readonly string[]).includes(value);

/** A saved global choice: an unknown or missing id reads as the default. */
export const normalizeSshThemeId = (value: unknown): SshThemeId => (isSshThemeId(value) ? value : DEFAULT_SSH_THEME);

export const sshThemeById = (id: unknown): SshTheme => SSH_THEMES.find((t) => t.id === id) ?? SSH_THEMES.find((t) => t.id === DEFAULT_SSH_THEME)!;

/** The theme an SSH cell draws with: the host's own choice, else the one of Settings > SSH, else the default. */
export const resolveSshTheme = (hostTheme: unknown, globalTheme: unknown): SshTheme =>
  sshThemeById(isSshThemeId(hostTheme) ? hostTheme : normalizeSshThemeId(globalTheme));

/** The value of a host's theme picker: a theme id, or FOLLOW_GLOBAL_THEME; what it stores on the host (undefined = follow). */
export const hostThemeValue = (theme: string | undefined): string => (isSshThemeId(theme) ? theme : FOLLOW_GLOBAL_THEME);
export const hostThemeFromValue = (value: string): SshThemeId | undefined => (isSshThemeId(value) ? value : undefined);
