// Server side of the SSH typing latency bench (test/ssh-latency.bench.test.ts), run in a child process of its own so the
// load the bench puts on the Pty Host's event loop never slows the "remote" end down. 127.0.0.1 only, user alice, no
// credentials ("none" method), a fresh host key on every start.
// - The shell echoes every typed character like a line editor. mode "split" also redraws `splitMs` later (zsh with
//   syntax highlighting / autosuggestions, fish): the echo reaches the client as two SSH packets.
// - A TCP proxy in front of the server delays each direction by half of `rttMs` (an emulated network round trip).
// - The server offers OpenSSH 9's default cipher and MAC order unless `ciphers` is given, so the client's preference decides
//   what is negotiated, as against a real sshd.
// Started with child_process.fork(file, [JSON options]); answers { port } (the proxy's) over IPC and runs until killed.
import { connect, createServer } from 'node:net';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const opts = { rttMs: 0, mode: 'simple', splitMs: 3, ...JSON.parse(process.argv[2] ?? '{}') };
const OPENSSH_CIPHERS = ['chacha20-poly1305@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'];
const OPENSSH_MACS = ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha1-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'];

/** The redraw that follows an echoed character in "split" mode (a distinct character, so the client can tell them apart). */
const redrawOf = (ch) => `\x1b[2m${String.fromCodePoint(ch.codePointAt(0) + 0x1000)}\x1b[22m\b`;

let host = utils.generateKeyPairSync('ed25519');
for (let tries = 1; tries < 20 && utils.parseKey(host.private) instanceof Error; tries++) host = utils.generateKeyPairSync('ed25519');

const server = new Server({ hostKeys: [host.private], algorithms: { cipher: opts.ciphers ?? OPENSSH_CIPHERS, hmac: OPENSSH_MACS } }, (conn) => {
  conn.on('error', () => undefined);
  conn.on('authentication', (ctx) => (ctx.username === 'alice' ? ctx.accept() : ctx.reject()));
  conn.on('ready', () => conn.on('session', (accept) => {
    const session = accept();
    session.on('pty', (ok) => ok?.());
    session.on('window-change', (ok) => ok?.());
    session.on('shell', (ok) => {
      const stream = ok();
      stream.write('bench\r\n$ ');
      stream.on('data', (chunk) => {
        for (const ch of chunk.toString('utf8')) {
          stream.write(ch === '\r' ? '\r\n$ ' : ch);
          if (opts.mode === 'split' && ch !== '\r') setTimeout(() => stream.write(redrawOf(ch)), opts.splitMs);
        }
      });
    });
  }));
});

/** Forwards `from` to `to`, each chunk `delayMs` after it arrived, in order. */
function delayed(from, to, delayMs) {
  if (delayMs <= 0) { from.on('data', (d) => to.write(d)); return; }
  const queue = [];
  let timer = null;
  const pump = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].due <= now + 0.5) to.write(queue.shift().data);
    if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].due - performance.now()));
  };
  from.on('data', (data) => {
    queue.push({ due: performance.now() + delayMs, data });
    if (!timer) timer = setTimeout(pump, delayMs);
  });
}

server.listen(0, '127.0.0.1', () => {
  const sshPort = server.address().port;
  const proxy = createServer((client) => {
    client.setNoDelay(true);
    const upstream = connect({ host: '127.0.0.1', port: sshPort });
    upstream.setNoDelay(true);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    delayed(client, upstream, opts.rttMs / 2);
    delayed(upstream, client, opts.rttMs / 2);
  });
  proxy.listen(0, '127.0.0.1', () => process.send({ port: proxy.address().port }));
});
