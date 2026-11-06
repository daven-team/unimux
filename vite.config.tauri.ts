// The renderer build of the Tauri app (1.2.0). Lives next to electron.vite.config.ts until the Electron build is removed (R1):
// the same React UI from src/renderer, with
// - window.mc over Tauri (src/renderer/src/bridge/mc.ts) loaded BEFORE the app, like the Electron preload: in the build it is
//   bundled on its own as a classic script (`mc-bridge.js`, run synchronously in <head>); inside the app bundle the bundler
//   may evaluate hoisted shared chunks before any entry code, and several modules read window.mc at load time. The dev server
//   serves unbundled modules, so there it is a module script in front of main.tsx;
// - the meta CSP removed (Tauri applies `app.security.csp` from tauri.conf.json and adds its IPC sources);
// - the update splash page (resources/update-splash) copied in for the update windows;
// - output in out/tauri-renderer (frontendDist), dev server on 5174 (devUrl).
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { splitMessages } from './electron.vite.messages';

const outDir = resolve(__dirname, 'out/tauri-renderer');
const BRIDGE_ENTRY = resolve(__dirname, 'src/renderer/src/bridge/mc.ts');
const BRIDGE_FILE = 'mc-bridge.js';
const MAIN_SCRIPT = '<script type="module" src="/src/main.tsx"></script>';

function tauriBridge(): Plugin {
  let command: 'build' | 'serve' = 'build';
  return {
    name: 'mc-tauri-bridge',
    configResolved(config) { command = config.command; },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(MAIN_SCRIPT)) throw new Error('vite.config.tauri.ts: the entry script of index.html was not found');
        const bridge = command === 'build' ? `<script src="/${BRIDGE_FILE}"></script>` : '<script type="module" src="/src/bridge/mc.ts"></script>';
        return html
          .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
          .replace('</head>', `    ${bridge}\n  </head>`);
      },
    },
    async generateBundle() {
      const bundle = await rolldown({ input: BRIDGE_ENTRY, platform: 'browser', logLevel: 'silent' });
      const { output } = await bundle.generate({ format: 'iife', minify: !process.env.MC_NOMINIFY });
      await bundle.close();
      this.emitFile({ type: 'asset', fileName: BRIDGE_FILE, source: output[0].code });
    },
  };
}

function updateSplash(): Plugin {
  return {
    name: 'mc-update-splash',
    apply: 'build',
    closeBundle() {
      cpSync(resolve(__dirname, 'resources/update-splash'), resolve(outDir, 'update-splash'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), splitMessages(), tauriBridge(), updateSplash()],
  clearScreen: false,
  server: { port: 5174, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_'],
  build: {
    outDir,
    emptyOutDir: true,
    minify: process.env.MC_NOMINIFY ? false : 'oxc',
    cssMinify: true,
    // WebView2 (Chromium 156) and WKWebView of macOS 12+.
    target: ['chrome120', 'safari15'],
  },
});
