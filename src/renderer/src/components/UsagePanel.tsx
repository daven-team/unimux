import { useEffect, useRef, useState } from 'react';
import { updateSettings } from '../../../shared/state';
import type { AccountNotice, LoginTarget } from '../../../shared/accounts';
import { adoptCopyOffered, cardState, claudeLoginActions, diagnosticLabel, effectivePercent, formatDuration, makeMainOffered, shortAccountName, shortDuration, summaryAccounts, usageBand, usageDiagnostics, usageErrorKind, usageSummary, type ProviderUsage, type SetAsideAccount, type UsageProvider, type UsageWindow } from '../../../shared/usage';
import { cswapNoteText, noticeText, setAsideText, usageErrorKey } from '../../../shared/usageMessages';
import { useI18n } from '../i18n';
import { swapErrorKey, swapErrorText } from '../../../shared/swapMessages';
import { askChoice, setUi, toast, update, useStore } from '../store';
import { useUsage } from '../usage';
import { openMenuAt } from './ContextMenu';
import { IChevron, IPlus } from './icons';
import { ProviderIcon } from './ProviderIcons';
import { BusyRing, RefreshIcon, useHoldBusy } from './Spinner';

const DORMANT_NOTE = 'Token dostępu wygasł - Claude Code odświeży go przy najbliższym użyciu. Uruchom sesję Claude (albo wyślij wiadomość), a limity wrócą.';
const HELD_NOTE = {
  live: 'To konto jest teraz zalogowane w Claude Code - jego limity pokazuje karta oznaczona jako główna.',
  'switched-out': 'Przełączone poza aplikacją (cswap lub /login), więc aplikacja nie odnawia tej kopii.',
} as const;
const DORMANT_SHORT = 'Limity wrócą po następnej wiadomości w Claude.';
const FORBIDDEN_NOTE = 'Odmowa dostępu (HTTP 403), np. wstrzymana subskrypcja. Logowanie jest ważne - ponowne logowanie nie pomoże.';
const FORBIDDEN_SHORT = 'Odmowa dostępu (HTTP 403)';
const CSWAP_SHORT = 'Kopię tego logowania ma też cswap, więc aplikacja jej nie odnawia.';
const ADOPT_LABEL = 'Odświeżaj tę kopię w unimuxie';
const ADOPT_BODY = 'Od teraz unimux będzie sam odnawiał tę kopię logowania.\n\nTo bezpieczne, jeśli logowano się do tego konta w unimuxie. Jeśli kopia pochodzi z „Ustaw jako główne” w starszej wersji, cswap może stracić swój token dla tego konta - wtedy wystarczy raz zalogować się do niego ponownie w cswap.\n\n„Zaloguj ponownie” pozostaje dostępne dla logowań, które naprawdę wygasły.';
const ADOPT_FAILED = 'Nie udało się zmienić sposobu odnawiania tej kopii.';
const ADOPT_LIVE = 'To konto jest teraz zalogowane w Claude Code - jego logowanie odnawia Claude Code, nie unimux.';
const ADOPT_READ_ONLY = 'Nie można teraz zmieniać kont: pliku kont aplikacji nie da się bezpiecznie odczytać (szczegóły w panelu limitów).';
const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };
const READ_ONLY_REMOVE = 'Nie można teraz usuwać kont: pliku kont aplikacji nie da się bezpiecznie odczytać (szczegóły w panelu limitów).';
const LIVE_REMOVE = 'Konta głównego nie można usunąć. Najpierw ustaw jako główne inne konto.';

/** Removes a saved Claude account (or a set-aside copy of one); refusals are told in a toast. */
async function removeSaved(id: string, tr: ReturnType<typeof useI18n>['tr']): Promise<void> {
  try {
    const result = await window.mc.removeAccount(id);
    if (!result.ok && result.error) toast(result.error === 'readOnly' ? tr(READ_ONLY_REMOVE) : result.error === 'live' ? tr(LIVE_REMOVE) : tr(swapErrorKey(result.error)), 'error');
  } catch { /* the next usage refresh shows the real state */ }
}

