import { buildChatRequest, profileById } from './capability.js';
import { nextEffort } from './effort.js';
import type {
  AcceptanceResult,
  BudgetPolicy,
  CapabilityProfile,
  ChatAdapter,
  ChoiceCard,
  Plan,
  Protocol,
  RunEvent,
  RunResult,
  Subtask,
  TaskStatus,
  UsageSnapshot,
} from './types.js';

export interface OrchestratorOptions {
  profiles: CapabilityProfile[];
  adapters: Partial<Record<Protocol, ChatAdapter>>;
  /** profileId -> API key. Keys belong in the OS keychain; this is an injection point. */
  apiKeys?: Record<string, string>;
  concurrency?: number;
  maxRetries?: number;
  /** Token and call budgets for this run. */
  budget?: BudgetPolicy;
  /** Per-task wall clock limit. Defaults to 120s. */
  taskTimeoutMs?: number;
  /** Hard cap on a single task's output tokens. Defaults to 2048. */
  maxOutputTokens?: number;
  /** External abort signal (run.stop). */
  signal?: AbortSignal;
  /** Human-readable roster of the team (roles, models, effort) for the planner/judge. */
  teamContext?: string;
  /** Optional run id so the server can create a snapshot before the run starts. */
  runId?: string;
  accept?: (task: Subtask, output: string) => Promise<AcceptanceResult>;
  /** Return the chosen option id. Omit to auto-abort when a run stalls. */
  onChoice?: (card: ChoiceCard) => Promise<string>;
}

interface TaskOutcome {
  ok: boolean;
  output: string;
}

export class Orchestrator {
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly usage: UsageSnapshot = { total: 0, byModel: {} };
  private readonly tokenEvents: Array<{ ts: number; tokens: number }> = [];
  private budgetExceeded = false;

  constructor(private readonly options: OrchestratorOptions) {}

