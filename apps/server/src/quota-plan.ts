import type { CapabilityProfile, Plan } from '@qiansi/engine';
import { modelFamilies, preferredModel, profileForModel, type KeySlot } from './model-catalog.js';
import type { Billing, RoutingStrategy } from './quota.js';
import { explainPick, orderByStrategy, performanceOf, type SlotScore } from './routing.js';

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
  /** 路由策略；默认订阅优先。 */
  strategy?: RoutingStrategy;
  /** 某个家族当前生效 Key 的计费类型。 */
  billingOf?: (slot: KeySlot) => Billing | null;
  /** 某个家族的按量单价（CNY/1M）。 */
  priceOf?: (slot: KeySlot) => number;
}): Substitution[] {
  const { plan, profiles, slotByProfile, hasKey, headroom } = input;
  const estimate = input.estimatePerTask ?? 6000;
  const strategy = input.strategy ?? 'subscription';
  const billingOf = input.billingOf ?? (() => null);
  const priceOf = input.priceOf ?? (() => 0);

  /** 策略排序后的候选（含解释），每次按当前余额现算。 */
  const orderFor = (exclude: KeySlot): SlotScore[] => {
    const scores: SlotScore[] = modelFamilies()
      .filter((family) => family.slot !== exclude && hasKey(family.slot))
      .map((family) => ({
        slot: family.slot,
        billing: billingOf(family.slot),
        priceCnyPerM: priceOf(family.slot),
        performance: performanceOf(family.slot),
        headroom: headroom(family.slot),
      }));
    return orderByStrategy(scores, strategy);
  };
  const needs = (slot: KeySlot): boolean => {
    const left = headroom(slot);
    return left !== -1 && left < estimate;
  };

  const substitutions: Substitution[] = [];
  for (const task of plan.subtasks) {
    const currentSlot = slotByProfile.get(task.profileId);
    if (!currentSlot || !needs(currentSlot)) continue;

    const target = orderFor(currentSlot).find(
      (candidate) => candidate.headroom === -1 || candidate.headroom >= estimate
    );
    if (!target) continue;
    const targetReason = explainPick(target, strategy);

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
      reason: `${
        headroom(currentSlot) === 0
          ? `${currentSlot} 额度已用尽`
          : `${currentSlot} 剩余额度不足一个任务（<${estimate} tok）`
      }；按「${strategy}」改派到 ${target.slot}：${targetReason}`,
    });
  }
  return substitutions;
}
