// The Git panel of a project that has no repository yet (or a machine without git): the empty state of the side panels
// (PanelEmpty, like the Snippets panel) with the ways out: create a repository, clone one into the folder, install git.
import { useState } from 'react';
import { useI18n } from '../i18n';
import { askChoice, toast } from '../store';
import { refreshGitProbe } from '../git/gitProbe';
import { GitCloneDialog } from './GitClone';
import { EmptyLink, fillTokens, PanelEmpty } from './PanelEmpty';

export function GitSetup({ projectId, projectName, kind }: { projectId: string; projectName: string; kind: 'no-repo' | 'no-git' }) {
  const { tr, errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [cloning, setCloning] = useState(false);
  const windows = window.mc.platform === 'win32';

  const init = async () => {
    const choice = await askChoice(
      tr('Utworzyć repozytorium git?'),
      tr('W folderze projektu „{name}” powstanie repozytorium (polecenie git init, gałąź main). Pliki zostają bez zmian, a po utworzeniu możesz dodawać je do commitów.', { name: projectName }),
      [{ label: tr('Utwórz repozytorium'), value: 'init', primary: true }],
    );
    if (choice !== 'init') return;
    setBusy(true);
    try {
      const result = await window.mc.git.init(projectId);
      if (result.ok) toast(tr('Repozytorium git zostało utworzone.'));
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(tr('Git: {error}', { error: String(e) }), 'error'); }
    finally { setBusy(false); void refreshGitProbe(projectId); }
  };

  const install = async () => {
    setBusy(true);
    try {
      const result = await window.mc.git.installGit();
      if (result.ok) toast(result.data.restart ? tr('Git został zainstalowany. Uruchom aplikację ponownie, aby go wykryć.') : tr('Otwarto stronę pobierania Gita.'));
      else toast(tr('Nie udało się zainstalować Gita automatycznie: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(String(e), 'error'); }
    finally { setBusy(false); void refreshGitProbe(projectId); }
  };

  if (kind === 'no-git') {
    return (
      <div className="sidebar-content git-panel">
        <PanelEmpty>
          <p>{tr('Panel Git potrzebuje programu git na tym komputerze.')}{windows ? ` ${tr('Instalacja przez winget potrwa chwilę i może poprosić o zgodę.')}` : ''}</p>
          <button className="btn primary" disabled={busy} onClick={() => void install()}>{busy ? '…' : windows || window.mc.platform === 'darwin' ? tr('Zainstaluj Git') : tr('Pobierz Git')}</button>
          <p>{fillTokens(tr('Git możesz też pobrać z {site}, a potem {check}.'), {
            site: <EmptyLink onClick={() => window.mc.openExternal('https://git-scm.com/downloads')}>git-scm.com</EmptyLink>,
            check: <EmptyLink onClick={() => void refreshGitProbe(projectId)}>{tr('sprawdzić ponownie')}</EmptyLink>,
          })}</p>
        </PanelEmpty>
      </div>
    );
  }

  return (
    <div className="sidebar-content git-panel">
      <PanelEmpty>
        <p>{tr('Ten projekt nie ma jeszcze repozytorium git.')}</p>
        <button className="btn primary" disabled={busy} onClick={() => void init()}>{busy ? '…' : tr('Utwórz repozytorium')}</button>
        <button className="btn" disabled={busy} onClick={() => setCloning(true)}>{tr('Sklonuj repozytorium tutaj')}</button>
      </PanelEmpty>
      {cloning && <GitCloneDialog target={{ kind: 'here', projectId, projectName }} onClose={() => setCloning(false)} />}
    </div>
  );
}
