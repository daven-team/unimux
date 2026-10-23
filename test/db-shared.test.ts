// The database contract (1.0.0): session ids, the connection normalizer, the connection form checks, state helpers and texts.
import { describe, expect, it } from 'vitest';
import {
  dbConnectionToDraft, dbEndpoint, dbErrorText, dbTlsModeLabel, dbSessionId, duplicateDbConnection, isDbSessionId, normalizeDbConnection, normalizeDbConnections,
  removeDbConnection, upsertDbConnection, validateDbDraft, type DbConnection, type DbErrorCode,
} from '../src/shared/db';
import { messages } from '../src/shared/messages';
import { defaultState, normalizeState } from '../src/shared/state';
import { isSftpSessionId } from '../src/shared/sftp';

const ID = '11111111-2222-4333-8444-555555555555';
const HOST = '99999999-2222-4333-8444-555555555555';
const base = { id: ID, kind: 'postgres', name: 'prod', host: 'db.example.com', port: 5432, user: 'app', database: 'shop', tls: 'require', ssh: null, readOnly: false, createdAt: 1, updatedAt: 2 };

describe('ids', () => {
  it('db session ids live in their own namespace', () => {
    expect(isDbSessionId(dbSessionId(ID))).toBe(true);
    expect(isDbSessionId(`sftp:${ID}`)).toBe(false);
    expect(isSftpSessionId(dbSessionId(ID))).toBe(false);
    expect(isDbSessionId('db:nope')).toBe(false);
  });
});

describe('normalizeDbConnection', () => {
  it('keeps a valid connection and drops unknown fields', () => {
    expect(normalizeDbConnection({ ...base, password: 'leak', extra: 1 })).toEqual(base);
  });

  it('falls back to defaults for bad optional fields and refuses unusable entries', () => {
    expect(normalizeDbConnection({ ...base, port: 0, tls: 'weird', color: 'red', group: ' ops ', statementTimeoutMs: -1, database: '' })).toEqual({ ...base, port: 5432, tls: 'prefer', group: 'ops', database: 'postgres' });
    expect(normalizeDbConnection({ ...base, tls: 'verify-full' })).toBeNull(); // no CA file: unusable, never weakened to require
    expect(normalizeDbConnection({ ...base, tls: 'verify-full', caPath: 'C:\\ca.pem' })).toMatchObject({ tls: 'verify-full', caPath: 'C:\\ca.pem' });
    expect(normalizeDbConnection({ ...base, id: 'x' })).toBeNull();
    expect(normalizeDbConnection({ ...base, kind: 'oracle' })).toBeNull();
    expect(normalizeDbConnection({ ...base, host: 'bad host' })).toBeNull();
    expect(normalizeDbConnection({ ...base, user: '' })).toBeNull();
    expect(normalizeDbConnection({ ...base, kind: 'redis', user: '' })).toMatchObject({ kind: 'redis', user: '', dbIndex: 0, port: 5432 });
  });

  it('keeps an SSH tunnel only with a host id and a valid database address', () => {
    expect(normalizeDbConnection({ ...base, ssh: { hostId: HOST, dbHost: '127.0.0.1', dbPort: 6543 } })?.ssh).toEqual({ hostId: HOST, dbHost: '127.0.0.1', dbPort: 6543 });
    // A damaged tunnel makes the connection unusable: it never becomes a direct connection.
    expect(normalizeDbConnection({ ...base, ssh: { hostId: HOST, dbHost: '127.0.0.1', dbPort: 'x' } })).toBeNull();
    expect(normalizeDbConnection({ ...base, ssh: { hostId: 'x', dbHost: '127.0.0.1', dbPort: 22 } })).toBeNull();
    expect(normalizeDbConnection({ ...base, ssh: { hostId: HOST, dbHost: 'bad host', dbPort: 22 } })).toBeNull();
    expect(normalizeDbConnection({ ...base, ssh: 'x' })).toBeNull();
    expect(normalizeDbConnection({ ...base, ssh: undefined })?.ssh).toBeNull();
  });

  it('a list drops duplicates and junk; the state normalizer keeps the list', () => {
    expect(normalizeDbConnections([base, base, null, 'x', { ...base, id: HOST }]).map((c) => c.id)).toEqual([ID, HOST]);
    expect(normalizeDbConnections('nope')).toEqual([]);
    const state = normalizeState({ ...defaultState(), dbConnections: [base, { junk: true }] });
    expect(state?.dbConnections).toEqual([base]);
    expect(normalizeState({ ...defaultState(), dbConnections: undefined })?.dbConnections).toEqual([]);
  });
});