  on(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async run(plan: Plan): Promise<RunResult> {
    const runId = this.options.runId ?? crypto.randomUUID();
    this.usage.total = 0;
    this.usage.byModel = {};
    this.tokenEvents.length = 0;
    this.budgetExceeded = false;
    const concurrency = Math.max(1, this.options.concurrency ?? 3);
    const maxRetries = Math.max(0, this.options.maxRetries ?? 2);
    const outputs: Record<string, string> = {};
    const completed = new Set<string>();
    const failed = new Set<string>();

    const pending = new Map<string, Subtask>();
    for (const task of plan.subtasks) {
      pending.set(task.id, { ...task, status: 'pending', attempts: 0 });
    }

    this.emit({ type: 'run.started', runId, goal: plan.goal });
    this.emit({ type: 'plan.created', plan });

    while (pending.size > 0) {
      if (this.budgetExceeded) {
        for (const task of pending.values()) {
          failed.add(task.id);
          this.emit({ type: 'task.failed', taskId: task.id, error: 'budget exceeded' });
        }
        pending.clear();
        break;
      }

      for (const task of [...pending.values()]) {
        if (task.dependsOn.some((dep) => failed.has(dep))) {
          failed.add(task.id);
          pending.delete(task.id);
          this.emit({ type: 'task.failed', taskId: task.id, error: 'upstream dependency failed' });
          continue;
        }
        task.status = task.dependsOn.every((dep) => completed.has(dep)) ? 'ready' : 'pending';
      }

      const ready = [...pending.values()].filter((task) => task.status === 'ready');
      if (ready.length === 0) {
        for (const task of pending.values()) {
          failed.add(task.id);
          this.emit({ type: 'task.failed', taskId: task.id, error: 'unresolvable dependencies' });
        }
        pending.clear();
        break;
      }

      const batch = ready.slice(0, concurrency);
      const results = await Promise.all(
        batch.map(async (task) => {
          const dependencyOutputs: Record<string, string> = {};
          for (const dependency of task.dependsOn) {
            const value = outputs[dependency];
            if (value) dependencyOutputs[dependency] = value;
          }
          return [task.id, await this.executeTask(task, maxRetries, dependencyOutputs)] as const;
        })
      );

      for (const [taskId, outcome] of results) {
        if (outcome.ok) {
          completed.add(taskId);
          outputs[taskId] = outcome.output;
        } else {
          failed.add(taskId);
        }
        pending.delete(taskId);
      }
    }

    const status: RunResult['status'] = failed.size === 0 ? 'done' : 'failed';
    this.emit({ type: 'run.finished', runId, status });
    return { runId, status, outputs };
  }

  private recordUsage(task: Subtask, modelId: string, input: number, output: number): void {
    const total = input + output;
    this.usage.total += total;
    const existing = this.usage.byModel[modelId] ?? { input: 0, output: 0 };
    existing.input += input;
    existing.output += output;
    this.usage.byModel[modelId] = existing;
    this.tokenEvents.push({ ts: Date.now(), tokens: total });

    this.emit({
      type: 'usage',
      taskId: task.id,
      nodeId: task.assignedNodeId,
      modelId,
      input,
      output,
      total,
      runTotal: this.usage.total,
    });
  }

  private checkBudget(
    modelId: string
  ): { scope: 'run' | 'model' | 'rate'; detail: string } | null {
    const budget = this.options.budget;
    if (!budget) return null;

    if (budget.maxTotalTokens && this.usage.total > budget.maxTotalTokens) {
      return {
        scope: 'run',
        detail: `run tokens ${this.usage.total} > ${budget.maxTotalTokens}`,
      };
    }

    const model = this.usage.byModel[modelId];
    const modelTotal = (model?.input ?? 0) + (model?.output ?? 0);
    if (budget.maxTokensPerModel && modelTotal > budget.maxTokensPerModel) {
      return {
        scope: 'model',
        detail: `${modelId} tokens ${modelTotal} > ${budget.maxTokensPerModel}`,
      };
    }

    const cutoff = Date.now() - 60000;
    while (this.tokenEvents.length > 0 && this.tokenEvents[0]!.ts < cutoff) {
      this.tokenEvents.shift();
    }
    const perMinute = this.tokenEvents.reduce((sum, item) => sum + item.tokens, 0);
    if (budget.maxTokensPerMinute && perMinute > budget.maxTokensPerMinute) {
      return {
        scope: 'rate',
        detail: `tokens/min ${perMinute} > ${budget.maxTokensPerMinute}`,
      };
    }

    return null;
  }

  private async executeTask(
    task: Subtask,
    maxRetries: number,
    dependencyOutputs: Record<string, string>
  ): Promise<TaskOutcome> {
    this.emit({ type: 'task.queued', taskId: task.id, nodeId: task.assignedNodeId });

    let output = '';
    let effort = task.effort;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (this.budgetExceeded) {
        task.status = 'failed';
        this.emit({
          type: 'task.failed',
          taskId: task.id,
          error: 'budget exceeded',
        });
        return { ok: false, output };
      }

      const maxCalls = this.options.budget?.maxCallsPerTask;
      if (maxCalls && attempt >= maxCalls) {
        this.emit({
          type: 'budget.exceeded',
          scope: 'calls',
          detail: `task ${task.id} reached ${maxCalls} model calls`,
          runTotal: this.usage.total,
        });
        task.status = 'failed';
        this.emit({
          type: 'task.failed',
          taskId: task.id,
          error: 'budget: max model calls per task',
        });
        return { ok: false, output };
      }

      task.status = 'running';
      task.attempts = attempt;
      this.emit({
        type: 'task.started',
        taskId: task.id,
        nodeId: task.assignedNodeId,
        effort,
        attempt,
      });

      output = '';
      let streamError: string | undefined;
      try {
        output = await this.streamTask(task, effort, dependencyOutputs);
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error);
        output = output || `Error: ${streamError}`;
      }

      const acceptance = streamError
        ? {
            pass: false,
            score: 0,
            reasons: [streamError],
            suggestedFix: 'Retry the request; if it keeps failing, check the connection.',
          }
        : await this.accept(task, output);
      this.emit({ type: 'task.acceptance', taskId: task.id, result: acceptance });

      if (acceptance.pass) {
        task.status = 'done';
        this.emit({ type: 'task.completed', taskId: task.id, output, artifacts: task.artifacts });
        return { ok: true, output };
      }

      if (attempt < maxRetries) {
        const raised = nextEffort(effort);
        if (raised !== effort) {
          effort = raised;
          task.effort = raised;
          this.emit({
            type: 'task.revised',
            taskId: task.id,
            nextEffort: raised,
            reason: acceptance.suggestedFix ?? (acceptance.reasons.join('; ') || 'acceptance failed'),
          });
        }
        continue;
      }

      const decision = await this.requestChoice(task, acceptance);
      if (decision === 'accept') {
        task.status = 'done';
        this.emit({ type: 'task.completed', taskId: task.id, output, artifacts: task.artifacts });
        return { ok: true, output };
      }

      task.status = 'failed';
      this.emit({
        type: 'task.failed',
        taskId: task.id,
        error: acceptance.reasons.join('; ') || 'acceptance failed after retries',
      });
      return { ok: false, output };
    }

