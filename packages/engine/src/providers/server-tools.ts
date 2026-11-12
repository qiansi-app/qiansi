import type {
  ChatAdapter,
  NormalizedChatRequest,
  NormalizedMessage,
  NormalizedStreamEvent,
  ToolCall,
  ToolboxOptions,
  ToolSpec,
} from '../types.js';

/**
 * Wraps any ChatAdapter with a server-executed tool loop. The model sees the
 * toolbox schemas; when it asks for a tool, the server runs it (file I/O, shell,
 * canvas queries, web search) and feeds the result back, until the model writes
 * its answer or the round budget is spent.
 *
 * 与 SearchToolAdapter 的区别：那个只认 web_search，遇到别的工具就把控制权交回；
 * 这个接一个通用 toolbox，所有工具都由 server 执行，未知工具会得到一条错误结果
 * 而不是让整轮停下。
 */
export class ServerToolAdapter implements ChatAdapter {
  constructor(
    private readonly inner: ChatAdapter,
    private readonly options: ToolboxOptions
  ) {}

  async *stream(request: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
    const maxRounds = Math.max(0, Math.min(12, this.options.maxRounds ?? 6));
    const tools = mergeTools(request.tools ?? [], this.options.tools);
    let messages: NormalizedMessage[] = [...request.messages];

    for (let round = 0; ; round += 1) {
      const allowTools = round < maxRounds;
      if (!allowTools) {
        // 轮次用尽后仍然要一次无工具的调用，否则模型可能永远停在「还要再查」。
        messages = [
          ...messages,
          {
            role: 'user',
            content:
              '工具轮次已用完。基于上面已有的工具结果直接给出最终交付物；不要再请求工具，也不要复述工具结果。',
          },
        ];
      }

      const calls: ToolCall[] = [];
      let current: ToolCall | undefined;
      let text = '';
      let failed = false;
      let lastDone: 'stop' | 'length' | 'tool_calls' | 'aborted' = 'stop';

      for await (const event of this.inner.stream({
        ...request,
        messages,
        tools: allowTools ? tools : [],
      })) {
        if (event.type === 'text-delta') {
          text += event.text;
          yield event;
        } else if (event.type === 'reasoning-delta' || event.type === 'usage') {
          yield event;
        } else if (event.type === 'done') {
          lastDone = event.reason;
        } else if (event.type === 'error') {
          yield event;
          failed = true;
        } else if (event.type === 'toolcall-delta') {
          current = collectCall(event, calls, current);
        }
      }

      if (failed) return;
      if (lastDone === 'aborted') {
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      if (!allowTools || calls.length === 0) {
        yield { type: 'done', reason: calls.length > 0 ? 'tool_calls' : lastDone };
        return;
      }

      messages = [...messages, { role: 'assistant', content: text, toolCalls: calls }];
      for (const call of calls) {
        const started = Date.now();
        let content = '';
        let isError = false;
        try {
          if (!call.name) throw new Error('工具名缺失');
          const result = await this.options.execute(call);
          content = result.content;
          isError = Boolean(result.isError);
        } catch (error) {
          content = `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
          isError = true;
        }
        this.options.onCall?.({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          ok: !isError,
          ms: Date.now() - started,
          content,
        });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content,
        });
      }
    }
  }
}

function mergeTools(base: ToolSpec[], extra: ToolSpec[]): ToolSpec[] {
  const seen = new Set(base.map((tool) => tool.name));
  return [...base, ...extra.filter((tool) => !seen.has(tool.name))];
}

/**
 * Tool-call deltas arrive in pieces: the first chunk carries id+name, later
 * chunks only append argument text. Some providers omit id or name on the first
 * chunk, so this tolerates missing fields.
 */
function collectCall(
  event: { id: string; name?: string; argsDelta?: string },
  calls: ToolCall[],
  current: ToolCall | undefined
): ToolCall | undefined {
  if (event.id && event.name) {
    if (!current || current.id !== event.id) {
      const next: ToolCall = {
        id: event.id,
        name: event.name,
        arguments: event.argsDelta ?? '',
      };
      calls.push(next);
      return next;
    }
    current.arguments += event.argsDelta ?? '';
    return current;
  }
  if (current) {
    if (!current.name && event.name) current.name = event.name;
    if (!current.id && event.id) current.id = event.id;
    current.arguments += event.argsDelta ?? '';
    return current;
  }
  if (event.name || event.argsDelta) {
    const next: ToolCall = {
      id: event.id || `call-${calls.length + 1}`,
      name: event.name ?? '',
      arguments: event.argsDelta ?? '',
    };
    calls.push(next);
    return next;
  }
  return current;
}
