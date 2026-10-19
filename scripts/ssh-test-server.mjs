// node scripts/ssh-test-server.mjs [--port <n>] [--keyboard <code>] [--no-auth] [--sftp-root <dir>] [--sftp-home <remote dir>] [--sftp-posix-rename]
// A local test SSH server on 127.0.0.1 for real-app checks: user alice, a random password, a fresh host key on every start.
// --sftp-root serves the sftp subsystem over that local folder (remote "/" = the folder).
// Prints one JSON line {"port","password","fingerprint","hostKey","pid"} (hostKey = base64 public blob) and runs until its PID is killed.
// Never use real credentials.
import { createHash, randomBytes } from 'node:crypto';

const { startTestServer } = await import('../test/helpers/sshServer.ts');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const password = randomBytes(9).toString('base64url');
const server = await startTestServer({ port: Number(arg('--port')) || 0, password, keyboardCode: arg('--keyboard'), noAuth: process.argv.includes('--no-auth'), sftpRoot: arg('--sftp-root'), sftpHome: arg('--sftp-home'), sftpPosixRename: process.argv.includes('--sftp-posix-rename'), greeting: 'unimux test server\r\n$ ', banner: 'unimux test server - local only\r\n' });
const fingerprint = `SHA256:${createHash('sha256').update(server.hostKeyBlob).digest('base64').replace(/=+$/, '')}`;
process.stdout.write(`${JSON.stringify({ port: server.port, password, fingerprint, hostKey: server.hostKeyBlob.toString('base64'), pid: process.pid })}\n`);
