// STUB (replaced at merge by the delegation agent's real file with the same signatures).
import type { AppState } from './types';

export interface Delegation { mode: 'auto' | string; maxAgents: number }

/** How many agents a coordinator may run at once. */
export function teamLimit(_state: AppState): number {
  return 4;
}

/** English error when an agent call would exceed the limit, else null. */
export function delegationRefusal(_state: AppState, _coordinatorId: string, _input: { newAgents?: number; taskCellId?: string }): string | null {
  return null;
}

export function delegationOf(_state: AppState): Delegation {
  return { mode: 'auto', maxAgents: 4 };
}

export function coordinatorRoleNote(_d: Delegation): string {
  return '';
}

export function coordinatorSystemRules(_d: Delegation): string {
  return '';
}
