import { createTerminalLinkOpener } from '../../shared/terminalLinks';
import { isTrustedLink, linkHost, withTrustedHost } from '../../shared/linkTrust';
import { updateSettings } from '../../shared/state';
import { askChoiceChecked, getS, getUi, toast, update } from './store';
import { tr } from './i18n';
export const confirmTerminalLink = createTerminalLinkOpener({
  isBusy: () => { const ui = getUi(); return !!(ui.dialog || ui.modal || ui.palette); },
  invalid: () => toast(tr('Nieobsługiwany adres linku.'), 'error'),
  // 1.2.5: the address in a box with its host in bold, "Kopiuj", and "Nie pytaj więcej o ten adres" (trusts its host).
  confirm: async (address) => {
    if (isTrustedLink(getS().settings.trustedLinkHosts, address)) return true;
    const { value, checked } = await askChoiceChecked(tr('Otworzyć link w przeglądarce?'), '', [
      { label: tr('Kopiuj'), value: 'copy', side: 'left' },
      { label: tr('Otwórz'), value: 'open', primary: true, hint: 'Enter' },
    ], tr('Nie pytaj więcej o ten adres'), { url: address });
    if (value === 'copy') {
      window.mc.clipboardWrite(address);
      toast(tr('Skopiowano link.'));
      return false;
    }
    const host = linkHost(address);
    if (value === 'open' && checked && host) update((st) => updateSettings(st, { trustedLinkHosts: withTrustedHost(st.settings.trustedLinkHosts, host) }));
    return value === 'open';
  },
  open: (address) => window.mc.openExternal(address),
});
