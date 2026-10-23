import type { ChatAdapter, NormalizedChatRequest, NormalizedStreamEvent } from '../types.js';
import { readSSE } from './sse.js';

function messagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

interface AnthropicEvent {
  type?: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

/**
 * Anthropic Messages protocol, including Claude and Anthropic-format local
 * relays. Thinking blocks carry signatures that must be round-tripped in tool
 * loops; v0 only streams them out, full tool-loop replay is a P1 task.
 */
export class AnthropicMessagesAdapter implements ChatAdapter {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async *stream(request: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(request.providerParams ?? {}),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(request.apiKey
        ? {
            'x-api-key': request.apiKey,
            authorization: `Bearer ${request.apiKey}`,
          }
        : {}),
      ...(request.extraHeaders ?? {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(messagesUrl(request.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      yield {
        type: 'error',
        code: 'network',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
      return;
    }

    if (!response.ok) {
      const message = await response.text().catch(() => '');
      yield {
        type: 'error',
        code: String(response.status),
        message: message || response.statusText,
        retryable: response.status === 429 || response.status >= 500,
      };
      return;
    }

    for await (const sse of readSSE(response)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(sse.data) as AnthropicEvent;
      } catch {
        continue;
      }

      switch (event.type) {
        case 'message_start':
          if (event.message?.usage?.input_tokens !== undefined) {
            yield {
              type: 'usage',
              input: event.message.usage.input_tokens,
              output: event.message.usage.output_tokens ?? 0,
            };
          }
          break;

        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            yield {
              type: 'toolcall-delta',
              id: event.content_block.id ?? '',
              name: event.content_block.name,
            };
          }
          break;

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text-delta', text: event.delta.text };
          } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            yield { type: 'reasoning-delta', text: event.delta.thinking };
          } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            yield {
              type: 'toolcall-delta',
              id: '',
              argsDelta: event.delta.partial_json,
            };
          }
          break;

        case 'message_delta':
          if (event.usage) {
            yield {
              type: 'usage',
              input: event.usage.input_tokens ?? 0,
              output: event.usage.output_tokens ?? 0,
            };
          }
          if (event.delta?.stop_reason) {
            const reason =
              event.delta.stop_reason === 'tool_use'
                ? 'tool_calls'
                : event.delta.stop_reason === 'max_tokens'
                  ? 'length'
                  : 'stop';
            yield { type: 'done', reason };
            return;
          }
          break;

        case 'message_stop':
          yield { type: 'done', reason: 'stop' };
          return;

        case 'error':
          yield {
            type: 'error',
            code: event.error?.type ?? 'provider',
            message: event.error?.message ?? 'provider error',
            retryable: true,
          };
          break;

        default:
          break;
      }
    }

    yield { type: 'done', reason: 'stop' };
  }
}
