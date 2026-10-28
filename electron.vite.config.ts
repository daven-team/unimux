import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { splitMessages } from './electron.vite.messages';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: process.env.MC_NOMINIFY ? false : 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          ptyhost: resolve(__dirname, 'src/ptyhost/index.ts'),
          sftphost: resolve(__dirname, 'src/sftphost/index.ts'),
          dbhost: resolve(__dirname, 'src/dbhost/index.ts'),
          // The SQLite engine thread of the DB Host (built-in modules only: it is run as an eval'd worker).
          sqliteworker: resolve(__dirname, 'src/dbhost/sqliteWorker.ts'),
          updatesplash: resolve(__dirname, 'src/updatesplash/index.ts'),
          // The conversation search thread (1.0.9): run as an eval'd worker as well, so main imports only its types.
          convsearch: resolve(__dirname, 'src/convsearch/worker.ts'),
        },
        // Lazy dependencies (MCP SDK, electron-updater) stay `require` behind a promise: the CommonJS builds they ship are loaded,
        // never a second ESM copy through import().
        output: { dynamicImportInCjs: false },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          updatesplash: resolve(__dirname, 'src/updatesplash/preload.ts'),
        },
      },
    },
  },
  renderer: {
    // splitMessages: each language's translations are a chunk of their own, only the active one is loaded.
    plugins: [react(), splitMessages()],
    // The renderer used to ship unminified (2.2 MB for the main chunk, 1.5 MB for the editor): minified it loads and parses much faster.
    build: { minify: process.env.MC_NOMINIFY ? false : 'esbuild', cssMinify: true },
  },
});