describe('connection form', () => {
  it('validates the typed form into an input', () => {
    const draft = dbConnectionToDraft();
    expect(draft).toMatchObject({ kind: 'postgres', host: 'localhost', port: '5432', user: 'postgres', database: 'postgres', tls: 'prefer', sshDbHost: '127.0.0.1' });
    expect(validateDbDraft({ ...draft, name: '', statementTimeout: '1.5' })).toEqual({ ok: true, value: {
      kind: 'postgres', name: 'localhost', host: 'localhost', port: 5432, user: 'postgres', tls: 'prefer', ssh: null, readOnly: false, database: 'postgres', statementTimeoutMs: 1500,
    } });
  });

  it('reports each bad field', () => {
    const r = validateDbDraft({ ...dbConnectionToDraft(), host: 'a b', port: '70000', user: '', tls: 'verify-full', caPath: '', statementTimeout: 'x' });
    expect(r).toEqual({ ok: false, errors: { host: 'Nieprawidłowy adres hosta', port: 'Nieprawidłowy port', user: 'Podaj nazwę użytkownika', caPath: 'Wybierz plik certyfikatu CA', statementTimeout: 'Nieprawidłowy limit czasu' } });
    const redis = validateDbDraft({ ...dbConnectionToDraft(undefined, 'redis'), dbIndex: '-1' });
    expect(redis).toEqual({ ok: false, errors: { dbIndex: 'Nieprawidłowy numer bazy' } });
  });

  it('with a tunnel the host field may stay empty and the database address is checked instead', () => {
    const r = validateDbDraft({ ...dbConnectionToDraft(), host: '', sshHostId: HOST, sshDbHost: '', sshDbPort: '' });
    expect(r.ok && r.value.ssh).toEqual({ hostId: HOST, dbHost: '127.0.0.1', dbPort: 5432 });
    expect(r.ok && r.value.name).toBe('127.0.0.1');
    expect(validateDbDraft({ ...dbConnectionToDraft(), sshHostId: HOST, sshDbHost: 'x y' })).toMatchObject({ ok: false, errors: { sshDbHost: 'Nieprawidłowy adres hosta' } });
  });

  it('round-trips a saved connection through the form', () => {
    const c = normalizeDbConnection({ ...base, color: '#112233', group: 'ops', statementTimeoutMs: 30000, ssh: { hostId: HOST, dbHost: '10.0.0.5', dbPort: 6432 } })!;
    const r = validateDbDraft(dbConnectionToDraft(c));
    expect(r).toEqual({ ok: true, value: { kind: c.kind, name: c.name, color: c.color, group: c.group, host: c.host, port: c.port, user: c.user, database: c.database, tls: c.tls, ssh: c.ssh, readOnly: false, statementTimeoutMs: 30000 } });
    expect(dbEndpoint(c)).toBe('10.0.0.5:6432/shop');
    expect(dbEndpoint({ ...c, ssh: null, host: '::1' })).toBe('[::1]:5432/shop');
  });
});

describe('state helpers', () => {
  it('adds, replaces, duplicates after the original with a free name, and removes', () => {
    const c = normalizeDbConnection(base) as DbConnection;
    let s = upsertDbConnection({ dbConnections: [] as DbConnection[] }, c);
    s = upsertDbConnection(s, { ...c, name: 'renamed' });
    expect(s.dbConnections.map((x) => x.name)).toEqual(['renamed']);
    s = duplicateDbConnection(s, ID, HOST, 50);
    s = duplicateDbConnection(s, ID, '77777777-2222-4333-8444-555555555555', 60);
    expect(s.dbConnections.map((x) => x.name)).toEqual(['renamed', 'renamed (3)', 'renamed (2)']);
    expect(s.dbConnections[2]).toMatchObject({ id: HOST, createdAt: 50, updatedAt: 50 });
    expect(removeDbConnection(s, ID).dbConnections).toHaveLength(2);
    expect(duplicateDbConnection(s, 'missing', HOST, 1)).toBe(s);
  });
});

describe('texts', () => {
  it('every error code has a translated text', () => {
    const codes: DbErrorCode[] = ['dbHostCrashed', 'connectionMissing', 'unsupported', 'dbAuth', 'dbRefused', 'dbDns', 'dbTimeout', 'dbTls', 'dbTlsUnsupported', 'dbNoDatabase', 'caFile', 'tunnel', 'dbClosed', 'dbFailed', 'readOnly', 'inTransaction', 'noSession', 'notConnected', 'invalid', 'noKey', 'conflict', 'notFound', 'server', 'statementTimeout', 'cancelled', 'auth'];
    for (const code of [...codes, 'busy', 'tooMany'] as DbErrorCode[]) expect(Object.hasOwn(messages, dbErrorText(code).key), code).toBe(true);
    for (const mode of ['disable', 'prefer', 'require', 'verify-full'] as const) {
      const { label, detail } = dbTlsModeLabel(mode);
      expect(Object.hasOwn(messages, label.key) && Object.hasOwn(messages, detail.key), mode).toBe(true);
    }
    expect(dbTlsModeLabel('require').detail.key).toBe('Bez weryfikacji certyfikatu');
  });
});
