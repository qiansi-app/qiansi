import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityProfile, Plan, RunEvent, UsageSnapshot } from '@qiansi/engine';
import { ensureStateDir } from './state-dir.js';
import type { Mandate } from './policy.js';
import type { LeadershipVerdict } from './leadership.js';

export interface RunReview extends LeadershipVerdict {
  model: string;
  at: number;
}

export interface RunEnvelope {
  seq: number;
  ts: number;
  event: RunEvent;
}

/**
 * 失败归因：给用户看的「为什么失败」+ 自动重试进度 + 是否已排下一次重试。
 * 重试上限固定为 1 次首跑 + 2 次自动续跑。
 */
export interface RunFailureSummary {
  headline: string;
  reasons: string[];
  failedTasks: Array<{ id: string; title: string; error: string }>;
  /** 这是第几次尝试（1 = 首跑）。 */
  attempt: number;
  maxAttempts: number;
  /** 是否已经排了下一次自动重试。 */
  retryScheduled: boolean;
  at: number;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'aborted';

export interface RunRecord {
  runId: string;
  goal: string;
  /** 这次运行属于哪个工作区；回写产物时写回同一张画布。 */
  workspaceId?: string;
  /** 计划从画布生成还是内置演示；启动补投副作用时据此决定要不要回写。 */
  planSource?: 'canvas' | 'builtin';
  /** 断点续跑链：上一轮运行的 id 与当前续跑深度（用于自动续跑上限）。 */
  resumedFrom?: string;
  resumeDepth?: number;
  /** 自动续跑意图：跨重启保留，失败/中断后自动排下一次续跑。 */
  autoResume?: boolean;
  /** 人为停止：自动续跑必须尊重它（DSH：故意停止暂停自动恢复）。 */
  manualStop?: boolean;
  /** 本轮用到的能力档案：断点续跑时按 profileId 恢复模型与路由。 */
  profiles?: CapabilityProfile[];
  status: RunStatus;
  plan?: Plan;
  outputs: Record<string, string>;
  usage: UsageSnapshot;
  /** What this run was authorised to do, and under which policy version. */
  mandate?: Mandate;
  /** 领导层复盘结论（旗舰模型对整轮成果的检验与建议）。 */
  review?: RunReview;
  /** 失败归因与重试进度（只在失败/中断时存在）。 */
  failureSummary?: RunFailureSummary;
  events: RunEnvelope[];
  seq: number;
  startedAt: number;
  finishedAt?: number;
  subscribers: Set<(envelope: RunEnvelope) => void>;
}

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runsDir = join(ensureStateDir(), 'runs');

  constructor() {
    mkdirSync(this.runsDir, { recursive: true });
  }

