import type { KeySlot } from './model-catalog.js';
import type { Billing, RoutingStrategy } from './quota.js';

/**
 * 工作流该走哪个模型家族，取决于用户在为什么付费。
 *
 *   性能优先 —— 先用最强的（relay/openai 一类旗舰档）。
 *   订阅优先 —— 先用已付费订阅的 Key（边际成本≈0），同类里挑更强的。
 *   成本优先 —— 按每百万 token 的边际花费从低到高排；订阅且有余额的记 0。
 *
 * 这里只排序，不做决定：具体能不能用还要看有没有 Key、有没有余额。
 */

export interface SlotScore {
  slot: KeySlot;
  /** 当前生效 Key 的计费类型；null 表示没有可用 Key。 */
  billing: Billing | null;
  /** 按量计费的估算单价（CNY / 1M token，输入+输出均值）。 */
  priceCnyPerM: number;
  /** 0..1 的粗粒度档位，用于性能排序。 */
  performance: number;
  /** -1 不限，0 已用尽。 */
  headroom: number;
}

/**
 * 家族旗舰档的粗排序。刻意保持简单、可解释：换模型只需改这里一个数。
 * 它不参与成本计算，只在「性能优先」和同等条件下的排序里起作用。
 */
const FAMILY_PERFORMANCE: Record<KeySlot, number> = {
  relay: 1.0,
  openai: 0.95,
  deepseek: 0.9,
  moonshot: 0.85,
  zhipu: 0.8,
  minimax: 0.8,
  qwen: 0.75,
};

export function performanceOf(slot: KeySlot): number {
  return FAMILY_PERFORMANCE[slot] ?? 0.7;
}

const hasQuota = (score: SlotScore): boolean => score.headroom !== 0;

/** 边际价格：订阅且有余额 = 0；按量 = 单价；无余额 = 无穷（不可选）。 */
function marginalPrice(score: SlotScore): number {
  if (!hasQuota(score)) return Number.POSITIVE_INFINITY;
  if (score.billing === 'subscription') return 0;
  return score.priceCnyPerM;
}

export function orderByStrategy(scores: SlotScore[], strategy: RoutingStrategy): SlotScore[] {
  const usable = scores.filter(hasQuota);
  const blocked = scores.filter((score) => !hasQuota(score));

  const sorted = [...usable];
  if (strategy === 'cost') {
    sorted.sort(
      (a, b) => marginalPrice(a) - marginalPrice(b) || b.performance - a.performance
    );
  } else if (strategy === 'subscription') {
    sorted.sort((a, b) => {
      const aSub = a.billing === 'subscription' ? 0 : 1;
      const bSub = b.billing === 'subscription' ? 0 : 1;
      return aSub - bSub || b.performance - a.performance;
    });
  } else {
    sorted.sort((a, b) => b.performance - a.performance);
  }
  return [...sorted, ...blocked];
}

/** 为什么挑中这个家族——写进运行说明，用户能看懂。 */
export function explainPick(score: SlotScore, strategy: RoutingStrategy): string {
  if (strategy === 'subscription') {
    return score.billing === 'subscription'
      ? `订阅 Key（边际成本 0），性能档 ${score.performance.toFixed(2)}`
      : `没有可用订阅 Key，回退到按量（约 ¥${score.priceCnyPerM}/1M）`;
  }
  if (strategy === 'cost') {
    return score.billing === 'subscription'
      ? '订阅 Key，余额内边际成本 0'
      : `按量单价约 ¥${score.priceCnyPerM}/1M`;
  }
  return `性能档 ${score.performance.toFixed(2)}`;
}
