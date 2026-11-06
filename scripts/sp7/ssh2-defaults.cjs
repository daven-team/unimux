// SP7: the algorithm lists ssh2 1.17 offers in the runtime it runs in (1.1.4: Electron's Node with BoringSSL, where the
// cipher and MAC lists are filtered by crypto.getCiphers / getHashes). Run under Electron with ELECTRON_RUN_AS_NODE=1:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/sp7/ssh2-defaults.cjs
const path = require('node:path');
const c = require(path.resolve(__dirname, '../../node_modules/ssh2/lib/protocol/constants'));
const keys = ['DEFAULT_KEX', 'DEFAULT_SERVER_HOST_KEY', 'DEFAULT_CIPHER', 'DEFAULT_MAC', 'DEFAULT_COMPRESSION', 'SUPPORTED_KEX', 'SUPPORTED_CIPHER', 'SUPPORTED_MAC'];
const out = { runtime: { electron: process.versions.electron ?? null, node: process.versions.node, openssl: process.versions.openssl, arch: process.arch } };
for (const k of keys) out[k] = c[k];
console.log(JSON.stringify(out, null, 1));
