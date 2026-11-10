import type { Plan } from '@qiansi/engine';

/**
 * 断点续跑的计划构建（长期项目的核心）。
 *
 * 一轮运行中途死掉时，已完成任务的产出还在账上；续跑不该重做它们——
 * 只挑出没产出的任务，依赖改指到「仍然待跑」的任务，并把已完成产出
 * 作为恢复上下文写进每个任务的说明里（上游注入由 seedOutputs 完成）。
 */

export interface ResumeTaskInfo {
  taskId: string;
  title: string;
  description: string;
  assignedNodeId?: string;
  profileId: string;
  effort: string;
  acceptanceCriteria: string;
  dependsOn: string[];
}

export interface ResumeBuildResult {
  plan: Plan;
  pending: string[];
  skippedDone: string[];
}

export function buildResumePlan(input: {
  prevPlan: Plan;
  prevOutputs: Record<string, string>;
  resumeDepth: number;
}): ResumeBuildResult {
  const prevPlan = input.prevPlan;
  const outputs = input.prevOutputs ?? {};

  const hasOutput = (taskId: string): boolean =>
    typeof outputs[taskId] === 'string' && outputs[taskId].trim().length > 0;

  // 待跑 = 上次计划里没有产出（或产出为空）的任务。
  const pendingTasks = prevPlan.subtasks.filter((task) => !hasOutput(task.id));
  const pendingIds = new Set(pendingTasks.map((task) => task.id));

  const doneTitles = prevPlan.subtasks
    .filter((task) => !pendingIds.has(task.id))
    .map((task) => `${task.id}「${task.title}」`);

  const recoveryNote =
    input.resumeDepth > 0
      ? `这是第 ${input.resumeDepth + 1} 次续跑（此前中断 ${input.resumeDepth} 次）。`
      : '这是中断后的续跑。';

  // dependsOn 原样保留：已完成任务的产出会由 orchestrator 的 seedOutputs 预置，
  // 调度器因此认为它们「已完成」，上游注入也按原来的依赖关系送达。
  const subtasks = pendingTasks.map((task) => {
    const doneDeps = task.dependsOn.filter((dep) => !pendingIds.has(dep));
    const doneNote = doneDeps.length
      ? `\n（这些依赖在上次运行已完成，产出已在「上游任务输出」里提供：${doneDeps.join('、')}）`
      : '';
    return {
      ...task,
      status: 'pending' as const,
      attempts: 0,
      description: [
        task.description,
        ``,
        `【恢复说明】${recoveryNote}${doneNote}`,
        doneDeps.length ? '已完成的任务不要重做，直接基于其产出继续。' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });

  return {
    plan: {
      goal: prevPlan.goal,
      rationale: `断点续跑（第 ${input.resumeDepth + 1} 次）：${pendingTasks.length} 个待跑任务${
        doneTitles.length ? `；上次已完成 ${doneTitles.length} 个（${doneTitles.join('、')}），产出已注入` : ''
      }。`,
      subtasks,
    },
    pending: pendingTasks.map((task) => task.id),
    skippedDone: prevPlan.subtasks.filter((task) => !pendingIds.has(task.id)).map((task) => task.id),
  };
}
