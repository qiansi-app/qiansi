import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, RunEvent, UsageSnapshot } from '@qiansi/engine';
import { ensureStateDir } from './state-dir.js';

export interface RunEnvelope {
  seq: number;
  ts: number;
  event: RunEvent;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'aborted';

export interface RunRecord {
  runId: string;
  goal: string;
  status: RunStatus;
  plan?: Plan;
  outputs: Record<string, string>;
  usage: UsageSnapshot;
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

  create(runId: string, goal: string): RunRecord {
    const record: RunRecord = {
      runId,
      goal,
      status: 'running',
      outputs: {},
      usage: { total: 0, byModel: {} },
      events: [],
      seq: 0,
      startedAt: Date.now(),
      subscribers: new Set(),
    };
    this.runs.set(runId, record);
    return record;
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
      record.status = event.status;
      record.finishedAt = Date.now();
      this.persist(record);
    }

    for (const subscriber of record.subscribers) subscriber(envelope);
  }

  subscribe(runId: string, subscriber: (envelope: RunEnvelope) => void): () => void {
    const record = this.runs.get(runId);
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
      plan: record.plan,
      outputs: record.outputs,
      usage: record.usage,
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
