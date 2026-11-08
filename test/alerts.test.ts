import { describe, expect, it } from 'vitest';
import {
  alertEventOf, createAlertSoundThrottle, decideAlert, defaultAlerts, ERROR_PHRASES, errorPhrase, inQuietHours, normalizeAlerts,
  type AlertContext, type AlertSettings,
} from '../src/shared/alerts';
import { messages } from '../src/shared/messages';
import { formatEntry, StatusLog } from '../src/shared/statusLog';

const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);
const ctx = (patch: Partial<AlertContext> = {}): AlertContext => ({
  prev: 'working', status: 'waiting', cause: 'hook', hooked: true, reason: 'done', userLooking: false, agent: true, now: at(12), ...patch,
});
const withAlerts = (patch: Partial<AlertSettings>): AlertSettings => ({ ...defaultAlerts(), ...patch });

describe('decideAlert', () => {
  it('raises nothing at all while the master switch is off, and keeps the rest of the settings', () => {
    const off = withAlerts({ enabled: false });
    for (const reason of ['done', 'attention', 'error'] as const) {
      expect(decideAlert(off, ctx({ reason }))).toMatchObject({ notify: false, sound: null, suppressed: 'disabled' });
    }
    expect(normalizeAlerts({ ...off, events: off.events }).enabled).toBe(false);
    expect(normalizeAlerts({}).enabled).toBe(true);
    expect(defaultAlerts().enabled).toBe(true);
  });

  it('chooses the event from the hook reason', () => {
    expect(decideAlert(defaultAlerts(), ctx({ reason: 'done' })).event).toBe('done');
    expect(decideAlert(defaultAlerts(), ctx({ reason: 'attention' })).event).toBe('attention');
    expect(decideAlert(defaultAlerts(), ctx({ reason: 'error' })).event).toBe('error');
  });

  it('treats a heuristic waiting as finished whatever its reason', () => {
    expect(alertEventOf('heuristic', 'done')).toBe('done');
    expect(alertEventOf('heuristic', 'attention')).toBe('done');
    const decision = decideAlert(defaultAlerts(), ctx({ cause: 'heuristic', hooked: false, reason: 'done' }));
    expect(decision).toMatchObject({ event: 'done', notify: true, sound: { kind: 'preset', id: 'ding-dong' } });
  });

  it('returns the configured sound and notify flag of the event', () => {
    const a = defaultAlerts();
    a.events.attention = { notify: false, sound: { kind: 'file', path: 'C:\\a.wav' } };
    expect(decideAlert(a, ctx({ reason: 'attention' }))).toEqual({ event: 'attention', notify: false, sound: { kind: 'file', path: 'C:\\a.wav' } });
    a.events.done.sound = { kind: 'off' };
    expect(decideAlert(a, ctx())).toEqual({ event: 'done', notify: true, sound: null });
  });

  it('raises nothing for an event with both notification and sound off', () => {
    const a = defaultAlerts();
    a.events.error = { notify: false, sound: { kind: 'off' } };
    expect(decideAlert(a, ctx({ reason: 'error' }))).toEqual({ event: 'error', notify: false, sound: null, suppressed: 'disabled' });
  });

  it('never alerts for shell cells', () => {
    expect(decideAlert(defaultAlerts(), ctx({ agent: false }))).toMatchObject({ notify: false, sound: null });
  });

  it('keeps the transition rules: no alert on restore, none for a stall-based waiting of a hooked cell', () => {
    // idle -> waiting by heuristic (restore / launch)
    expect(decideAlert(defaultAlerts(), ctx({ prev: 'idle', cause: 'heuristic', hooked: false }))).toMatchObject({ notify: false, sound: null });
    // already waiting, or exited -> waiting
    expect(decideAlert(defaultAlerts(), ctx({ prev: 'waiting' }))).toMatchObject({ notify: false, sound: null });
    expect(decideAlert(defaultAlerts(), ctx({ prev: 'exited' }))).toMatchObject({ notify: false, sound: null });
    // lost Stop: the silence net of a hooked cell is not an alert
    expect(decideAlert(defaultAlerts(), ctx({ cause: 'heuristic', hooked: true }))).toMatchObject({ notify: false, sound: null });
    // a heuristic cell that was working does alert
    expect(decideAlert(defaultAlerts(), ctx({ cause: 'heuristic', hooked: false }))).toMatchObject({ notify: true });
    // not waiting at all
    expect(decideAlert(defaultAlerts(), ctx({ status: 'working' }))).toMatchObject({ notify: false, sound: null });
  });

  it('stays silent while the user looks at the cell, unless notifyWhenFocused', () => {
    expect(decideAlert(defaultAlerts(), ctx({ userLooking: true }))).toMatchObject({ notify: false, sound: null });
    const focused = withAlerts({ notifyWhenFocused: true });
    expect(decideAlert(focused, ctx({ userLooking: true }))).toMatchObject({ notify: true, sound: { kind: 'preset' } });
    expect(decideAlert(focused, ctx({ userLooking: false }))).toMatchObject({ notify: true });
  });

  it('quiet hours silence both the notification and the sound', () => {
    const quiet = withAlerts({ quietHours: { enabled: true, start: '22:00', end: '07:00' } });
    expect(decideAlert(quiet, ctx({ now: at(23) }))).toMatchObject({ notify: false, sound: null });
    expect(decideAlert(quiet, ctx({ now: at(3) }))).toMatchObject({ notify: false, sound: null });
    expect(decideAlert(quiet, ctx({ now: at(12) }))).toMatchObject({ notify: true, sound: { kind: 'preset' } });
    // also with notifyWhenFocused
    expect(decideAlert({ ...quiet, notifyWhenFocused: true }, ctx({ now: at(23), userLooking: true }))).toMatchObject({ notify: false, sound: null });
  });

  it('throttles bursts of sounds per event but not the notifications, and only counts sounds that would play', () => {
    const allow = createAlertSoundThrottle(1000);
    const first = decideAlert(defaultAlerts(), ctx({ allowSound: allow }));
    const second = decideAlert(defaultAlerts(), ctx({ allowSound: allow }));
    expect(first.sound).not.toBeNull();
    expect(second).toMatchObject({ notify: true, sound: null, suppressed: 'sound-throttled' });
    // a silent event does not consume the window
    const quiet = createAlertSoundThrottle(1000);
    const a = defaultAlerts();
    a.events.done.sound = { kind: 'off' };
    decideAlert(a, ctx({ allowSound: quiet }));
    expect(decideAlert(defaultAlerts(), ctx({ allowSound: quiet })).sound).not.toBeNull();
  });

  it('a finished sound never swallows the needs-you or error sound within the window', () => {
    const allow = createAlertSoundThrottle(1000);
    const t0 = at(12, 0).getTime();
    const done = decideAlert(defaultAlerts(), ctx({ allowSound: allow, now: new Date(t0) }));
    const attention = decideAlert(defaultAlerts(), ctx({ allowSound: allow, reason: 'attention', now: new Date(t0 + 100) }));
    const error = decideAlert(defaultAlerts(), ctx({ allowSound: allow, reason: 'error', now: new Date(t0 + 200) }));
    const doneAgain = decideAlert(defaultAlerts(), ctx({ allowSound: allow, now: new Date(t0 + 300) }));
    expect([done.sound?.kind, attention.sound?.kind, error.sound?.kind]).toEqual(['preset', 'preset', 'preset']);
    expect(doneAgain.sound).toBeNull();
    expect(doneAgain.suppressed).toBe('sound-throttled');
    // two finished sounds within the window play once; the window opens again afterwards
    expect(decideAlert(defaultAlerts(), ctx({ allowSound: allow, now: new Date(t0 + 1000) })).sound).not.toBeNull();
  });

  it('reports why a real alert transition raised nothing', () => {
    expect(decideAlert(defaultAlerts(), ctx({ userLooking: true })).suppressed).toBe('focused');
    expect(decideAlert(withAlerts({ quietHours: { enabled: true, start: '09:00', end: '17:00' } }), ctx({ now: at(12) })).suppressed).toBe('quiet-hours');
    const off = defaultAlerts();
    off.events.done = { notify: false, sound: { kind: 'off' } };
    expect(decideAlert(off, ctx()).suppressed).toBe('disabled');
    // no alert transition or a shell cell: nothing to explain
    expect(decideAlert(defaultAlerts(), ctx({ prev: 'waiting' })).suppressed).toBeUndefined();
    expect(decideAlert(defaultAlerts(), ctx({ agent: false })).suppressed).toBeUndefined();
    expect(decideAlert(defaultAlerts(), ctx()).suppressed).toBeUndefined();
  });
});