  private fileFor(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private readPersisted(runId: string): { snapshot: any; events: RunEnvelope[] } | undefined {
    const file = this.fileFor(runId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as {
        snapshot: any;
        events: RunEnvelope[];
      };
    } catch {
      return undefined;
    }
  }

  private persist(record: RunRecord): void {
    mkdirSync(this.runsDir, { recursive: true });
    writeFileSync(
      this.fileFor(record.runId),
      JSON.stringify({ snapshot: this.snapshot(record.runId), events: record.events }, null, 2),
      'utf8'
    );
  }

  create(
    runId: string,
    goal: string,
    workspaceId?: string,
    planSource?: 'canvas' | 'builtin',
    extra?: {
      resumedFrom?: string;
      resumeDepth?: number;
      autoResume?: boolean;
      profiles?: CapabilityProfile[];
    }
  ): RunRecord {
    const record: RunRecord = {
      runId,
      goal,
      workspaceId,
      planSource,
      resumedFrom: extra?.resumedFrom,
      resumeDepth: extra?.resumeDepth,
      autoResume: extra?.autoResume,
      profiles: extra?.profiles,

      status: 'running',
      outputs: {},
      usage: { total: 0, byModel: {} },
      events: [],
      seq: 0,
      startedAt: Date.now(),
      subscribers: new Set(),
    };
    this.runs.set(runId, record);
    // Persist at creation: a run that dies with the process must still be
    // discoverable, otherwise the progress strip and the history both vanish.
    try {
      this.persist(record);
    } catch {
      // a read-only state dir should not prevent the run itself
    }
    return record;
  }

  /** 正在跑的运行（内存里 status 仍是 running 的），最新的在前。 */
  running(): RunRecord[] {
    return [...this.runs.values()]
      .filter((record) => record.status === 'running')
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 最近一段时间内刚结束的运行（含失败），用于页面切回时补一个完成态。 */
  recentFinished(withinMs: number): RunRecord | undefined {
    const now = Date.now();
    return [...this.runs.values()]
      .filter((record) => record.status !== 'running' && record.finishedAt && now - record.finishedAt <= withinMs)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  }

  get(runId: string): RunRecord | undefined {
    const existing = this.runs.get(runId);
    if (existing) return existing;

    const persisted = this.readPersisted(runId);
    if (!persisted) return undefined;
    const record: RunRecord = {
      ...persisted.snapshot,
      events: persisted.events,
      seq: persisted.events.at(-1)?.seq ?? 0,
      subscribers: new Set(),
    };
    this.runs.set(runId, record);
    return record;
  }

  append(runId: string, event: RunEvent): void {
    const record = this.runs.get(runId);
    if (!record) return;

    const envelope: RunEnvelope = {
      seq: record.seq + 1,
      ts: Date.now(),
      event,
    };
    record.seq = envelope.seq;
    record.events.push(envelope);

    if (event.type === 'plan.created') record.plan = event.plan;
    if (event.type === 'task.completed') record.outputs[event.taskId] = event.output;
    if (event.type === 'usage') {
      const current = record.usage.byModel[event.modelId] ?? { input: 0, output: 0 };
      current.input += event.input;
      current.output += event.output;
      record.usage.byModel[event.modelId] = current;
      record.usage.total = event.runTotal;
    }
    if (event.type === 'run.finished') {
      // 第一个终态为准：优雅停机先写 aborted， orchestrator 收尾可能再报一次
      // failed/aborted——不得覆盖，否则「人为停止」会被误记成失败。
      if (record.finishedAt) {
        return;
      }
      record.status = event.status;
      record.finishedAt = Date.now();
      this.persist(record);
    } else if (
      // Persist the milestones a recovering UI needs, but never the token
      // streams: a checkpoint per task transition is cheap, per delta is not.
      event.type === 'plan.created' ||
      event.type === 'task.queued' ||
      event.type === 'task.started' ||
      event.type === 'task.completed' ||
      event.type === 'task.failed' ||
      event.type === 'task.acceptance'
    ) {
      try {
        this.persist(record);
      } catch {
        // persistence is best effort; the in-memory run continues
      }
    }

    for (const subscriber of record.subscribers) subscriber(envelope);
  }

  /**
   * A run persists as `running` until it finishes. If the process dies first,
   * that record is a lie the next launch inherits — the UI polls /api/runs/
   * active and gets nothing, so the user sees their progress silently vanish.
   * Called once at startup: mark them interrupted so the canvas can say so.
   */
  interruptStale(reason = '服务重启，运行被中断'): string[] {
    const interrupted: string[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(this.runsDir).filter((name) => name.endsWith('.json'));
    } catch {
      return interrupted;
    }
    for (const name of files) {
      const runId = name.slice(0, -'.json'.length);
      if (this.runs.has(runId)) continue; // live in memory: not stale
      const persisted = this.readPersisted(runId);
      const snapshot = persisted?.snapshot as { status?: string } | undefined;
      if (!snapshot || snapshot.status !== 'running') continue;
      const record = this.get(runId);
      if (!record) continue;
      const envelope: RunEnvelope = {
        seq: record.seq + 1,
        ts: Date.now(),
        event: { type: 'budget.exceeded', scope: 'run', detail: reason, runTotal: record.usage.total },
      };
      // A structured note lands in the event log so the reason survives.
      record.seq = envelope.seq;
      record.events.push(envelope);
      const finished: RunEnvelope = {
        seq: record.seq + 1,
        ts: Date.now(),
        event: { type: 'run.finished', runId, status: 'aborted' },
      };
      record.seq = finished.seq;
      record.events.push(finished);
      record.status = 'aborted';
      record.finishedAt = Date.now();
      try {
        this.persist(record);
      } catch {
        // nothing else we can do; the next boot retries
      }
      interrupted.push(runId);
    }
    return interrupted;
  }

  /**
   * Persisted immediately: a mandate is the evidence of who authorised a run,
   * so it must survive a crash that happens while the run is still going.
   */
  setMandate(runId: string, mandate: Mandate): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.mandate = mandate;
    this.persist(record);
  }

  /** 领导层复盘可能在运行结束之后才产出；落盘保证重启后仍能看到。 */
  setReview(runId: string, review: RunReview): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.review = review;
    try {
      this.persist(record);
    } catch {
      // 复盘写不进去不影响运行记录本身
    }
  }

