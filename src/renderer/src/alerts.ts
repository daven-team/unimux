// Raises the alerts (OS notification and sound) for agent status changes. The decision itself is pure (shared/alerts).
import { ALERT_EVENTS, alertEventOf, createAlertSoundThrottle, createTurnDedupe, decideAlert, type AlertEventId } from '../../shared/alerts';
import { alertBody as bodyOf, alertNotice, createAlertBurst, groupAlerts, type AlertItem } from '../../shared/alertBurst';
import { cellLabel } from '../../shared/agentWork';
import { activeProject, activeTab, findCell, getProfile } from '../../shared/state';
import { shouldNotify, type CellStatus, type HookInfo, type StatusCause, type StatusReason } from '../../shared/status';
import { playAlertSound } from './alertSound';
import { profileName } from './cliUi';
import { tr } from './i18n';
import { getS, getUi } from './store';
import { statusLog, terminals } from './terminals/TerminalManager';
import { noticeActions } from '../../shared/permissionAction';

function isVisible(cellId: string): boolean {
  const tab = activeTab(activeProject(getS()));
  if (!tab?.cells.some((c) => c.id === cellId)) return false;
  const max = getUi().maximizedCellId;
  return !max || max === cellId;
}

/** Body of the OS notification: what happened to which agent (and for an error, the human phrase of its code). */
export function alertBody(event: AlertEventId, name: string, errorCode?: string): string {
  return bodyOf(tr, event, name, errorCode);
}

/** Notifications wait about a second for others: a burst of turn ends becomes one notification per event. */
const burst = createAlertBurst<AlertItem>((items) => {
  for (const group of groupAlerts(items)) {
    const notice = alertNotice(tr, group);
    // 1.0.9: a single cell's permission dialog gets Zezwól / Odrzuć / Pokaż; its token is taken now, when the toast goes out.
    const enabled = getS().settings.alerts.notificationActions;
    const token = enabled && group.length === 1 && group[0].event === 'attention' ? terminals.permissionToken(notice.cellId) : null;
    window.mc.notify({ ...notice, ...noticeActions({ event: group[0].event, cells: group.length, enabled, token }) });
  }
}, { setTimer: (fn, ms) => window.setTimeout(fn, ms), clearTimer: (timer) => window.clearTimeout(timer as number) });

const allowSound = createAlertSoundThrottle();
const firstOfTurn = createTurnDedupe();

/** Called for every status change of a cell; raises whatever the alert settings and the status rules allow. */
export function alertForStatus(
  cellId: string, status: CellStatus, prev: CellStatus, cause: StatusCause, reason: StatusReason, hooked: boolean, info?: HookInfo,
): void {
  if (status !== 'waiting') return;
  const s = getS();
  const found = findCell(s, cellId);
  if (!found) return;
  const profile = getProfile(s, found.cell.profileId);
  // One finished / error alert per turn, so a redraw after minimize / restore that revives the status cannot alert again.
  const duplicate = shouldNotify(prev, status, cause, hooked) && !firstOfTurn(cellId, alertEventOf(cause, reason), info?.turn);
  const decision = decideAlert(s.settings.alerts, {
    prev, status, cause, hooked, reason, agent: profile.cli !== 'shell', now: new Date(), allowSound,
    muted: found.cell.muted === true, duplicate,
    userLooking: document.hasFocus() && isVisible(cellId),
  });
  if (decision.suppressed) statusLog.markAlert(cellId, decision.suppressed);
  if (!decision.notify && !decision.sound) return;
  statusLog.markAlert(cellId);
  if (decision.notify) {
    burst.push({
      event: decision.event, cellId, label: cellLabel(found.cell, getUi().sessionTitles, profileName(profile, tr)), errorCode: info?.error,
      projectId: found.project.id, projectName: found.project.name, tabId: found.tab.id, tabName: found.tab.name,
    });
  }
  if (decision.sound) void playAlertSound(decision.event, decision.sound);
  // 1.0.9: the taskbar button flashes (the Dock icon bounces once) when the window is not focused; main checks the focus.
  if (decision.event === 'attention' && s.settings.alerts.flashWindow && !document.hasFocus()) window.mc.flashAttention();
}

let previewing = false;

/** Short preview of an event sound at `volume` after the slider was committed; never overlaps itself. System beeps are skipped (they ignore the volume). */
export async function previewVolume(volume: number): Promise<void> {
  if (previewing) return;
  const { events } = getS().settings.alerts;
  const event = ALERT_EVENTS.find((e) => events[e].sound.kind === 'preset' || events[e].sound.kind === 'file');
  if (!event) return;
  previewing = true;
  try {
    await playAlertSound(event, events[event].sound, volume);
  } finally {
    setTimeout(() => { previewing = false; }, 700);
  }
}

/** The test button of the settings: plays exactly what would play, and sends a sample notification only when it is on. */
export async function testAlert(event: AlertEventId): Promise<boolean> {
  const s = getS();
  const { alerts } = s.settings;
  const config = alerts.events[event];
  const agent = s.profiles.find((p) => p.cli === 'claude')?.name ?? 'Claude';
  if (config.notify) window.mc.notify({ title: 'unimux', body: alertBody(event, agent, 'rate_limit'), cellId: '' });
  return playAlertSound(event, config.sound, alerts.volume);
}
