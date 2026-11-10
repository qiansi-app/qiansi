import {
  AnthropicMessagesAdapter,
  OpenAIChatAdapter,
  SearchToolAdapter,
  buildChatRequest,
  type ChatAdapter,
  type NormalizedMessage,
  type Protocol,
  type SearchFn,
} from '@qiansi/engine';
import { profileForModel } from './model-catalog.js';
import type { DpapiVault } from './vault.js';

export interface ChatConnection {
  connectionId?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
  /** Explicit key for one request; never persisted. */
  apiKey?: string;
}

export interface ChatResult {
  text: string;
  usage: { input: number; output: number; total: number };
  /** Queries the server ran for the model, when webSearch was on. */
  searches?: Array<{ query: string; hits: number }>;
}

const adapters: Record<Protocol, ChatAdapter> = {
  'openai-chat': new OpenAIChatAdapter(),
  'anthropic-messages': new AnthropicMessagesAdapter(),
};

function envFallback(connectionId?: string, baseUrl?: string): string {
  if (baseUrl?.includes('127.0.0.1') || baseUrl?.includes('localhost')) {
    return process.env.ANTHROPIC_AUTH_TOKEN ?? '';
  }
  if (connectionId?.includes('deepseek') || baseUrl?.includes('deepseek')) {
    return process.env.DEEPSEEK_API_KEY ?? '';
  }
  if (connectionId?.includes('minimax') || baseUrl?.includes('minimaxi')) {
    return process.env.MINIMAX_API_KEY ?? '';
  }
  if (connectionId?.includes('moonshot') || baseUrl?.includes('moonshot')) {
    return process.env.MOONSHOT_API_KEY ?? '';
  }
  return '';
}

/** Non-streaming completion used by node chat, discussion and layout. */
export async function completeChat(
  vault: DpapiVault,
  connection: ChatConnection,
  messages: NormalizedMessage[],
  options: {
    maxTokens?: number;
    timeoutMs?: number;
    /** When provided, the model gets the server-side web_search tool. */
    search?: SearchFn;
  } = {}
): Promise<ChatResult> {
  const protocol: Protocol =
    connection.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat';
  const baseUrl =
    connection.baseUrl?.trim() ||
    (protocol === 'anthropic-messages' ? 'http://127.0.0.1:15721' : 'https://api.deepseek.com');
  const model = connection.model?.trim() || (protocol === 'anthropic-messages' ? 'claude-sonnet-4-6[1M]' : 'deepseek-chat');
  const apiKey =
    connection.apiKey?.trim() ||
    (connection.connectionId ? await vault.get(connection.connectionId) : null) ||
    envFallback(connection.connectionId, baseUrl);

  const baseAdapter = adapters[protocol];
  const searches: Array<{ query: string; hits: number }> = [];
  const adapter =
    options.search != null
      ? new SearchToolAdapter(baseAdapter, {
          search: options.search,
          onSearch: ({ query, hits }) => searches.push({ query, hits }),
        })
      : baseAdapter;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);
  let text = '';
  const usage = { input: 0, output: 0, total: 0 };
  try {
    // Build through the shared request builder so the family's effort dialect
    // applies: sending 'off' turns thinking OFF for GLM/Kimi/Qwen-class models.
    // Constructing the request by hand here left thinking on, and a 500-token
    // budget went entirely to reasoning — discussions came back empty.
    const profile = { ...profileForModel(model), protocol, baseUrl };
    const request = buildChatRequest(profile, messages, 'off', {
      apiKey,
      maxTokens: options.maxTokens ?? 1600,
      signal: controller.signal,
    });
    for await (const event of adapter.stream(request)) {
      if (event.type === 'text-delta') text += event.text;
      if (event.type === 'usage') {
        usage.input += event.input;
        usage.output += event.output;
        usage.total += event.input + event.output;
      }
      if (event.type === 'error') throw new Error(event.message);
    }
  } finally {
    clearTimeout(timer);
  }
  return { text: text.trim(), usage, ...(searches.length > 0 ? { searches } : {}) };
}
