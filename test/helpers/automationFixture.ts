import { vi } from 'vitest';
import { AutomationService } from '../../src/main/automation';
import { StateController } from '../../src/main/stateController';
import { addProject, addTab, defaultState } from '../../src/shared/state';
import { layoutForCount } from '../../src/shared/layout';

/** Two projects: a team (coordinator + worker) in the first, a lone coordinator in the second. */
export function automationFixture() {
  let state = addProject(defaultState(), { name: 'Own project', path: 'D:/own' });
  state = addTab(state, state.projects[0].id, { name: 'Team', layout: layoutForCount(2), cells: [{ profileId: 'codex', role: 'coordinator' }, { profileId: 'claude', role: 'worker' }] });
  const project = state.projects[0], [coordinator, worker] = project.tabs[0].cells;
  state = addProject(state, { name: 'Other project', path: 'D:/other' });
  state = addTab(state, state.projects[1].id, { layout: layoutForCount(1), cells: [{ profileId: 'codex', role: 'coordinator' }] });
  const outsider = state.projects[1].tabs[0].cells[0];
  const controller = new StateController(state, vi.fn());
  const deps = {
    createWorktree: vi.fn(async (path: string, name: string) => ({ path: `${path}-wt-${name}`, branch: `mc/${name}` })),
    isCellRunning: vi.fn(() => true),
    restartAgent: vi.fn(async (): Promise<{ restarted: boolean; reason?: string }> => ({ restarted: true })),
    removeWorktree: vi.fn(async () => {}), startCells: vi.fn<(ids: string[]) => void>(), deliver: vi.fn(async () => {}),
  };
  return { service: new AutomationService(controller, deps), controller, deps, project, coordinator, worker, outsider };
}
