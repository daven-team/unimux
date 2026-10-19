// Gives node-pty's ConPTY output Worker (one per Windows terminal) small V8 heap limits. The worker only pipes a named pipe
// into a socket, yet with the default limits each one costs about 14 MB of the Pty Host; with these about 3.9 MB less
// (node-pty 1.1.0, 10 terminals: 13.9 -> 10.1 MB each; 5 terminals flooding 385 MB peaked at 4.6 MB of worker heap).
// Runs at install time (postinstall), so the packaged app carries the patched file; idempotent (an older patch is updated);
// fails loudly when node-pty's code no longer has the expected text (an upgrade: check and adapt).
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const MARKER = '/* unimux: conout worker resourceLimits */';
const TARGET = '{ workerData: workerData }';
/** Young 1 MB, old 16 MB, code 4 MB, stack 1 MB: plenty for a stream pipe (a flood keeps its heap under 5 MB). */
const LIMITS = 'resourceLimits: { maxYoungGenerationSizeMb: 1, maxOldGenerationSizeMb: 16, codeRangeSizeMb: 4, stackSizeMb: 1 }';
const PATCHED = `{ workerData: workerData, ${MARKER} ${LIMITS} }`;

/** The patched source, the same source when it is patched already; throws when the Worker call is not found exactly once. */
function patchSource(source) {
  const earlier = /\/\* unimux: conout worker resourceLimits \*\/ resourceLimits: \{[^}]*\}/;
  if (earlier.test(source)) return source.replace(earlier, `${MARKER} ${LIMITS}`);
  const at = source.indexOf(TARGET);
  if (at < 0 || source.indexOf(TARGET, at + 1) >= 0) {
    throw new Error(`node-pty windowsConoutConnection.js: expected exactly one "${TARGET}" (node-pty changed; update scripts/patch-node-pty.cjs)`);
  }
  return source.slice(0, at) + PATCHED + source.slice(at + TARGET.length);
}

const isPatched = (source) => source.includes(MARKER) && source.includes(LIMITS);

function patchModule(moduleRoot) {
  const file = join(moduleRoot, 'lib', 'windowsConoutConnection.js');
  const source = readFileSync(file, 'utf8');
  const patched = patchSource(source);
  if (patched !== source) writeFileSync(file, patched);
  return { file, changed: patched !== source };
}

module.exports = { MARKER, LIMITS, patchSource, isPatched, patchModule };

if (require.main === module) {
  const { file, changed } = patchModule(dirname(require.resolve('node-pty/package.json')));
  console.log(`${changed ? 'patched' : 'already patched'}: ${file}`);
}