function Bar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="usage-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <span className={usageBand(percent)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function WindowRow({ window, now, language }: { window: UsageWindow; now: number; language: string }) {
  const { tr } = useI18n();
  const percent = effectivePercent(window, now);
  const upcoming = window.resetsAt * 1000 > now;
  const at = new Date(window.resetsAt * 1000);
  const clock = window.id === '5h'
    ? at.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="usage-row">
      <span className="usage-label">{window.id === '5h' ? tr('5 godz.') : tr('7 dni')}</span>
      <Bar percent={percent} label={window.id === '5h' ? tr('5 godz.') : tr('7 dni')} />
      <span className="usage-pct">{Math.round(percent)}%</span>
      {upcoming && <span className="usage-reset">{tr('reset {time}', { time: clock })} · {tr('za {time}', { time: formatDuration(window.resetsAt - now / 1000) })}</span>}
    </div>
  );
}

const openAuth = (provider: UsageProvider, target: LoginTarget) => setUi({ modal: { kind: 'auth', provider, target } });

/** The login target that renews this account. */
function reloginTarget(usage: ProviderUsage): LoginTarget {
  return usage.managed && !usage.active && usage.provider === 'claude' ? { type: 'account', id: usage.accountId.replace(/^claude:/, '') } : { type: 'main' };
}

function KebabIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden><circle cx="8" cy="3.5" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="8" cy="12.5" r="1.2" /></svg>;
}

