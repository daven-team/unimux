// Alerts: an OS notification and/or a sound per agent event (finished, needs you, error).
// Everything here is pure: settings model, migration of the retired waiting-sound settings, and the decision of what to raise.
import type { MessageKey } from './i18n';
import type { CellStatus, StatusCause, StatusReason } from './status';
import { shouldNotify } from './status';
import { createSoundThrottle, isLocalAbsolutePath, shouldAlertUser, SOUND_THROTTLE_MS } from './sound';
import { isPresetId, type PresetId } from './soundPresets';

export type AlertEventId = 'done' | 'attention' | 'error';
export const ALERT_EVENTS: readonly AlertEventId[] = ['done', 'attention', 'error'];

export type SoundChoice =
  | { kind: 'off' }
  | { kind: 'preset'; id: PresetId }
  | { kind: 'system' }
  | { kind: 'file'; path: string };

export interface EventAlert {
  notify: boolean;
  sound: SoundChoice;
}

export interface QuietHours {
  enabled: boolean;
  /** 'HH:MM', local time; alerts are suppressed from `start` (inclusive) to `end` (exclusive), the range may wrap midnight. */
  start: string;
  end: string;
}

export interface AlertSettings {
  /** The master switch: false silences every alert (popups and sounds) whatever the events below say. */
  enabled: boolean;
  /** 0..1, applies to presets and own files (the system sound ignores it). */
  volume: number;
  /** Also alert while the app window is focused and the cell is visible. */
  notifyWhenFocused: boolean;
  quietHours: QuietHours;
  events: Record<AlertEventId, EventAlert>;
  /** 1.0.9: "Zezwól" / "Odrzuć" / "Pokaż" in the notification of a permission request (see shared/permissionAction). */
  notificationActions: boolean;
  /** 1.0.9: flash the taskbar button (Windows) / bounce the Dock icon once (macOS) when an agent needs you in an unfocused window. */
  flashWindow: boolean;
  /** 1.0.9: the number of agents waiting for you on the taskbar button (Windows overlay) / the Dock icon (macOS badge). */
  taskbarBadge: boolean;
  /** 1.0.9: Windows: the taskbar button shows an indeterminate progress while any agent works. */
  taskbarProgress: boolean;
}

export const DEFAULT_ALERT_VOLUME = 0.7;
export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: '22:00', end: '07:00' };
const MAX_PATH_LENGTH = 1024;

export const DEFAULT_EVENT_SOUNDS: Record<AlertEventId, SoundChoice> = {
  done: { kind: 'preset', id: 'ding-dong' },
  attention: { kind: 'preset', id: 'alert' },
  error: { kind: 'preset', id: 'low-warn' },
};

export function defaultAlerts(): AlertSettings {
  return {
    enabled: true,
    volume: DEFAULT_ALERT_VOLUME,
    notifyWhenFocused: false,
    quietHours: { ...DEFAULT_QUIET_HOURS },
    events: {
      done: { notify: true, sound: { ...DEFAULT_EVENT_SOUNDS.done } },
      attention: { notify: true, sound: { ...DEFAULT_EVENT_SOUNDS.attention } },
      error: { notify: true, sound: { ...DEFAULT_EVENT_SOUNDS.error } },
    },
    notificationActions: true,
    flashWindow: true,
    taskbarBadge: true,
    taskbarProgress: true,
  };
}

export function isAlertEvent(value: unknown): value is AlertEventId {
  return typeof value === 'string' && (ALERT_EVENTS as readonly string[]).includes(value);
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeVolume(value: unknown, fallback = DEFAULT_ALERT_VOLUME): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1, value)) * 100) / 100 : fallback;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value);

export function normalizeQuietHours(value: unknown): QuietHours {
  const q = isObject(value) ? value : {};
  return {
    enabled: q.enabled === true,
    start: isTime(q.start) ? q.start : DEFAULT_QUIET_HOURS.start,
    end: isTime(q.end) ? q.end : DEFAULT_QUIET_HOURS.end,
  };
}

export function isUsablePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes('\0') && isLocalAbsolutePath(value);
}

export function normalizeSoundChoice(value: unknown, fallback: SoundChoice): SoundChoice {
  if (!isObject(value)) return { ...fallback };
  if (value.kind === 'off') return { kind: 'off' };
  if (value.kind === 'system') return { kind: 'system' };
  if (value.kind === 'preset' && isPresetId(value.id)) return { kind: 'preset', id: value.id };
  if (value.kind === 'file' && isUsablePath(value.path)) return { kind: 'file', path: value.path };
  return { ...fallback };
}

