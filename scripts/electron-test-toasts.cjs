// Electron target of the real-app harness (scripts/real-app.mjs spawnApp): loaded into the main process with
// NODE_OPTIONS=--require before the app's own code, so an OS notification of a check never reaches the desktop, not even one
// shown before the script's main inspector is attached. The notifications land in globalThis.__shown, which mainControl's
// toasts() / toastClick() / toastAction() read (the Tauri check build does the same with MC_TEST_TOASTS=1, see W4).
// NODE_OPTIONS is put back to what the script had (MC_TEST_TOASTS_NODE_OPTIONS), so the terminals, agents and hosts the app
// starts see the same environment as without the harness.
if (process.env.MC_TEST_TOASTS_NODE_OPTIONS !== undefined) {
  if (process.env.MC_TEST_TOASTS_NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.MC_TEST_TOASTS_NODE_OPTIONS;
  else delete process.env.NODE_OPTIONS;
  delete process.env.MC_TEST_TOASTS_NODE_OPTIONS;
}
if (process.type === 'browser') {
  globalThis.__shown ??= [];
  // While preload modules load, `require('electron')` is not Electron's API yet: patch it the first time the app's own code
  // gets it (long before `ready`, the earliest a Notification can be shown).
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    const result = load.call(this, request, ...rest);
    if (request === 'electron' && result?.Notification && !globalThis.__testToasts) {
      result.Notification.prototype.show = function show() { globalThis.__shown.push(this); };
      globalThis.__testToasts = true;
      Module._load = load;
    }
    return result;
  };
}
