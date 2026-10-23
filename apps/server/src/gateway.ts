import {
  AnthropicMessagesAdapter,
  OpenAIChatAdapter,
  type CapabilityProfile,
  type ChatAdapter,
  type NormalizedMessage,
  type Protocol,
} from '@qiansi/engine';
import { liveProfiles } from './live.js';
import type { DpapiVault } from './vault.js';

export interface GatewayModel {
  id: string;
  label: string;
  profileId: string;
  keyRef: string;
  protocol: Protocol;
}

export const gatewayModels: GatewayModel[] = [
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    profileId: 'live-deepseek',
    keyRef: 'conn-deepseek',
    protocol: 'openai-chat',
  },
  {
    id: 'minimax',
    label: 'MiniMax M3.1',
    profileId: 'live-minimax',
    keyRef: 'conn-minimax',
    protocol: 'anthropic-messages',
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet (local relay)',
    profileId: 'live-sonnet',
    keyRef: 'conn-claude-relay',
    protocol: 'anthropic-messages',
  },
  {
    id: 'claude-opus',
    label: 'Claude Opus (local relay)',
    profileId: 'live-opus',
    keyRef: 'conn-claude-relay',
    protocol: 'anthropic-messages',
  },
];

export interface GatewayModelResolution {
  model: GatewayModel;
  profile: CapabilityProfile;
  apiKey: string;
  adapter: ChatAdapter;
}

export async function resolveGatewayModel(
  modelId: string,
  vault: DpapiVault
): Promise<GatewayModelResolution | undefined> {
  const model = gatewayModels.find(
    (item) => item.id === modelId || item.profileId === modelId
  );
  if (!model) return undefined;

  const profile = liveProfiles.find((item) => item.id === model.profileId);
  if (!profile) return undefined;

  const fromVault = await vault.get(model.keyRef);
  const apiKey =
    fromVault ??
    (model.keyRef === 'conn-deepseek'
      ? process.env.DEEPSEEK_API_KEY
      : model.keyRef === 'conn-minimax'
        ? process.env.MINIMAX_API_KEY
        : process.env.ANTHROPIC_AUTH_TOKEN) ??
    '';

  const adapter =
    profile.protocol === 'anthropic-messages'
      ? new AnthropicMessagesAdapter()
      : new OpenAIChatAdapter();

  return { model, profile, apiKey, adapter };
}

export function toNormalizedMessages(
  messages: Array<{ role?: string; content?: unknown }>
): NormalizedMessage[] {
  const normalized: NormalizedMessage[] = [];
  for (const message of messages) {
    const role =
      message.role === 'system' || message.role === 'assistant' || message.role === 'tool'
        ? message.role
        : 'user';
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'text' in part) {
                  return String((part as { text?: unknown }).text ?? '');
                }
                return '';
              })
              .join('\n')
          : String(message.content ?? '');
    normalized.push({ role, content });
  }
  return normalized;
}

export class GatewayUsage {
  private readonly events: Array<{ ts: number; tokens: number }> = [];
  total = 0;

  constructor(private readonly maxTokensPerMinute = 20000) {}

  private prune(): void {
    const cutoff = Date.now() - 60000;
    while (this.events.length > 0 && this.events[0]!.ts < cutoff) {
      this.events.shift();
    }
  }

  check(): { ok: boolean; perMinute: number } {
    this.prune();
    const perMinute = this.events.reduce((sum, item) => sum + item.tokens, 0);
    return { ok: perMinute <= this.maxTokensPerMinute, perMinute };
  }

  add(tokens: number): void {
    this.total += tokens;
    this.events.push({ ts: Date.now(), tokens });
  }

  snapshot() {
    this.prune();
    return {
      total: this.total,
      perMinute: this.events.reduce((sum, item) => sum + item.tokens, 0),
    };
  }
}