  /** 失败归因：随运行记录持久化，界面与自动重试都用它。 */
  setFailureSummary(runId: string, summary: RunFailureSummary): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.failureSummary = summary;
    try {
      this.persist(record);
    } catch {
      // 写不进去不影响失败本身
    }
  }

  /** 人为停止：记录后，自动续跑与启动补排都不再接手这一轮。 */
  markManualStop(runId: string): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.manualStop = true;
    try {
      this.persist(record);
    } catch {
      // 标记丢失最多导致多续跑一轮
    }
  }

  /**
   * 断点续跑的预注入：把上一轮已完成任务的产出放进本轮 outputs，
   * 这样续跑任务的依赖解析能直接取到上游（orchestrator 按任务 id 找）。
   */
  seedOutputs(runId: string, outputs: Record<string, string>): void {
    const record = this.runs.get(runId);
    if (!record) return;
    for (const [taskId, value] of Object.entries(outputs)) {
      if (typeof value === 'string' && value.trim()) record.outputs[taskId] = value;
    }
    this.persist(record);
  }

  getMandate(runId: string): Mandate | undefined {
    return this.get(runId)?.mandate;
  }

  subscribe(runId: string, subscriber: (envelope: RunEnvelope) => void): () => void {    const record = this.runs.get(runId);
    if (!record) return () => {};
    record.subscribers.add(subscriber);
    return () => record.subscribers.delete(subscriber);
  }

  snapshot(runId: string) {
    const record = this.runs.get(runId);
    if (!record) {
      const persisted = this.readPersisted(runId);
      return persisted?.snapshot;
    }
    return {
      runId: record.runId,
      status: record.status,
      goal: record.goal,
      workspaceId: record.workspaceId,
      planSource: record.planSource,
      resumedFrom: record.resumedFrom,
      resumeDepth: record.resumeDepth,
      autoResume: record.autoResume,
      manualStop: record.manualStop,
      profiles: record.profiles,
      plan: record.plan,
      outputs: record.outputs,
      usage: record.usage,
      mandate: record.mandate,
      review: record.review,
      failureSummary: record.failureSummary,
      lastSeq: record.seq,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  list() {
    const items: Array<{
      runId: string;
      status: string;
      goal: string;
      tokens: number;
      events: number;
      startedAt: number;
      finishedAt?: number;
      workspaceId?: string;
    }> = [];

    for (const file of readdirSync(this.runsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.runsDir, file), 'utf8')) as {
          snapshot?: any;
          events?: RunEnvelope[];
        };
        if (!data.snapshot) continue;
        items.push({
          runId: data.snapshot.runId,
          status: data.snapshot.status,
          goal: data.snapshot.goal,
          workspaceId: data.snapshot.workspaceId,
          tokens: data.snapshot.usage?.total ?? 0,
          events: data.events?.length ?? 0,
          startedAt: data.snapshot.startedAt,
          finishedAt: data.snapshot.finishedAt,
        });
      } catch {
        // ignore corrupt files
      }
    }

    return items.sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
  }
}
