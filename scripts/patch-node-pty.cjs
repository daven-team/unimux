// Gives node-pty's ConPTY output Worker (one per Windows terminal) small V8 heap reservations and an error listener.
// The worker only pipes a named pipe into a socket, yet with the default limits each one costs about 14 MB of the Pty Host;
// the saving comes from the small young generation and code range (node-pty 1.1.0, 10 terminals: about 13.9 -> 10 MB each;
// 5 terminals flooding 385 MB peaked at 4.6 MB of worker heap). The old generation cap is generous (64 MB) so a flood can
// never reach it. Should the worker still fail, the listener names the cause in the Pty Host's log (node-pty has none, so the
// error would surface as an anonymous uncaught exception); the dead worker closes its pipe, node-pty reports the terminal's
// exit and the cell shows it as ended instead of freezing. Nothing is killed from the listener (the ClosePseudoConsole
// deadlock the worker exists to avoid).
// Runs at install time (postinstall), so the packaged app carries the patched file; idempotent (an older patch is replaced);
// fails loudly when node-pty's code no longer has the expected text (an upgrade: check and adapt).
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const MARKER = '/* unimux: conout worker resourceLimits */';
const ERROR_MARKER = '/* unimux: conout worker error */';
/** The Worker statement of node-pty 1.1.0, unpatched. */
const TARGET = "this._worker = new worker_threads_1.Worker(path_1.join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData: workerData });";
/** Young 1 MB, old 64 MB, code 4 MB, stack 1 MB. */
const LIMITS = 'resourceLimits: { maxYoungGenerationSizeMb: 1, maxOldGenerationSizeMb: 64, codeRangeSizeMb: 4, stackSizeMb: 1 }';
const ON_ERROR = `this._worker.on('error', function (e) { console.error('unimux: conout worker failed', e); }); ${ERROR_MARKER}`;
const PATCHED = `${TARGET.replace('{ workerData: workerData }', `{ workerData: workerData, ${MARKER} ${LIMITS} }`)} ${ON_ERROR}`;

/** Removes any earlier version of this patch (limits and error listener), giving node-pty's own text back. */
function unpatch(source) {
  return source
    .replace(/, \/\* unimux: conout worker resourceLimits \*\/ resourceLimits: \{[^}]*\} \}/g, ' }')
    .replace(/ this\._worker\.on\('error', [^\n]*?\/\* unimux: conout worker error \*\//g, '');
}

/** The patched source (the same text when it is current already); throws when the Worker statement is not found exactly once. */
function patchSource(source) {
  const original = unpatch(source);
  const at = original.indexOf(TARGET);
  if (at < 0 || original.indexOf(TARGET, at + 1) >= 0) {
    throw new Error(`node-pty windowsConoutConnection.js: expected exactly one "${TARGET}" (node-pty changed; update scripts/patch-node-pty.cjs)`);
  }
  return original.slice(0, at) + PATCHED + original.slice(at + TARGET.length);
}

/** The current version of the patch is in place: limits and error listener. */
const isPatched = (source) => source.includes(PATCHED);

function patchModule(moduleRoot) {
  const file = join(moduleRoot, 'lib', 'windowsConoutConnection.js');
  const source = readFileSync(file, 'utf8');
  const patched = patchSource(source);
  if (patched !== source) writeFileSync(file, patched);
  return { file, changed: patched !== source };
}

module.exports = { MARKER, ERROR_MARKER, LIMITS, PATCHED, patchSource, isPatched, patchModule };

if (require.main === module) {
  const { file, changed } = patchModule(dirname(require.resolve('node-pty/package.json')));
  console.log(`${changed ? 'patched' : 'already patched'}: ${file}`);
}
