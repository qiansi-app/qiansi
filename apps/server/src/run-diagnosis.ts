import { existsSync, statSync, accessSync, constants } from 'node:fs';
import type { RunRecord, RunFailureSummary, RunStatus } from './store.js';
import { familyOf, type KeySlot } from './model-catalog.js';

/**
 * 运行失败后的「环境诊断」：不只说任务错了，还要说清楚这次运行依赖的环境
 * 现在是否可用——工作目录在不在、节点用的模型还能不能拿到 Key、是不是被
 * 用户手动停用了。界面据此给出可直接执行的修复动作和重跑入口。
 *
 * 借鉴 Grok Bot 的失败处理原则：报告「能做/不能做、为什么」，把判断交给
 * 下一步动作，而不是让用户猜。
 */

export interface DiagnosisTask {
  id: string;
  title: string;
  nodeId: string;
  status: 'done' | 'failed' | 'pending';
  error?: string;
}

export interface DiagnosisModel {
  nodeId: string;
  name: string;
  model: string;
  slot: KeySlot | 'unknown';
  disabled: boolean;
  ready: boolean;
  /** 给用户看的一句话：可用 / 没有可用 Key / 厂商已停用。 */
  note: string;
}

export interface DiagnosisRootDir {
  path: string;
  exists: boolean;
  writable: boolean;
  /** 来自画布设置还是服务端启动目录；后者意味着产出可能不在用户预期的项目里。 */
  source: 'workspace' | 'server';
}

export interface RunDiagnosis {
  ok: true;
  runId: string;
  workspaceId: string;
  status: RunStatus;
  goal: string;
  hasPlan: boolean;
  failure: RunFailureSummary | null;
  attempt: number;
  maxAttempts: number;
  tasks: DiagnosisTask[];
  environment: {
    rootDir: DiagnosisRootDir | null;
    models: DiagnosisModel[];
    /** 拿不到 Key、或被停用的厂商。 */
    missing: string[];
    hints: string[];
  };
  actions: {
    resume: { available: boolean; reason?: string; pending: number };
    fresh: { available: boolean; reason?: string };
    userView: { available: boolean; reason?: string };
  };
  /** 另一轮正在跑时，重跑会排队而不是失败。 */
  activeRunId: string | null;
}

export interface DiagnosisInput {
  record: RunRecord;
  workspaceId: string;
  rootDir: string | null;
  rootDirSource: 'workspace' | 'server';
  disabledSlots: Set<string>;
  keyReady: (slot: KeySlot) => Promise<boolean>;
  userViewAvailable: boolean;
  activeRunId: string | null;
  /** 这次运行之后是否已经起了续跑：旧的「已排队重试」不能当成现在的状态。 */
  hasResumedChild?: boolean;
  now?: number;
}

function dirState(path: string | null): DiagnosisRootDir | null {
  if (!path) return null;
  const exists = existsSync(path);
  let writable = false;
  if (exists) {
    try {
      accessSync(path, constants.W_OK);
      writable = statSync(path).isDirectory();
    } catch {
      writable = false;
    }
  }
  return { path, exists, writable, source: 'server' };
}

