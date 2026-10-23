// Small renderer helpers around the CLI status (kept out of actions.ts so components can import them cheaply).
import { profileAvailable, type CliStatusMap } from '../../shared/cliStatus';
import type { MessageKey, MessageParams } from '../../shared/i18n';
import { shownProfileName } from '../../shared/profiles';
import type { Profile } from '../../shared/types';
import { getS } from './store';

/** A profile's shown name: the built-in shell profile follows the shell chosen in Settings (see shownProfileName). */
export function profileName(profile: Pick<Profile, 'id' | 'name' | 'cli'>, tr: (key: MessageKey, params?: MessageParams) => string): string {
  return shownProfileName(profile, getS().settings.shell, tr);
}

/** Profile name for menus and selects; profiles whose CLI is not installed stay selectable but are annotated. */
export function profileOptionLabel(
  profile: Pick<Profile, 'id' | 'name' | 'cli'>,
  cliStatus: CliStatusMap,
  tr: (key: MessageKey, params?: MessageParams) => string,
): string {
  const name = profileName(profile, tr);
  return profileAvailable(profile, cliStatus) ? name : `${name} ${tr('(niezainstalowany)')}`;
}