/** Reads a saved `alerts` object; every missing or corrupt field falls back to its default. */
export function normalizeAlerts(value: unknown): AlertSettings {
  const r = isObject(value) ? value : {};
  const d = defaultAlerts();
  const events = isObject(r.events) ? r.events : {};
  const event = (id: AlertEventId): EventAlert => {
    const e = isObject(events[id]) ? events[id] as Record<string, unknown> : {};
    return { notify: typeof e.notify === 'boolean' ? e.notify : d.events[id].notify, sound: normalizeSoundChoice(e.sound, d.events[id].sound) };
  };
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    volume: normalizeVolume(r.volume),
    notifyWhenFocused: typeof r.notifyWhenFocused === 'boolean' ? r.notifyWhenFocused : d.notifyWhenFocused,
    quietHours: normalizeQuietHours(r.quietHours),
    events: { done: event('done'), attention: event('attention'), error: event('error') },
    notificationActions: typeof r.notificationActions === 'boolean' ? r.notificationActions : d.notificationActions,
    flashWindow: typeof r.flashWindow === 'boolean' ? r.flashWindow : d.flashWindow,
    taskbarBadge: typeof r.taskbarBadge === 'boolean' ? r.taskbarBadge : d.taskbarBadge,
    taskbarProgress: typeof r.taskbarProgress === 'boolean' ? r.taskbarProgress : d.taskbarProgress,
  };
}

/** Keys of the retired settings (a boolean, a three-way sound mode, its file and volume 0-100, and the focus option). */
export const LEGACY_ALERT_KEYS = ['notifications', 'waitingSound', 'waitingSoundFile', 'waitingSoundVolume', 'notifyWhenFocused'] as const;

/**
 * Builds the alerts from the retired settings keys of a saved state. Without any of them (a fresh install) the defaults apply.
 * The old sound played whenever the agent started waiting for the user, which included a turn that ended with an error,
 * so the chosen sound moves to all three events (system -> system, own file -> the same file, off -> off).
 */
export function migrateLegacyAlerts(settings: Record<string, unknown>): AlertSettings {
  const d = defaultAlerts();
  if (!LEGACY_ALERT_KEYS.some((key) => key in settings)) return d;
  const notify = typeof settings.notifications === 'boolean' ? settings.notifications : true;
  const file = settings.waitingSoundFile;
  const volume = typeof settings.waitingSoundVolume === 'number' && Number.isFinite(settings.waitingSoundVolume)
    ? normalizeVolume(settings.waitingSoundVolume / 100) : DEFAULT_ALERT_VOLUME;
  const waiting: SoundChoice = settings.waitingSound === 'system' ? { kind: 'system' }
    : settings.waitingSound === 'custom' ? (isUsablePath(file) ? { kind: 'file', path: file } : { kind: 'system' }) // custom without a file used to beep
      : { kind: 'off' };
  return {
    ...d,
    volume,
    notifyWhenFocused: settings.notifyWhenFocused === true,
    events: {
      done: { notify, sound: waiting },
      attention: { notify, sound: { ...waiting } },
      error: { notify, sound: { ...waiting } },
    },
  };
}

/** The saved alerts when present, otherwise the migration of the retired keys. */
export function readAlerts(settings: Record<string, unknown> | undefined): AlertSettings {
  const s = settings ?? {};
  return isObject(s.alerts) ? normalizeAlerts(s.alerts) : migrateLegacyAlerts(s);
}

// ── quiet hours ─────────────────────────────────────────────────────────────

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** True when `now` (local time) is inside the quiet range. An empty range (start = end) never suppresses. */
export function inQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled || !isTime(quiet.start) || !isTime(quiet.end)) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// ── decision ────────────────────────────────────────────────────────────────

export interface AlertContext {
  prev: CellStatus;
  status: CellStatus;
  cause: StatusCause;
  hooked: boolean;
  reason: StatusReason;
  /** Window focused and the cell visible. */
  userLooking: boolean;
  /** Claude or Codex cell (never a shell). */
  agent: boolean;
  /** The user muted this cell's alerts (cell menu). */
  muted?: boolean;
  /** This turn already raised its alert (see `createTurnDedupe`). */
  duplicate?: boolean;
  now: Date;
  /** Asked only when a sound would play; allowed calls open a new quiet window (see createAlertSoundThrottle). */
  allowSound?: (nowMs: number, event: AlertEventId) => boolean;
}

/** Why a real alert transition raised nothing (or no sound); recorded in the status log so bug reports show it. */
export type AlertSuppression = 'focused' | 'quiet-hours' | 'disabled' | 'sound-throttled' | 'muted' | 'duplicate';

/** One burst throttle per event: a finished sound must not swallow the needs-you or error sound that follows. */
export function createAlertSoundThrottle(windowMs = SOUND_THROTTLE_MS): (nowMs: number, event: AlertEventId) => boolean {
  const byEvent = Object.fromEntries(ALERT_EVENTS.map((event) => [event, createSoundThrottle(windowMs)])) as Record<AlertEventId, (now: number) => boolean>;
  return (nowMs, event) => byEvent[event](nowMs);
}

