// node scripts/ssh-test-server.mjs [--port <n>] [--keyboard <code>] [--no-auth] [--sftp-root <dir>] [--sftp-home <remote dir>] [--sftp-posix-rename]
//   [--public-key-file <file with an authorized_keys line accepted for alice>] [--sftp-delay <ms per READ/WRITE answer>]
//   [--sftp-sudo] [--sftp-sudo-password <pw>] [--sftp-sudo-requiretty]   (0.9.9: `sudo ... sftp-server` exec requests)
//   [--sftp-sudo-locale pl] [--sftp-sudo-ignore-env] [--sftp-lsetstat]   (sudo in Polish without LC_ALL=C; lsetstat@openssh.com)
//   [--shell-root <dir>] [--shell-home <remote dir>] [--shell-osc7]   (1.0.6: a fake shell over that folder, cd / ls / vim,
//   answering the path completion exec `exec sh -s` like a Linux server; --shell-osc7: the prompt reports its folder)
//   [--bar debian|alpine|windows]   (1.0.7: canned answers to the SSH status bar script, or a server without sh)
// A local test SSH server on 127.0.0.1 for real-app checks: user alice, a random password, a fresh host key on every start.
// --sftp-root serves the sftp subsystem over that local folder (remote "/" = the folder).
// Prints one JSON line {"port","password","fingerprint","hostKey","pid"} (hostKey = base64 public blob) and runs until its PID is killed.
// Never use real credentials.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { startTestServer } = await import('../test/helpers/sshServer.ts');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const password = randomBytes(9).toString('base64url');
const server = await startTestServer({ port: Number(arg('--port')) || 0, password, keyboardCode: arg('--keyboard'), noAuth: process.argv.includes('--no-auth'), publicKey: arg('--public-key-file') ? readFileSync(arg('--public-key-file'), 'utf8').trim() : undefined, sftpRoot: arg('--sftp-root'), sftpHome: arg('--sftp-home'), sftpPosixRename: process.argv.includes('--sftp-posix-rename'),
  sftpSudo: process.argv.includes('--sftp-sudo') || arg('--sftp-sudo-password') || process.argv.includes('--sftp-sudo-requiretty')
    ? { password: arg('--sftp-sudo-password'), requiretty: process.argv.includes('--sftp-sudo-requiretty'), locale: arg('--sftp-sudo-locale'), ignoreEnv: process.argv.includes('--sftp-sudo-ignore-env') } : undefined,
  sftpLsetstat: process.argv.includes('--sftp-lsetstat'),
  bar: arg('--bar'), shellRoot: arg('--shell-root'), shellHome: arg('--shell-home'), shellOsc7: process.argv.includes('--shell-osc7'),
  greeting: 'unimux test server\r\n$ ', banner: 'unimux test server - local only\r\n' });
if (arg('--sftp-delay') && server.sftp) server.sftp.delayMs = Number(arg('--sftp-delay')) || 0;
const fingerprint = `SHA256:${createHash('sha256').update(server.hostKeyBlob).digest('base64').replace(/=+$/, '')}`;
process.stdout.write(`${JSON.stringify({ port: server.port, password, fingerprint, hostKey: server.hostKeyBlob.toString('base64'), pid: process.pid })}\n`);
