import {
  AnthropicMessagesAdapter,
  OpenAIChatAdapter,
  buildChatRequest,
  type AcceptanceResult,
  type CapabilityProfile,
  type Subtask,
  type ToolEvidence,
} from '@qiansi/engine';

/**
 * Acceptance is the most expensive call in a run: it reads the whole output and
 * runs once per task. Two-level filtering keeps the expensive judge for the
 * cases that need it.
 *
 *   1. structural — free. Empty, truncated, or an error echo is decided here.
 *   2. cheap      — a small router model decides the obvious passes.
 *   3. full       — the real judge, for everything the gate declined to settle.
 *
 * The gate only ever settles a *pass*. A cheap "fail" would trigger a retry,
 * which costs a worker call plus another judge call, so a negative verdict is
 * always escalated to the full judge instead of trusted.
 */

export interface JudgeTarget {
  profile: CapabilityProfile;
  apiKey: string;
}

export type GateName = 'structural' | 'cheap' | 'full';

export interface GatedResult extends AcceptanceResult {
  gate: GateName;
  /** Set by the cheap gate; how sure the router was of its pass. */
  confidence?: number;
}

export interface RoutedJudgeOptions {
  /** Cheap model used to settle obvious passes. Omit to judge every task fully. */
  router?: JudgeTarget;
  full: JudgeTarget;
  teamContext?: string;
  /** Confidence the router must reach before its pass is trusted. */
  routerMinConfidence?: number;
  routerTimeoutMs?: number;
  fullTimeoutMs?: number;
  /** Book the judge's own tokens too — they are a real part of a run's cost. */
  onUsage?: (event: { stage: 'router' | 'full'; input: number; output: number; model: string }) => void;
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface CallOutcome {
  text: string;
  input: number;
  output: number;
  failed?: string;
  aborted?: boolean;
}

async function judgeOnce(
  target: JudgeTarget,
  system: string,
  user: string,
  options: { maxTokens: number; timeoutMs: number }
): Promise<CallOutcome> {
  const adapter =
    target.profile.protocol === 'anthropic-messages'
      ? new AnthropicMessagesAdapter()
      : new OpenAIChatAdapter();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let text = '';
  let input = 0;
  let output = 0;
  try {
    const request = buildChatRequest(
      target.profile,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      'off',
      { apiKey: target.apiKey, maxTokens: options.maxTokens, signal: controller.signal }
    );
    for await (const event of adapter.stream(request)) {
      if (event.type === 'text-delta') text += event.text;
      if (event.type === 'usage') {
        input += event.input;
        output += event.output;
      }
      if (event.type === 'error') throw new Error(event.message);
    }
    return { text, input, output };
  } catch (error) {
    if (controller.signal.aborted) return { text, input, output, aborted: true };
    return { text, input, output, failed: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Catches the failures that need no model at all. */
function structuralCheck(output: string, evidence?: ToolEvidence): GatedResult | null {
  const text = output.trim();
  // 真的调用过工具（写文件、跑命令）时，短答复可能是「已完成」，交给评委判断；
  // 纯文本任务仍然按长度拦空答案。
  const didWork = (evidence?.tools ?? []).some((tool) => tool.ok);
  if (text.length < 20 && !didWork) {
    return {
      pass: false,
      score: 0,
      reasons: ['产出为空或过短'],
      suggestedFix: '写出满足验收标准的完整答案，不要只返回占位符。',
      gate: 'structural',
    };
  }
  if (/^(error|错误|exception|failed)\s*[:：]/i.test(text)) {
    return {
      pass: false,
      score: 0,
      reasons: ['产出是错误回显，不是任务结果'],
      suggestedFix: '重新执行任务并给出实际结果。',
      gate: 'structural',
    };
  }
  return null;
}

/**
 * 工具证据：模型可能只写「已完成」而不复述调用过程，评委需要独立看到
 * 这一次真正调用了哪些工具，才能判断「调用 read_file」这类验收条件。
 */
function toolEvidenceLine(evidence?: ToolEvidence): string {
  const tools = evidence?.tools ?? [];
  if (tools.length === 0) return '';
  const counts = new Map<string, { ok: number; fail: number }>();
  for (const tool of tools) {
    const entry = counts.get(tool.name) ?? { ok: 0, fail: 0 };
    if (tool.ok) entry.ok += 1;
    else entry.fail += 1;
    counts.set(tool.name, entry);
  }
  const parts = [...counts.entries()].map(
    ([name, count]) =>
      `${name}×${count.ok + count.fail}${count.fail > 0 ? `（${count.fail} 次失败）` : ''}`
  );
  return `本次任务实际调用的工具：${parts.join('、')}。`;
}

export function createRoutedJudge(options: RoutedJudgeOptions) {
  const minConfidence = options.routerMinConfidence ?? 0.7;
  const routerTimeoutMs = options.routerTimeoutMs ?? 12000;
  const fullTimeoutMs = options.fullTimeoutMs ?? 25000;
  const teamLine = options.teamContext ? `\n团队身份：\n${options.teamContext}` : '';
  // The gate must never become a tax. When the router is unreachable, every
  // task would pay its timeout before falling through to the real judge, so
  // after two consecutive failures the run finishes without the gate.
  let routerFailures = 0;

  return async (task: Subtask, output: string, evidence?: ToolEvidence): Promise<GatedResult> => {
    const early = structuralCheck(output, evidence);
    if (early) return early;
    const evidenceLine = toolEvidenceLine(evidence);

    if (options.router && routerFailures < 2) {
      const excerpt = output.length > 4000 ? `${output.slice(0, 4000)}\n……（已截断）` : output;
      const gate = await judgeOnce(
        options.router,
        `你是分派闸门。你的职责只有一个：判断产出是否明显满足验收标准，并给出你的把握程度。拿不准就降低 confidence，不要猜。只返回一个 JSON 对象。${teamLine}`,
        [
          `验收标准：${task.acceptanceCriteria}`,
          evidenceLine ? `工具证据：${evidenceLine}` : '',
          `产出节选：`,
          excerpt,
          '',
          '验收标准里要求调用某工具时，以工具证据为准；不要因为产出文本没有提到工具就判失败。',
          '只返回：{"pass":true|false,"confidence":0到1,"reason":"一句话"}',
        ]
          .filter(Boolean)
          .join('\n'),
        { maxTokens: 256, timeoutMs: routerTimeoutMs }
      );

      const verdict = gate.failed || gate.aborted ? null : extractJson(gate.text);
      if (gate.input || gate.output) {
        options.onUsage?.({
          stage: 'router',
          input: gate.input,
          output: gate.output,
          model: options.router.profile.model,
        });
      }
      if (verdict) routerFailures = 0;
      else routerFailures += 1;
      const confidence = Number(verdict?.confidence ?? 0);
      if (verdict && verdict.pass === true && confidence >= minConfidence) {
        return {
          pass: true,
          score: Math.min(0.95, 0.6 + confidence * 0.35),
          reasons: [
            typeof verdict.reason === 'string' && verdict.reason
              ? `闸门放行：${verdict.reason}`
              : '闸门放行',
          ],
          gate: 'cheap',
          confidence,
        };
      }
    }

    const excerpt =
      output.length > 12000 ? `${output.slice(0, 12000)}\n……（已截断）` : output;
    const full = await judgeOnce(
      options.full,
      `你是严格的验收评委。只返回一个 JSON 对象。${teamLine}`,
      [
        `任务：${task.title}`,
        `验收标准：${task.acceptanceCriteria}`,
        evidenceLine ? `工具证据：${evidenceLine}` : '',
        `产出：`,
        excerpt,
        '',
        '验收标准里要求调用某工具或读写文件时，以工具证据为准；不要因为产出文本没有提到工具就判失败。',
        '请严格验收。只返回一个 JSON 对象，不要 Markdown、不要代码围栏、不要解释：',
        '{"pass":true|false,"score":0到1,"reasons":["..."],"suggested_fix":"..."}',
      ]
        .filter(Boolean)
        .join('\n'),
      { maxTokens: 1024, timeoutMs: fullTimeoutMs }
    );

    if (full.input || full.output) {
      options.onUsage?.({
        stage: 'full',
        input: full.input,
        output: full.output,
        model: options.full.profile.model,
      });
    }

    if (full.aborted) {
      return {
        pass: true,
        score: 0.6,
        reasons: ['评委超时，已按放行处理，请人工确认'],
        needsHuman: true,
        gate: 'full',
      };
    }
    if (full.failed) {
      // The worker produced real output; failing the task for the judge's
      // network error punishes the wrong party.
      return {
        pass: true,
        score: 0.5,
        needsHuman: true,
        reasons: [`评委调用失败（${full.failed}），已标记为需人工确认`],
        gate: 'full',
      };
    }

    const verdict = extractJson(full.text);
    if (!verdict) {
      return {
        pass: true,
        score: 0.6,
        needsHuman: true,
        reasons: ['评委返回无法解析，已标记为需人工确认'],
        gate: 'full',
      };
    }

    return {
      pass: Boolean(verdict.pass),
      score: Number(verdict.score ?? 0),
      reasons: Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : [],
      suggestedFix:
        typeof verdict.suggested_fix === 'string' ? verdict.suggested_fix : undefined,
      gate: 'full',
    };
  };
}
