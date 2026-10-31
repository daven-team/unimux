import { tr } from './i18n';
// Grid templates (1.1.1): save a grid as a template, open a new grid from one, rename, update and delete them.
import { applyTemplateCells, captureTemplate, TEMPLATE_LIMITS, templateFolders, templatesFor } from '../../shared/gridTemplates';
import { removePreset, uid, upsertPreset } from '../../shared/state';
import type { Preset, PresetCell } from '../../shared/types';
import type { MenuItem } from './components/ContextMenu';
import { openTab, type TabSpecCell } from './actions';
import { askChoice, askText, getS, toast, update } from './store';

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * Template cells ready for openTab in a project: folders resolved against its root (a folder missing there falls back to the root
 * with a short note) and a profile deleted since replaced by the default one.
 */
export async function resolveTemplateCells(projectPath: string, cells: PresetCell[]): Promise<TabSpecCell[]> {
  const platform = window.mc.platform;
  const found = new Set<string>();
  await Promise.all(templateFolders(cells, projectPath, platform).map(async (folder) => {
    if (await window.mc.pathExists(folder).catch(() => false)) found.add(folder);
  }));
  const applied = applyTemplateCells(cells, projectPath, platform, (folder) => found.has(folder));
  if (applied.missing.length) toast(tr('Brak folderu w tym projekcie: {folders}. Te komórki startują w katalogu projektu.', { folders: applied.missing.join(', ') }));
  const s = getS();
  const fallback = s.profiles.some((p) => p.id === s.settings.lastProfileId) ? s.settings.lastProfileId : s.profiles[0].id;
  return applied.cells.map((cell) => (s.profiles.some((p) => p.id === cell.profileId) ? cell : { ...cell, profileId: fallback, role: undefined }));
}

/** Opens a new grid from a template in a project; resolves to the new cells' ids. */
export async function openTemplate(projectId: string, templateId: string): Promise<string[]> {
  const s = getS();
  const project = s.projects.find((p) => p.id === projectId);
  const template = s.presets.find((p) => p.id === templateId);
  if (!project || !template) return [];
  const cells = await resolveTemplateCells(project.path, template.cells);
  return openTab(projectId, template.layout, cells, template.name);
}

/** "Save as template…" of a grid: a global template; a template with the same name can be replaced (its id is kept). */
export async function saveGridAsTemplate(projectId: string, tabId: string): Promise<void> {
  const s = getS();
  const project = s.projects.find((p) => p.id === projectId);
  const tab = project?.tabs.find((t) => t.id === tabId);
  if (!project || !tab) return;
  const name = (await askText(tr('Nazwa szablonu'), tab.name))?.trim().slice(0, TEMPLATE_LIMITS.name);
  if (!name) return;
  const latest = getS();
  const same = latest.presets.find((p) => !p.projectId && sameName(p.name, name));
  let id: string = uid();
  if (same) {
    const choice = await askChoice(tr('Szablon „{name}” już istnieje', { name }), tr('Zastąpić go układem i komórkami tego gridu?'), [
      { label: tr('Zapisz jako nowy'), value: 'new' },
      { label: tr('Zastąp'), value: 'replace', primary: true },
    ]);
    if (!choice) return;
    if (choice === 'replace') id = same.id;
  }
  if (id !== same?.id && latest.presets.length >= TEMPLATE_LIMITS.count) {
    toast(tr('Osiągnięto limit szablonów ({count}). Usuń któryś, żeby zapisać nowy.', { count: TEMPLATE_LIMITS.count }), 'error');
    return;
  }
  const current = getS().projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId) ?? tab;
  update((st) => upsertPreset(st, captureTemplate({ id, name, project, tab: current, platform: window.mc.platform })));
  toast(tr('Zapisano szablon „{name}”', { name }));
}

/** Replaces a template's layout and cells with a grid's (name, id and scope stay). */
export function updateTemplateFromGrid(templateId: string, projectId: string, tabId: string): void {
  const s = getS();
  const template = s.presets.find((p) => p.id === templateId);
  const project = s.projects.find((p) => p.id === projectId);
  const tab = project?.tabs.find((t) => t.id === tabId);
  if (!template || !project || !tab) return;
  const next = captureTemplate({ id: template.id, name: template.name, project, tab, platform: window.mc.platform });
  update((st) => upsertPreset(st, { ...next, ...(template.projectId ? { projectId: template.projectId } : {}) }));
  toast(tr('Zaktualizowano szablon „{name}”', { name: template.name }));
}

export async function renameTemplate(templateId: string): Promise<void> {
  const template = getS().presets.find((p) => p.id === templateId);
  if (!template) return;
  const name = (await askText(tr('Nazwa szablonu'), template.name))?.trim().slice(0, TEMPLATE_LIMITS.name);
  if (!name || name === template.name) return;
  update((st) => { const t = st.presets.find((p) => p.id === templateId); return t ? upsertPreset(st, { ...t, name }) : st; });
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const template = getS().presets.find((p) => p.id === templateId);
  if (!template) return;
  const ok = await askChoice(tr('Usunąć szablon „{name}”?', { name: template.name }), tr('Gridy utworzone z tego szablonu zostają.'), [
    { label: tr('Anuluj'), value: '' },
    { label: tr('Usuń'), value: 'delete', danger: true },
  ]);
  if (ok === 'delete') update((st) => removePreset(st, templateId));
}

/** The menu of one template (the grid dialog's chips): rename, update from the project's grid on screen, delete. */
export function templateMenuItems(template: Preset, projectId: string): MenuItem[] {
  const project = getS().projects.find((p) => p.id === projectId);
  const tab = project?.tabs.find((t) => t.id === project.activeTabId);
  return [
    { header: template.name },
    { label: tr('Zmień nazwę'), onClick: () => void renameTemplate(template.id) },
    { label: tab ? tr('Zaktualizuj z gridu „{name}”', { name: tab.name }) : tr('Zaktualizuj z bieżącego gridu'), disabled: !tab, onClick: () => { if (tab) updateTemplateFromGrid(template.id, projectId, tab.id); } },
    { sep: true },
    { label: tr('Usuń szablon'), danger: true, onClick: () => void deleteTemplate(template.id) },
  ];
}

/** "New grid from template" entries of the Add menu (empty without templates). */
export function newGridFromTemplateItems(projectId: string): MenuItem[] {
  const list = templatesFor(getS().presets, projectId);
  if (!list.length) return [];
  return [
    { sep: true },
    { header: tr('Nowy grid z szablonu') },
    ...list.slice(0, 12).map((t) => ({ label: t.name, onClick: () => void openTemplate(projectId, t.id) })),
  ];
}