function AccountCard({ usage, now, language, showMain, savedIndex, swapping, onMakeMain }: {
  usage: ProviderUsage; now: number; language: string; showMain: boolean;
  /** Position among the saved Claude accounts (1-based); names the account in diagnostics instead of its e-mail. */
  savedIndex: number;
  /** Account id whose swap is running (any card is locked meanwhile), or null. */
  swapping: string | null; onMakeMain: (usage: ProviderUsage) => void;
}) {
  const { tr } = useI18n();
  const busy = swapping !== null;
  // On macOS Claude keeps its tokens in the Keychain, so the main login cannot be exchanged there.
  // A saved copy that already is the main login cannot become it again.
  const canMakeMain = makeMainOffered(usage) && claudeLoginActions(window.mc.platform, true).managedAccounts;
  const providerName = NAMES[usage.provider];
  const name = usage.email || providerName;
  const age = formatDuration((now - usage.fetchedAt) / 1000);
  // One of a few fixed states (cardState): the same situation always looks the same, whatever the reason behind it.
  const state = cardState(usage);
  const expired = state === 'expired';
  const dormant = usage.status === 'dormant';
  const removeAccount = async () => {
    const choice = await askChoice(
      tr('Usunąć konto {name}?', { name }),
      tr('Logowanie zostanie usunięte z aplikacji. Samo konto pozostaje bez zmian.'),
      [{ label: tr('Usuń konto'), value: 'yes', danger: true }],
    );
    if (choice !== 'yes') return;
    await removeSaved(usage.accountId.replace(/^claude:/, ''), tr);
  };

  // "Renew this copy in unimux": only after the user confirms; the main process checks the record again.
  const canAdopt = adoptCopyOffered(usage) && claudeLoginActions(window.mc.platform, true).managedAccounts;
  const adoptCopy = async () => {
    const choice = await askChoice(tr('Odświeżać kopię konta {name} w unimuxie?', { name }), tr(ADOPT_BODY), [{ label: tr(ADOPT_LABEL), value: 'yes', primary: true }]);
    if (choice !== 'yes') return;
    try {
      const result = await window.mc.adoptAccountCopy(usage.accountId.replace(/^claude:/, ''));
      if (result.ok) toast(tr('unimux odnawia teraz kopię konta {name}.', { name }));
      else if (result.error === 'readOnly') toast(tr(ADOPT_READ_ONLY), 'error');
      else if (result.error === 'live') toast(tr(ADOPT_LIVE), 'error');
      else if (result.error === 'busy' || result.error === 'pending') toast(tr(swapErrorKey(result.error)), 'error');
      else toast(tr(ADOPT_FAILED), 'error');
    } catch {
      toast(tr(ADOPT_FAILED), 'error');
    }
  };
  // The longer explanation of a copy cswap also holds is a tooltip; "Renew this copy in unimux" is in the card's menu.
  const cswapNote = usage.heldBy === 'cswap' ? cswapNoteText(usage.status) : undefined;

  const copyDiagnostics = () => {
    window.mc.clipboardWrite(usageDiagnostics(usage, Date.now(), diagnosticLabel(usage, savedIndex)));
    toast(tr('Skopiowano diagnostykę.'));
  };
  const reasonTitle = usage.error ? tr('Przyczyna techniczna: {code}', { code: usage.error }) : undefined;
  const kind = usageErrorKind(usage.error);
  // Temporary trouble (limits server, network, renewal) is told calmly; only an unknown or unreadable answer is shown as a warning.
  const calm = kind !== 'other' && kind !== 'parse';
  const retry = usage.retryAt !== undefined && usage.retryAt > now ? tr('za {time}', { time: formatDuration((usage.retryAt - now) / 1000) }) : tr('wkrótce');
  // A saved Claude account whose sign-in cannot be renewed (server limits, rejected renewal, a copy cswap or an outside switch
  // holds) must never leave the user stuck: signing in again is always offered. Not on access denied (403): the sign-in is valid.
  const heldElsewhere = usage.heldBy === 'cswap' || usage.heldBy === 'switched-out';
  const canRelogin = usage.managed && !usage.active && usage.provider === 'claude' && !expired && usage.status !== 'forbidden'
    && (kind === 'refreshLimited' || kind === 'refresh' || heldElsewhere) && claudeLoginActions(window.mc.platform, true).managedAccounts;
  const failureText = tr(usageErrorKey(kind, usage.provider), { name: providerName, retry });

  // Details of a state are a tooltip at most: the card itself shows one short line and, when expired, one button.
  const heldTitle = usage.heldBy === 'cswap' && cswapNote ? tr(cswapNote) : usage.heldBy && usage.heldBy !== 'cswap' ? tr(HELD_NOTE[usage.heldBy]) : undefined;
  const windows = usage.windows.map((window) => <WindowRow key={window.id} window={window} now={now} language={language} />);
  let body;
  if (state === 'expired') {
    // The same row for every expired sign-in (a rejected renewal, a dead main login, a dead or outdated copy).
    body = (
      <div className="usage-expired" title={heldTitle ?? reasonTitle}>
        <span className="usage-note">{tr('Logowanie wygasło')}</span>
        <button className="btn small primary" onClick={() => openAuth(usage.provider, reloginTarget(usage))}>{tr('Zaloguj ponownie')}</button>
      </div>
    );
  } else if (state === 'apiKey') {
    body = <p className="usage-note">{tr('Codex: logowanie kluczem API, brak limitów.')}</p>;
  } else if (state === 'unavailable') {
    const text = usage.status === 'forbidden' ? tr(FORBIDDEN_SHORT) : dormant ? tr(DORMANT_SHORT) : failureText;
    const title = usage.status === 'forbidden' ? tr(FORBIDDEN_NOTE) : dormant ? tr(DORMANT_NOTE) : reasonTitle;
    body = <p className={`usage-note ${calm || dormant ? '' : 'warn'}`} title={title}>{text}</p>;
  } else {
    // `ok` and `stale`: the numbers, then at most one short line (why they are old, or whose copy this is).
    const ageNote = usage.source === 'log' ? tr('stan z ostatniej sesji, sprzed {age}', { age }) : state === 'stale' ? tr('dane sprzed {age}', { age }) : '';
    const failed = usage.status === 'error';
    const line = usage.status === 'forbidden' ? tr(FORBIDDEN_SHORT)
      : failed ? (ageNote ? `${failureText} (${ageNote})` : failureText)
      : ageNote || (usage.heldBy === 'switched-out' ? tr(HELD_NOTE['switched-out']) : usage.heldBy === 'cswap' ? tr(CSWAP_SHORT) : '');
    const title = usage.status === 'forbidden' ? tr(FORBIDDEN_NOTE) : failed ? reasonTitle : dormant ? tr(DORMANT_NOTE) : heldTitle;
    body = (
      <>
        {windows}
        {line && <p className={`usage-note ${(failed && !calm) || usage.status === 'forbidden' ? 'warn' : ''}`} title={title}>{line}</p>}
      </>
    );
  }

  return (
    <div className={`usage-card ${expired ? 'expired' : ''} ${dormant && !expired ? 'dormant' : ''} ${state === 'stale' && usage.status === 'error' ? 'stale' : ''} ${swapping === usage.accountId ? 'busy' : ''}`} title={usage.org || undefined} aria-busy={swapping === usage.accountId || undefined}>
      <div className="usage-card-head">
        <ProviderIcon provider={usage.provider} />
        <span className="usage-account" title={name}>{name}</span>
        {usage.plan && <span className="usage-chip">{usage.plan}</span>}
        {showMain && usage.active && <span className="usage-chip main">{tr('główne')}</span>}
        {swapping === usage.accountId && (
          <span className="usage-swapping" role="status" aria-live="polite">
            <BusyRing className="usage-spinner" />
            {tr('Przełączam konto…')}
          </span>
        )}
        {swapping !== usage.accountId && (
          <button
            className="usage-kebab"
            aria-haspopup="menu"
            aria-label={tr('Menu konta')}
            title={tr('Menu konta')}
            onClick={(e) => openMenuAt(e.currentTarget, [
              ...(canMakeMain ? [{ label: tr('Ustaw jako główne'), disabled: busy, onClick: () => onMakeMain(usage) }] : []),
              ...(canAdopt ? [{ label: tr(ADOPT_LABEL), disabled: busy, onClick: () => void adoptCopy() }] : []),
              ...(canRelogin ? [{ label: tr('Zaloguj ponownie to konto'), disabled: busy, onClick: () => openAuth(usage.provider, reloginTarget(usage)) }] : []),
              { label: tr('Skopiuj diagnostykę'), onClick: copyDiagnostics },
              ...(usage.managed ? [{ label: tr('Usuń konto'), danger: true, disabled: busy, onClick: () => void removeAccount() }] : []),
            ])}
          ><KebabIcon /></button>
        )}
      </div>
      {body}
    </div>
  );
}

