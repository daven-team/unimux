// Building blocks of the Termius-like host and identity editors: an input with a leading icon, the password field (a saved
// password is a masked placeholder that can be replaced or removed, its value never comes back from main, D6), the key chip
// with its "+ Klucz SSH" picker, the identity suggestions under the user name field and the chip of a picked identity.
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { READ_ONLY_VAULT_HINT } from '../../../../shared/ssh';
import { identityCredential, identityCredentialText, matchIdentities, type SshIdentity } from '../../../../shared/sshIdentity';
import { useI18n } from '../../i18n';
import { showSshDetail } from '../../ssh';
import { useSshStore } from '../../sshStore';
import { openMenuAt, type MenuItem } from '../ContextMenu';
import { IKey, IPlus, IX } from '../icons';
import { IEye, IEyeOff, IIdentity, IPassword, IUser } from './sshIcons';

const shortType = (type: string) => type.replace('ssh-', '').replace('ecdsa-sha2-nist', 'ecdsa-');
const MASK = '••••••••';

/** An input (or any field) with a muted icon on its left and optional buttons on its right. */
export function IconInput({ icon, trailing, className, children }: { icon: ReactNode; trailing?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`ssh-he-input${className ? ` ${className}` : ''}`}>
      <span className="ssh-he-lead">{icon}</span>
      {children}
      {trailing && <span className="ssh-he-trail">{trailing}</span>}
    </div>
  );
}

/**
 * A write-only password: what is typed is stored on "Zapisz"; a saved one shows as a masked placeholder, × marks it for
 * removal on "Zapisz". The eye shows the typed text only.
 */
export function PasswordField({ value, onChange, saved, locked, cleared, onClear, disabled }: {
  value: string; onChange(value: string): void; saved: boolean; locked: boolean; cleared: boolean; onClear(): void; disabled: boolean;
}) {
  const { tr } = useI18n();
  const [shown, setShown] = useState(false);
  const kept = saved && !cleared;
  return (
    <>
      <IconInput icon={<IPassword />} trailing={<>
        {kept && !value && !disabled && (
          <button type="button" className="ssh-he-icon-btn" aria-label={tr('Usuń zapisane hasło')} title={tr('Usuń zapisane hasło')} onClick={onClear}><IX /></button>
        )}
        <button type="button" className="ssh-he-icon-btn" aria-label={tr(shown ? 'Ukryj hasło' : 'Pokaż hasło')} title={tr(shown ? 'Ukryj hasło' : 'Pokaż hasło')} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
          {shown ? <IEyeOff /> : <IEye />}
        </button>
      </>}>
        <input className="input" type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={value} maxLength={1024} disabled={disabled}
          placeholder={kept ? MASK : tr('Hasło')} aria-label={kept ? `${tr('Hasło')} (${tr('Hasło zapisane')})` : tr('Hasło')} title={disabled ? tr(READ_ONLY_VAULT_HINT) : undefined}
          onChange={(e) => onChange(e.target.value)} />
      </IconInput>
      {locked && !cleared && !value && <div className="ssh-error" role="alert">{tr('Nie można odczytać tego sekretu na tym komputerze. Usuń go i dodaj ponownie.')}</div>}
    </>
  );
}

