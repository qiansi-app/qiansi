import type { Effort } from './types.js';

export const EFFORT_ORDER: Effort[] = ['off', 'low', 'medium', 'high', 'max'];

export function effortRank(effort: Effort): number {
  return EFFORT_ORDER.indexOf(effort);
}

export function nextEffort(effort: Effort): Effort {
  const index = effortRank(effort);
  return EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, index + 1)] ?? 'max';
}

export type TaskKind =
  | 'mechanical'
  | 'extraction'
  | 'writing'
  | 'reasoning'
  | 'code'
  | 'review';

/**
 * Heuristic seed for the plan rubric. The orchestrator model is expected to
 * overrule this per subtask; this exists so the engine can run without an
 * extra model call and gives the UI a sensible default.
 */
export function defaultEffortFor(kind: TaskKind, blastRadius = 1): Effort {
  if (blastRadius >= 3) return 'high';
  switch (kind) {
    case 'mechanical':
      return 'off';
    case 'extraction':
      return 'low';
    case 'writing':
      return 'medium';
    case 'code':
      return 'medium';
    case 'review':
      return 'high';
    case 'reasoning':
      return 'high';
    default:
      return 'medium';
  }
}
