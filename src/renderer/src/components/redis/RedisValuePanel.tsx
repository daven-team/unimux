// The value of one key (1.0.0): its type, TTL (set / persist), length and size, rename (overwrite only after a confirmation),
// copy, delete (confirmed), and the view of its type (RedisValues.tsx). Read-only connections show no edit controls.
import { useEffect, useState } from 'react';
import { redisDataDisplay, type RedisData, type RedisKeyInfo } from '../../../../shared/dbRedis';
import { formatBytes, formatTtl, parseTtlInput } from '../../../../shared/redisView';
import { useI18n } from '../../i18n';
import { askChoice, toast } from '../../store';
import { resultText, whereText, withTab } from '../../redis/redisClient';
import { openMenuAt } from '../ContextMenu';
import { IEdit, IMore } from '../icons';
import { DataText, RedisDialog, TypeBadge, useOffline } from './common';
import { HashView, ListView, SetView, StreamView, StringView, ZsetView } from './RedisValues';

export interface ValueProps {
  tabId: string;
  keyName: RedisData;
  readOnly: boolean;
  /** Something changed the key (TTL, length): the browser reads its details again. */
  onChanged: () => void;
  /** The key holds another type now or vanished: the panel reads it again. */
  onReload: () => void;
  /** Where the value lives, for confirmations: "local redis · DB 3". */
  where: string;
}

export function RedisValuePanel({ tabId, info, readOnly, onChanged, onGone }: {
  tabId: string; info: RedisKeyInfo; readOnly: boolean; onChanged: (key: RedisData) => void; onGone: (key: RedisData, renamedTo?: RedisData) => void;
}) {
  const { tr } = useI18n();
  const offline = useOffline();
  const where = whereText(tabId);
  const [dialog, setDialog] = useState<null | 'ttl' | 'rename'>(null);
  const [generation, setGeneration] = useState(0);
  const key = info.key;
  const ttl = formatTtl(info.ttlMs);
  const remove = async () => {
    const choice = await askChoice(tr('Usunąć klucz?'), `${redisDataDisplay(key)}
${where}`, [{ label: tr('Usuń'), value: 'delete', danger: true }]);
    if (choice !== 'delete') return;
    const r = await withTab(tabId, (sid) => window.mc.db.redis.write(sid, { op: 'delete', keys: [key] }));
    if (!r.ok) { toast(resultText(r), 'error'); return; }
    toast(tr('Klucz usunięty'));
    onGone(key);
  };
  const props: ValueProps = { tabId, keyName: key, readOnly, onChanged: () => onChanged(key), onReload: () => { onChanged(key); setGeneration((g) => g + 1); }, where };
  const copyName = () => { window.mc.clipboardWrite(redisDataDisplay(key)); toast(tr('Skopiowano')); };
  // Below about 420 px the actions move into one menu (the container query in redis.css shows either the buttons or the menu).
  const moreMenu = (el: HTMLElement) => openMenuAt(el, [
    { label: tr('Kopiuj nazwę'), onClick: copyName },
    ...(readOnly ? [] : [{ label: tr('Zmień nazwę'), disabled: offline, onClick: () => setDialog('rename') }]),
    { label: tr('Odśwież'), onClick: () => props.onReload() },
    ...(readOnly ? [] : [{ sep: true as const }, { label: tr('Usuń'), danger: true, disabled: offline, onClick: () => void remove() }]),
  ]);
  return (
    <div className="redis-value">
      <header className="redis-value-head">
        <TypeBadge type={info.type} />
        <DataText data={key} className="redis-value-key" />
        <span className="grow" />
        <span className="redis-value-actions">
          <button className="btn small ghost" title={tr('Kopiuj nazwę klucza')} onClick={copyName}>{tr('Kopiuj nazwę')}</button>
          {!readOnly && <button className="btn small ghost redis-rename" disabled={offline} onClick={() => setDialog('rename')}><IEdit /> {tr('Zmień nazwę')}</button>}
          <button className="btn small ghost" onClick={() => props.onReload()}>{tr('Odśwież')}</button>
          {!readOnly && <button className="btn small danger redis-delete-key" disabled={offline} onClick={() => void remove()}>{tr('Usuń')}</button>}
        </span>
        <button className="btn small ghost icon redis-value-more" aria-label={tr('Więcej akcji')} title={tr('Więcej akcji')} onClick={(e) => moreMenu(e.currentTarget)}><IMore /></button>
      </header>
      <div className="redis-value-meta">
        <span className="redis-meta-item">TTL: <button className={`redis-ttl-btn ${readOnly ? 'static' : ''}`} disabled={readOnly || offline} onClick={() => setDialog('ttl')}>{ttl ?? tr('bez wygaśnięcia')}</button></span>
        {info.length !== undefined && <span className="redis-meta-item">{info.type === 'string' ? tr('Rozmiar: {size}', { size: formatBytes(info.length) }) : tr('Elementów: {count}', { count: info.length.toLocaleString() })}</span>}
        {info.memory !== undefined && <span className="redis-meta-item">{tr('Pamięć: {size}', { size: formatBytes(info.memory) })}</span>}
      </div>
      <div className="redis-value-body" key={generation}>
        {info.type === 'string' ? <StringView {...props} />
          : info.type === 'hash' ? <HashView {...props} />
            : info.type === 'list' ? <ListView {...props} />
              : info.type === 'set' ? <SetView {...props} />
                : info.type === 'zset' ? <ZsetView {...props} />
                  : info.type === 'stream' ? <StreamView {...props} />
                    : <div className="redis-center muted">{tr('Ten typ ({type}) nie ma podglądu. Użyj konsoli.', { type: info.type ?? '?' })}</div>}
      </div>
      {dialog === 'ttl' && <TtlDialog tabId={tabId} keyName={key} ttlMs={info.ttlMs ?? null} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged(key); }} />}
      {dialog === 'rename' && <RenameDialog tabId={tabId} keyName={key} onClose={() => setDialog(null)} onDone={(to) => { setDialog(null); onGone(key, to); }} />}
    </div>
  );
}