/** The key of a host or identity: a chip with × once chosen, otherwise "+ Klucz SSH" that lists the vault keys. */
export function KeyField({ keyId, onChange }: { keyId?: string; onChange(keyId: string | undefined): void }) {
  const { tr } = useI18n();
  const keys = useSshStore((st) => st.vault?.keys);
  const readOnly = useSshStore((st) => !!st.vault?.readOnly);
  const key = keyId ? keys?.find((k) => k.id === keyId) : undefined;
  if (keyId) {
    return (
      <div className="ssh-he-chip">
        <span className="ssh-he-lead"><IKey /></span>
        <span className="ssh-he-chip-text">{key ? key.label : tr('Klucz przypisany do hosta nie istnieje')}</span>
        {key && <span className="ssh-he-chip-meta">{shortType(key.type)}</span>}
        <button type="button" className="ssh-he-icon-btn" aria-label={tr('Odłącz klucz')} title={tr('Odłącz klucz')} onClick={() => onChange(undefined)}><IX /></button>
      </div>
    );
  }
  const items = (): MenuItem[] => [
    ...(keys ?? []).map((k): MenuItem => ({ label: k.label, hint: shortType(k.type), onClick: () => onChange(k.id) })),
    ...(keys?.length && !readOnly ? [{ sep: true } as const] : []),
    ...(!readOnly ? [{ label: tr('Nowy klucz...'), onClick: () => showSshDetail({ kind: 'newKey' }) }] : []),
  ];
  return (
    <button type="button" className="ssh-he-add" aria-haspopup="menu" onClick={(e) => { const list = items(); if (list.length) openMenuAt(e.currentTarget, list); }}>
      <IPlus />{tr('Klucz SSH')}
    </button>
  );
}

/**
 * The user name with the identities that match it (focus or typing opens the list). Arrows move, Enter picks the highlighted
 * identity (with none highlighted Enter submits the form as usual), Esc closes the list without closing the pane.
 */
export function UsernameField({ value, onChange, onPick, identities, dataField = 'username' }: {
  value: string; onChange(value: string): void; onPick(identity: SshIdentity): void; identities: readonly SshIdentity[]; dataField?: string;
}) {
  const { tr } = useI18n();
  const saved = useSshStore((st) => st.vault?.savedIdentityPasswords);
  const keys = useSshStore((st) => st.vault?.keys);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const matches = matchIdentities(identities, value);
  const shown = open && matches.length > 0;
  const keyIds = (keys ?? []).map((k) => k.id);
  const pick = (identity: SshIdentity) => { setOpen(false); setActive(-1); onPick(identity); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!matches.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((n) => (n < 0 ? (step > 0 ? 0 : matches.length - 1) : (n + step + matches.length) % matches.length));
    } else if (e.key === 'Enter' && shown && matches[active]) {
      e.preventDefault();
      pick(matches[active]);
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };
  return (
    <div className="ssh-he-combo">
      <IconInput icon={<IUser />}>
        <input className="input" data-field={dataField} value={value} spellCheck={false} autoComplete="off" maxLength={64}
          placeholder={tr('Użytkownik')} aria-label={tr('Użytkownik')}
          role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls={shown ? listId : undefined}
          aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setActive(-1); }} onKeyDown={onKeyDown} />
      </IconInput>
      {shown && (
        <ul className="ssh-he-suggest" role="listbox" id={listId} aria-label={tr('Tożsamości')}>
          {matches.map((identity, n) => (
            <li key={identity.id} id={`${listId}-${n}`} role="option" aria-selected={n === active} className={n === active ? 'on' : undefined}
              // The input keeps the focus (a blur would close the list before the click lands).
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(n)} onClick={() => pick(identity)}>
              <span className="ssh-he-lead"><IIdentity /></span>
              <span className="ssh-he-suggest-text">
                <span className="ssh-he-suggest-name">{identity.label}</span>
                <span className="ssh-he-suggest-meta">{identity.username} · {tr(identityCredentialText(identityCredential(identity, saved ?? [], keyIds)))}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A picked identity in place of the user name, password and key fields; × detaches it (the host's own fields come back). */
export function IdentityChip({ identity, onDetach }: { identity: SshIdentity; onDetach(): void }) {
  const { tr } = useI18n();
  return (
    <div className="ssh-he-chip ssh-he-identity" title={`${identity.label} · ${identity.username}`}>
      <span className="ssh-he-lead"><IIdentity /></span>
      <span className="ssh-he-chip-text">{identity.label}</span>
      <span className="ssh-he-chip-meta">{identity.username}</span>
      <button type="button" className="ssh-he-icon-btn" aria-label={tr('Odłącz tożsamość')} title={tr('Odłącz tożsamość')} onClick={onDetach}><IX /></button>
    </div>
  );
}