/**
 * Notices about the saved accounts (outside switches, set-aside copies, the upgrade), cards set aside after a failed
 * restore, and an accounts.json that cannot be read safely. Each says what happened and what to do.
 */
function AccountNotices({ notices, setAside, copies, readOnlyPath }: { notices: AccountNotice[]; setAside: SetAsideAccount[]; copies: string[]; readOnlyPath?: string }) {
  const { tr } = useI18n();
  if (!notices.length && !setAside.length && !readOnlyPath) return null;
  // A second copy goes while the account's card stays; a set-aside card is the account's card itself ("Usuń konto").
  const removeCopy = async (recordId: string | undefined, email: string | undefined, whole = false) => {
    const name = email ?? NAMES.claude;
    const choice = whole
      ? await askChoice(tr('Usunąć konto {name}?', { name }), tr('Logowanie zostanie usunięte z aplikacji. Samo konto pozostaje bez zmian.'), [{ label: tr('Usuń konto'), value: 'yes', danger: true }])
      : await askChoice(tr('Usunąć kopię konta {name}?', { name }), tr('Kopia logowania zostanie usunięta z aplikacji. Konto i jego karta pozostają bez zmian.'), [{ label: tr('Usuń kopię'), value: 'yes', danger: true }]);
    if (choice !== 'yes' || !recordId) return;
    await removeSaved(recordId, tr);
  };
  return (
    <div className="usage-notices">
      {readOnlyPath && (
        <div className="usage-warning" role="alert">
          <p className="usage-note warn">{tr('Pliku kont aplikacji ({path}) nie da się bezpiecznie odczytać, więc aplikacja niczego w nim nie zapisuje. Do tego czasu nowych logowań nie można zapisać, a kont nie można usuwać. Napraw albo usuń ten plik i uruchom aplikację ponownie.', { path: readOnlyPath })}</p>
        </div>
      )}
      {setAside.map((card) => (
        <div key={`set-aside:${card.recordId}`} className="usage-warning" role="status">
          <p className="usage-note">{tr(setAsideText(card.restoring), { email: card.email ?? NAMES.claude })}</p>
          <div className="usage-empty-buttons">
            <button className="btn small" onClick={() => openAuth('claude', { type: 'account', id: card.recordId })}>{tr('Zaloguj ponownie')}</button>
            <button className="btn small" onClick={() => void removeCopy(card.recordId, card.email, true)}>{tr('Usuń konto')}</button>
          </div>
        </div>
      ))}
      {notices.map((notice) => {
        const text = noticeText(notice, window.mc.platform);
        return (
          <div key={notice.id} className="usage-warning" role="status">
            <p className="usage-note">{tr(text.key, text.params)}</p>
            <div className="usage-empty-buttons">
              {notice.kind === 'quarantined' && notice.recordId && copies.includes(notice.recordId) && <button className="btn small" onClick={() => void removeCopy(notice.recordId, notice.email)}>{tr('Usuń kopię')}</button>}
              <button className="btn small ghost" onClick={() => void window.mc.dismissAccountNotice(notice.id).catch(() => undefined)}>{tr('Ukryj')}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Fixed section above the status bar: limits of the connected Claude and Codex accounts. */
export function UsagePanel() {
  const { tr, language } = useI18n();
  const settings = useStore((st) => st.s.settings);
  const rail = useStore((st) => st.s.sidebarCollapsed);
  const { providers, notices = [], setAside = [], duplicateCopies = [], accountsReadOnly } = useUsage();
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const spinning = useHoldBusy(refreshing, 700);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [swapPending, setSwapPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // An interrupted swap blocks further swaps until the user has checked the accounts and cleared the warning.
  useEffect(() => {
    void window.mc.swapPending().then((pending) => { if (alive.current) setSwapPending(pending); }).catch(() => undefined);
    return window.mc.on('accounts:swapPending', (pending) => { if (alive.current) setSwapPending(pending); });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!settings.showAiUsage) return null;

  const visible = providers.filter((usage) => usage.status !== 'signedOut');
  const shown = summaryAccounts(providers);
  const refresh = async () => {
    setRefreshing(true);
    try { await window.mc.refreshUsage(); } catch { /* the next scheduled refresh retries */ } finally { if (alive.current) setRefreshing(false); }
  };
  const clearWarning = async () => {
    const choice = await askChoice(
      tr('Wyczyścić ostrzeżenie?'),
      tr('Kopia awaryjna poprzedniej zamiany (z danymi logowania) zostanie usunięta na stałe, a zamiany kont zostaną odblokowane. Zrób to dopiero po sprawdzeniu, że oba konta działają.'),
      [{ label: tr('Wyczyść ostrzeżenie'), value: 'yes', danger: true }],
    );
    if (choice !== 'yes') return;
    try {
      const result = await window.mc.clearSwapPending();
      if (result.ok) { if (alive.current) setSwapPending(false); }
      // The recovery of an interrupted activation waits for Claude Code's locks and keeps its backups until it is done.
      else if (result.error === 'locked') toast(tr('Claude Code trzyma teraz blokady plików logowania. Aplikacja sama ponawia naprawę przerwanej zamiany - spróbuj wyczyścić ostrzeżenie za chwilę.'));
      else toast(tr('Nie udało się wyczyścić ostrzeżenia.'), 'error');
    } catch {
      toast(tr('Nie udało się wyczyścić ostrzeżenia.'), 'error');
    }
  };
  const makeMain = async (target: ProviderUsage) => {
    if (swapping !== null) return;
    const main = providers.find((usage) => usage.provider === 'claude' && usage.active);
    const current = main?.email || tr('obecne konto główne');
    const name = target.email || NAMES.claude;
    const exhausted = target.windows.some((window) => effectivePercent(window, Date.now()) >= 100);
    // The main sign-in expired or is gone: there is nothing to save, the swap simply puts the chosen account in its place.
    const noMainLogin = !main || main.status === 'expired' || main.status === 'signedOut';
    const body = (noMainLogin
      ? tr('Obecne konto główne ({current}) nie ma ważnego logowania, więc nie ma czego zapisywać. Wybrane konto stanie się głównym logowaniem Claude Code. Otwarte sesje Claude zwykle przejmują nowe logowanie przy następnej wiadomości - sesję, która tego nie zrobi, wystarczy zrestartować lub wznowić.', { current })
      : tr('Logowanie obecnego konta głównego ({current}) zostanie zapisane na jego karcie, a wybrane konto stanie się głównym logowaniem Claude Code. Na czas zamiany aplikacja blokuje pliki logowania tak samo jak Claude Code. Otwarte sesje Claude zwykle przejmują nowe logowanie przy następnej wiadomości - sesję, która tego nie zrobi, wystarczy zrestartować lub wznowić.', { current }))
      + (exhausted ? `\n\n${tr('Limity tego konta są wyczerpane (100%), więc sesje mogą nie działać do czasu resetu.')}` : '');
    const choice = await askChoice(tr('Ustawić {name} jako konto główne?', { name }), body, [{ label: tr('Ustaw jako główne'), value: 'yes', primary: true }]);
    if (choice !== 'yes') return;
    setSwapping(target.accountId);
    try {
      const result = await window.mc.makeMainAccount(target.accountId.replace(/^claude:/, ''));
      if (result.ok) toast(result.email ? tr('Konto główne: {email}', { email: result.email }) : tr('Zmieniono konto główne.'));
      // The texts name the account: the main process' e-mail, else the card's.
      else { const text = swapErrorText({ error: result.error, email: result.email ?? target.email }); toast(tr(text.key, text.params), 'error'); }
    } catch {
      toast(tr('Nie udało się zmienić konta głównego.'), 'error');
    } finally {
      if (alive.current) setSwapping(null);
    }
  };
  const summary = usageSummary(providers, now) || tr('Konta AI');
  // Tooltip of one account: name plus every window, e.g. "Claude · 5 h 12% · 7 days 40%".
  const accountDetail = (usage: ProviderUsage, nowMs: number) => [
    usage.email || NAMES[usage.provider],
    ...usage.windows.map((window) => `${window.id === '5h' ? tr('5 godz.') : tr('7 dni')} ${Math.round(effectivePercent(window, nowMs))}%`),
  ].join(' · ');
  const updated = visible.length ? new Date(Math.max(...visible.map((usage) => usage.fetchedAt))).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) : '';
  const claudeCount = visible.filter((usage) => usage.provider === 'claude').length;
  const hasCodex = visible.some((usage) => usage.provider === 'codex');
  // On macOS Claude keeps its tokens in the Keychain, so isolated profiles cannot work there.
  const claudeLogin = claudeLoginActions(window.mc.platform, visible.some((usage) => usage.provider === 'claude' && usage.active));

  if (rail) {
    if (!shown.length) return null;
    return (
      <div className="usage-panel usage-rail" title={summary}>
        {shown.map((usage) => (
          <div key={usage.accountId} className={`usage-rail-item ${usage.status === 'dormant' ? 'dormant' : ''}`} title={accountDetail(usage, now)}>
            <ProviderIcon provider={usage.provider} size={14} />
            {usage.windows.map((window) => {
              const percent = effectivePercent(window, now);
              return (
                <div key={window.id} className="usage-rail-win">
                  <span className="usage-rail-line"><span>{window.id === '5h' ? '5h' : '7d'}</span><span>{Math.round(percent)}</span></span>
                  <Bar percent={percent} label={`${usage.email || NAMES[usage.provider]} ${window.id === '5h' ? tr('5 godz.') : tr('7 dni')}`} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  const collapsed = settings.usageCollapsed;
  const toggle = () => update((st) => updateSettings(st, { usageCollapsed: !collapsed }));
  // No Claude login can be saved while accounts.json is read-only: the entries stay visible, disabled, with the reason.
  const readOnlyHint = accountsReadOnly ? tr('Niedostępne: pliku kont aplikacji nie da się bezpiecznie odczytać (szczegóły w panelu limitów).') : undefined;
  const openAddMenu = (el: HTMLElement) => openMenuAt(el, [
    ...(claudeLogin.menu === 'new' ? [{ label: tr('Dodaj konto Claude'), disabled: !!readOnlyHint, onClick: () => openAuth('claude', { type: 'new' }) }] : []),
    ...(claudeLogin.menu === 'main' ? [{ label: tr('Zaloguj się do Claude'), disabled: !!readOnlyHint, onClick: () => openAuth('claude', { type: 'main' }) }] : []),
    ...(readOnlyHint && claudeLogin.menu ? [{ label: readOnlyHint, disabled: true, onClick: () => undefined }] : []),
    ...(hasCodex ? [] : [{ label: tr('Zaloguj się do Codex'), onClick: () => openAuth('codex', { type: 'main' }) }]),
  ]);
  return (
    <section className="usage-panel" aria-label={tr('Limity kont AI')}>
      <div className="usage-head">
        <button className="usage-title" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? tr('Rozwiń limity kont AI') : tr('Zwiń limity kont AI')}>
          {/* The chevron points where the panel goes: up to expand, down to collapse. */}
          <span className={`usage-chevron ${collapsed ? 'up' : ''}`}><IChevron /></span>
          {tr('Limity kont AI')}
        </button>
        <button className="btn ghost icon" onClick={(e) => openAddMenu(e.currentTarget)} title={tr('Dodaj konto')} aria-label={tr('Dodaj konto')}><IPlus /></button>
        <button className="btn ghost icon" onClick={() => void refresh()} disabled={spinning} title={tr('Odśwież limity')} aria-label={tr('Odśwież limity')}><RefreshIcon spinning={spinning} /></button>
      </div>
      {collapsed && (shown.length ? (
        <div className="usage-mini-list">
          {shown.map((usage) => {
            const label = usage.provider === 'claude' && claudeCount > 1 ? shortAccountName(usage.email, NAMES.claude, 7) : '';
            return (
              <div key={usage.accountId} className={`usage-mini ${usage.status === 'dormant' ? 'dormant' : ''}`} title={accountDetail(usage, now)}>
                <span className="usage-mini-who">
                  <ProviderIcon provider={usage.provider} size={12} />
                  {label && <span className="usage-mini-name">{label}</span>}
                </span>
                <span className="usage-mini-wins">
                  {usage.windows.map((window) => {
                    const percent = effectivePercent(window, now);
                    const upcoming = window.resetsAt * 1000 > now;
                    return (
                      <span key={window.id} className="usage-mini-win">
                        <span className="usage-mini-tag">{window.id === '5h' ? '5h' : '7d'}</span>
                        <span className="usage-mini-bar"><Bar percent={percent} label={`${usage.email || NAMES[usage.provider]} ${window.id === '5h' ? tr('5 godz.') : tr('7 dni')}`} /></span>
                        <span className="usage-mini-pct">{Math.round(percent)}%</span>
                        <span className="usage-mini-reset">{upcoming ? shortDuration(window.resetsAt - now / 1000) : ''}</span>
                      </span>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
      ) : <p className="usage-note">{providers.some((usage) => usage.status === 'dormant') ? tr(DORMANT_SHORT) : summary}</p>)}
      {!collapsed && (
        <>
          {swapPending && (
            <div className="usage-warning" role="alert">
              <p className="usage-note">{tr('Poprzednia zamiana kont została przerwana. Konta mogą wymagać ponownego zalogowania: sprawdź oba konta, a po wyczyszczeniu ostrzeżenia zaloguj się ponownie na każde, które przestało działać (logowanie Claude zawsze można wykonać od nowa). Do czasu wyczyszczenia ostrzeżenia kolejne zamiany są zablokowane.')}</p>
              <button className="btn small" onClick={() => void clearWarning()}>{tr('Wyczyść ostrzeżenie')}</button>
            </div>
          )}
          <AccountNotices notices={notices} setAside={setAside} copies={duplicateCopies} readOnlyPath={accountsReadOnly} />
          {visible.length ? (
            <>
              {visible.map((usage) => <AccountCard key={usage.accountId} usage={usage} savedIndex={visible.filter((u) => u.managed && u.provider === 'claude').indexOf(usage) + 1} now={now} language={language} showMain={claudeCount > 1} swapping={swapping} onMakeMain={(target) => void makeMain(target)} />)}
              {updated && <p className="usage-note">{tr('Zaktualizowano {time}', { time: updated })}</p>}
            </>
          ) : (
            <div className="usage-empty">
              <p className="usage-note">{tr('Brak podłączonych kont. Dodaj konto, aby zobaczyć limity.')}</p>
              <div className="usage-empty-buttons">
                <button className="btn small" disabled={!!readOnlyHint} title={readOnlyHint} onClick={() => openAuth('claude', { type: claudeLogin.emptyTarget })}><ProviderIcon provider="claude" size={14} />Claude</button>
                <button className="btn small" onClick={() => openAuth('codex', { type: 'main' })}><ProviderIcon provider="codex" size={14} />Codex</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