export async function buildRunDiagnosis(input: DiagnosisInput): Promise<RunDiagnosis> {
  const { record } = input;
  const storedFailure = record.failureSummary ?? null;
  // 失败总结是失败那一刻的快照；如果之后已经续跑过，「已排队重试」就是旧消息。
  const failure: RunFailureSummary | null = storedFailure
    ? { ...storedFailure, retryScheduled: Boolean(storedFailure.retryScheduled) && !input.hasResumedChild }
    : null;
  const subtasks = record.plan?.subtasks ?? [];
  const outputs = record.outputs ?? {};
  const failedIds = new Set((failure?.failedTasks ?? []).map((task) => task.id));
  const failedError = new Map((failure?.failedTasks ?? []).map((task) => [task.id, task.error]));

  const tasks: DiagnosisTask[] = subtasks.map((task) => {
    const hasOutput = String(outputs[task.id] ?? '').trim().length > 0;
    const status: DiagnosisTask['status'] = hasOutput
      ? 'done'
      : failedIds.has(task.id)
        ? 'failed'
        : 'pending';
    return {
      id: task.id,
      title: task.title,
      nodeId: task.assignedNodeId,
      status,
      error: failedError.get(task.id),
    };
  });

  // 用到的模型：计划里的节点一次运行最多用几个不同档案；按节点去重展示。
  const profileById = new Map((record.profiles ?? []).map((profile) => [profile.id, profile]));
  const seenNodes = new Set<string>();
  const models: DiagnosisModel[] = [];
  for (const task of subtasks) {
    if (seenNodes.has(task.assignedNodeId)) continue;
    seenNodes.add(task.assignedNodeId);
    const profile = profileById.get(task.profileId);
    const model = String(profile?.model ?? '');
    const family = model ? familyOf(model) : undefined;
    const slot = family?.slot ?? 'unknown';
    const disabled = slot !== 'unknown' && input.disabledSlots.has(slot);
    const ready = slot !== 'unknown' && !disabled ? await input.keyReady(slot) : false;
    models.push({
      nodeId: task.assignedNodeId,
      name: task.title,
      model: model || '未设置',
      slot,
      disabled,
      ready,
      note: disabled ? '厂商已停用' : ready ? '可用' : slot === 'unknown' ? '未知模型' : '没有可用 Key',
    });
  }

  const missing = [...new Set(models.filter((item) => !item.ready).map((item) => item.slot))];

  const hints: string[] = [];
  const rootDir = input.rootDir
    ? { ...(dirState(input.rootDir) as DiagnosisRootDir), source: input.rootDirSource }
    : null;
  if (rootDir && !rootDir.exists) {
    hints.push(
      rootDir.source === 'workspace'
        ? `画布的工作目录不存在：${rootDir.path}。节点读写文件和跑命令会退回服务端目录，重跑前请修正。`
        : `当前使用服务端启动目录 ${rootDir.path}，它不是你的项目。给这张画布设置工作目录后再重跑，产出才会落在项目里。`
    );
  } else if (rootDir && !rootDir.writable) {
    hints.push(`工作目录不可写：${rootDir.path}。写文件的节点会失败。`);
  }
  const disabledUsed = models.filter((item) => item.disabled);
  if (disabledUsed.length > 0) {
    hints.push(
      `用到已停用的厂商：${[...new Set(disabledUsed.map((item) => item.slot))].join('、')}。在「模型密钥」里启用，或把节点换成可用模型，否则重跑还会失败。`
    );
  }
  const noKey = models.filter((item) => !item.disabled && !item.ready && item.slot !== 'unknown');
  if (noKey.length > 0) {
    hints.push(`这些模型没有可用 Key：${[...new Set(noKey.map((item) => item.slot))].join('、')}。`);
  }
  const reasonsText = (failure?.reasons ?? []).join(' ');
  if (/预算用尽/.test(reasonsText)) {
    hints.push('本轮 token 预算用尽：到设置里提高本轮上限，或把大任务拆成几轮再重跑。');
  }
  if (record.manualStop) {
    hints.push('这一轮是手动停止的，不是环境坏了；重跑会从断点继续。');
  }
  if (failure?.retryScheduled) {
    hints.push('已排队自动重试：等这一轮跑完再手动重跑，避免两次运行互相打断。');
  } else if (failure && (record.resumeDepth ?? 0) >= 2) {
    hints.push('自动重试已用尽（3/3）。下面的重跑是手动发起的，不占自动额度。');
  }
  if (input.activeRunId && input.activeRunId !== record.runId) {
    hints.push('已有另一轮运行在跑：这里的重跑会排队，等它结束后自动开始。');
  }

  const pending = tasks.filter((task) => task.status !== 'done').length;
  const hasPlan = subtasks.length > 0;
  return {
    ok: true,
    runId: record.runId,
    workspaceId: input.workspaceId,
    status: record.status,
    goal: record.goal,
    hasPlan,
    failure,
    attempt: failure?.attempt ?? (record.resumeDepth ?? 0) + 1,
    maxAttempts: failure?.maxAttempts ?? (record.autoResume ? 3 : 1),
    tasks,
    environment: { rootDir, models, missing, hints },
    actions: {
      resume: hasPlan
        ? pending > 0
          ? { available: true, pending }
          : { available: false, pending, reason: '所有任务都已有产出；要重跑整轮请用「整轮重跑」。' }
        : { available: false, pending, reason: '运行记录里没有计划，无法续跑。' },
      fresh: hasPlan
        ? { available: true }
        : { available: false, reason: '运行记录里没有计划；请回到画布重新运行。' },
      userView: input.userViewAvailable
        ? { available: true }
        : { available: false, reason: '工作目录里没找到可自动启动的项目（package.json 的 dev/start/preview 或 index.html）。' },
    },
    activeRunId: input.activeRunId,
  };
}