function TtlDialog({ tabId, keyName, ttlMs, onClose, onDone }: { tabId: string; keyName: RedisData; ttlMs: number | null; onClose: () => void; onDone: () => void }) {
  const { tr } = useI18n();
  const [text, setText] = useState(ttlMs ? String(Math.round(ttlMs / 1000)) : '');
  const [error, setError] = useState<string | null>(null);
  const apply = async (persist: boolean) => {
    const ms = persist ? null : parseTtlInput(text);
    if (!persist && ms === null) { setError(tr('Nieprawidłowy czas wygaśnięcia')); return; }
    const r = await withTab(tabId, (sid) => window.mc.db.redis.write(sid, persist ? { op: 'persist', key: keyName } : { op: 'expire', key: keyName, ttlMs: ms! }));
    if (!r.ok) { setError(resultText(r)); return; }
    onDone();
  };
  return (
    <RedisDialog title={tr('Czas wygaśnięcia')} onClose={onClose} actions={<>
      {ttlMs !== null && <button className="btn small redis-persist" onClick={() => void apply(true)}>{tr('Usuń wygaśnięcie')}</button>}
      <span className="grow" />
      <button className="btn small" onClick={onClose}>{tr('Anuluj')}</button>
      <button className="btn small primary redis-ttl-save" onClick={() => void apply(false)}>{tr('Ustaw')}</button>
    </>}>
      <p className="muted">{ttlMs === null ? tr('Klucz nie wygasa.') : tr('Wygasa za {ttl}', { ttl: formatTtl(ttlMs) ?? '' })}</p>
      <label className="field"><span>{tr('Nowy czas (sekundy lub z jednostką)')}</span>
        <input className="input redis-ttl-input" autoFocus value={text} placeholder={tr('np. 60, 5m, 2h, 1d')} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void apply(false); }} />
      </label>
      {error && <p className="redis-error-text" role="alert">{error}</p>}
    </RedisDialog>
  );
}

function RenameDialog({ tabId, keyName, onClose, onDone }: { tabId: string; keyName: RedisData; onClose: () => void; onDone: (to: RedisData) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState(typeof keyName === 'string' ? keyName : '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [name]);
  const apply = async () => {
    if (!name || name === keyName) { onClose(); return; }
    let r = await withTab(tabId, (sid) => window.mc.db.redis.write(sid, { op: 'rename', key: keyName, newKey: name }));
    if (!r.ok && r.error === 'keyExists') {
      const choice = await askChoice(tr('Klucz „{name}” już istnieje', { name }), `${tr('Nadpisanie usunie jego obecną wartość.')}\n${whereText(tabId)}`, [
        { label: tr('Nadpisz'), value: 'overwrite', danger: true },
      ]);
      if (choice !== 'overwrite') return;
      r = await withTab(tabId, (sid) => window.mc.db.redis.write(sid, { op: 'rename', key: keyName, newKey: name, overwrite: true }));
    }
    if (!r.ok) { setError(resultText(r)); return; }
    onDone(name);
  };
  return (
    <RedisDialog title={tr('Zmień nazwę klucza')} onClose={onClose} actions={<>
      <button className="btn small" onClick={onClose}>{tr('Anuluj')}</button>
      <button className="btn small primary redis-rename-save" onClick={() => void apply()}>{tr('Zmień nazwę')}</button>
    </>}>
      <label className="field"><span>{tr('Nowa nazwa')}</span>
        <input className="input redis-rename-input" autoFocus value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }} />
      </label>
      {error && <p className="redis-error-text" role="alert">{error}</p>}
    </RedisDialog>
  );
}
