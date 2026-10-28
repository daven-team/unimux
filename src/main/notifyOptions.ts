/**
 * Options of an OS notification. It is always silent: the app plays the sound the user chose for the event itself
 * (preset, system beep or own file), so the OS notification sound would double it, and "sound off" must really be silent.
 */
export function notificationOptions(n: { title: string; body: string }): { title: string; body: string; silent: true } {
  return { title: String(n.title).slice(0, 200), body: String(n.body).slice(0, 500), silent: true };
}

export type NoticeButton = { text: string; answer?: 'allow' | 'deny' };

/**
 * 1.0.9: the buttons of a permission notification ('answer': Zezwól, Odrzuć, Pokaż; 'show': Pokaż only). Native actions on
 * macOS and on Windows (Electron 44 builds the toast's buttons itself; a click reaches the running app through the toast's
 * activation, under the app's AppUserModelID). Other platforms get none: a click on the notification still shows the cell.
 */
export function notificationActions(kind: 'answer' | 'show', platform: string, t: (key: 'Zezwól' | 'Odrzuć' | 'Pokaż') => string): NoticeButton[] {
  if (platform !== 'win32' && platform !== 'darwin') return [];
  const show = { text: t('Pokaż') };
  return kind === 'answer' ? [{ text: t('Zezwól'), answer: 'allow' }, { text: t('Odrzuć'), answer: 'deny' }, show] : [show];
}