    return { ok: false, output };
  }

  private async streamTask(
    task: Subtask,
    effort: Subtask['effort'],
    dependencyOutputs: Record<string, string>
  ): Promise<string> {
    const profile = profileById(this.options.profiles, task.profileId);
    const adapter = this.options.adapters[profile.protocol];
    if (!adapter) throw new Error(`No adapter registered for protocol ${profile.protocol}`);

    const controller = new AbortController();
    const timeoutMs = this.options.taskTimeoutMs ?? 120000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const external = this.options.signal;
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const upstream = Object.entries(dependencyOutputs)
        .filter(([, value]) => value.trim().length > 0)
        .map(([id, value]) => `### ${id}\n${value}`)
        .join('\n\n');

      const messages = [
        {
          role: 'system' as const,
          content: [
            `You are a specialist agent on a multi-agent team. Role: ${task.title}.`,
            `Acceptance criteria: ${task.acceptanceCriteria}`,
            ...(this.options.teamContext
              ? [`Team roster (respect each member's model and effort):\n${this.options.teamContext}`]
              : []),
            'Return the finished work only. Do not narrate your process.',
            'Keep the answer concise; do not repeat the prompt.',
          ].join('\n'),
        },
        ...(upstream
          ? [
              {
                role: 'user' as const,
                content: `Upstream task outputs (use them as the source of truth):\n\n${upstream}`,
              },
            ]
          : []),
        { role: 'user' as const, content: task.description },
      ];

      const request = buildChatRequest(
        profile,
        messages,
        effort,
        {
          apiKey: this.options.apiKeys?.[profile.id],
          maxTokens: Math.min(profile.maxOutput, this.options.maxOutputTokens ?? 2048),
          signal: controller.signal,
        }
      );

      let text = '';
      for await (const event of adapter.stream(request)) {
        if (event.type === 'text-delta') {
          text += event.text;
          this.emit({ type: 'text.delta', taskId: task.id, nodeId: task.assignedNodeId, text: event.text });
        } else if (event.type === 'reasoning-delta') {
          this.emit({
            type: 'reasoning.delta',
            taskId: task.id,
            nodeId: task.assignedNodeId,
            text: event.text,
          });
        } else if (event.type === 'usage') {
          this.recordUsage(task, profile.id, event.input, event.output);
          const violation = this.checkBudget(profile.id);
          if (violation) {
            this.budgetExceeded = true;
            this.emit({
              type: 'budget.exceeded',
              scope: violation.scope,
              detail: violation.detail,
              runTotal: this.usage.total,
            });
            throw new Error(`Budget exceeded: ${violation.detail}`);
          }
        } else if (event.type === 'error') {
          throw new Error(`${event.code}: ${event.message}`);
        }
      }
      return text;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  private async accept(task: Subtask, output: string): Promise<AcceptanceResult> {
    if (this.options.accept) return this.options.accept(task, output);
    const pass = output.trim().length > 0;
    return {
      pass,
      score: pass ? 0.7 : 0,
      reasons: pass ? [] : ['empty output'],
      suggestedFix: pass ? undefined : 'Produce a non-empty result that satisfies the acceptance criteria.',
    };
  }

  private async requestChoice(task: Subtask, acceptance: AcceptanceResult): Promise<string> {
    const card: ChoiceCard = {
      id: crypto.randomUUID(),
      taskId: task.id,
      title: `Task "${task.title}" still fails acceptance`,
      detail: acceptance.reasons.join('; ') || 'The acceptance check failed after the retry budget.',
      options: [
        {
          id: 'retry',
          label: 'Retry at max effort',
          consequence: 'More latency and tokens; the model may still fail.',
        },
        {
          id: 'accept',
          label: 'Accept current output',
          consequence: 'Downstream work may inherit the defect.',
        },
        {
          id: 'abort',
          label: 'Abort this task',
          consequence: 'Dependent tasks will be blocked.',
        },
      ],
    };

    this.emit({ type: 'choice.requested', card });
    const option = this.options.onChoice ? await this.options.onChoice(card) : 'abort';
    this.emit({ type: 'choice.resolved', cardId: card.id, optionId: option });
    return option;
  }
}

export type { TaskStatus };
