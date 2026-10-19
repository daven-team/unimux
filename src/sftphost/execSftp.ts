// SFTP over an exec channel (0.9.9, "Uruchamiaj SFTP przez sudo"): ssh2 1.17 starts its SFTP client only on the "sftp"
// subsystem (Client.sftp()), so a server command such as `sudo -n /usr/lib/openssh/sftp-server` runs on a public exec channel
// and ssh2's own SFTP protocol class is attached to that channel here. This is the one file that uses an ssh2 internal
// (lib/protocol/SFTP.js, its constructor and push/_init): test/sftp-sudo.test.ts pins it and fails on an ssh2 upgrade.
import { createRequire } from 'module';
import type { Duplex } from 'stream';
import type { SFTPWrapper } from 'ssh2';

/** The ssh2 version this adapter was written and tested against (package.json pins it exactly). */
export const SSH2_SFTP_ADAPTER_VERSION = '1.17.0';

interface SftpInternals extends SFTPWrapper {
  push(data: Buffer | null): void;
  _init(): void;
  outgoing: { id: number; window: number; packetSize: number; state: string };
  readable: boolean;
}
type SftpCtor = new (client: unknown, chanInfo: unknown, cfg: { server?: boolean; debug?: (line: string) => void }) => SftpInternals;

let ctor: SftpCtor | null = null;
/** ssh2's SFTP protocol class (internal module). */
export function sftpClass(): SftpCtor {
  if (!ctor) {
    const mod = createRequire(import.meta.url)('ssh2/lib/protocol/SFTP.js') as { SFTP?: SftpCtor };
    if (typeof mod.SFTP !== 'function') throw new Error('ssh2 SFTP class not found');
    ctor = mod.SFTP;
  }
  return ctor;
}

/**
 * ssh2's SFTP protocol (client side, or server side with `server`) on any duplex byte stream: an exec channel, or in tests a
 * pipe. The channel's flow control stays with the stream (SFTP sees an endless window and writes through stream.write); the
 * stream's end and close end the SFTP session like a closed subsystem channel. `start` sends the client INIT; call it only
 * after anything that must come first on stdin (a sudo password).
 */
export function sftpOverStream(stream: Duplex, opts: { server?: boolean; remoteIdent?: string } = {}): { sftp: SFTPWrapper; start(): void } {
  const SFTP = sftpClass();
  const outgoing = { id: 0, window: Number.MAX_SAFE_INTEGER, packetSize: 32 * 1024, state: 'open' };
  const protocol = {
    _remoteIdentRaw: opts.remoteIdent,
    channelData: (_id: number, data: Buffer) => { if (outgoing.state === 'open') stream.write(data); },
    channelClose: () => { try { stream.end(); } catch { /* gone */ } try { (stream as { close?(): void }).close?.(); } catch { /* gone */ } },
    channelEOF: () => { try { stream.end(); } catch { /* gone */ } },
  };
  const sftp = new SFTP({ _protocol: protocol }, { type: 'session', incoming: { id: 0, window: Number.MAX_SAFE_INTEGER, packetSize: 32 * 1024, state: 'open' }, outgoing }, { server: opts.server === true });
  let ended = false;
  const end = () => { if (ended) return; ended = true; sftp.push(null); };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    end();
    outgoing.state = 'closed';
    sftp.emit('close');
  };
  stream.on('data', (chunk: Buffer) => { if (!ended) sftp.push(chunk); });
  stream.on('end', end);
  stream.on('close', close);
  stream.on('error', (error: Error) => { sftp.emit('error', error); close(); });
  return { sftp, start: () => sftp._init() };
}
