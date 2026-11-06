// SP7: the 1.1.4 side of the russh matrix. Runs under Electron 45 as Node (ELECTRON_RUN_AS_NODE=1, BoringSSL, exactly the
// runtime of the 1.1.4 Pty Host) and uses the real 1.1.4 code: SshLogin (src/sshcore/login.ts: connect options, auth order,
// prompts), mapSshError and KnownHostsStore (src/main/ssh/knownHosts.ts, writes the app's known_hosts.json).
//
//   electron.exe scripts/sp7/ssh2-side.mjs <cases.json>      one JSON line per case on stdout
//
// Case: {kind: "login" | "hostkey", host, port, user, privateKey?, passphrase?, password?, allowPasswordPrompt?,
//        promptAnswer? (password prompt), answers?: string[] (keyboard-interactive), hostKeyAlg? (hostkey only), exec?, knownHostsFile?}
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'package.json'));
const { Client } = require('ssh2');
const C = require('ssh2/lib/protocol/constants');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ SshLogin }, { mapSshError }, { KnownHostsStore }] = await Promise.all([load('src/sshcore/login.ts'), load('src/ptyhost/sshErrors.ts'), load('src/main/ssh/knownHosts.ts')]);

const TIMERS = { authStepMs: 20_000, keepaliveMs: 15_000, keepaliveCountMax: 3 };

function login(c) {
  return new Promise((done) => {
    const start = performance.now();
    const out = { ok: false, methodsSeen: [], prompts: [], ms: {} };
    const client = new Client();
    let finished = false;
    const finish = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      out.ms.total = Math.round(performance.now() - start);
      try { client.end(); } catch { /* closed */ }
      done({ ...out, ...extra });
    };
    const guard = setTimeout(() => finish({ error: 'timeout', code: 'timeout' }), 25_000);
    const req = { id: 'sp7', host: c.host, port: c.port, username: c.user, cols: 80, rows: 24, allowPasswordPrompt: !!c.allowPasswordPrompt,
      ...(c.privateKey ? { privateKey: c.privateKey } : {}), ...(c.passphrase ? { passphrase: c.passphrase } : {}), ...(c.password ? { password: c.password } : {}) };
    let sl;
    const hooks = {
      live: () => !finished, arm() {}, disarm() {}, phase() {},
      hostKey(promptId, keyBase64) { out.hostKey = keyBase64; out.ms.hostKey = Math.round(performance.now() - start); sl.answerHostKey(promptId, true); },
      authPrompt(promptId, prompt) { out.prompts.push(prompt); sl.answerAuth(promptId, prompt.kind === 'password' ? [c.promptAnswer ?? ''] : (c.answers ?? [])); },
    };
    sl = new SshLogin(req, TIMERS, hooks);
    const config = sl.connectConfig();
    const handler = config.authHandler;
    config.authHandler = (methods, partial, next) => {
      out.methodsSeen.push(methods);
      handler(methods, partial, (m) => { out.methodsSeen.push(m && typeof m === 'object' ? `-> ${m.type}` : `-> ${m}`); next(m); });
    };
    client.on('handshake', (n) => { out.names = { kex: n.kex, hostKey: n.serverHostKey, cipher: n.cs.cipher, mac: n.cs.mac, compression: n.cs.compress }; out.ms.kex = Math.round(performance.now() - start); });
    client.on('banner', (b) => { out.banner = b; });
    client.on('ready', () => {
      out.ms.ready = Math.round(performance.now() - start);
      out.authenticated = true;
      if (!c.exec) { out.ok = true; finish(); return; }
      client.exec(c.exec, (err, stream) => {
        if (err) { finish({ error: String(err.message) }); return; }
        let stdout = '';
        let exitStatus = null;
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.on('exit', (code) => { exitStatus = code; });
        stream.on('close', () => { out.ok = true; finish({ exec: { stdout, exitStatus } }); });
      });
    });
    out.events = [];
    client.on('error', (err) => { out.events.push(`error ${err.level ?? ''} ${err.message}`); finish({ error: String(err.message), level: err.level, code: mapSshError(err, sl.override) }); });
    client.on('end', () => out.events.push('end'));
    // 'error' may come right after 'close': give it a moment so the session ends with the code 1.1.4 would show.
    client.on('close', () => out.events.push('close'));
    client.on('close', () => setTimeout(() => finish({ error: out.authenticated ? undefined : 'closed', code: out.authenticated ? undefined : mapSshError(undefined, sl.override) }), 100));
    client.connect(config);
  });
}

/** The host key the server presents for one forced algorithm, trusted into a 1.1.4 KnownHostsStore (the app's own file). */
function hostkey(c) {
  return new Promise((done) => {
    const client = new Client();
    let finished = false;
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(guard); try { client.end(); } catch { /* closed */ } done(r); };
    const guard = setTimeout(() => finish({ ok: false, error: 'timeout' }), 20_000);
    client.on('error', (err) => finish({ ok: false, error: String(err.message), level: err.level }));
    client.on('close', () => finish({ ok: false, error: 'closed' }));
    client.connect({
      // Only this host key algorithm, and everything ssh2 supports otherwise, so legacy servers show their keys too.
      host: c.host, port: c.port, username: c.user, readyTimeout: 0,
      algorithms: { serverHostKey: [c.hostKeyAlg], kex: C.SUPPORTED_KEX, cipher: C.SUPPORTED_CIPHER, hmac: C.SUPPORTED_MAC },
      hostVerifier: (key, verify) => {
        const store = new KnownHostsStore(c.knownHostsFile);
        const judged = store.judge(c.host, c.port, key);
        const trusted = store.trust(c.host, c.port, key, 'save');
        finish({ ok: true, base64: key.toString('base64'), keyType: judged.keyType, fingerprint: judged.fingerprint, trusted });
        verify(false);
      },
    });
  });
}

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const c of cases) {
  const r = c.kind === 'hostkey' ? await hostkey(c) : await login(c);
  process.stdout.write(`${JSON.stringify({ id: c.id, ...r })}\n`);
}
process.exit(0);