export interface AlertDecision {
  event: AlertEventId;
  notify: boolean;
  /** What to play, or null for silence. */
  sound: SoundChoice | null;
  /** Set when the transition deserved an alert but something held it back (all of it, or only the sound for a burst). */
  suppressed?: AlertSuppression;
}

/**
 * One alert per turn and event: finished / error alerts of a cell are raised once for each turn key (a user turn of the
 * heuristic, the turn id of a Codex notify). Attention is never deduped (every approval is a new question), and a missing
 * key (hook-driven Claude, whose "Stop that continued" legitimately alerts again) is always allowed.
 */
export function createTurnDedupe(): (cellId: string, event: AlertEventId, turn: string | undefined) => boolean {
  const last = new Map<string, string>();
  return (cellId, event, turn) => {
    if (turn === undefined || event === 'attention') return true;
    const key = `${cellId}:${event}`;
    if (last.get(key) === turn) return false;
    last.set(key, turn);
    return true;
  };
}

/**
 * The event of a cell that just started waiting: an error is an error however it was learned (a hook, or the failure line
 * of Codex output); attention needs a precise hook; anything else is "finished".
 */
export function alertEventOf(cause: StatusCause, reason: StatusReason): AlertEventId {
  if (reason === 'error') return 'error';
  return cause === 'hook' && reason === 'attention' ? reason : 'done';
}

/**
 * What to raise for a status change. It keeps every rule of the former notification: only a real transition seen in this
 * session (no alert on restore, none for a silence-based "waiting" of a hooked cell), nothing while the user looks at the
 * cell unless `notifyWhenFocused`, nothing for shell cells. On top: quiet hours silence everything, a disabled event
 * raises nothing, and bursts of sounds are throttled.
 */
export function decideAlert(alerts: AlertSettings, ctx: AlertContext): AlertDecision {
  const event = alertEventOf(ctx.cause, ctx.reason);
  const none: AlertDecision = { event, notify: false, sound: null };
  if (!ctx.agent || !shouldNotify(ctx.prev, ctx.status, ctx.cause, ctx.hooked)) return none;
  if (ctx.muted) return { ...none, suppressed: 'muted' };
  if (ctx.duplicate) return { ...none, suppressed: 'duplicate' };
  if (!alerts.enabled) return { ...none, suppressed: 'disabled' };
  if (!shouldAlertUser(true, ctx.userLooking, alerts.notifyWhenFocused)) return { ...none, suppressed: 'focused' };
  if (inQuietHours(alerts.quietHours, ctx.now)) return { ...none, suppressed: 'quiet-hours' };
  const config = alerts.events[event];
  const wantsSound = config.sound.kind !== 'off';
  if (!config.notify && !wantsSound) return { ...none, suppressed: 'disabled' };
  const soundAllowed = !wantsSound || (ctx.allowSound?.(ctx.now.getTime(), event) ?? true);
  return {
    event, notify: config.notify, sound: wantsSound && soundAllowed ? config.sound : null,
    ...(wantsSound && !soundAllowed ? { suppressed: 'sound-throttled' as const } : {}),
  };
}

// ── notification text ───────────────────────────────────────────────────────

/** Human phrases of the StopFailure error codes; unknown codes use the last entry. */
export const ERROR_PHRASES: Record<string, MessageKey> = {
  rate_limit: 'limit osiągnięty',
  overloaded: 'serwer przeciążony',
  authentication_failed: 'błąd uwierzytelniania',
  oauth_org_not_allowed: 'organizacja bez dostępu',
  account_on_hold: 'konto wstrzymane',
  billing_error: 'problem z rozliczeniem',
  invalid_request: 'nieprawidłowe żądanie',
  model_not_found: 'nie znaleziono modelu',
  server_error: 'błąd serwera',
  max_output_tokens: 'limit tokenów odpowiedzi',
  cloud_credential_error: 'błąd poświadczeń chmury',
  unknown: 'nieznany błąd',
  /** Codex: "You've hit your usage limit" in its output. */
  'usage-limit': 'limit osiągnięty',
  /** The agent CLI ended in the middle of a turn with nobody at the keyboard (status.ts, agent cells with prompt marks). */
  'cli-exited': 'CLI zakończył działanie',
};

/** Error codes that mean "a limit was reached": the cell header says so instead of a generic error. */
export const LIMIT_ERRORS: ReadonlySet<string> = new Set(['rate_limit', 'usage-limit']);

/** Header label of a cell whose last turn failed: "limit reached" for limits, a plain "error" otherwise. */
export function failureLabel(code: string | undefined): MessageKey {
  return code && LIMIT_ERRORS.has(code) ? 'limit osiągnięty' : 'błąd';
}

export function errorPhrase(code: string | undefined): MessageKey {
  return (code && Object.hasOwn(ERROR_PHRASES, code) ? ERROR_PHRASES[code] : ERROR_PHRASES.unknown);
}
