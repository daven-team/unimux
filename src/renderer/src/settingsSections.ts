// The sections of the Settings page in their order; deep links (`ui.settingsSection`) find a section by its name.
// 1.0.7: six sections instead of eight. 1.1.2: "Konta i limity" (the limits panel, the switcher and the limit warnings).
import type { MessageKey } from '../../shared/i18n';

export const SETTINGS_SECTIONS = ['Ogólne', 'Terminal', 'Powiadomienia i dźwięki', 'Konta i limity', 'Agenci', 'Skróty klawiszowe', 'SSH'] as const satisfies readonly MessageKey[];
export type SettingsSectionName = (typeof SETTINGS_SECTIONS)[number];

/** The index of a section, for `ui.settingsSection`. */
export const settingsSectionIndex = (name: SettingsSectionName): number => SETTINGS_SECTIONS.indexOf(name);
