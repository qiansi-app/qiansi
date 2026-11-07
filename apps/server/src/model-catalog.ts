import type { CapabilityProfile, Protocol } from '@qiansi/engine';
import { relayBase } from './live.js';

/**
 * A key calls a family of models, not one model. Everything that routes a
 * model id to a gateway (canvas plans, /v1, adapt_canvas) goes through this
 * catalog: the node only declares the model, the catalog decides which key
 * slot serves it.
 */
export type KeySlot = 'deepseek' | 'minimax' | 'moonshot' | 'zhipu' | 'qwen' | 'openai' | 'relay';

export interface ModelFamily {
  slot: KeySlot;
  /** Matches a model id to this family. Checked in order; first hit wins. */
  match: RegExp;
  label: string;
  protocol: Protocol;
  baseUrl: string;
  /** Where the key lives: vault ref, env fallback, credentials field. */
  vaultRef: string;
  /** Older vault refs still written by the studio before the catalog rename. */
  vaultAliases?: string[];
  envVar: string;
  /** Models we advertise for this key. Not exhaustive — unknown ids in the
   * family still route here. */
  models: string[];
  contextWindow: number;
  maxOutput: number;
  effortDialect: 'none' | 'minimax-output-effort' | 'glm-thinking';
}

export function modelFamilies(relay: string = relayBase): ModelFamily[] {
  return [
    {
      slot: 'deepseek',
      match: /^deepseek/i,
      label: 'DeepSeek',
      protocol: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      vaultRef: 'conn-deepseek',
      envVar: 'DEEPSEEK_API_KEY',
      models: ['deepseek-v4-pro', 'deepseek-flash'],
      contextWindow: 128000,
      maxOutput: 16384,
      effortDialect: 'none',
    },
    {
      slot: 'minimax',
      match: /^minimax|^MiniMax|^abab/i,
      label: 'MiniMax',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      vaultRef: 'conn-minimax',
      envVar: 'MINIMAX_API_KEY',
      models: ['MiniMax-M3.1-Flash', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7'],
      contextWindow: 200000,
      maxOutput: 16384,
      effortDialect: 'minimax-output-effort',
    },
    {
      slot: 'moonshot',
      match: /^kimi|^moonshot/i,
      label: 'Moonshot (Kimi)',
      protocol: 'openai-chat',
      baseUrl: 'https://api.moonshot.cn/v1',
      vaultRef: 'conn-moonshot',
      vaultAliases: ['conn-kimi'],
      envVar: 'MOONSHOT_API_KEY',
      models: ['kimi-k2.7-code', 'kimi-k2.6'],
      contextWindow: 128000,
      maxOutput: 16384,
      effortDialect: 'none',
    },
    {
      slot: 'zhipu',
      match: /^glm|^zhipu|^chatglm/i,
      label: '智谱 GLM',
      protocol: 'openai-chat',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      vaultRef: 'conn-zhipu',
      envVar: 'ZHIPUAI_API_KEY',
      models: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.6'],
      contextWindow: 128000,
      maxOutput: 16384,
      // glm-5.3-flash always thinks and rejects thinking:disabled with 1210
      // ("请使用 low、high 或 max"), so no thinking param is sent at all —
      // instead the completion budget must be large enough to hold both.
      effortDialect: 'none',
    },
    {
      slot: 'qwen',
      match: /^qwen/i,
      label: '通义千问',
      protocol: 'openai-chat',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      vaultRef: 'conn-qwen',
      envVar: 'DASHSCOPE_API_KEY',
      models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
      contextWindow: 128000,
      maxOutput: 16384,
      effortDialect: 'none',
    },
    {
      slot: 'openai',
      match: /^gpt-|^o[134]-|^chatgpt/i,
      label: 'OpenAI',
      protocol: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      vaultRef: 'conn-openai',
      envVar: 'OPENAI_API_KEY',
      models: ['gpt-4o', 'gpt-4o-mini'],
      contextWindow: 128000,
      maxOutput: 16384,
      effortDialect: 'none',
    },
    {
      slot: 'relay',
      match: /^claude|^fable/i,
      label: 'Claude (local relay)',
      protocol: 'anthropic-messages',
      baseUrl: relay,
      vaultRef: 'conn-claude-relay',
      envVar: 'ANTHROPIC_AUTH_TOKEN',
      models: ['claude-opus-4-8[1M]', 'claude-sonnet-4-6[1M]', 'claude-haiku-4-5'],
      contextWindow: 1000000,
      maxOutput: 8192,
      effortDialect: 'none',
    },
  ];
}

export interface ModelRoute {
  slot: KeySlot;
  protocol: Protocol;
  baseUrl: string;
  vaultRef: string;
  envVar: string;
  /** The provider string on the node was just a hint; the family decided. */
  matchedBy: 'model' | 'hint' | 'fallback';
}

/** A node's provider string only breaks ties for ids no family claims. */
function slotFromHint(hint?: string): KeySlot | null {
  const value = String(hint ?? '').toLowerCase();
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('minimax')) return 'minimax';
  if (value.includes('moonshot') || value.includes('kimi')) return 'moonshot';
  if (value.includes('zhipu') || value.includes('bigmodel') || value.includes('glm')) {
    return 'zhipu';
  }
  if (value.includes('qwen') || value.includes('dashscope')) return 'qwen';
  if (value.includes('openai') || value.includes('gpt')) return 'openai';
  if (value.includes('relay') || value.includes('claude') || value.includes('anthropic')) {
    return 'relay';
  }
  return null;
}

