import type { Plan } from '@qiansi/engine';

/**
 * 领导层（旗舰模型）职责，按用户定的分工：
 *   - 检验成果：作为完整评委（便宜闸门只筛明显通过，拿不准的交给它）；
 *   - 提出建议：每轮结束后复盘，给出结论与改进建议；
 *   - 分配工作：自动编排由主控模型拆解（已有）；
 *   - 发起讨论：成果远远达不到目标时，触发多模型讨论找原因。
 *
 * 这里只放纯逻辑与提示词构建，模型调用在 index.ts（需要 completeChat 与 Key）。
 */

export interface TaskOutcome {
  taskId: string;
  title: string;
  status: 'done' | 'failed' | 'pending';
  /** 最后一次验收的分数与理由（没有验收事件时为 null）。 */
  score: number | null;
  reasons: string[];
  chars: number;
}

export interface LeadershipVerdict {
  verdict: 'ok' | 'weak' | 'failed';
  score: number;
  summary: string;
  suggestions: string[];
  action: 'none' | 'discuss';
}

export interface OutcomeSummary {
  total: number;
  done: number;
  failed: number;
  /** 有分数的任务的平均分；全都没有分数时为 null。 */
  avgScore: number | null;
}

export function summarizeOutcomes(tasks: TaskOutcome[]): OutcomeSummary {
  const done = tasks.filter((task) => task.status === 'done').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  const scored = tasks.filter((task) => typeof task.score === 'number');
  const avgScore = scored.length
    ? scored.reduce((sum, task) => sum + (task.score ?? 0), 0) / scored.length
    : null;
  return { total: tasks.length, done, failed, avgScore };
}

/**
 * 是否「远远达不到目标」：
 *   - 有任务失败（目标至少缺了一块）；或
 *   - 全部完成但平均验收分低于 0.6（过是过了，质量不够）。
 * 分数缺失（评委降级软通过）不作依据——那是基础设施问题，不是产出问题。
 */
export function decideAction(summary: OutcomeSummary): 'none' | 'discuss' {
  if (summary.total === 0) return 'none';
  if (summary.failed > 0) return 'discuss';
  if (summary.avgScore !== null && summary.avgScore < 0.6) return 'discuss';
  return 'none';
}

/** 复盘提示词：给旗舰模型看「目标 + 每个任务的结果」，要一份短 JSON。 */
export function buildReviewPrompt(goal: string, tasks: TaskOutcome[]): string {
  const lines = tasks.map((task) => {
    const head = `- ${task.taskId}「${task.title}」：${task.status}`;
    const score = task.score === null ? '' : `，验收 ${task.score.toFixed(2)}`;
    const reasons = task.reasons.length ? `；理由：${task.reasons.join('；').slice(0, 160)}` : '';
    return `${head}${score}，产出 ${task.chars} 字${reasons}`;
  });
  return [
    `总目标：${goal}`,
    '',
    '各任务结果：',
    ...lines,
    '',
    '你是这轮编排的决策者。基于以上结果做一次简短复盘，只输出一个 JSON 对象：',
    '{"verdict":"ok|weak|failed","score":0到1,"summary":"一句话结论","suggestions":["最多3条可执行建议"],"action":"none|discuss"}',
    '判定规则：成果基本达成目标 → ok/none；通过但质量明显不足 → weak/none 或 weak/discuss；有任务失败或方向偏了 → failed/discuss。',
    '建议必须具体到「下一轮改什么」，不要泛泛而谈，不要评价自己。',
  ].join('\n');
}

/** 讨论主题：把失败与建议带进去，让讨论有靶子。 */
export function buildDiscussionTopic(
  goal: string,
  summary: OutcomeSummary,
  verdict: LeadershipVerdict | null
): string {
  const parts = [`这轮编排没有达到目标：${goal}`];
  parts.push(
    `结果：${summary.done}/${summary.total} 完成${
      summary.failed ? `，${summary.failed} 个失败` : ''
    }${summary.avgScore !== null ? `，平均验收 ${summary.avgScore.toFixed(2)}` : ''}。`
  );
  if (verdict) {
    parts.push(`决策者复盘：${verdict.summary}`);
    if (verdict.suggestions.length) parts.push(`已提出的建议：${verdict.suggestions.join('；')}`);
  }
  parts.push('请讨论：最可能的根因是什么？下一轮具体应该怎么改（模型选择、任务拆分、验收标准、资料）？不要客套。');
  return parts.join('\n');
}

/** 宽松解析模型复盘的 JSON；字段缺失时给出保守默认值。 */
export function normalizeVerdict(raw: unknown, summary: OutcomeSummary): LeadershipVerdict {
  const value = (raw ?? {}) as Record<string, unknown>;
  const verdict =
    value.verdict === 'ok' || value.verdict === 'weak' || value.verdict === 'failed'
      ? value.verdict
      : decideAction(summary) === 'discuss'
        ? 'weak'
        : 'ok';
  const score = Number(value.score);
  return {
    verdict,
    score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : summary.avgScore ?? 0.5,
    summary: String(value.summary ?? '').slice(0, 300),
    suggestions: Array.isArray(value.suggestions)
      ? value.suggestions.map((item) => String(item)).filter(Boolean).slice(0, 3)
      : [],
    action:
      value.action === 'discuss' || value.action === 'none'
        ? value.action
        : decideAction(summary),
  };
}

/** 从计划与运行事件里提取每个任务的结果摘要。 */
export function collectOutcomes(
  plan: Plan | undefined,
  outputs: Record<string, string>,
  acceptances: Array<{ taskId?: string; result?: { score?: number; reasons?: string[] } }>
): TaskOutcome[] {
  if (!plan) return [];
  const lastByTask = new Map<string, { score: number | null; reasons: string[] }>();
  for (const item of acceptances) {
    if (!item.taskId) continue;
    lastByTask.set(item.taskId, {
      score: typeof item.result?.score === 'number' ? item.result.score : null,
      reasons: Array.isArray(item.result?.reasons) ? item.result.reasons.map(String) : [],
    });
  }
  return plan.subtasks.map((task) => {
    const output = outputs[task.id] ?? '';
    const acceptance = lastByTask.get(task.id);
    return {
      taskId: task.id,
      title: task.title,
      status: output ? 'done' : 'failed',
      score: acceptance?.score ?? null,
      reasons: acceptance?.reasons ?? [],
      chars: output.length,
    };
  });
}
