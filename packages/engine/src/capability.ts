import type { CapabilityProfile, Effort, EffortDialect, NormalizedChatRequest } from './types.js';

export function profileById(profiles: CapabilityProfile[], id: string): CapabilityProfile {
  const profile = profiles.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown capability profile: ${id}`);
  return profile;
}

export interface EffortTranslation {
  params: Record<string, unknown>;
  warning?: string;
}

const BUDGET_BY_EFFORT: Record<Exclude<Effort, 'off'>, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  max: 32768,
};

const OPENAI_BY_EFFORT: Record<Exclude<Effort, 'off'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
};

function clampBudget(profile: CapabilityProfile, effort: Exclude<Effort, 'off'>): number {
  const desired = BUDGET_BY_EFFORT[effort];
  const range = profile.effort.budgetRange;
  if (!range) return desired;
  return Math.min(range[1], Math.max(range[0], desired));
}

/**
 * Translate a canonical effort level into the provider-specific request fragment.
 * Unknown or unsupported levels are downgraded to the model default instead of
 * being sent raw, because several providers reject unexpected values with a 400.
 */
export function translateEffort(profile: CapabilityProfile, effort: Effort): EffortTranslation {
  const dialect: EffortDialect = profile.effort.dialect;

  switch (dialect) {
    case 'openai-reasoning-effort': {
      if (effort === 'off') return { params: {} };
      return { params: { reasoning_effort: OPENAI_BY_EFFORT[effort] } };
    }
    case 'anthropic-thinking-budget': {
      if (effort === 'off') return { params: {} };
      return {
        params: {
          thinking: {
            type: 'enabled',
            budget_tokens: clampBudget(profile, effort),
          },
        },
      };
    }
    case 'minimax-output-effort': {
      if (effort === 'off') return { params: {} };
      const values = profile.effort.values ?? ['low', 'medium', 'high', 'xhigh', 'max'];
      const value = values.includes(effort) ? effort : values[values.length - 1];
      return { params: { output_config: { effort: value } } };
    }
    case 'qwen-enable-thinking': {
      const budget = effort === 'off' ? 0 : clampBudget(profile, effort);
      return {
        params: {
          enable_thinking: effort !== 'off',
          thinking_budget: budget,
        },
      };
    }
    case 'kimi-thinking': {
      return {
        params: {
          chat_template_kwargs: { thinking: effort !== 'off' },
        },
      };
    }
    case 'glm-thinking': {
      return {
        params: {
          thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
        },
      };
    }
    case 'deepseek-model-switch': {
      return {
        params: {},
        warning:
          effort === 'off'
            ? undefined
            : 'DeepSeek effort is a model switch (chat vs reasoner); the profile model controls it.',
      };
    }
    case 'none': {
      return {
        params: {},
        warning: effort === 'off' ? undefined : `Profile ${profile.id} has no effort control; using its default.`,
      };
    }
    default: {
      return { params: {}, warning: `Unknown effort dialect for ${profile.id}; using default.` };
    }
  }
}

export function buildChatRequest(
  profile: CapabilityProfile,
  messages: NormalizedChatRequest['messages'],
  effort: Effort,
  options: {
    apiKey?: string;
    extraHeaders?: Record<string, string>;
    maxTokens?: number;
    tools?: NormalizedChatRequest['tools'];
    signal?: AbortSignal;
  } = {}
): NormalizedChatRequest {
  const { params } = translateEffort(profile, effort);
  return {
    baseUrl: profile.baseUrl,
    apiKey: options.apiKey,
    extraHeaders: options.extraHeaders,
    model: profile.model,
    messages,
    tools: options.tools,
    effort,
    maxTokens: options.maxTokens ?? profile.maxOutput,
    providerParams: params,
    signal: options.signal,
  };
}