describe('inQuietHours', () => {
  const q = (start: string, end: string, enabled = true) => ({ enabled, start, end });
  it('handles a same-day range', () => {
    expect(inQuietHours(q('09:00', '17:00'), at(9))).toBe(true);
    expect(inQuietHours(q('09:00', '17:00'), at(16, 59))).toBe(true);
    expect(inQuietHours(q('09:00', '17:00'), at(17))).toBe(false);
    expect(inQuietHours(q('09:00', '17:00'), at(8, 59))).toBe(false);
  });
  it('handles a range that wraps midnight', () => {
    expect(inQuietHours(q('22:00', '07:00'), at(22))).toBe(true);
    expect(inQuietHours(q('22:00', '07:00'), at(0, 30))).toBe(true);
    expect(inQuietHours(q('22:00', '07:00'), at(6, 59))).toBe(true);
    expect(inQuietHours(q('22:00', '07:00'), at(7))).toBe(false);
    expect(inQuietHours(q('22:00', '07:00'), at(21, 59))).toBe(false);
  });
  it('is off when disabled, empty or malformed', () => {
    expect(inQuietHours(q('22:00', '07:00', false), at(23))).toBe(false);
    expect(inQuietHours(q('10:00', '10:00'), at(10))).toBe(false);
    expect(inQuietHours(q('25:00', '07:00'), at(23))).toBe(false);
  });
});

describe('error phrases', () => {
  it('maps every documented code to a translated phrase and falls back to unknown', () => {
    expect(errorPhrase('rate_limit')).toBe('limit osiągnięty');
    expect(errorPhrase('nope')).toBe('nieznany błąd');
    expect(errorPhrase(undefined)).toBe('nieznany błąd');
    expect(errorPhrase('__proto__')).toBe('nieznany błąd');
    for (const key of Object.values(ERROR_PHRASES)) expect(Object.hasOwn(messages, key)).toBe(true);
    for (const key of ['{name} skończył pracę', '{name} potrzebuje Ciebie', '{name} - błąd: {detail}']) expect(Object.hasOwn(messages, key)).toBe(true);
  });
});

describe('status log alert markers', () => {
  const entry = (log: StatusLog) => log.push({ at: 0, cellId: 'c', from: 'working', to: 'waiting', cause: 'hook', trigger: 'stop', reason: 'done' });
  it('records an alert and a suppressed alert with its reason', () => {
    const log = new StatusLog();
    entry(log); log.markAlert('c');
    entry(log); log.markAlert('c', 'quiet-hours');
    const [raised, held] = log.list().map(formatEntry);
    expect(raised).toMatch(/ alert( |$)/);
    expect(raised).not.toContain('suppressed');
    expect(held).toContain('alert=suppressed:quiet-hours');
    expect(held).not.toMatch(/ alert( |$)/);
  });
});
