import {
  AnthropicMessagesAdapter,
  OpenAIChatAdapter,
  type CapabilityProfile,
  type ChatAdapter,
  type NormalizedMessage,
} from '@qiansi/engine';
import { catalogEntries, modelFamilies, profileForModel, type KeySlot } from './model-catalog.js';
import type { DpapiVault } from './vault.js';

export interface GatewayModel {
  id: string;
  label: string;
  slot: KeySlot;
  keyRef: string;
  protocol: CapabilityProfile['protocol'];
}

/**
 * One key, many models: the gateway exposes every model in the catalog and
 * resolves each to the key slot that serves it.
 */
export const gatewayModels: GatewayModel[] = catalogEntries().map((entry) => ({
  id: entry.id,
  label: entry.label,
  slot: entry.slot,
  keyRef: entry.keyRef,
  protocol: entry.protocol,
}));

export interface GatewayModelResolution {
  model: GatewayModel;
  profile: CapabilityProfile;
  apiKey: string;
  adapter: ChatAdapter;
  /** Which managed key served this call; usage is booked against it. */
  keyId: string;
}

const slotEnv: Record<KeySlot, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zhipu: 'ZHIPUAI_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  openai: 'OPENAI_API_KEY',
  relay: 'ANTHROPIC_AUTH_TOKEN',
};

export async function resolveGatewayModel(
  modelId: string,
  vault: DpapiVault,
  pickKey?: (slot: KeySlot) => { keyId: string; vaultRef: string } | null
): Promise<GatewayModelResolution | undefined> {
  const model = gatewayModels.find(
    (item) => item.id === modelId || item.keyRef === modelId || item.slot === modelId
  );
  if (!model) return undefined;

  const profile = profileForModel(model.id, model.label);

  // The managed key wins: it is the one whose quota was checked, and it may be
  // a second account added after the first one ran out.
  const picked = pickKey?.(model.slot) ?? null;
  let apiKey = picked ? ((await vault.get(picked.vaultRef)) ?? '') : '';

  const family = modelFamilies().find((item) => item.slot === model.slot);
  let fromVault = await vault.get(model.keyRef);
  for (const alias of family?.vaultAliases ?? []) {
    if (fromVault) break;
    fromVault = await vault.get(alias);
  }
  if (!apiKey) apiKey = fromVault ?? process.env[slotEnv[model.slot]] ?? '';

  const adapter =
    profile.protocol === 'anthropic-messages'
      ? new AnthropicMessagesAdapter()
      : new OpenAIChatAdapter();

  return { model, profile, apiKey, adapter, keyId: picked?.keyId ?? 'default' };
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
