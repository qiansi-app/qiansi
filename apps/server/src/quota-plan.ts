import type { CapabilityProfile, Plan } from '@qiansi/engine';
import { modelFamilies, preferredModel, profileForModel, type KeySlot } from './model-catalog.js';

/**
 * A run that would spend a key's last tokens is worse than a run that uses a
 * different vendor: it fails halfway with a 429 the user cannot fix mid-flight.
 * Before starting, any task whose family is out of quota (or too close to it)
 * is moved to the cheapest reachable family that still has headroom, and the
 * move is reported so it can be shown rather than silently applied.
 */

export interface Substitution {
  taskId: string;
  nodeId?: string;
  fromSlot: KeySlot;
  fromModel: string;
  toSlot: KeySlot;
  toModel: string;
  reason: string;
}

/** Order families are tried in when a lane has to move. */
const FALLBACK_ORDER: KeySlot[] = ['deepseek', 'zhipu', 'minimax', 'qwen', 'moonshot', 'openai', 'relay'];

export function substituteExhausted(input: {
  plan: Plan;
  profiles: CapabilityProfile[];
  slotByProfile: Map<string, KeySlot>;
  /** Whether the slot has any usable credential at all. */
  hasKey: (slot: KeySlot) => boolean;
  /** Remaining tokens; -1 means unlimited, 0 means exhausted. */
  headroom: (slot: KeySlot) => number;
  /** Rough per-task spend used to decide whether "almost exhausted" is enough. */
  estimatePerTask?: number;
}): Substitution[] {
  const { plan, profiles, slotByProfile, hasKey, headroom } = input;
  const estimate = input.estimatePerTask ?? 6000;
  const needs = (slot: KeySlot): boolean => {
    const left = headroom(slot);
    return left !== -1 && left < estimate;
  };

  const substitutions: Substitution[] = [];
  for (const task of plan.subtasks) {
    const currentSlot = slotByProfile.get(task.profileId);
    if (!currentSlot || !needs(currentSlot)) continue;

    const target = FALLBACK_ORDER.filter((slot) => slot !== currentSlot)
      .map((slot) => ({ slot, left: headroom(slot) }))
      .find((candidate) => hasKey(candidate.slot) && (candidate.left === -1 || candidate.left >= estimate));
    if (!target) continue;

    const family = modelFamilies().find((item) => item.slot === target.slot);
    if (!family) continue;
    const model = preferredModel(family.models);
    const profile = profiles.find((item) => item.id === task.profileId);
    if (!profile) continue;

    const before = profile.model;
    const replacement = profileForModel(model, family.label);
    // Keep the plan-scoped id: subtasks and key assignment are keyed by it.
    Object.assign(profile, replacement, { id: profile.id, label: profile.label });
    slotByProfile.set(task.profileId, target.slot);

    substitutions.push({
      taskId: task.id,
      nodeId: task.assignedNodeId,
      fromSlot: currentSlot,
      fromModel: before,
      toSlot: target.slot,
      toModel: model,
      reason:
        headroom(currentSlot) === 0
          ? `${currentSlot} 额度已用尽`
          : `${currentSlot} 剩余额度不足一个任务（<${estimate} tok）`,
    });
  }
  return substitutions;
}
