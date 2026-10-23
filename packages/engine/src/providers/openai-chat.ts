import type { ChatAdapter, NormalizedChatRequest, NormalizedStreamEvent } from '../types.js';
import { readSSE } from './sse.js';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

interface OpenAIChunk {
  error?: { code?: string; message?: string };
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Covers DeepSeek, Kimi, Qwen, GLM, MiniMax text, OpenAI and any
 * OpenAI-compatible gateway (one-api/new-api).
 */
export class OpenAIChatAdapter implements ChatAdapter {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async *stream(request: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: true,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(request.providerParams ?? {}),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
      ...(request.extraHeaders ?? {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(joinUrl(request.baseUrl, '/chat/completions'), {
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
      if (sse.data === '[DONE]') {
        yield { type: 'done', reason: 'stop' };
        return;
      }

      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(sse.data) as OpenAIChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        yield {
          type: 'error',
          code: String(chunk.error.code ?? 'provider'),
          message: chunk.error.message ?? 'provider error',
          retryable: true,
        };
        continue;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: 'text-delta', text: delta.content };
      if (delta?.reasoning_content) {
        yield { type: 'reasoning-delta', text: delta.reasoning_content };
      }
      if (delta?.tool_calls) {
        for (const call of delta.tool_calls) {
          yield {
            type: 'toolcall-delta',
            id: call.id ?? '',
            name: call.function?.name,
            argsDelta: call.function?.arguments,
          };
        }
      }
      if (chunk.usage) {
        yield {
          type: 'usage',
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      }
    }

    yield { type: 'done', reason: 'stop' };
  }
}