export function resolveModelRoute(model: string, hint?: string): ModelRoute {
  const id = String(model ?? '').trim();
  for (const family of modelFamilies()) {
    if (family.match.test(id)) {
      return {
        slot: family.slot,
        protocol: family.protocol,
        baseUrl: family.baseUrl,
        vaultRef: family.vaultRef,
        envVar: family.envVar,
        matchedBy: 'model',
      };
    }
  }
  const hinted = slotFromHint(hint);
  if (hinted) {
    const family = modelFamilies().find((item) => item.slot === hinted)!;
    return {
      slot: family.slot,
      protocol: family.protocol,
      baseUrl: family.baseUrl,
      vaultRef: family.vaultRef,
      envVar: family.envVar,
      matchedBy: 'hint',
    };
  }
  const relay = modelFamilies().find((item) => item.slot === 'relay')!;
  return {
    slot: 'relay',
    protocol: relay.protocol,
    baseUrl: relay.baseUrl,
    vaultRef: relay.vaultRef,
    envVar: relay.envVar,
    matchedBy: 'fallback',
  };
}

export function familyOf(model: string): ModelFamily | undefined {
  const id = String(model ?? '').trim();
  return modelFamilies().find((family) => family.match.test(id));
}

export function profileForModel(model: string, label?: string): CapabilityProfile {
  const id = String(model ?? '').trim();
  const family = familyOf(id);
  const base = {
    id: `gw-${id}`,
    label: label ?? id,
    provider: family?.label ?? 'Custom',
    model: id,
    modalities: { tools: true, json: true } as CapabilityProfile['modalities'],
    domesticReachable: true,
    strengths: { reasoning: 0.8, writing: 0.8 },
  };
  if (!family) {
    // Unknown family: route through the relay like everything else, so a call
    // never dies just because the id is new.
    return {
      ...base,
      protocol: 'anthropic-messages',
      baseUrl: relayBase,
      contextWindow: 128000,
      maxOutput: 8192,
      effort: { dialect: 'none', canDisable: true },
    };
  }
  return {
    ...base,
    provider: family.label,
    protocol: family.protocol,
    baseUrl: family.baseUrl,
    contextWindow: family.contextWindow,
    maxOutput: family.maxOutput,
    modalities:
      family.slot === 'minimax'
        ? { tools: true, json: true, vision: true }
        : base.modalities,
    effort: {
      dialect: family.effortDialect,
      values:
        family.effortDialect === 'minimax-output-effort'
          ? ['low', 'medium', 'high', 'xhigh', 'max']
          : undefined,
      canDisable: true,
    },
  };
}

/** Every model every configured family advertises — for /v1/models. */export function catalogEntries(): Array<{
  id: string;
  label: string;
  slot: KeySlot;
  keyRef: string;
  protocol: Protocol;
}> {
  return modelFamilies().flatMap((family) =>
    family.models.map((model) => ({
      id: model,
      label: `${family.label} · ${model}`,
      slot: family.slot,
      keyRef: family.vaultRef,
      protocol: family.protocol,
    }))
  );
}

export function slotOfKeyRef(keyRef: string): KeySlot | undefined {
  return modelFamilies().find((family) => family.vaultRef === keyRef)?.slot;
}

/**
 * Cheap/fast tier beats the flagship for worker nodes: most orchestration
 * subtasks are short and get re-run on failure, so latency and price matter
 * more than the last few points of benchmark.
 */
const CHEAP_HINTS = ['flash', 'air', 'turbo', 'lite', 'highspeed'];

export function preferredModel(models: string[]): string {
  if (!models.length) return '';
  const scored = models.map((model) => {
    const lower = model.toLowerCase();
    const cheap = CHEAP_HINTS.some((hint) => lower.includes(hint)) ? 0 : 1;
    // within the same tier prefer the highest version number (v4 > v3, 5.3 > 5)
    const version = lower
      .match(/(\d+(?:\.\d+)*)/)?.[1]
      ?.split('.')
      .map((part) => Number(part))
      .reduce((acc, part, index) => acc + part * 10 ** (2 - index), 0) ?? 0;
    return { model, cheap, version };
  });
  scored.sort((a, b) => a.cheap - b.cheap || b.version - a.version);
  return scored[0]!.model;
}

export function isCheapModel(model: string): boolean {
  const lower = String(model ?? '').toLowerCase();
  return CHEAP_HINTS.some((hint) => lower.includes(hint));
}

/**
 * The router does one thing — settle the obvious passes so the expensive judge
 * only sees the hard ones — so it should be the cheapest model the run can
 * actually reach. Ordered cheapest-first; the first slot with a key wins.
 */
const ROUTER_ORDER: Array<{ slot: KeySlot; model: string }> = [
  { slot: 'deepseek', model: 'deepseek-flash' },
  { slot: 'zhipu', model: 'glm-5.3-flash' },
  { slot: 'minimax', model: 'MiniMax-M3.1-Flash' },
  { slot: 'qwen', model: 'qwen-turbo' },
  { slot: 'moonshot', model: 'kimi-k2.6' },
  { slot: 'openai', model: 'gpt-4o-mini' },
  { slot: 'relay', model: 'claude-haiku-4-5' },
];

export function routerChoice(
  keys: Partial<Record<KeySlot, string>>
): { slot: KeySlot; model: string } | null {
  for (const candidate of ROUTER_ORDER) {
    if (keys[candidate.slot]) return candidate;
  }
  return null;
}
