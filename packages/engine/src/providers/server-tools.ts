import type {
  ChatAdapter,
  NormalizedChatRequest,
  NormalizedMessage,
  NormalizedStreamEvent,
  ToolCall,
  ToolLoopState,
  ToolboxOptions,
  ToolSpec,
} from '../types.js';

/**
 * Wraps any ChatAdapter with a server-executed tool loop. The model sees the
 * toolbox schemas; when it asks for a tool, the server runs it (file I/O, shell,
 * canvas queries, web search) and feeds the result back, until the model writes
 * its answer or a budget gate closes the loop.
 *
 * 与 SearchToolAdapter 的区别：那个只认 web_search，遇到别的工具就把控制权交回；
 * 这个接一个通用 toolbox，所有工具都由 server 执行，未知工具会得到一条错误结果
 * 而不是让整轮停下。
 *
 * 工具循环护栏（2026-11，写成功即收手）——设计得很窄，只拦真正会失控的循环：
 * 1. 调用次数硬闸：每任务最多执行 maxCalls 次（默认 24，研究任务 36），
 *    状态由编排器跨「验收重试」共享；
 * 2. 同路径同内容的重复写入直接跳过（路径先规范化，消除 ./ 与反斜杠别名）；
 *    不同内容的修正、run_command 的重跑一律放行——「编辑→测试→修复」不能被截断；
 * 3. 累计工具字符预算（默认 400k）：大文件反复重写会把上下文撑爆；
 * 4. 被跳过/被预算拒绝的调用不进入 onCall 证据，避免伪造「工具成功」骗过验收与引用核查。
 */
export class ServerToolAdapter implements ChatAdapter {
  constructor(
    private readonly inner: ChatAdapter,
    private readonly options: ToolboxOptions
  ) {}

  async *stream(request: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
    const maxRounds = Math.max(0, Math.min(12, this.options.maxRounds ?? 6));
    const maxCalls = Math.max(1, Math.min(64, this.options.maxCalls ?? 24));
    const maxChars = Math.max(50_000, Math.min(2_000_000, this.options.maxToolChars ?? 400_000));
    const state: ToolLoopState =
      this.options.state ?? { executed: 0, written: new Set<string>(), chars: 0 };
    const tools = mergeTools(request.tools ?? [], this.options.tools);
    let messages: NormalizedMessage[] = [...request.messages];
    let toolsDisabled = false;

    for (let round = 0; ; round += 1) {
      const allowTools = round < maxRounds && !toolsDisabled;
      if (!allowTools) {
        // 轮次/次数/字符任一闸门关闭后，仍然要一次无工具的调用，
        // 否则模型可能永远停在「还要再试一次」。
        const notice = toolsDisabled
          ? '工具调用已停止（达到次数、重复或体量上限）。基于上面已有的结果直接给出最终交付物；不要再请求工具，也不要复述工具结果。'
          : '工具轮次已用完。基于上面已有的工具结果直接给出最终交付物；不要再请求工具，也不要复述工具结果。';
        messages = [...messages, { role: 'user', content: notice }];
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
      let executedThisRound = 0;
      let skippedThisRound = 0;
      for (const call of calls) {
        const started = Date.now();
        const isWrite = /^(write_file|append_file)$/.test(call.name);
        const fingerprint = isWrite ? writeFingerprint(call.arguments) : '';
        let content = '';
        let isError = false;
        let executed = false;
        if (state.executed >= maxCalls) {
          // 预算用尽：本轮之后不再开放工具。
          content = `工具调用预算已用尽（本任务上限 ${maxCalls} 次）。基于已有结果直接给出最终交付物，不要再请求工具。`;
          toolsDisabled = true;
        } else if (fingerprint && state.written.has(fingerprint)) {
          // 同路径、同内容：重复写入没有意义，跳过且不记证据。
          skippedThisRound += 1;
          const path = pathOf(call.arguments) || '该文件';
          content = `相同内容已写入过 ${path}，本次重复写入已跳过。如果全部交付物都已完成，立即输出最终答案；需要修正时请写入不同的内容，或继续处理其它文件。`;
        } else {
          try {
            if (!call.name) throw new Error('工具名缺失');
            const result = await this.options.execute(call);
            content = result.content;
            isError = Boolean(result.isError);
          } catch (error) {
            content = `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
            isError = true;
          }
          executed = true;
          executedThisRound += 1;
          state.executed += 1;
          if (fingerprint && !isError) state.written.add(fingerprint);
          state.chars += call.arguments.length + content.length;
          if (state.chars >= maxChars) toolsDisabled = true;
        }
        if (executed) {
          // 只有真正执行过的调用才进证据与界面：跳过/拒绝的调用不能被验收当成成功。
          this.options.onCall?.({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            ok: !isError,
            ms: Date.now() - started,
            content,
          });
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content,
        });
      }
      // 整轮都是重复写入：停止工具，让下一轮直接作答。
      if (executedThisRound === 0 && skippedThisRound > 0) toolsDisabled = true;
    }
  }
}

/**
 * 写入指纹：规范化路径 + 内容。解析失败就不做去重（宁可多执行，不误杀）。
 * 路径别名（out.txt / ./out.txt / a\..\out.txt）必须视为同一个文件。
 */
function writeFingerprint(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    const path = parsed.path ?? parsed.file;
    const content = parsed.content ?? parsed.text;
    if (typeof path !== 'string' || typeof content !== 'string') return '';
    return `${normalizePath(path)}\u0000${content}`;
  } catch {
    return '';
  }
}

function normalizePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  const drive = /^[a-zA-Z]:/.exec(path)?.[0] ?? '';
  const rest = drive ? path.slice(drive.length) : path;
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  path = `${drive}${parts.join('/')}` || raw.trim();
  return path;
}

function pathOf(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    const path = parsed.path ?? parsed.file ?? parsed.url;
    return typeof path === 'string' ? path.slice(0, 200) : '';
  } catch {
    return '';
  }
}

function mergeTools(base: ToolSpec[], extra: ToolSpec[]): ToolSpec[] {
  const seen = new Set(base.map((tool) => tool.name));
  return [...base, ...extra.filter((tool) => !seen.has(tool.name))];
}

/**
 * Tool-call deltas arrive in pieces: the first chunk carries id+name, later
 * chunks only append argument text. Some providers omit id or name on the first
 * chunk, so this tolerates missing fields — but a chunk that names a different
 * tool always starts a new call, even when the id repeats or is missing.
 */
function collectCall(
  event: { id: string; name?: string; argsDelta?: string },
  calls: ToolCall[],
  current: ToolCall | undefined
): ToolCall | undefined {
  // 部分厂商会省略 id、或让同一响应里两个调用复用 id；此时用「上一段参数已是
  // 完整 JSON 且新一段以 { 开头」判定这是新调用，避免两个写入被拼成一个。
  const currentComplete =
    Boolean(current?.arguments.trim()) &&
    (() => {
      try {
        JSON.parse(current!.arguments);
        return true;
      } catch {
        return false;
      }
    })();
  const startsFreshObject =
    Boolean(event.argsDelta) &&
    event.argsDelta!.trimStart().startsWith('{') &&
    currentComplete;
  const startsNew =
    startsFreshObject ||
    (Boolean(event.name) &&
      (!current || current.name !== event.name || (Boolean(event.id) && event.id !== current.id)));
  if (startsNew) {
    const next: ToolCall = {
      id: event.id || `call-${calls.length + 1}`,
      name: event.name ?? '',
      arguments: event.argsDelta ?? '',
    };
    calls.push(next);
    return next;
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
