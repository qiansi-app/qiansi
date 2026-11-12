import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  AnthropicMessagesAdapter,
  OpenAIChatAdapter,
  Orchestrator,
  SearchToolAdapter,
  buildChatRequest,
  discussionPrompt,
  isConversationStyle,
  probeConnection,
  redactSecrets,
  styleById,
  type CapabilityProfile,
  type Plan,
  type Protocol,
} from '@qiansi/engine';
import { AuditLog } from './audit.js';
import {
  CanvasConflict,
  CanvasStore,
  canvasSummary,
  canvasSvg,
  writeRunArtifacts,
  type CanvasNode,
  type CanvasOp,
} from './canvas.js';
import { collectCanvasFiles, fileSummary } from './canvas-files.js';
import { DemoAdapter, demoPlan, demoProfiles } from './demo.js';
import { completeChat, type ChatConnection } from './chat.js';
import { gatewayModels, GatewayUsage, resolveGatewayModel, toNormalizedMessages } from './gateway.js';
import { livePlan, liveProfiles } from './live.js';
import { createRoutedJudge } from './acceptance.js';
import { buildPlanFromCanvas, diagnoseCanvas } from './plan-from-canvas.js';
import {
  familyOf,
  isCheapModel,
  modelFamilies,
  preferredModel,
  profileForModel,
  resolveModelRoute,
  routerChoice,
  type KeySlot,
} from './model-catalog.js';
import { PolicyStore, scopeForRequest, type Mandate } from './policy.js';
import { checkWorkspaceName, WorkspaceStore } from './workspaces.js';
import { saveRunDeliverables } from './deliverables.js';
import { EffectsLedger } from './effects.js';
import { buildResumePlan } from './resume.js';
import {
  buildDiscussionTopic,
  buildReviewPrompt,
  collectOutcomes,
  decideAction,
  normalizeVerdict,
  summarizeOutcomes,
  type LeadershipVerdict,
} from './leadership.js';
import { QuotaStore } from './quota.js';
import { substituteExhausted } from './quota-plan.js';
import { orderByStrategy, performanceOf } from './routing.js';
import { buildHandoffPack } from './handoff.js';
import { buildRunDiagnosis } from './run-diagnosis.js';
import {
  detectProject,
  latestUserView,
  readUserView,
  runUserView,
  userViewShotFile,
  type UserViewReport,
} from './user-view.js';
import { part, summarize, type HealthPart, type StatusReport } from './status.js';
import { RunStore, type RunEnvelope, type RunFailureSummary, type RunRecord } from './store.js';
import { buildNodeToolbox } from './node-tools.js';
import { TakeoverWatcher } from './takeover-watcher.js';
import {
  SelfOptEngine,
  describeSelfOpt,
  findLevel,
  findMode,
  type SelfOptLevel,
  type SelfOptMode,
} from './selfopt.js';
import { ensureStateDir } from './state-dir.js';
import { DpapiVault } from './vault.js';
import { WebSearchService } from './web-search.js';
import { APP_VERSION } from './version.js';

const app = new Hono();

/**
 * Load local secrets from a gitignored .env.local. Keeps keys out of command
 * lines and the repository while still working with `npm run dev`.
 */
function loadLocalEnv(): void {
  const candidates = [
    join(process.cwd(), '.env.local'),
    join(process.cwd(), '..', '..', '.env.local'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) process.env[key] = value;
    }
    return;
  }
}

loadLocalEnv();

const store = new RunStore();
// stateDir 在这一行之后才定义；账本自己按同样的规则解析目录。
const effects = new EffectsLedger(ensureStateDir());
// A run left as `running` by a previous process would make the progress strip
// silently disappear after a restart; mark it interrupted so the canvas can say
// what happened instead of showing nothing.
const interruptedRuns = store.interruptStale();
if (interruptedRuns.length) {
  console.log(`[qiansi] interrupted ${interruptedRuns.length} stale run(s): ${interruptedRuns.join(', ')}`);
}
const idempotency = new Map<string, unknown>();
const runAborts = new Map<string, AbortController>();
/** A second live run would write its artifacts over the first one's. */
let activeLiveRunId: string | null = null;
/** Whether a run came from the drawing or from the built-in demo plan. */
const runPlanSource = new Map<string, 'canvas' | 'builtin'>();

/**
 * Provider errors echo key ids back (Moonshot reports `ak-…` in billing
 * failures). Scrub before the event reaches the run log, the SSE stream or the
 * result endpoint.
 */
function redactRunEvent<T extends { type: string }>(event: T): T {
  const record = event as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  if (typeof record.error === 'string') {
    next.error = redactSecrets(record.error, []);
    changed = true;
  }
  const result = record.result as { reasons?: unknown } | undefined;
  if (result && Array.isArray(result.reasons)) {
    next.result = {
      ...result,
      reasons: result.reasons.map((reason) =>
        typeof reason === 'string' ? redactSecrets(reason, []) : reason
      ),
    };
    changed = true;
  }
  // 工具调用可能把路径或命令里的密钥带进事件流：落盘前脱敏。
  if (record.type === 'tool.called') {
    if (typeof record.args === 'string') next.args = redactSecrets(record.args, []);
    if (typeof record.preview === 'string') next.preview = redactSecrets(record.preview, []);
    changed = true;
  }
  return (changed ? next : record) as unknown as T;
}

/**
 * 失败归因：把一堆 task.failed 事件压成用户看得懂的几类原因，
 * 并带上「第几次尝试 / 还会不会自动重试」。
 */
function classifyRunError(error: string): string {
  if (/budget exceeded/i.test(error)) return '预算用尽';
  if (/upstream dependency/i.test(error)) return '上游任务失败';
  if (/\b(401|403|429)\b|suspended|unauthorized|api key|no usable key|invalid.*key/i.test(error)) {
    return '模型额度或密钥不可用';
  }
  if (/network|aborted|timeout|ECONN|fetch failed|socket/i.test(error)) {
    return '网络中断或请求超时';
  }
  if (/验收|未通过|产出为空|过短|acceptance/i.test(error)) return '验收未通过';
  return '任务执行失败';
}

function buildFailureSummary(input: {
  record: RunRecord;
  plan: { subtasks?: Array<{ id: string; title?: string }> };
  status: 'failed' | 'aborted';
  retryScheduled: boolean;
}): RunFailureSummary {
  const failedEvents = input.record.events
    .filter((envelope) => envelope.event.type === 'task.failed')
    .map((envelope) => envelope.event as { taskId: string; error: string });
  const byTask = new Map<string, string>();
  for (const event of failedEvents) byTask.set(event.taskId, event.error);
  const subtasks = input.plan.subtasks ?? [];
  const roots = [...byTask.entries()].filter(
    ([, error]) => !/upstream dependency/i.test(error)
  );
  const failedTasks = roots.map(([id, error]) => ({
    id,
    title: String(subtasks.find((task) => task.id === id)?.title ?? id),
    error: String(error).slice(0, 300),
  }));
  const counts = new Map<string, number>();
  for (const task of failedTasks) {
    const label = classifyRunError(task.error);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const reasons = [...counts.entries()].map(([label, count]) => `${label} ×${count}`);
  for (const task of failedTasks.slice(0, 3)) {
    reasons.push(`${task.id}「${task.title}」：${task.error.slice(0, 180)}`);
  }
  if (failedTasks.length === 0) {
    reasons.push(
      input.status === 'aborted' ? '运行被中断（没有任务级错误）' : '运行失败（没有任务级错误）'
    );
  }
  return {
    headline:
      failedTasks.length > 0
        ? `${failedTasks.length} 个任务失败`
        : input.status === 'aborted'
          ? '运行被中断'
          : '运行失败',
    reasons,
    failedTasks,
    attempt: (input.record.resumeDepth ?? 0) + 1,
    maxAttempts: input.record.autoResume ? 3 : 1,
    retryScheduled: input.retryScheduled,
    at: Date.now(),
  };
}

/**
 * 把失败总结写成画布上的一张卡片（固定 id，多次失败时原地更新）。
 */
function publishFailureSummaryNode(workspaceId: string, summary: RunFailureSummary): void {
  try {
    const store = canvasFor(workspaceId);
    const document = store.read();
    const id = 'run-failure-summary';
    const patch = {
      kind: 'artifact',
      name:
        summary.attempt <= summary.maxAttempts
          ? `失败总结 · 第 ${summary.attempt}/${summary.maxAttempts} 次`
          : `失败总结 · 第 ${summary.attempt} 次（自动上限 ${summary.maxAttempts}）`,
      role: summary.retryScheduled ? '已排队自动重试' : '未自动重试',
      provider: 'local',
      model: 'local',
      effort: 'off',
      status: 'failed',
      accent: '#f87171',
      taskId: 'run-failure-summary',
      output: [
        `结论：${summary.headline}`,
        ...summary.reasons,
        summary.retryScheduled
          ? '下一次重试：当前运行结束后自动开始。'
          : '重试：在运行条或「需要人工」面板点「重试」，会从断点继续。',
      ]
        .join('\n')
        .slice(0, 4000),
      artifact: summary.headline,
      metric: summary.retryScheduled ? '自动重试中' : '可手动重试',
    };
    const ops = document.nodes.some((node) => node.id === id)
      ? [{ op: 'update_node' as const, id, patch }]
      : [
          {
            op: 'add_node' as const,
            node: { id, type: 'artifact' as const, position: { x: 80, y: 520 }, data: patch },
          },
        ];
    store.apply(ops);
  } catch {
    // 展示失败不影响运行记录
  }
}

const approvalsFile = () => join(stateDir, 'approvals.json');
/** Approvals must survive a restart: an agent may still be waiting on one. */
function persistApprovals(): void {
  try {
    const items = [...approvals.values()].slice(-200);
    writeFileSync(approvalsFile(), JSON.stringify(items, null, 1), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // persistence is best effort; the in-memory record still works
  }
}
const vault = new DpapiVault();
const gatewayUsage = new GatewayUsage(Number(process.env.QIANSI_GATEWAY_TPM ?? 20000));

interface ApprovalRecord {
  id: string;
  action: string;
  risk: string;
  costEstimate: number;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  resolvedAt?: number;
  note?: string;
}

const approvals = new Map<string, ApprovalRecord>();

interface ExternalCallEvent {
  type: 'external.call';
  runId: string;
  taskId: string;
  nodeId: string;
  sessionId: string;
  agent: string;
  purpose: string;
  model: string;
  output: string;
  usage: { input: number; output: number; total: number };
  at: number;
}

const activitySubscribers = new Set<(event: ExternalCallEvent) => void>();
const externalCalls: ExternalCallEvent[] = [];
const externalUsageByAgent = new Map<string, { tokens: number; calls: number }>();
const externalUsageBySession = new Map<
  string,
  { tokens: number; calls: number; agent: string; updatedAt: number }
>();

function recordExternalCall(input: {
  sessionId: string;
  agent: string;
  purpose: string;
  model: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
}): ExternalCallEvent {
  const runId = randomUUID();
  const taskId = `ext-${runId.slice(0, 8)}`;
  const nodeId = `external:${input.sessionId}`;
  const goal = `外部调用 · ${input.agent} · ${input.purpose}`;
  const total = input.inputTokens + input.outputTokens;

  store.create(runId, goal);
  store.append(runId, { type: 'run.started', runId, goal });
  store.append(runId, {
    type: 'plan.created',
    plan: {
      goal,
      subtasks: [
        {
          id: taskId,
          title: input.purpose,
          description: `${input.agent} → ${input.model}`,
          assignedNodeId: nodeId,
          profileId: input.model,
          effort: 'medium',
          acceptanceCriteria: 'external call',
          machineCheckable: false,
          dependsOn: [],
          status: 'done',
          attempts: 1,
        },
      ],
    },
  });
  store.append(runId, { type: 'task.queued', taskId, nodeId });
  store.append(runId, {
    type: 'task.started',
    taskId,
    nodeId,
    effort: 'medium',
    attempt: 0,
  });
  store.append(runId, {
    type: 'task.acceptance',
    taskId,
    result: { pass: true, score: 1, reasons: ['外部调用'] },
  });
  store.append(runId, { type: 'task.completed', taskId, output: input.output });
  store.append(runId, {
    type: 'usage',
    taskId,
    nodeId,
    modelId: input.model,
    input: input.inputTokens,
    output: input.outputTokens,
    total,
    runTotal: total,
  });
  store.append(runId, { type: 'run.finished', runId, status: 'done' });

  const event: ExternalCallEvent = {
    type: 'external.call',
    runId,
    taskId,
    nodeId,
    sessionId: input.sessionId,
    agent: input.agent,
    purpose: input.purpose,
    model: input.model,
    output: input.output,
    usage: { input: input.inputTokens, output: input.outputTokens, total },
    at: Date.now(),
  };

  externalCalls.unshift(event);
  if (externalCalls.length > 50) externalCalls.pop();

  const agentUsage = externalUsageByAgent.get(input.agent) ?? { tokens: 0, calls: 0 };
  agentUsage.tokens += total;
  agentUsage.calls += 1;
  externalUsageByAgent.set(input.agent, agentUsage);

  const sessionUsage = externalUsageBySession.get(input.sessionId) ?? {
    tokens: 0,
    calls: 0,
    agent: input.agent,
    updatedAt: 0,
  };
  sessionUsage.tokens += total;
  sessionUsage.calls += 1;
  sessionUsage.agent = input.agent;
  sessionUsage.updatedAt = event.at;
  externalUsageBySession.set(input.sessionId, sessionUsage);

  for (const subscriber of activitySubscribers) subscriber(event);
  return event;
}

const stateDir = ensureStateDir();
const workspaces = new WorkspaceStore(stateDir);
/** 每个工作区一份 CanvasStore（惰性创建并缓存）。 */
const canvasStores = new Map<string, CanvasStore>();
function canvasFor(workspaceId?: string): CanvasStore {
  const meta = workspaces.resolve(workspaceId);
  let store = canvasStores.get(meta.id);
  if (!store) {
    store = new CanvasStore(workspaces.dirOf(meta.id));
    canvasStores.set(meta.id, store);
  }
  return store;
}
/** 请求属于哪个工作区：优先 x-qiansi-workspace 头，其次 ?ws=，最后当前工作区。 */
function workspaceOf(context: Context): string {
  const fromHeader = context.req.header('x-qiansi-workspace');
  const fromQuery = context.req.query('ws');
  return workspaces.resolve(fromHeader ?? fromQuery).id;
}
const audit = new AuditLog(stateDir);
const policy = new PolicyStore(stateDir);
const quota = new QuotaStore(stateDir);
let quotaSeeded = false;

/**
 * Keys that exist on disk become managed keys on first use, so quota controls
 * appear for the accounts a user already configured without re-entering them.
 */
async function ensureQuotaSeeded(): Promise<void> {
  if (quotaSeeded) return;
  quotaSeeded = true;
  try {
    quota.seed(
      modelFamilies().map((family) => ({
        slot: family.slot,
        label: family.label,
        vaultRef: family.vaultRef,
        envPresent: Boolean(process.env[family.envVar]),
      })),
      await vault.refs()
    );
  } catch {
    // seeding is best effort; explicit key management still works
  }
}

/**
 * The credential a call should use right now: the active managed key when it
 * has quota, otherwise the next key that does, otherwise the legacy ref/env.
 */
async function slotCredential(
  slot: KeySlot
): Promise<{ keyId: string; secret: string } | null> {
  await ensureQuotaSeeded();
  // 用户明确停用的厂商：连环境变量兜底也不给用，否则「停用」只是界面上的。
  if (readDisabledSlots().has(slot)) return null;
  const family = modelFamilies().find((item) => item.slot === slot);
  const envSecret = family ? (process.env[family.envVar] ?? '') : '';

  const pick = quota.pick(slot);
  if (pick) {
    const secret = (await vault.get(pick.vaultRef)) || envSecret;
    if (secret) return { keyId: pick.keyId, secret };
  }
  if (!family) return null;
  const legacy = (await vault.get(family.vaultRef)) || envSecret;
  return legacy ? { keyId: 'default', secret: legacy } : null;
}

/**
 * 服务端搜索：模型只发 query，真正的联网由这里完成。Key 走配额感知的
 * slotCredential（订阅优先），因此智谱订阅的搜索额度会被优先使用。
 */
const webSearch = new WebSearchService(vault, {
  keyFor: async (slot) => (await slotCredential(slot))?.secret,
});

/** 自我优化的默认仓库根：从 cwd 往上找第一个带 .git 的目录。 */
function defaultSelfOptRoot(): string {
  if (process.env.QIANSI_SELFOPT_ROOT) return process.env.QIANSI_SELFOPT_ROOT;
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * 自我优化的模型通道：复盘与实现用旗舰模型（默认 deepseek-v4-pro），
 * 与评委的选择口径一致。评审团会显式指定模型（options.model），
 * 指定模型不可用时退回默认链。可用 QIANSI_SELFOPT_MODEL 覆盖默认。
 */
async function selfOptChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { maxTokens: number; timeoutMs: number; model?: string }
): Promise<{ text: string; usage: { total: number }; model?: string }> {
  await ensureQuotaSeeded();
  const requested = String(process.env.QIANSI_SELFOPT_MODEL ?? '').trim();
  // 会思考的模型可能把整个预算花在推理上、正文为空；空输出就换下一家。
  const candidates = [
    String(options.model ?? '').trim(),
    requested,
    'deepseek-v4-pro',
    'deepseek-flash',
    'glm-5.3-flash',
    'MiniMax-M3.1-Flash',
  ].filter((item, index, list) => Boolean(item) && list.indexOf(item) === index);
  let lastError = 'no_usable_key';
  for (const model of candidates) {
    const family = familyOf(model);
    const slot = family?.slot ?? 'relay';
    const credential = await slotCredential(slot);
    if (!credential) continue;
    try {
      const result = await completeChat(
        vault,
        { model, apiKey: credential.secret, protocol: family?.protocol, baseUrl: family?.baseUrl },
        messages,
        { maxTokens: options.maxTokens, timeoutMs: options.timeoutMs }
      );
      if (!result.text.trim()) {
        lastError = `${model} 返回空正文（推理吃掉了输出预算）`;
        continue;
      }
      quota.record({
        slot,
        keyId: credential.keyId,
        model,
        tokens: result.usage.total,
        source: 'chat',
      });
      return { text: result.text, usage: { total: result.usage.total }, model };
    } catch (error) {
      lastError = redactSecrets(error instanceof Error ? error.message : String(error), []);
    }
  }
  throw new Error(lastError);
}

/**
 * 评审团的候选名单：每个有 key 的厂商取最多两个模型（旗舰 + 快模型）。
 * 评审团优先凑不同厂商，引擎再做去重与截断。
 * 读 key 要走 DPAPI（每次几百毫秒），所以结果缓存一分钟：状态轮询不会反复解密。
 */
let selfOptRosterCache: { at: number; models: string[] } | null = null;

async function availableSelfOptModels(): Promise<string[]> {
  if (selfOptRosterCache && Date.now() - selfOptRosterCache.at < 60_000) {
    return selfOptRosterCache.models;
  }
  await ensureQuotaSeeded();
  const models: string[] = [];
  for (const family of modelFamilies()) {
    const credential = await slotCredential(family.slot);
    if (!credential) continue;
    for (const model of family.models.slice(0, 2)) {
      if (!models.includes(model)) models.push(model);
    }
  }
  selfOptRosterCache = { at: Date.now(), models };
  return models;
}

/** 自省会话 -> 画布：体检与每条问题都成为可读的节点。 */
const selfoptCanvases = new Map<string, string>();
const selfoptSyncAt = new Map<string, number>();

function publishSelfOpt(session: {
  id: string;
  rootDir: string;
  mode: string;
  level: string;
  status: string;
  usedTokens: number;
  budget: { maxTokens: number };
  stages: Array<{ id: string; label: string; status: string; detail?: string; tokens?: number }>;
  findings: Array<{ id: string; title: string; kind: string; severity: string; evidence: string; proposal: string; acceptance: string; status: string; note?: string; commit?: string; proposedBy?: string; reviews?: Array<{ verdict: string }> }>;
  versions: string[];
  panel?: string[];
}): void {
  const workspaceId = selfoptCanvases.get(session.id);
  if (!workspaceId) return;
  const now = Date.now();
  if (session.status === 'running' && now - (selfoptSyncAt.get(session.id) ?? 0) < 700) return;
  selfoptSyncAt.set(session.id, now);
  try {
    const store = canvasFor(workspaceId);
    const doc = store.read();
    const existing = new Set(doc.nodes.map((node) => node.id));
    const ops: CanvasOp[] = [];
    const upsert = (node: CanvasNode) => {
      if (existing.has(node.id)) ops.push({ op: 'update_node', id: node.id, patch: node.data ?? {} });
      else ops.push({ op: 'add_node', node });
    };
    const repo = basename(session.rootDir) || session.rootDir;
    upsert({
      id: 'selfopt-root',
      type: 'library',
      position: { x: 60, y: 60 },
      data: {
        kind: 'library',
        name: `自省 · ${repo}`,
        role: `${session.mode}/${session.level} · 预算 ${session.budget.maxTokens}${session.panel && session.panel.length > 1 ? ` · 评审团 ${session.panel.length} 家` : ''}`,
        provider: 'local',
        model: 'library',
        effort: 'off',
        status: 'idle',
        accent: '#38d9c2',
        isPublic: true,
        metric: `${session.status} · ${session.usedTokens} tok`,
        output: session.rootDir,
      },
    });
    const survey = session.stages.find((stage) => stage.id === 'survey');
    const surveyText = (survey?.detail ?? '') + (survey?.tokens ? ` · ${survey.tokens} tok` : '');
    upsert({
      id: 'selfopt-survey',
      type: 'artifact',
      position: { x: 420, y: 60 },
      data: {
        kind: 'artifact',
        name: '体检',
        role: '跑检查、读 git 与 TODO',
        provider: '',
        model: '',
        effort: 'off',
        status: survey?.status === 'failed' ? 'failed' : survey?.status === 'done' ? 'done' : 'running',
        accent: '#4d6bfe',
        taskId: '',
        output: surveyText.slice(0, 4000),
        artifact: surveyText.slice(0, 120),
        metric: '体检',
      },
    });
    session.findings.forEach((finding, index) => {
      const status =
        finding.status === 'applied' ? 'done' as const :
        finding.status === 'failed' ? 'failed' as const :
        finding.status === 'skipped' ? 'idle' as const :
        (session.status === 'running' ? 'running' as const : 'idle' as const);
      const reviewLine = (() => {
        const reviews = finding.reviews ?? [];
        if (reviews.length === 0) return '';
        const count = (verdict: string) => reviews.filter((item) => item.verdict === verdict).length;
        return `互审：${count('confirm')} 确认 / ${count('revise')} 修正 / ${count('refute')} 驳回`;
      })();
      const text = [
        finding.proposedBy ? `提出：${finding.proposedBy}` : '',
        reviewLine,
        `依据：${finding.evidence}`,
        `改法：${finding.proposal}`,
        `验收：${finding.acceptance}`,
        `状态：${finding.status}${finding.note ? `（${finding.note}）` : ''}${finding.commit ? ` · 提交 ${finding.commit}` : ''}`,
      ]
        .filter(Boolean)
        .join(String.fromCharCode(10));
      upsert({
        id: `finding-${index + 1}`,
        type: 'artifact',
        position: { x: 420, y: 230 + index * 170 },
        data: {
          kind: 'artifact',
          name: `[${finding.severity}/${finding.kind}] ${finding.title}`.slice(0, 60),
          role: finding.status,
          provider: '',
          model: '',
          effort: 'off',
          status,
          accent: finding.severity === 'high' ? '#f87171' : finding.severity === 'medium' ? '#e0a458' : '#4d6bfe',
          taskId: finding.id,
          output: text.slice(0, 4000),
          artifact: `改法：${finding.proposal}`.slice(0, 120),
          metric: finding.status,
        },
      });
    });
    const edgeExists = new Set(doc.edges.map((edge) => edge.id));
    if (!edgeExists.has('so-edge-root')) {
      ops.push({ op: 'add_edge', edge: { id: 'so-edge-root', source: 'selfopt-root', target: 'selfopt-survey', label: '体检', data: { kind: 'handoff' } } });
    }
    session.findings.forEach((_, index) => {
      const id = `so-edge-f${index + 1}`;
      if (edgeExists.has(id)) return;
      ops.push({ op: 'add_edge', edge: { id, source: 'selfopt-survey', target: `finding-${index + 1}`, label: '问题', data: { kind: 'review' } } });
    });
    if (ops.length > 0) store.apply(ops);
  } catch {
    // 展示失败不影响自省
  }
}

const selfOpt = new SelfOptEngine({
  stateDir,
  audit: (entry) => audit.record(entry),
  onProgress: (session) => publishSelfOpt(session),
  chat: selfOptChat,
  roster: async () => (await availableSelfOptModels()).map((model) => ({ model })),
  search: (query, maxResults) => webSearch.search({ query, maxResults }),
});

/** The port the listener actually bound, which can differ from QIANSI_PORT. */
let boundPort: number | null = null;
const serverStartedAt = Date.now();
/** Written by an intentional stop, so a watchdog can tell it from a crash. */
const manualStopPath = join(stateDir, 'manual-stop');
// Starting is the counterpart of stopping: a fresh process clears the marker,
// otherwise a deliberate stop would look permanent.
try {
  if (existsSync(manualStopPath)) unlinkSync(manualStopPath);
} catch {
  // a read-only state dir just keeps the marker; the watchdog stays quiet
}
try {
  const persisted = JSON.parse(readFileSync(approvalsFile(), 'utf8')) as ApprovalRecord[];
  if (Array.isArray(persisted)) {
    for (const record of persisted) {
      if (record && typeof record.id === 'string') approvals.set(record.id, record);
    }
  }
} catch {
  // no approvals file yet
}
const tokenPath = join(stateDir, 'server-token');
/**
 * The token must survive a restart: agents (and the MCP server) read it from
 * disk, so rotating it on every launch logged them out for no reason.
 */
function resolveToken(): string {
  const fromEnv = process.env.QIANSI_TOKEN ?? process.env.AGENTWEAVE_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first run: generate below
  }
  const generated = randomBytes(24).toString('hex');
  try {
    writeFileSync(tokenPath, generated, { mode: 0o600 });
  } catch {
    // a read-only state dir still leaves the token valid for this process
  }
  return generated;
}
const token = resolveToken();

/**
 * 实时接管：盯住当前 agent 会话，用户每发一条新需求就自动「新建画布 →
 * 自动编排 → 立即运行」。串行走：已有运行在跑时，新需求会退避重试，
 * 等这一轮结束再接。
 */
const takeoverWatcher = new TakeoverWatcher({
  onAsk: async (ask, info) => {
    const origin = `http://127.0.0.1:${boundPort ?? Number(process.env.QIANSI_PORT ?? 8787)}`;
    const response = await fetch(`${origin}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qiansi-token': token },
      body: JSON.stringify({
        source: 'auto',
        task: ask,
        autoArrange: true,
        autoRun: true,
        sessionFile: info.file,
      }),
      // 编排可能要一分钟；但挂死时不能让 busy 永远为真。
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      archived?: boolean;
      runId?: string | null;
      queued?: boolean;
      runError?: string | null;
      workspaceId?: string;
    } | null;
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error ?? `handoff HTTP ${response.status}`);
    }
    if (body.archived) {
      throw new Error('自动编排没有产出可运行的节点');
    }
    // 排队也算接管成功：画布已建好，等当前运行结束自动开跑。
    if (!body.runId && !body.queued) {
      throw new Error(body.runError ?? '运行没有启动');
    }
    audit.record({
      actor: 'takeover',
      action: 'takeover.auto',
      target: body.workspaceId,
      detail: { ask: ask.slice(0, 160), runId: body.runId },
    });
  },
  log: (line) => console.log(`[takeover] ${line}`),
});

app.get('/api/takeover/watch', (context) => context.json({ ok: true, ...takeoverWatcher.status() }));

/** 实时接管状态落盘：服务重启或 VS Code 重载后自动继续监听。 */
const takeoverStateFile = join(stateDir, 'takeover-watch.json');

function persistTakeoverState(enabled: boolean, file: string): void {
  try {
    writeFileSync(
      takeoverStateFile,
      JSON.stringify({ enabled, sessionFile: file || undefined }, null, 1),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch {
    // 状态文件写不进去不影响本次监听
  }
}

try {
  const saved = JSON.parse(readFileSync(takeoverStateFile, 'utf8')) as {
    enabled?: boolean;
    sessionFile?: string;
  };
  if (saved.enabled) takeoverWatcher.start(saved.sessionFile);
} catch {
  // 没开过实时接管
}

app.post('/api/takeover/watch', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const enabled = body?.enabled === true;
  const sessionFile = String(body?.sessionFile ?? '').trim();
  const status = enabled ? takeoverWatcher.start(sessionFile || undefined) : takeoverWatcher.stop();
  persistTakeoverState(status.enabled, status.file);
  audit.record({
    actor: actorOf(context),
    action: enabled ? 'takeover.watch.start' : 'takeover.watch.stop',
    target: status.file || undefined,
  });
  return context.json({ ok: true, ...status });
});

/**
 * A second token that can only read. Anything handed to an external script gets
 * this one, so a mistake there cannot rewrite the board, the vault or the runs.
 */
const readTokenPath = join(stateDir, 'server-token-read');
const readToken = (() => {
  const fromEnv = process.env.QIANSI_READ_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const existing = readFileSync(readTokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first run: generate below
  }
  const generated = randomBytes(24).toString('hex');
  try {
    writeFileSync(readTokenPath, generated, { mode: 0o600 });
  } catch {
    // a read-only state dir still leaves the token valid for this process
  }
  return generated;
})();

const allowedOrigins = new Set(
  (
    process.env.QIANSI_ORIGINS ??
    process.env.AGENTWEAVE_ORIGINS ??
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787'
  )
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

function originAllowed(context: Context): boolean {
  const origin = context.req.header('origin');
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return true;
    }
  } catch {
    // fall through to deny
  }
  return false;
}

/** Who caused this request: the UI, or a named agent through MCP. */
function actorOf(context: Context): string {
  const agent = context.req.header('x-qiansi-agent') ?? context.req.header('x-agentweave-agent');
  if (agent) return agent;
  if (context.req.header('x-qiansi-session') ?? context.req.header('x-agentweave-session')) {
    return 'agent';
  }
  return 'local-ui';
}

app.use('/api/*', async (context, next) => {
  if (context.req.path === '/api/health' || context.req.path === '/api/bootstrap') {
    return next();
  }
  if (!originAllowed(context)) {
    return context.json({ error: 'origin_not_allowed' }, 403);
  }
  const cookie = getCookie(context, 'qs_session') ?? getCookie(context, 'aw_session');
  const header =
    context.req.header('x-qiansi-token') ?? context.req.header('x-agentweave-token');
  const presented = header || cookie || '';
  if (presented === token) {
    // The shared token says "a local caller"; the policy says what that caller
    // may do. Named callers (x-qiansi-agent) can be given more or less than the
    // wildcard, and acceptMode decides whether unlisted agents get in at all.
    const scope = scopeForRequest(context.req.method, context.req.path);
    if (scope) {
      const actor = actorOf(context);
      const admission = policy.admit(actor, scope);
      if (!admission.allowed) {
        audit.record({
          actor,
          action: 'policy.denied',
          target: context.req.path,
          detail: { scope, reason: admission.reason },
        });
        return context.json(
          {
            error: 'not_admitted',
            scope,
            actor,
            reason: admission.reason,
            policyVersion: admission.policyVersion,
            hint: '在 ~/.qiansi/policy.json 或 GET/PUT /api/policy 里给这个 agent 授权。',
          },
          403
        );
      }
    }
    return next();
  }

  if (presented === readToken) {
    const method = context.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return next();
    audit.record({
      actor: actorOf(context),
      action: 'auth.read_only_denied',
      target: context.req.path,
      detail: { method },
    });
    return context.json({ error: 'read_only_token' }, 403);
  }

  return context.json({ error: 'unauthorized' }, 401);
});

app.get('/api/health', (context) =>
  context.json({
    ok: true,
    version: APP_VERSION,
    relay: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    minimax: Boolean(process.env.MINIMAX_API_KEY),
    moonshot: Boolean(process.env.MOONSHOT_API_KEY),
  })
);

/**
 * Everything a supervisor needs to decide "restart it", "leave it" or "tell a
 * person", without reading logs. Mirrors dsh-superagent's status contract so a
 * cron entry, a shell script or an agent can all treat the four codes the same
 * way.
 */
async function buildStatus(): Promise<StatusReport> {
  const parts: Record<string, HealthPart> = {};
  const setup: string[] = [];
  const warnings: string[] = [];

  try {
    accessSync(stateDir, fsConstants.W_OK);
    parts.state = part('ready', stateDir);
  } catch (error) {
    parts.state = part(
      'error',
      `状态目录不可写：${error instanceof Error ? error.message : String(error)}`
    );
  }

  let refs: string[] = [];
  try {
    refs = await vault.refs();
    parts.vault = part('ready', `${refs.length} 个凭据`);
  } catch (error) {
    parts.vault = part(
      'error',
      `保险库读不出来：${error instanceof Error ? error.message : String(error)}`
    );
  }

  const configured = modelFamilies().filter(
    (family) =>
      refs.includes(family.vaultRef) ||
      (family.vaultAliases ?? []).some((alias) => refs.includes(alias)) ||
      Boolean(process.env[family.envVar])
  );
  if (configured.length === 0) {
    parts.models = part('setup', '没有可用的模型 Key');
    setup.push('没有配置任何模型 Key：打开连接面板，或用 CC Switch 导入');
  } else {
    parts.models = part('ready', configured.map((family) => family.slot).join(', '));
  }

  try {
    const document = canvasFor(workspaces.current()).read();
    const diagnosis = diagnoseCanvas(document);
    parts.canvas = part('ready', `revision ${document.revision}`);
    if (!diagnosis.runnable) {
      warnings.push(`画布当前不能运行：${diagnosis.reasons.join('；')}`);
    }
  } catch (error) {
    parts.canvas = part(
      'error',
      `画布读不出来：${error instanceof Error ? error.message : String(error)}`
    );
  }

  let runningTasks = 0;
  let activeRunAgeMs: number | null = null;
  if (activeLiveRunId) {
    const record = store.get(activeLiveRunId);
    const lastEvent = record?.events.at(-1);
    const lastAt = lastEvent?.ts ?? record?.startedAt ?? Date.now();
    activeRunAgeMs = Date.now() - lastAt;
    runningTasks = record?.plan?.subtasks.length ?? 0;
    // A run that has not emitted an event in ten minutes is not "slow", it is
    // stuck: every model call has a 45s timeout above it.
    if (activeRunAgeMs > 10 * 60_000) {
      parts.run = part(
        'error',
        `运行 ${activeLiveRunId} 已 ${Math.round(activeRunAgeMs / 60000)} 分钟没有事件，疑似卡死`
      );
    } else {
      parts.run = part('starting', `运行中：${activeLiveRunId}`);
    }
  } else {
    parts.run = part('ready', '没有在跑的任务');
  }

  const portFile = join(stateDir, 'server-port');
  try {
    const published = Number(readFileSync(portFile, 'utf8').trim());
    if (boundPort && published !== boundPort) {
      parts.port = part('error', `端口文件写着 ${published}，实际监听 ${boundPort}`);
    } else {
      parts.port = part('ready', String(boundPort ?? published));
    }
  } catch {
    parts.port = part('error', '端口文件缺失：依赖它的 MCP 与 hook 找不到服务');
  }

  return summarize({
    startedAt: serverStartedAt,
    manuallyStopped: existsSync(manualStopPath),
    parts,
    setup,
    warnings,
    load: {
      activeRunId: activeLiveRunId,
      activeRunAgeMs,
      runningTasks,
    },
  });
}

app.get('/api/status', async (context) => context.json(await buildStatus()));

app.get('/api/policy', (context) => {
  const current = policy.read();
  return context.json({ ok: true, policy: current, revision: current.version });
});

/**
 * Editing the policy is a human action: an agent that could rewrite the policy
 * could grant itself anything, so the route needs policy.write, which the
 * default agent entry does not have.
 */
app.put('/api/policy', async (context) => {
  const body = (await context.req.json().catch(() => null)) as
    | { acceptMode?: unknown; humans?: unknown; agents?: unknown; revision?: unknown }
    | null;
  if (!body) return context.json({ error: 'invalid_body' }, 400);

  const revision = Number(body.revision ?? NaN);
  if (!Number.isFinite(revision)) {
    return context.json({ error: 'revision_required' }, 400);
  }

  const result = policy.update(
    {
      acceptMode:
        body.acceptMode === 'off' || body.acceptMode === 'observe' ? body.acceptMode : 'auto',
      humans: Array.isArray(body.humans) ? (body.humans as never) : policy.read().humans,
      agents: Array.isArray(body.agents) ? (body.agents as never) : policy.read().agents,
    },
    revision
  );

  if (!result.ok) {
    return context.json({ error: 'stale_revision', policy: result.current }, 409);
  }
  audit.record({
    actor: actorOf(context),
    action: 'policy.update',
    target: `v${result.policy.version}`,
    detail: { acceptMode: result.policy.acceptMode, agents: result.policy.agents.length },
  });
  return context.json({ ok: true, policy: result.policy, revision: result.policy.version });
});

/**
 * An intentional stop. It is recorded on disk so the watchdog can tell "I was
 * told to stop" from "it died", and leaves it stopped instead of resurrecting
 * something a person deliberately turned off.
 */
/**
 * Graceful shutdown (DSH 提案 P6): cancel in-flight runs first, flush the
 * ledgers, then exit. A hard exit mid-run used to orphan a `running` record and
 * lose the quota bookkeeping for the whole day.
 */
async function gracefulShutdown(reason: string): Promise<void> {
  try {
    audit.record({ actor: 'server', action: 'server.shutdown', target: reason });
    for (const [runId, controller] of runAborts) {
      controller.abort();
      store.append(runId, { type: 'run.finished', runId, status: 'aborted' });
      if (activeLiveRunId === runId) activeLiveRunId = null;
    }
    runAborts.clear();
    quota.flush();
  } catch {
    // every step above is best effort; the goal is still to exit
  }
  process.exit(0);
}

app.post('/api/admin/stop', async (context) => {
  const actor = actorOf(context);
  const admission = policy.admit(actor, 'policy.write');
  if (!admission.allowed) {
    audit.record({
      actor,
      action: 'policy.denied',
      target: '/api/admin/stop',
      detail: { reason: admission.reason },
    });
    return context.json({ error: 'not_admitted', reason: admission.reason }, 403);
  }
  try {
    writeFileSync(manualStopPath, new Date().toISOString(), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // still stop; only the watchdog hint is lost
  }
  audit.record({ actor, action: 'server.stop', target: 'manual' });
  // The response flushes first; shutdown runs after the client has an answer.
  setTimeout(() => void gracefulShutdown('manual'), 150);
  return context.json({ ok: true, stopping: true, manuallyStopped: true });
});

process.on('SIGINT', () => void gracefulShutdown('sigint'));
process.on('SIGTERM', () => void gracefulShutdown('sigterm'));

/**
 * 自动续跑：带 autoResume 意图的运行在失败/中断后，自己排下一次「断点续跑」。
 * 走自己的 HTTP 接口而不是内部函数——复用同一套校验与审计，且天然幂等。
 * 人为停止时不动（看门狗同理）。
 */
function scheduleAutoResume(runId: string, delayMs = 5000): void {
  const timer = setTimeout(() => {
    if (existsSync(manualStopPath)) return;
    const port = boundPort ?? Number(process.env.QIANSI_PORT ?? 8787);
    const source = store.get(runId);
    const requestHeaders: Record<string, string> = {
      'x-qiansi-token': token,
      'content-type': 'application/json',
      'x-qiansi-agent': 'auto-resume',
      // 续跑必须回到原工作区：少了这个头，workspaceOf 会落到「当前画布」，
      // 服务端就会以 resume_workspace_mismatch 拒绝——自动重试永远不会发生。
      ...(source?.workspaceId ? { 'x-qiansi-workspace': source.workspaceId } : {}),
    };
    void fetch(`http://127.0.0.1:${port}/api/commands`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        commandId: `auto-resume-${runId}-${Date.now()}`,
        type: 'run.start',
        payload: { mode: 'live', resumeOf: runId, autoResume: true },
      }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        audit.record({
          actor: 'server',
          action: 'run.auto_resume',
          target: runId,
          detail: { ok: response.ok, runId: body?.runId ?? null, error: body?.error ?? null },
        });
      })
      .catch((error: unknown) => {
        audit.record({
          actor: 'server',
          action: 'run.auto_resume_failed',
          target: runId,
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      });
  }, delayMs);
  timer.unref?.();
}

app.get('/api/bootstrap', (context) => {
  if (!originAllowed(context)) {
    return context.json({ error: 'origin_not_allowed' }, 403);
  }
  setCookie(context, 'qs_session', token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 86400,
  });
  // The VS Code panel embeds this page in a cross-site iframe, where a
  // SameSite=Strict cookie is never sent — every API call 401'd and the studio
  // silently fell back to the demo graph. The page keeps this token in memory
  // and authenticates by header, which has no SameSite rules. Reading the body
  // is railguarded by same-origin policy, and any local process could read
  // ~/.qiansi/server-token anyway.
  return context.json({ ok: true, token });
});

app.get('/api/connections', async (context) =>
  context.json({
    relay: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    minimax: Boolean(process.env.MINIMAX_API_KEY),
    moonshot: Boolean(process.env.MOONSHOT_API_KEY),
    vault: await vault.refs(),
  })
);

app.get('/api/vault/status', async (context) => context.json({ refs: await vault.refs() }));

/**
 * Key management, CC Switch style: every subscription is a row you can see,
 * measure, disable, or rotate to. Secrets go straight into the DPAPI vault and
 * are never returned by any of these routes.
 */
/**
 * 厂商级停用：某个家族的 key 不可用（欠费、被停用）时，直接把它从一切
 * 选模型的地方排除——评审团、接续编排、自动编排、运行时的 key 解析都走这里。
 */
const modelPolicyFile = join(stateDir, 'model-policy.json');

function readDisabledSlots(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(modelPolicyFile, 'utf8')) as {
      disabledSlots?: unknown;
    };
    return new Set(
      (Array.isArray(parsed.disabledSlots) ? parsed.disabledSlots : [])
        .map((item) => String(item))
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function writeDisabledSlots(slots: string[]): void {
  const allowed = new Set(modelFamilies().map((family) => family.slot));
  const clean = [...new Set(slots.map((slot) => String(slot)).filter((slot) => allowed.has(slot as KeySlot)))];
  writeFileSync(
    modelPolicyFile,
    JSON.stringify({ version: 1, disabledSlots: clean }, null, 1),
    { encoding: 'utf8', mode: 0o600 }
  );
}

app.get('/api/model-policy', (context) =>
  context.json({ ok: true, disabledSlots: [...readDisabledSlots()] })
);

app.put('/api/model-policy', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const list = Array.isArray(body?.disabledSlots) ? body.disabledSlots : [];
  writeDisabledSlots(list);
  audit.record({
    actor: actorOf(context),
    action: 'model-policy.update',
    target: 'disabledSlots',
    detail: { disabledSlots: [...readDisabledSlots()] },
  });
  return context.json({ ok: true, disabledSlots: [...readDisabledSlots()] });
});

async function keysSnapshot() {
  await ensureQuotaSeeded();
  const disabled = readDisabledSlots();
  return modelFamilies().map((family) => ({
    ...quota.view(family.slot, family.label),
    disabled: disabled.has(family.slot),
    prices: quota.prices()[family.slot],
    protocol: family.protocol,
    models: family.models,
  }));
}

function readQuotaInput(value: unknown): { period: 'day' | 'month'; limitTokens: number } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const limitTokens = Number(raw.limitTokens ?? 0);
  if (!Number.isFinite(limitTokens) || limitTokens <= 0) return null;
  return { period: raw.period === 'day' ? 'day' : 'month', limitTokens };
}

app.get('/api/keys', async (context) =>
  context.json({
    ok: true,
    slots: await keysSnapshot(),
    recent: quota.recent(40),
    seeded: quotaSeeded,
    strategy: quota.strategy(),
  })
);

app.post('/api/keys', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const slot = String(body?.slot ?? '') as KeySlot;
  const family = modelFamilies().find((item) => item.slot === slot);
  if (!family) return context.json({ ok: false, error: 'unknown_slot' }, 400);
  const secret = String(body?.secret ?? '').trim();
  if (!secret) return context.json({ ok: false, error: 'secret_required' }, 400);

  const id = String(body?.id ?? '').trim() || randomBytes(4).toString('hex');
  const label = String(body?.label ?? '').trim() || `${family.label} · ${id}`;
  const vaultRef = id === 'default' ? family.vaultRef : `conn-${slot}-${id}`;

  await ensureQuotaSeeded();
  try {
    await vault.set(vaultRef, secret);
    quota.addKey(slot, {
      id,
      label,
      vaultRef,
      quota: readQuotaInput(body?.quota),
      billing: body?.billing === 'subscription' ? 'subscription' : 'metered',
    });
  } catch (error) {
    return context.json(
      { ok: false, error: error instanceof Error ? error.message : 'add_failed' },
      409
    );
  }
  audit.record({ actor: actorOf(context), action: 'keys.add', target: `${slot}/${id}` });
  return context.json({ ok: true, id, vaultRef, slots: await keysSnapshot() });
});

/** 路由策略：性能优先 / 订阅优先 / 成本优先。全局生效，运行时可覆盖。 */
app.put('/api/keys/strategy', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const value = body?.strategy;
  if (value !== 'performance' && value !== 'subscription' && value !== 'cost') {
    return context.json({ ok: false, error: 'invalid_strategy' }, 400);
  }
  const strategy = quota.setStrategy(value);
  audit.record({ actor: actorOf(context), action: 'keys.strategy', target: strategy });
  return context.json({ ok: true, strategy, slots: await keysSnapshot() });
});

app.patch('/api/keys/:slot/:id', async (context) => {
  const slot = context.req.param('slot') as KeySlot;
  const id = context.req.param('id');
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  await ensureQuotaSeeded();
  const updated = quota.updateKey(slot, id, {
    label: typeof body?.label === 'string' ? body.label : undefined,
    enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
    quota: body?.quota === null ? null : readQuotaInput(body?.quota) ?? undefined,
    billing: body?.billing === undefined ? undefined : body.billing === 'subscription' ? 'subscription' : 'metered',
  });
  if (!updated) return context.json({ ok: false, error: 'key_not_found' }, 404);
  audit.record({
    actor: actorOf(context),
    action: 'keys.update',
    target: `${slot}/${id}`,
    detail: { enabled: updated.enabled, quota: updated.quota },
  });
  return context.json({ ok: true, slots: await keysSnapshot() });
});

app.post('/api/keys/:slot/:id/activate', async (context) => {
  const slot = context.req.param('slot') as KeySlot;
  const id = context.req.param('id');
  await ensureQuotaSeeded();
  if (!quota.setActive(slot, id)) return context.json({ ok: false, error: 'key_not_found' }, 404);
  audit.record({ actor: actorOf(context), action: 'keys.activate', target: `${slot}/${id}` });
  return context.json({ ok: true, slots: await keysSnapshot() });
});

app.post('/api/keys/:slot/:id/secret', async (context) => {
  const slot = context.req.param('slot') as KeySlot;
  const id = context.req.param('id');
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const secret = String(body?.secret ?? '').trim();
  if (!secret) return context.json({ ok: false, error: 'secret_required' }, 400);
  await ensureQuotaSeeded();
  const vaultRef = quota.vaultRefFor(slot, id);
  if (!vaultRef) return context.json({ ok: false, error: 'key_not_found' }, 404);
  await vault.set(vaultRef, secret);
  audit.record({ actor: actorOf(context), action: 'keys.secret', target: `${slot}/${id}` });
  return context.json({ ok: true, slots: await keysSnapshot() });
});

app.delete('/api/keys/:slot/:id', async (context) => {
  const slot = context.req.param('slot') as KeySlot;
  const id = context.req.param('id');
  await ensureQuotaSeeded();
  const vaultRef = quota.vaultRefFor(slot, id);
  if (!quota.removeKey(slot, id)) return context.json({ ok: false, error: 'key_not_found' }, 404);
  // Default keys point at the family's original ref; removing the entry must not
  // delete a secret other tooling still reads.
  if (vaultRef && id !== 'default') {
    try {
      await vault.remove(vaultRef);
    } catch {
      // the entry is gone either way
    }
  }
  audit.record({ actor: actorOf(context), action: 'keys.remove', target: `${slot}/${id}` });
  return context.json({ ok: true, slots: await keysSnapshot() });
});

app.post('/api/vault/set', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const ref = String(body?.ref ?? '').trim();
  const value = String(body?.value ?? '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(ref) || !value) {
    return context.json({ error: 'ref_and_value_required' }, 400);
  }
  await vault.set(ref, value);
  audit.record({ actor: actorOf(context), action: 'vault.set', target: ref });
  return context.json({ ok: true, ref });
});

app.post('/api/vault/remove', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const ref = String(body?.ref ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(ref)) {
    return context.json({ error: 'invalid_ref' }, 400);
  }
  await vault.remove(ref);
  audit.record({ actor: actorOf(context), action: 'vault.remove', target: ref });
  return context.json({ ok: true, ref });
});

/**
 * The official model catalog a key can call, straight from the provider's own
 * /models endpoint — the canvas never asks the user to type model ids by hand.
 */
type CatalogPayload = { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
type CatalogCache = Record<string, { models: string[]; fetchedAt: number; baseUrl: string }>;
const catalogCachePath = () => join(stateDir, 'model-catalogs.json');

function readCatalogCache(): CatalogCache {
  try {
    const parsed = JSON.parse(readFileSync(catalogCachePath(), 'utf8')) as CatalogCache;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCatalogCache(cache: CatalogCache): void {
  try {
    writeFileSync(catalogCachePath(), JSON.stringify(cache, null, 1), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // caching is an optimisation, never a requirement
  }
}

async function fetchProviderModels(
  protocol: 'openai-chat' | 'anthropic-messages',
  baseUrl: string,
  apiKey: string
): Promise<{ ok: boolean; models?: string[]; source?: string; error?: string }> {
  // Anthropic-compatible gateways often skip /v1/models, so fall back to the
  // same origin's OpenAI-style endpoint before giving up.
  const candidates =
    protocol === 'anthropic-messages'
      ? [`${baseUrl}/v1/models`, `${baseUrl.replace(/\/anthropic$/, '')}/v1/models`]
      : [`${baseUrl}/models`];
  const headers: Record<string, string> =
    protocol === 'anthropic-messages'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` };
  let lastStatus = 0;
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let payload: CatalogPayload | null = null;
      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        lastStatus = response.status;
        if (!response.ok) continue;
        payload = (await response.json().catch(() => null)) as CatalogPayload | null;
      } finally {
        clearTimeout(timer);
      }
      const raw: Array<{ id?: string }> = payload?.data ?? payload?.models ?? [];
      const models = [
        ...new Set(
          raw
            .map((item) => String(item?.id ?? '').trim())
            .filter((id) => id && !/embedding|tts|whisper|rerank|audio|image/i.test(id))
        ),
      ].sort((a, b) => a.localeCompare(b));
      if (models.length) return { ok: true, models, source: url };
    } catch {
      continue;
    }
  }
  return { ok: false, error: `provider returned ${lastStatus || 'no catalog'}` };
}

/** 搜索工具当前用哪家 provider、哪些已配置；不返回任何 Key。 */
app.get('/api/search/status', async (context) =>
  context.json({ ok: true, ...(await webSearch.status()) })
);

/**
 * 直接执行一次联网搜索。画布节点和外部 agent 都可以先在这里取回结果，
 * 再把结果当上下文交给不支持工具调用的模型。
 */
app.post('/api/search', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const query = String(body?.query ?? '').trim().slice(0, 300);
  if (!query) return context.json({ ok: false, error: 'query_required' }, 400);
  const maxResults = Math.min(Math.max(Number(body?.maxResults ?? 6) || 6, 1), 10);
  try {
    const startedAt = Date.now();
    const hits = await webSearch.search({ query, maxResults });
    audit.record({
      actor: actorOf(context),
      action: 'search.query',
      target: query,
      detail: { hits: hits.length, ms: Date.now() - startedAt },
    });
    return context.json({ ok: true, query, hits, provider: (await webSearch.status()).provider });
  } catch (error) {
    return context.json(
      {
        ok: false,
        error: redactSecrets(error instanceof Error ? error.message : String(error), []),
      },
      502
    );
  }
});

app.get('/api/models/catalog', (context) =>
  context.json({ ok: true, catalogs: readCatalogCache() })
);

/** Pull every configured key's real catalog once and cache it. */
app.post('/api/models/refresh', async (context) => {
  const cache = readCatalogCache();
  const refreshed: string[] = [];
  const failed: Array<{ ref: string; error: string }> = [];
  for (const family of modelFamilies()) {
    const apiKey = await vault.get(family.vaultRef);
    if (!apiKey) continue;
    const result = await fetchProviderModels(family.protocol, family.baseUrl, apiKey);
    if (result.ok && result.models?.length) {
      cache[family.vaultRef] = {
        models: result.models,
        fetchedAt: Date.now(),
        baseUrl: family.baseUrl,
      };
      refreshed.push(`${family.slot}:${result.models.length}`);
    } else {
      failed.push({ ref: family.vaultRef, error: result.error ?? 'unknown' });
    }
  }
  writeCatalogCache(cache);
  audit.record({
    actor: actorOf(context),
    action: 'models.refresh',
    detail: { refreshed: refreshed.length, failed: failed.length },
  });
  return context.json({ ok: failed.length === 0, refreshed, failed, catalogs: cache });
});

app.post('/api/connections/models', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const protocol = body?.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat';
  const baseUrl = String(body?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) return context.json({ ok: false, error: 'baseUrl_required' }, 400);

  const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : '';
  const apiKey =
    String(body?.apiKey ?? '').trim() ||
    (connectionId ? ((await vault.get(connectionId)) ?? '') : '');
  if (!apiKey) return context.json({ ok: false, error: 'key_required' }, 400);

  const result = await fetchProviderModels(protocol, baseUrl, apiKey);
  if (result.ok) {
    // remember what this key can really call, so defaults stop being guesses
    const cache = readCatalogCache();
    cache[connectionId || baseUrl] = {
      models: result.models ?? [],
      fetchedAt: Date.now(),
      baseUrl,
    };
    writeCatalogCache(cache);
    return context.json({ ok: true, models: result.models, source: result.source });
  }
  return context.json({ ok: false, error: result.error ?? 'fetch_failed' }, 502);
});

/** Providers saved in CC Switch (~/.cc-switch/cc-switch.db). Keys are never returned. */
app.get('/api/connections/ccswitch', async (context) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return context.json({ ok: false, error: 'node:sqlite_unavailable' }, 503);
  }
  const dbPath = join(homedir(), ".cc-switch", "cc-switch.db");
  if (!existsSync(dbPath)) return context.json({ ok: true, providers: [] });
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT id, app_type, name, settings_config, is_current FROM providers').all() as Array<Record<string, unknown>>;
    db.close();
    const providers = [];
    for (const row of rows) {
      if (row.app_type !== 'claude') continue;
      let baseUrl = '';
      let hasKey = false;
      try {
        const parsed = JSON.parse(String(row.settings_config ?? '{}'));
        const env = parsed.env ?? parsed;
        baseUrl = String(env.ANTHROPIC_BASE_URL ?? '').trim();
        hasKey = Boolean(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY);
      } catch {
        continue;
      }
      if (!baseUrl || !hasKey) continue;
      providers.push({
        id: String(row.id),
        name: String(row.name ?? row.id),
        baseUrl,
        protocol: 'anthropic-messages',
        isCurrent: Boolean(row.is_current),
      });
    }
    return context.json({ ok: true, providers });
  } catch (error) {
    return context.json(
      { ok: false, error: error instanceof Error ? error.message : 'ccswitch_read_failed' },
      500
    );
  }
});

/** Imports the selected CC Switch providers: keys go straight into the vault and are never echoed back. */
app.post('/api/connections/ccswitch/import', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 20) : [];
  if (!ids.length) return context.json({ ok: false, error: 'ids_required' }, 400);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return context.json({ ok: false, error: 'node:sqlite_unavailable' }, 503);
  }
  const dbPath = join(homedir(), ".cc-switch", "cc-switch.db");
  if (!existsSync(dbPath)) return context.json({ ok: false, error: 'ccswitch_not_found' }, 404);
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const imported = [];
    const failed: string[] = [];
    for (const id of ids) {
      const row = db
        .prepare('SELECT id, name, settings_config FROM providers WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row) {
        failed.push(String(id));
        continue;
      }
      let baseUrl = '';
      let apiKey = '';
      try {
        const parsed = JSON.parse(String(row.settings_config ?? '{}'));
        const env = parsed.env ?? parsed;
        baseUrl = String(env.ANTHROPIC_BASE_URL ?? '').trim();
        apiKey = String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '');
      } catch {
        failed.push(String(id));
        continue;
      }
      if (!baseUrl || !apiKey) {
        failed.push(String(id));
        continue;
      }
      const connectionId = `ccsw-${String(row.id).replace(/-/g, '').slice(0, 12)}`;
      await vault.set(connectionId, apiKey);
      // The catalog routes by model to a key SLOT (conn-moonshot, conn-zhipu,
      // …). Seed the slot with this key when the slot is still empty, so an
      // imported provider works in live runs without extra configuration.
      const slot =
        baseUrl.includes('moonshot.cn') ? 'conn-moonshot'
        : baseUrl.includes('deepseek') ? 'conn-deepseek'
        : baseUrl.includes('minimaxi') ? 'conn-minimax'
        : baseUrl.includes('bigmodel') ? 'conn-zhipu'
        : '';
      if (slot && !(await vault.get(slot))) {
        await vault.set(slot, apiKey);
      }
      audit.record({
        actor: actorOf(context),
        action: 'ccswitch.import',
        target: connectionId,
        detail: { slot: slot || 'none' },
      });
      imported.push({
        id: connectionId,
        label: `${row.name}（CC Switch）`,
        provider: String(row.name ?? row.id),
        protocol: 'anthropic-messages',
        baseUrl,
        models: [],
        status: 'untested',
        tools: ['fs.read'],
        approval: 'always',
        note: '从 CC Switch 导入：key 已存入保险库。点「拉取官方模型」填充目录。',
      });
    }
    db.close();
    return context.json({ ok: failed.length === 0, imported, failed });
  } catch (error) {
    return context.json(
      { ok: false, error: error instanceof Error ? error.message : 'ccswitch_import_failed' },
      500
    );
  }
});

app.post('/api/connections/test', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !body.baseUrl || !body.model) {
    return context.json(
      { ok: false, latencyMs: 0, checks: [], error: 'baseUrl and model are required' },
      400
    );
  }

  const protocol: Protocol =
    body.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat';
  const baseUrl = String(body.baseUrl).trim();
  const model = String(body.model).trim();
  let apiKey = String(body.apiKey ?? '').trim();

  if (!apiKey && body.connectionId) {
    apiKey = (await vault.get(String(body.connectionId))) ?? '';
  }

  if (!apiKey) {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(baseUrl)) {
      apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? '';
    } else if (baseUrl.includes('deepseek')) {
      apiKey = process.env.DEEPSEEK_API_KEY ?? '';
    } else if (baseUrl.includes('moonshot')) {
      apiKey = process.env.MOONSHOT_API_KEY ?? '';
    } else if (baseUrl.includes('minimaxi')) {
      apiKey = process.env.MINIMAX_API_KEY ?? '';
    }
  }

  const profile: CapabilityProfile = {
    id: 'probe',
    label: 'probe',
    provider: 'probe',
    protocol,
    baseUrl,
    model,
    contextWindow: 128000,
    maxOutput: 8192,
    modalities: { tools: true, json: true },
    effort: { dialect: 'none', canDisable: true },
    domesticReachable: true,
  };

  const result = await probeConnection(profile, apiKey);
  return context.json({
    ...result,
    error: result.error ? redactSecrets(result.error, [apiKey]) : undefined,
  });
});

app.post('/api/chat', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-30) : [];
  if (messages.length === 0) return context.json({ error: 'messages_required' }, 400);

  const connection: ChatConnection = {
    connectionId: body?.connectionId ? String(body.connectionId) : undefined,
    protocol: body?.protocol ? String(body.protocol) : undefined,
    baseUrl: body?.baseUrl ? String(body.baseUrl) : undefined,
    model: body?.model ? String(body.model) : undefined,
  };
  try {
    const result = await completeChat(
      vault,
      connection,
      messages.map((item: any) => ({
        role:
          item?.role === 'system' || item?.role === 'assistant' ? item.role : ('user' as const),
        content: String(item?.content ?? '').slice(0, 20000),
      })),
      {
        maxTokens: Math.min(Math.max(Number(body?.maxTokens ?? 800) || 800, 16), 4096),
        // 联网时最多 2 轮搜索 + 1 轮作答，给足时间；纯对话保持原来的 45 秒。
        timeoutMs: body?.webSearch === true ? 90000 : 45000,
        search: body?.webSearch === true ? webSearch.search : undefined,
      }
    );
    return context.json({ ok: true, ...result });
  } catch (error) {
    console.error('[workflow] failed', error);
    return context.json(
      { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error), []) },
      502
    );
  }
});

/**
 * 把一件可以独立完成的事交给便宜模型（默认按当前路由策略挑，通常是订阅家族），
 * 结果直接返回给调用方——外部会话不必花自己的额度去写这些内容。
 */
app.post('/api/delegate', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const prompt = String(body?.prompt ?? '').trim().slice(0, 20000);
  if (!prompt) return context.json({ ok: false, error: 'prompt_required' }, 400);
  const system = String(body?.system ?? '').slice(0, 4000);
  const maxTokens = Math.min(Math.max(Number(body?.maxTokens ?? 1200) || 1200, 64), 8192);
  const requestedModel = String(body?.model ?? '').trim();
  const strategy = quota.strategy();

  await ensureQuotaSeeded();

  // 选模型：显式指定 > 按策略挑一个还有余额的家族。
  let slot: KeySlot | null = null;
  let model = requestedModel;
  if (model) {
    slot = familyOf(model)?.slot ?? 'relay';
  } else {
    const scores = modelFamilies()
      .filter((family) => Boolean(quota.slot(family.slot)?.keys.length))
      .map((family) => {
        const price = quota.prices()[family.slot];
        return {
          slot: family.slot,
          billing: quota.billingOf(family.slot),
          priceCnyPerM: (price.in + price.out) / 2,
          performance: performanceOf(family.slot),
          headroom: quota.headroom(family.slot),
        };
      });
    const best = orderByStrategy(scores, strategy)[0];
    if (!best) return context.json({ ok: false, error: 'no_usable_key' }, 503);
    slot = best.slot;
    const family = modelFamilies().find((item) => item.slot === best.slot)!;
    model = preferredModel(family.models);
  }

  const credential = slot ? await slotCredential(slot) : null;
  if (!credential) return context.json({ ok: false, error: 'no_usable_key', slot }, 503);
  // 每个家族有自己的协议与端点：只给模型名会让请求打到默认的 DeepSeek。
  const family = modelFamilies().find((item) => item.slot === slot);

  try {
    const result = await completeChat(
      vault,
      {
        model,
        apiKey: credential.secret,
        protocol: family?.protocol,
        baseUrl: family?.baseUrl,
      },
      [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        { role: 'user' as const, content: prompt },
      ],
      { maxTokens, timeoutMs: 90000, search: body?.webSearch === true ? webSearch.search : undefined }
    );
    quota.record({
      slot: slot ?? 'relay',
      keyId: credential.keyId,
      model,
      tokens: result.usage.total,
      source: 'chat',
    });
    audit.record({
      actor: actorOf(context),
      action: 'delegate',
      target: model,
      detail: { slot, strategy, tokens: result.usage.total },
    });
    return context.json({
      ok: true,
      text: result.text,
      model,
      slot,
      strategy,
      tokens: result.usage.total,
    });
  } catch (error) {
    return context.json(
      { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error), []) },
      502
    );
  }
});

interface DiscussParticipant {
  id: string;
  name: string;
  model: string;
  connectionId?: string;
  protocol?: string;
  baseUrl?: string;
}

/** 多模型讨论的可复用内核：界面上的「AI 讨论」与领导层自动触发共用。 */
async function runDiscussion(input: {
  topic: string;
  context?: string;
  rounds: number;
  styleId: string;
  participants: DiscussParticipant[];
}): Promise<{
  rounds: Array<{ round: number; messages: Array<{ name: string; model: string; content: string }> }>;
  effectiveRounds: number;
  style: { id: string; label: string };
}> {
  const style = styleById(isConversationStyle(input.styleId) ? input.styleId : 'peer');
  const history: Array<{ name: string; model: string; content: string }> = [];
  const transcript: Array<{ round: number; messages: typeof history }> = [];
  // Keep one discussion under eight model calls so a bad key or slow provider
  // cannot pin the request for minutes.
  const effectiveRounds = Math.min(
    input.rounds,
    Math.max(1, Math.floor(8 / Math.max(input.participants.length, 1)))
  );
  for (let round = 1; round <= effectiveRounds; round += 1) {
    const roundMessages: typeof history = [];
    for (const participant of input.participants) {
      const prior = history.length
        ? history.map((item) => `[${item.name} · ${item.model}]\n${item.content}`).join('\n\n')
        : '（还没有人发言）';
      let content = '';
      try {
        const result = await completeChat(
          vault,
          participant,
          [
            {
              role: 'system',
              content:
                `你正在参加一场多 AI 讨论。直接给出观点，引用或反驳前面发言者的具体内容；不要复述主题，不要使用客套话。控制在 300 字以内。
${discussionPrompt(style)}`,
            },
            {
              role: 'user',
              content: `讨论主题：${input.topic}\n\n${input.context ? `文件上下文：\n${input.context}\n\n` : ''}已有发言：\n${prior}\n\n现在轮到你（${participant.name}，模型 ${participant.model}）发言。`,
            },
          ],
          { maxTokens: 1600, timeoutMs: 60000 }
        );
        content = result.text || '（没有返回内容）';
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        content = `（调用失败：${redactSecrets(detail, [])}）`;
      }
      const entry = { name: participant.name, model: participant.model, content };
      history.push(entry);
      roundMessages.push(entry);
    }
    transcript.push({ round, messages: roundMessages });
  }
  return { rounds: transcript, effectiveRounds, style: { id: style.id, label: style.label } };
}

app.post('/api/discuss', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const topic = String(body?.topic ?? '').trim().slice(0, 2000);
  const fileContext = String(body?.context ?? '').trim().slice(0, 4000);
  const rounds = Math.min(Math.max(Number(body?.rounds ?? 2) || 2, 1), 3);
  const styleId = String(body?.style ?? 'peer');
  const participants: DiscussParticipant[] = (Array.isArray(body?.participants) ? body.participants : [])
    .slice(0, 5)
    .map((item: any) => ({
      id: String(item?.id ?? ''),
      name: String(item?.name ?? '模型'),
      model: String(item?.model ?? ''),
      connectionId: item?.connectionId ? String(item.connectionId) : undefined,
      protocol: item?.protocol ? String(item.protocol) : undefined,
      baseUrl: item?.baseUrl ? String(item.baseUrl) : undefined,
    }));
  if (!topic || participants.length < 2) {
    return context.json({ error: 'topic_and_two_participants_required' }, 400);
  }

  try {
    const result = await runDiscussion({
      topic,
      context: fileContext || undefined,
      rounds,
      styleId,
      participants,
    });
    return context.json({ ok: true, ...result, requestedRounds: rounds });
  } catch (error) {
    return context.json(
      { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error), []) },
      502
    );
  }
});

app.post('/api/layout', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const nodes = (Array.isArray(body?.nodes) ? body.nodes : [])
    .filter((item: any) => item?.id && item?.kind !== 'region')
    .slice(0, 60)
    .map((item: any) => ({
      id: String(item.id),
      name: String(item.name ?? item.id),
      kind: String(item.kind ?? 'agent'),
    }));
  if (nodes.length === 0) return context.json({ error: 'nodes_required' }, 400);
  const edges = (Array.isArray(body?.edges) ? body.edges : [])
    .slice(0, 120)
    .map((item: any) => ({ source: String(item?.source ?? ''), target: String(item?.target ?? '') }));

  const resolution = await resolveGatewayModel('claude-sonnet', vault).catch(() => undefined);
  if (!resolution) return context.json({ error: 'layout_model_unavailable' }, 503);

  try {
    const result = await completeChat(
      vault,
      {
        baseUrl: resolution.profile.baseUrl,
        model: resolution.profile.model,
        protocol: resolution.profile.protocol,
        apiKey: resolution.apiKey,
      },
      [
        {
          role: 'system',
          content:
            '你是多 AI 编排画布的排版器。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
        },
        {
          role: 'user',
          content: `给每个节点分配一个层级（列号，整数）。规则：主控层级为 0；有上游依赖的节点层级必须大于其所有上游；没有依赖的普通节点层级为 1；同一层可以有多个节点。
节点：${JSON.stringify(nodes)}
连线：${JSON.stringify(edges)}
只输出：{"levels":{"节点id":整数}}`,
        },
      ],
      { maxTokens: 600, timeoutMs: 25000 }
    );
    const parsed = parseModelJson<{ levels?: Record<string, unknown> }>(result.text, 'layout_output');
    if (!parsed.levels || typeof parsed.levels !== 'object') {
      throw new Error('layout_levels_missing');
    }

    const incoming = new Map<string, number>();
    for (const edge of edges) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }
    const levelOf = new Map<string, number>();
    for (const node of nodes) {
      const raw = Number(parsed.levels[node.id]);
      const fallback = node.kind === 'orchestrator' ? 0 : (incoming.get(node.id) ?? 0) > 0 ? 1 : 2;
      levelOf.set(node.id, Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), 12) : fallback);
    }

    const columns = new Map<number, typeof nodes>();
    for (const node of nodes) {
      const level = levelOf.get(node.id) ?? 0;
      columns.set(level, [...(columns.get(level) ?? []), node]);
    }
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [level, list] of columns) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      list.forEach((node, index) => {
        positions[node.id] = { x: 120 + level * 360, y: 120 + index * 200 };
      });
    }
    return context.json({ ok: true, positions, levels: Object.fromEntries(levelOf), source: 'ai' });
  } catch (error) {
    return context.json(
      { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error), []) },
      502
    );
  }
});

/**
 * 会话委托：把当前对话里的任务需求原文交给牵丝。
 * 牵丝读画布（谁在、谁闲着、谁是主控）、读可用模型，自己拆活、定交付物与验收、
 * 建节点连线，可选直接开跑。与 handoff 的区别：handoff 接管已有会话的上下文，
 * 这里只接「接下来要干什么」——需求一句话，其余由牵丝安排。
 */
/**
 * 合成主控：当前画布没设主控时，按计费策略挑一个有 Key 的家族顶上——
 * 委托/接续不该因为「没右键设主控」就整个失败。
 */
async function synthesizedOrchestratorNode(): Promise<CanvasNode | null> {
  const strategy = quota.strategy();
  const candidates = modelFamilies()
    .map((family) => ({ family, slot: family.slot }))
    .filter(({ slot }) => Boolean(quota.slot(slot)?.keys.length));
  const scores = orderByStrategy(
    candidates.map(({ slot }) => {
      const price = quota.prices()[slot];
      return {
        slot,
        billing: quota.billingOf(slot),
        priceCnyPerM: (price.in + price.out) / 2,
        performance: performanceOf(slot),
        headroom: quota.headroom(slot),
      };
    }),
    strategy
  );
  for (const score of scores) {
    const credential = await slotCredential(score.slot);
    if (!credential) continue;
    const family = modelFamilies().find((item) => item.slot === score.slot);
    if (!family) continue;
    const model = preferredModel(family.models);
    return {
      id: 'orchestrator',
      type: 'agent',
      position: { x: 60, y: 200 },
      data: {
        kind: 'orchestrator',
        name: '主控',
        role: '拆解 · 分派 · 验收',
        provider: family.label,
        model,
        effort: 'high',
        status: 'idle',
        accent: '#ff7a45',
        metric: 'ready',
        connectionId: family.vaultRef,
        protocol: family.protocol,
        baseUrl: family.baseUrl,
      },
    };
  }
  return null;
}

app.post('/api/delegate-task', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const task = String(body?.task ?? '').trim();
  if (!task) return context.json({ ok: false, error: 'task_required' }, 400);
  if (task.length > 4000) return context.json({ ok: false, error: 'task_too_long' }, 400);
  const run = body?.run !== false; // 默认开跑：委托就是为了干活
  // 一个工作流一张画布：委托新建一张，不覆盖你正在看的这张。
  const wsName = checkWorkspaceName(task.split(/[。；;\n]/)[0]?.slice(0, 24) || '委托任务');
  const createdWs = workspaces.create(wsName.ok ? wsName.name : '委托任务');
  const wsId = createdWs.id;
  const store = canvasFor(wsId);

  /** 落盘 ops：主控节点与 orchestratorId 必须写进存储，内存副本不算数。 */
  const initOps: CanvasOp[] = [];
  if (store.read().nodes.length === 0) {
    // 新画布天生是空的：优先沿用当前画布的主控；没有就按计费策略合成一个。
    const sourceCanvas = canvasFor(workspaceOf(context)).read();
    const orchestratorNode =
      sourceCanvas.nodes.find((node) => node.id === sourceCanvas.orchestratorId) ??
      (await synthesizedOrchestratorNode());
    if (!orchestratorNode) {
      workspaces.archive(wsId);
      return context.json(
        { ok: false, error: 'no_orchestrator', hint: '没有任何可用模型 Key，无法合成主控。先在「密钥与额度」里配一个。' },
        400
      );
    }
    initOps.push({ op: 'add_node', node: orchestratorNode });
    initOps.push({ op: 'set_orchestrator', id: orchestratorNode.id });
  }
  if (initOps.length > 0) {
    store.apply(initOps);
  }
  // 落盘后重读：initOps 之前的内存副本没有 orchestratorId。
  const current = store.read();

  const orchestratorNode = current.nodes.find((node) => node.id === current.orchestratorId);
  if (!orchestratorNode) {
    return context.json({ ok: false, error: 'no_orchestrator', hint: '右键节点 → 设为主控。' }, 400);
  }

  // 可用模型：画布上现有执行节点优先（保留用户精心调好的团队），
  // 不够时按计费策略从目录补齐。
  const workerNodes = current.nodes.filter(
    (node) =>
      node.type === 'agent' &&
      node.id !== current.orchestratorId &&
      !['region', 'library', 'file', 'artifact'].includes(String(node.data?.kind ?? ''))
  );
  const known = new Set(workerNodes.map((node) => String(node.data?.model ?? '')).filter(Boolean));
  const extra: Array<{ connectionId: string; name: string; provider: string; model: string; effort: string }> = [];
  for (const family of modelFamilies()) {
    const credential = await slotCredential(family.slot);
    if (!credential) continue;
    const preferred = preferredModel(family.models);
    if (known.has(preferred)) continue;
    extra.push({
      connectionId: family.vaultRef,
      name: family.label,
      provider: family.label,
      model: preferred,
      effort: 'low',
    });
  }
  if (workerNodes.length === 0 && extra.length === 0) {
    return context.json({ ok: false, error: 'no_workers', hint: '画布上没有带模型的执行节点，目录里也没有可用 Key。' }, 400);
  }

  // 编排主控：画布主控优先，调不通就换目录里第一个可用家族。
  const orchestrator = {
    connectionId: String(orchestratorNode.data?.connectionId ?? ''),
    model: String(orchestratorNode.data?.model ?? ''),
    protocol: orchestratorNode.data?.protocol,
    baseUrl: orchestratorNode.data?.baseUrl,
  };
  const fallbackOrchestrator = extra[0]
    ? { connectionId: extra[0].connectionId, model: extra[0].model }
    : undefined;

  const origin = new URL(context.req.url).origin;
  const candidates = fallbackOrchestrator ? [orchestrator, fallbackOrchestrator] : [orchestrator];
  const headers = { 'content-type': 'application/json', 'x-qiansi-token': token };
  const models = [
    ...workerNodes.map((node) => ({
      connectionId: String(node.data?.connectionId ?? ''),
      name: String(node.data?.name ?? ''),
      provider: String(node.data?.provider ?? ''),
      model: String(node.data?.model ?? ''),
      effort: String(node.data?.effort ?? 'medium'),
    })),
    ...extra,
  ].filter((item) => item.connectionId);

  let response: Response | null = null;
  for (const candidate of candidates) {
    if (!candidate.model) continue;
    response = await fetch(`${origin}/api/workflow`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        goal: task,
        orchestrator: candidate,
        models,
        // 画布上已有的公共资料库直接当上下文喂给编排器。
        files: current.nodes
          .filter((node) => String(node.data?.kind ?? '') === 'library' && node.data?.isPublic)
          .flatMap((node) =>
            ((node.data?.libraryFiles as Array<{ name: string }> | undefined) ?? [])
              .slice(0, 5)
              .map((file) => ({ name: file.name, preview: `来自资料库「${String(node.data?.name)}」` }))
          )
          .slice(0, 10),
      }),
    });
    if (response.ok) break;
  }

  if (!response || !response.ok) {
    const status = response?.status ?? 0;
    return context.json({ ok: false, error: 'arrange_failed', status }, 502);
  }
  const raw = (await response.json().catch(() => null)) as {
    workflow?: { summary?: string; nodes?: Array<Record<string, any>>; edges?: Array<Record<string, any>>; notes?: string[]; revised?: boolean };
  } | null;
  const workflow = raw?.workflow;
  if (!workflow?.nodes?.length) {
    return context.json({ ok: false, error: 'arrange_empty' }, 502);
  }

  // 只替换执行节点：主控与资料库不动，用户调好的团队结构保留。
  const ops: CanvasOp[] = [];
  const keepIds = new Set(
    current.nodes
      .filter((node) => node.id === current.orchestratorId || String(node.data?.kind ?? '') !== 'agent')
      .map((node) => node.id)
  );
  for (const node of current.nodes) {
    if (!keepIds.has(node.id)) ops.push({ op: 'remove_node', id: node.id });
  }
  // remove_node 会级联清掉连到被移除节点的边；新计划的连线在下面重建。
  const idMap = new Map<string, string>();
  workflow.nodes.slice(0, 10).forEach((item, index) => {
    const id = `task-${index + 1}`;
    idMap.set(String(item.id ?? index), id);
    ops.push({
      op: 'add_node',
      node: {
        id,
        type: 'agent',
        position: { x: 420 + (index % 3) * 300, y: 90 + Math.floor(index / 3) * 220 },
        data: {
          kind: 'agent',
          name: String(item.name ?? `任务 ${index + 1}`),
          role: String(item.role ?? ''),
          task: String(item.task ?? ''),
          deliverable: String(item.deliverable ?? ''),
          acceptanceCriteria: Array.isArray(item.acceptance) ? item.acceptance : [],
          provider: String(item.provider ?? ''),
          model: String(item.model ?? ''),
          effort: String(item.effort ?? 'medium'),
          status: 'idle',
          accent: '#4d6bfe',
          connectionId: String(item.connectionId ?? ''),
        },
      },
    });
  });
  for (const [index, edge] of (workflow.edges ?? []).entries()) {
    const source = idMap.get(String(edge.source));
    const target = idMap.get(String(edge.target));
    if (!source || !target) continue;
    ops.push({
      op: 'add_edge',
      edge: {
        source,
        target,
        label: String(edge.label ?? ''),
        data: { kind: String(edge.kind ?? 'handoff') },
      },
    });
  }
  const applied = store.apply(ops);
  audit.record({
    actor: actorOf(context),
    action: 'delegate_task.arrange',
    target: `r${applied.document.revision}`,
    detail: { tasks: workflow.nodes.length, revised: workflow.revised === true },
  });

  let runId: string | null = null;
  let runError: string | null = null;
  if (run) {
    // 运行落在委托新建的那张画布上（一个工作流一张画布）。
    const started = await fetch(`${origin}/api/commands`, {
      method: 'POST',
      headers: { ...headers, 'x-qiansi-workspace': wsId },
      body: JSON.stringify({
        commandId: `delegate-task-${randomUUID()}`,
        type: 'run.start',
        payload: {
          mode: 'live',
          goal: task.slice(0, 500),
          budget: { maxTotalTokens: 160000, maxCallsPerTask: 3 },
        },
      }),
    });
    const startedBody = (await started.json().catch(() => null)) as {
      runId?: string;
      ok?: boolean;
      error?: string;
      hint?: string;
      reasons?: string[];
    } | null;
    if (started.ok && startedBody?.runId) runId = startedBody.runId;
    if (!runId) {
      // 失败要带着原因回去，画布保留——用户要看得见为什么没跑。
      runError = startedBody?.error ?? `HTTP ${started.status}`;
      if (startedBody?.reasons?.length) runError += `：${startedBody.reasons.join('；')}`;
      if (startedBody?.hint) runError += `（${startedBody.hint}）`;
    }
  }

  return context.json({
    ok: true,
    workspaceId: wsId,
    workspaceName: createdWs.name,
    summary: String(workflow.summary ?? '').slice(0, 200),
    tasks: workflow.nodes.length,
    notes: workflow.notes ?? [],
    revised: workflow.revised === true,
    revision: applied.document.revision,
    runId,
    runError,
  });
});

/**
 * 接续外部 agent 的会话：读最近一段真实对话 + 项目事实，合成资料包挂到画布上，
 * 可选自动编排（让主控生成工作流）与立即运行。读取全部在本地完成，注入前脱敏。
 */
/**
 * 排队运行：托管建好了画布却撞上「已有运行」时，不再报错放弃，
 * 而是排进队列，当前运行一结束就自动开跑。这是「建了画布却没动静」的根因。
 */
interface QueuedRun {
  workspaceId: string;
  goal: string;
  queuedAt: number;
  /** 排队的是「续跑」而不是新一轮：轮到时带上原运行 id。 */
  resumeOf?: string;
}
const runQueue: QueuedRun[] = [];
let drainingQueue = false;

function queueRun(workspaceId: string, goal: string, resumeOf?: string): boolean {
  if (runQueue.some((item) => item.workspaceId === workspaceId && item.resumeOf === resumeOf)) return false;
  if (runQueue.length >= 10) return false;
  runQueue.push({ workspaceId, goal, queuedAt: Date.now(), resumeOf });
  return true;
}

function serverOrigin(): string {
  return `http://127.0.0.1:${boundPort ?? Number(process.env.QIANSI_PORT ?? 8787)}`;
}

async function drainRunQueue(): Promise<void> {
  if (drainingQueue) return;
  drainingQueue = true;
  try {
    while (runQueue.length > 0) {
      const next = runQueue[0]!;
      const response = await fetch(`${serverOrigin()}/api/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-qiansi-token': token,
          'x-qiansi-workspace': next.workspaceId,
        },
        body: JSON.stringify({
          commandId: `queued-run-${randomUUID()}`,
          type: 'run.start',
          payload: {
            mode: 'live',
            goal: next.goal,
            autoResume: true,
            ...(next.resumeOf ? { resumeOf: next.resumeOf } : {}),
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        runId?: string;
        error?: string;
      } | null;
      if (response.ok && body?.runId) {
        runQueue.shift();
        audit.record({
          actor: 'server',
          action: 'run.queued.start',
          target: next.workspaceId,
          detail: { runId: body.runId, goal: next.goal.slice(0, 120) },
        });
        continue;
      }
      if (body?.error === 'run_in_progress') return; // 等下一次 run.finished 再来
      runQueue.shift();
      audit.record({
        actor: 'server',
        action: 'run.queued.failed',
        target: next.workspaceId,
        detail: { error: body?.error ?? `HTTP ${response.status}` },
      });
    }
  } finally {
    drainingQueue = false;
  }
}

app.post('/api/handoff', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  // 留空 = 接管「最近真正活跃」的那个 agent 会话（全局最新），
  // 而不是服务端启动目录下的旧会话；项目事实跟会话的 cwd 走。
  // 显式目录先归一化：尾部分隔符会让编码目录对不上，静默落到别的项目。
  const rawCwd = String(body?.cwd ?? '').trim();
  const cwd = rawCwd ? resolve(rawCwd) : '';
  const source =
    body?.source === 'codex' || body?.source === 'claude-code' ? body.source : 'auto';
  const autoArrange = body?.autoArrange !== false;
  // 默认开跑：接续就是把活交给牵丝，不是只搬资料。
  const autoRun = body?.autoRun !== false;
  // 任务原文：用户可以直接在弹窗里写，不写才从会话里取。
  const taskOverride = String(body?.task ?? '').trim().slice(0, 4000);
  // 实时接管可以钉住某个会话文件；不钉就按「全局最新」读。
  const sessionFile = String(body?.sessionFile ?? '').trim();

  const pack = buildHandoffPack({ cwd, source, sessionFile: sessionFile || undefined });

  // 一个工作流一张画布：接续新建一张，不碰你正在看的。
  const goalGuess = (taskOverride || pack.session?.userAsks.at(-1) || '').split(/[。；;\n]/)[0]?.slice(0, 24) ?? '';
  const wsName = checkWorkspaceName(goalGuess || '接续会话');
  const createdWs = workspaces.create(wsName.ok ? wsName.name : '接续会话');
  const handoffWsId = createdWs.id;
  const handoffStore = canvasFor(handoffWsId);
  // 节点工具的工作目录 = 会话项目目录：worker 可以在里面读写与跑命令。
  if (pack.project?.cwd) workspaces.setRootDir(handoffWsId, pack.project.cwd);

  const fileId = randomUUID();
  const filesDir = join(stateDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  const fileName = `接续上下文-${pack.session?.source ?? 'project'}-${stamp}.md`;
  try {
    writeFileSync(join(filesDir, `${fileId}-${fileName}`), pack.markdown, 'utf8');
  } catch (error) {
    return context.json(
      {
        ok: false,
        error: `无法保存资料包：${error instanceof Error ? error.message : String(error)}`,
      },
      500
    );
  }

  // 接续画布天生是空的：优先沿用当前画布的主控；没有、或主控属于已停用厂商，
  // 就按计费策略合成一个——否则新画布会带着一个注定调不通的主控。
  const handoffOrchestratorSource = canvasFor(workspaceOf(context)).read();
  const sourceOrchestrator = handoffOrchestratorSource.nodes.find(
    (node) => node.id === handoffOrchestratorSource.orchestratorId
  );
  const handoffOrchestratorNode =
    (sourceOrchestrator &&
    !readDisabledSlots().has(familyOf(String(sourceOrchestrator.data?.model ?? ''))?.slot ?? '')
      ? sourceOrchestrator
      : undefined) ?? (await synthesizedOrchestratorNode());
  const document = handoffStore.read();
  const ops: CanvasOp[] = [];
  if (handoffOrchestratorNode) {
    ops.push({ op: 'add_node', node: handoffOrchestratorNode });
    // orchestratorId 必须落盘，否则这张画布判定不可运行。
    ops.push({ op: 'set_orchestrator', id: handoffOrchestratorNode.id });
  }
  const library = document.nodes.find((node) => node.data?.name === '接续上下文');
  const metric = `${pack.session?.source ?? 'project'} · ${pack.session?.messageCount ?? 0} 条`;
  if (library) {
    ops.push({
      op: 'update_node',
      id: library.id,
      patch: { libraryFiles: [{ id: fileId, name: fileName, size: pack.bytes }], metric },
    });
  } else {
    ops.push({
      op: 'add_node',
      node: {
        id: `handoff-${fileId.slice(0, 8)}`,
        type: 'library',
        position: { x: 80, y: 80 },
        data: {
          kind: 'library',
          name: '接续上下文',
          role: '从 agent 会话与项目自动提取，运行时会注入各节点',
          provider: 'local',
          model: 'library',
          effort: 'off',
          status: 'idle',
          accent: '#38d9c2',
          isPublic: true,
          metric,
          libraryFiles: [{ id: fileId, name: fileName, size: pack.bytes }],
        },
      },
    });
  }
  handoffStore.apply(ops);

  const arranged: { nodes: number; edges: number } = { nodes: 0, edges: 0 };
  if (autoArrange && pack.session) {
    // 复用已有的工作流生成器，而不是写第二套：它已经会说画布图格式，也按计划选模型。
    const origin = new URL(context.req.url).origin;
    const available: Array<{
      connectionId: string;
      name: string;
      provider: string;
      model: string;
      effort: string;
    }> = [];
    for (const family of modelFamilies()) {
      const credential = await slotCredential(family.slot);
      if (!credential) continue;
      available.push({
        connectionId: family.vaultRef,
        name: family.label,
        provider: family.label,
        model: preferredModel(family.models),
        effort: 'low',
      });
    }
    // 自动编排选谁，取决于计费策略：订阅优先时先用已付费的家族。
    const strategy = quota.strategy();
    const scores = available.map((item) => {
      const slot = familyOf(item.model)?.slot ?? 'relay';
      const price = quota.prices()[slot];
      return {
        slot,
        billing: quota.billingOf(slot),
        priceCnyPerM: (price.in + price.out) / 2,
        performance: performanceOf(slot),
        headroom: quota.headroom(slot),
      };
    });
    const order = orderByStrategy(scores, strategy).map((score) => score.slot);
    available.sort(
      (a, b) =>
        order.indexOf(familyOf(a.model)?.slot ?? 'relay') -
        order.indexOf(familyOf(b.model)?.slot ?? 'relay')
    );

    // 有明确任务原文时以它为准：会话结论只是背景，不能把目标带偏。
    const goalParts = [
      taskOverride || pack.session?.userAsks.at(-1) || '',
      taskOverride ? '' : pack.session?.conclusions.at(-1) ?? '',
    ].filter(Boolean);
    const goal = (goalParts.join('\n') || `接续 ${pack.session?.source ?? 'agent'} 会话的工作`).slice(0, 1200);
    console.log(`[handoff] available models: ${available.length}`, available.map((m) => m.connectionId).join(','));
    if (available.length > 0) {
      const current = handoffStore.read();
      const orchestratorNode = current.nodes.find((node) => node.id === current.orchestratorId);
      const orchestrator = orchestratorNode
        ? {
            connectionId: String(orchestratorNode.data?.connectionId ?? available[0]!.connectionId),
            model: String(orchestratorNode.data?.model ?? available[0]!.model),
            protocol: orchestratorNode.data?.protocol,
            baseUrl: orchestratorNode.data?.baseUrl,
          }
        : { connectionId: available[0]!.connectionId, model: available[0]!.model };
      // 主控候选：画布主控优先，之后把每个可用模型都试一遍。
      // 单只 Key 失效时不能让整个接续失败；用户停用的厂商直接跳过。
      const seenModels = new Set<string>();
      const disabledSlots = readDisabledSlots();
      const orchestrators = [orchestrator, ...available.map((item) => ({ connectionId: item.connectionId, model: item.model }))]
        .filter((candidate) => {
          if (!candidate.model || seenModels.has(candidate.model)) return false;
          if (disabledSlots.has(familyOf(candidate.model)?.slot ?? '')) return false;
          seenModels.add(candidate.model);
          return true;
        });
      try {
        let response: Response | null = null;
        console.log();
        const deadline = Date.now() + 90_000;
        for (const candidate of orchestrators) {
          if (Date.now() > deadline) {
            pack.notes.push('自动编排超时（90 秒），已跳过剩余候选。');
            break;
          }
          try {
          response = await fetch(`${origin}/api/workflow`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-qiansi-token': token },
            body: JSON.stringify({
              goal,
              orchestrator: candidate,
              models: available,
              files: [{ name: fileName, preview: pack.markdown.slice(0, 900) }],
              // 接续要快：跳过第二遍审校。形态兜底与派活边补齐仍是确定性的。
              critique: false,
            }),
          });
          if (response.ok) break;
          } catch (candidateError) {
            pack.notes.push(`候选 ${candidate.model} 失败：${candidateError instanceof Error ? candidateError.message : String(candidateError)}`);
            response = null;
          }
        }
        if (!response) throw new Error('workflow_unavailable');
        // /api/workflow 返回 { ok, workflow: { summary, nodes, edges } }
        // 先读文本再解析：解析失败时这里还能把服务端的错误原文呈现给用户。
        const responseText = await response.text().catch(() => '');
        let raw: {
          workflow?: { nodes?: Array<Record<string, any>>; edges?: Array<Record<string, any>> };
          nodes?: Array<Record<string, any>>;
          edges?: Array<Record<string, any>>;
          error?: string;
        } | null = null;
        try {
          raw = responseText ? JSON.parse(responseText) : null;
        } catch {
          raw = null;
        }
        const generated = {
          nodes: raw?.workflow?.nodes ?? raw?.nodes ?? [],
          edges: raw?.workflow?.edges ?? raw?.edges ?? [],
        };
        console.log(`[handoff] workflow status=${response.status} nodes=${generated.nodes.length}`);
        if (!response.ok) {
          const detail = raw?.error ? ` · ${raw.error}` : '';
          pack.notes.push(
            `自动编排失败：/api/workflow 返回 HTTP ${response.status}${detail} ${responseText.slice(0, 300)}`
          );
        }
        if (response.ok && generated?.nodes?.length) {
          const doc = handoffStore.read();
          const placed: CanvasOp[] = [];
          const libId =
            doc.nodes.find((node) => node.data?.name === '接续上下文')?.id ??
            `handoff-${fileId.slice(0, 8)}`;
          generated.nodes.slice(0, 10).forEach((item, index) => {
            placed.push({
              op: 'add_node',
              node: {
                id: String(item.id),
                type: 'agent',
                position: { x: 380 + (index % 2) * 320, y: 120 + Math.floor(index / 2) * 230 },
                data: {
                  kind: 'agent',
                  name: String(item.name ?? `节点 ${index + 1}`),
                  role: String(item.role ?? ''),
                  // 编排给出的工单/交付物/验收随节点一并落到画布，
                  // 否则接续会话生成的节点又会退回通用验收。
                  task: String(item.task ?? ''),
                  deliverable: String(item.deliverable ?? ''),
                  acceptanceCriteria: Array.isArray(item.acceptance) ? item.acceptance : [],
                  provider: String(item.provider ?? ''),
                  model: String(item.model ?? ''),
                  effort: String(item.effort ?? 'medium'),
                  status: 'idle',
                  accent: '#4d6bfe',
                  connectionId: String(item.connectionId ?? ''),
                },
              },
            });
            placed.push({
              op: 'add_edge',
              edge: { source: libId, target: String(item.id), label: '资料', data: { kind: 'context' } },
            });
          });
          for (const item of generated.edges ?? []) {
            placed.push({
              op: 'add_edge',
              edge: {
                source: String(item.source ?? ''),
                target: String(item.target ?? ''),
                label: String(item.label ?? ''),
                data: { kind: String(item.kind ?? 'handoff') },
              },
            });
          }
          const applied = handoffStore.apply(placed);
          arranged.nodes = generated.nodes.length;
          arranged.edges = (generated.edges ?? []).length + generated.nodes.length;
          audit.record({
            actor: actorOf(context),
            action: 'handoff.arrange',
            target: `r${applied.document.revision}`,
            detail: arranged,
          });
        }
      } catch (error) {
        // 自动编排失败不影响资料包已经落地，但要说清楚为什么
        pack.notes.push(
          `自动编排失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (arranged.nodes === 0) {
      pack.notes.push('自动编排没有产出（模型未配置或生成失败），仅写入了接续资料包。');
    }
  }

  audit.record({
    actor: actorOf(context),
    action: 'handoff.read',
    target: pack.session?.sessionId ?? 'project-only',
    detail: {
      source: pack.session?.source,
      bytes: pack.bytes,
      records: pack.session?.messageCount ?? 0,
    },
  });

  let runId: string | null = null;
  let runError = '';
  let runQueued = false;
  const runGoal = (taskOverride || pack.session?.userAsks.at(-1) || '接续 agent 会话继续工作').slice(0, 500);
  if (autoRun && arranged.nodes > 0) {
    try {
      const origin = new URL(context.req.url).origin;
      // 运行落在接续新建的那张画布上，goal 用任务原文。
      const started = await fetch(`${origin}/api/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-qiansi-token': token, 'x-qiansi-workspace': handoffWsId },
        body: JSON.stringify({
          commandId: `handoff-run-${randomUUID()}`,
          type: 'run.start',
          // 接管失败自动重试（断点续跑，最多 2 次），失败原因必须让用户看见。
          payload: { mode: 'live', goal: runGoal, autoResume: true },
        }),
      });
      const startedBody = (await started.json().catch(() => null)) as {
        runId?: string;
        ok?: boolean;
        error?: string;
        hint?: string;
        reasons?: unknown[];
      } | null;
      if (started.ok && startedBody?.runId) {
        runId = startedBody.runId;
      } else if (startedBody?.error === 'run_in_progress') {
        // 上一轮还没跑完：排队，等它结束后自动开跑，而不是把画布晾在一边。
        runQueued = queueRun(handoffWsId, runGoal);
        if (runQueued) {
          pack.notes.push('已有运行在跑：本画布已排队，当前运行结束后自动开跑。');
        } else {
          runError = 'run_in_progress · 排队已满（10 条），请稍后再试';
          pack.notes.push(`运行没有启动：${runError}`);
        }
      } else {
        // 「勾了立即运行却没跑」必须说清楚原因（互斥、策略、缺凭证、不可运行）。
        runError = startedBody?.error ?? `HTTP ${started.status}`;
        const reasons = Array.isArray(startedBody?.reasons) ? startedBody.reasons : [];
        if (reasons.length > 0) {
          runError += ` · ${reasons.map((item) => String(item)).slice(0, 3).join('；')}`;
        }
        if (startedBody?.hint) runError += ` · ${startedBody.hint}`;
        pack.notes.push(`运行没有启动：${runError.slice(0, 300)}`);
      }
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      pack.notes.push(`运行没有启动：${runError.slice(0, 300)}`);
    }
  } else if (autoRun) {
    pack.notes.push('没有可运行的节点：自动编排未开启或没有产出，本次没有启动运行。');
  }
  if (arranged.nodes === 0) {
    // 编排没产出：新画布只有一张资料库，归档进历史别占标签栏。
    workspaces.archive(handoffWsId);
  }

  return context.json({
    ok: true,
    archived: arranged.nodes === 0,
    workspaceId: handoffWsId,
    workspaceName: createdWs.name,
    session: pack.session
      ? {
          source: pack.session.source,
          sessionId: pack.session.sessionId,
          file: pack.session.file,
          records: pack.session.messageCount,
          ageMinutes: Math.round((Date.now() - pack.session.updatedAt) / 60000),
          tools: pack.session.tools,
        }
      : null,
    project: pack.project
      ? { cwd: pack.project.cwd, branch: pack.project.branch, files: pack.project.files.length }
      : null,
    pack: { bytes: pack.bytes, fileId, name: fileName },
    arranged,
    runId,
    queued: runQueued,
    runError: runError || null,
    notes: pack.notes,
  });
});

/**
 * First balanced JSON object in the text, honouring string literals and escapes.
 * Models routinely wrap JSON in prose or code fences; a greedy regex grabs from
 * the first `{` to the last `}` and fails the moment either side carries extra
 * braces. This scanner stops at the matching close brace instead.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 解析模型输出的 JSON；失败时带上原文开头，方便看出模型到底回了什么。 */
function parseModelJson<T>(text: string, label: string): T {
  const raw = extractJsonObject(text);
  if (raw) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // fall through to the labelled error
    }
  }
  throw new Error(
    `${label}_unparseable · 模型原文开头：${text.replace(/\s+/g, ' ').slice(0, 160) || '（空）'}`
  );
}

/**
 * 自动编排的验收兜底。模型偶尔不给验收条件，或只给一条——
 * 这里补的是通用但可判定的条目，不是「质量要好」这类空话。
 */
function defaultAcceptance(deliverable: string, name: string): string[] {
  return [
    `交付物「${deliverable || name}」完整，下游可以直接拿它继续干活`,
    '每条结论都能在给定材料或来源里找到依据，没有编造的数字、接口与引用',
    '总目标里与本任务相关的要求全部覆盖，没有遗漏',
  ];
}

app.post('/api/workflow', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const goal = String(body?.goal ?? '').trim().slice(0, 4000);
  if (!goal) return context.json({ error: 'goal_required' }, 400);

  const orchestrator = body?.orchestrator ?? {};
  if (!orchestrator?.model) return context.json({ error: 'orchestrator_required' }, 400);

  const models = (Array.isArray(body?.models) ? body.models : [])
    .slice(0, 12)
    .map((item: any) => ({
      connectionId: String(item?.connectionId ?? item?.id ?? ''),
      name: String(item?.name ?? item?.label ?? '模型'),
      provider: String(item?.provider ?? ''),
      model: String(item?.model ?? ''),
      effort: String(item?.effort ?? 'medium'),
    }))
    .filter((item: any) => item.connectionId)
    // 用户停用的厂商不参与编排：否则计划会派活给一个注定失败的模型。
    .filter((item: any) => !readDisabledSlots().has(familyOf(item.model)?.slot ?? ''));
  if (models.length === 0) return context.json({ error: 'models_required' }, 400);

  const files = (Array.isArray(body?.files) ? body.files : [])
    .slice(0, 40)
    .map((item: any) => ({
      name: String(item?.name ?? 'file'),
      preview: String(item?.preview ?? '').slice(0, 900),
    }));
  const fileContext = files
    .map((file: any) => `- ${file.name}${file.preview ? `\n${file.preview}` : ''}`)
    .join('\n')
    .slice(0, 5000);

  try {
    const messages: Array<{ role: 'system' | 'assistant' | 'user'; content: string }> = [
      {
        role: 'system',
        content:
          '你是多 AI 工作流的编排器。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
      },
      {
        role: 'user',
        content: `用户目标：${goal}

可用模型：${JSON.stringify(models)}
${fileContext ? `\n用户上传的文件（名称与内容预览）：\n${fileContext}\n` : ''}
请按任务实际需要决定规模（2–10 个节点），并只输出：
{"summary":"一句中文概述","nodes":[{"id":"n1","name":"事实梳理","role":"该环节用的方法与资料，如：逐条对照官方文档核实","task":"一句话工单：输入是什么、要产出什么","deliverable":"交付物名称（形式：清单/表格/代码/文稿），必须包含哪几项","acceptance":["可判定的验收条件 1","验收条件 2"],"connectionId":"从上面选择","model":"从上面列表选择具体模型","effort":"low|medium|high"}],"edges":[{"source":"orchestrator","target":"n1","kind":"assign","label":"任务 · 调研"}]}

目标怎么定（先读这里）：
- 对结果负责，不对字面动作负责：「帮我回客户邮件」背后往往是「让这个客户续约」。先判断用户真正要达成的结果，验收标准对着结果写（如「客户看完愿意约下一次通话」），流程围绕结果设计；
- 但交付形态绝不改变：用户要邮件就交付邮件，要 PPT 就交付 PPT。「做一份PPT」可以升级为「让忙碌的决策者 30 分钟内看懂并拍板」，可最后一步的交付物仍然是那份 PPT——把它换成 Word、文档或口头汇报就是失败；
- role 不写「扮演资深专家」这类角色扮演（已被行业证明不能提升质量），写这个环节实际用的资料、工具与方法，例如「逐条对照官方文档核实」「按 MECE 拆分」；
- 用户上传的文件与接续资料只是**参考资料**：用来补充事实与约束，不能把总目标替换成资料里的议题；资料与明确目标无关时直接忽略并在 summary 里说明。

规模怎么定：
- 只有一个交付物、一条路走到底：2–3 个节点；
- 要调研、要产出、还要核对的中等任务：4–6 个；
- 要覆盖多个互不依赖的部分、需要多轮验证、或者要产出多种格式的复杂任务：7–10 个；
- 宁可少一个也不要凑数。每个节点都要能回答「删掉它，哪份交付物就没人产出了」；答不上来就合并掉。反过来，一个节点如果包含两类以上互不依赖的产出，拆成两个。

拆解规则（按任务拆，不按角色拆）：
1. 先想清楚这次要交付什么，再决定分几步；每一步是一个有明确输入和输出的任务，不是一个「角色」；
2. 节点名称写任务名（如「事实梳理」「初稿起草」），不要写「研究员」「写手」这类只描述身份的称呼；
3. deliverable 必须具名且可交接：下游要能直接拿它继续干活。写清形式（清单/表格/文稿/代码）和必须包含的要点；
4. acceptance 给 2–3 条，每条都要能被第三方独立判断真假：要么可数（至少 N 个、不超过 N 字），要么可观察（必须包含 X、不能出现 Y），要么可对照（与资料包一致）。禁止写「质量好」「表达清晰」这类无法判定的标准；
5. 主控节点 id 固定为 "orchestrator"，不需要出现在 nodes 里；
6. connectionId 必须是上面列表中的值；
7. 每个工作节点至少有一条来自 orchestrator 的 assign 边；
8. 有依赖的节点之间加 handoff 边，边的 label 写清楚交的是什么（如「事实卡 → 起草」）；
9. 需要独立验收的加 review 边；
10. effort 按任务复杂度选择；
11. 分工不要重叠：两个节点不能产出同一份交付物；也不要留空档——总目标里明确要求的每一块，都要有节点负责；
12. 最终交付节点（把成果交给用户的那一步）的 acceptance 里要有一条形态标准：交付物形态与用户要求的形态一致；
13. 目标保真是红线：允许提升目标层级（对结果负责），不允许更换交付物形态；
14. 每个工作节点都能调用本地工具：读写工作目录内的文件、执行 shell 命令、查询画布、联网检索。目标要求改代码/跑测试/写文件时，把动作写进工单，验收写成可判定的结果（例如「npm test 退出码为 0」「文件 X 中包含 Y」）；不需要工具的任务不要强行调用。`,
      },
    ];

    // 会思考的模型（relay Claude）可能把预算花在推理上；预算放宽 + 失败重试
    // 一次，重试时把上次的坏输出贴回去让它自己纠正。
    const result = await completeChat(
      vault,
      {
        connectionId: orchestrator.connectionId ? String(orchestrator.connectionId) : undefined,
        protocol: orchestrator.protocol ? String(orchestrator.protocol) : undefined,
        baseUrl: orchestrator.baseUrl ? String(orchestrator.baseUrl) : undefined,
        model: String(orchestrator.model),
      },
      messages,
      { maxTokens: 8000, timeoutMs: 150000 }
    );

    let text = result.text;
    let parsed: {
      summary?: string;
      nodes?: Array<Record<string, any>>;
      edges?: Array<Record<string, any>>;
    };
    try {
      parsed = parseModelJson(text, 'workflow_output');
    } catch {
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({
        role: 'user',
        content:
          '你上次的输出无法解析为 JSON（可能被截断或夹带了说明文字）。只输出一个完整的 JSON 对象本身，从 { 开始到 } 结束，不要任何其他文字。',
      });
      const retry = await completeChat(
        vault,
        {
          connectionId: orchestrator.connectionId ? String(orchestrator.connectionId) : undefined,
          protocol: orchestrator.protocol ? String(orchestrator.protocol) : undefined,
          baseUrl: orchestrator.baseUrl ? String(orchestrator.baseUrl) : undefined,
          model: String(orchestrator.model),
        },
        messages,
        { maxTokens: 8000, timeoutMs: 150000 }
      );
      text = retry.text;
      parsed = parseModelJson(text, 'workflow_output');
    }

    // 第二遍：让同一个主控换一顶「审校者」的帽子，专门挑三件事——
    // 分工重叠、总目标有要求但没人负责的缺口、验收条件不判定。
    // 只有它明确 verdict=revise 且给出的节点仍然合法时才替换主计划。
    let planNotes: string[] = [];
    let planRevised = false;
    if (body?.critique !== false) {
      const critiqueStarted = Date.now();
      try {
        const review = await completeChat(
          vault,
          {
            connectionId: orchestrator.connectionId ? String(orchestrator.connectionId) : undefined,
            protocol: orchestrator.protocol ? String(orchestrator.protocol) : undefined,
            baseUrl: orchestrator.baseUrl ? String(orchestrator.baseUrl) : undefined,
            model: String(orchestrator.model),
          },
          [
            {
              role: 'system',
              content:
                '你是工作流计划的审校者。只判断五件事：分工是否重叠、总目标里是否有没人负责的部分、验收条件能否被第三方独立判定、节点数是否与任务规模匹配（该拆没拆，或为了凑数硬加）、交付物形态是否与用户要求的形态一致（允许提升目标层级，不允许更换形态）。只输出一个 JSON 对象。',
            },
            {
              role: 'user',
              content: `总目标：${goal}

待审计划：${JSON.stringify({ summary: parsed.summary, nodes: parsed.nodes, edges: parsed.edges }).slice(0, 7000)}

输出格式：
{"verdict":"ok|revise","issues":["具体问题，一条一句"],"nodes":[],"edges":[]}

规则：
1. verdict=revise 时，在 nodes/edges 里给出修正后的完整计划，字段与原计划一致；verdict=ok 时两者留空数组；
2. 只改有问题的部分，没问题的节点原样保留；
3. issues 写事实，不写建议措辞：例如「n2 与 n3 都产出初稿」「总目标要求的成本对比没人负责」「n1 的验收『表达清晰』无法判定」「用户要 PPT，n4 的交付物却是一份文字稿，形态被换了」；
4. 节点数按任务实际需要判断：单一产出 2–3 个，要调研、写作再核对的中等任务 4–6 个，复杂任务 7–10 个。节点数超过所在档位上限时，只有每个多出来的节点都有独立交付物、且能被下游直接使用才算合理；否则判 revise 合并。`,
            },
          ],
          { maxTokens: 7000, timeoutMs: 150000 }
        );
        const reviewed = parseModelJson<{
          verdict?: string;
          issues?: unknown[];
          nodes?: unknown[];
          edges?: unknown[];
        }>(review.text, 'workflow_critique');
        planNotes = (Array.isArray(reviewed.issues) ? reviewed.issues : [])
          .map((item) => String(item).slice(0, 160))
          .filter(Boolean)
          .slice(0, 6);
        if (
          reviewed.verdict === 'revise' &&
          Array.isArray(reviewed.nodes) &&
          reviewed.nodes.length > 0
        ) {
          parsed = {
            summary: parsed.summary,
            nodes: reviewed.nodes as Array<Record<string, any>>,
            edges: (Array.isArray(reviewed.edges) && reviewed.edges.length > 0
              ? reviewed.edges
              : parsed.edges) as Array<Record<string, any>>,
          };
          planRevised = true;
        }
        audit.record({
          actor: actorOf(context),
          action: 'workflow.critique',
          detail: {
            verdict: reviewed.verdict ?? 'unknown',
            issues: planNotes.length,
            ms: Date.now() - critiqueStarted,
          },
        });
      } catch {
        // 审校是增强项：它挂了就用第一遍的计划，不能因此让用户拿不到画布
      }
    }

    const allowedConnections = new Set(models.map((item: any) => item.connectionId));
    const effortValues = new Set(['off', 'low', 'medium', 'high', 'max']);
    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
      .slice(0, 10)
      .map((item: any, index: number) => {
        const connectionId = allowedConnections.has(String(item?.connectionId ?? ''))
          ? String(item.connectionId)
          : models[index % models.length].connectionId;
        // 编排器会从可用模型列表里挑具体模型；没挑就按 connectionId 兜底，
        // 否则生成的节点缺 model，画布直接判定不可运行。
        const familyModels = models.filter((m: any) => m.connectionId === connectionId);
        const fallbackModel = familyModels[index % Math.max(1, familyModels.length)]?.model ?? models[0].model;
        const requestedModel = String(item?.model ?? '').trim();
        const model = familyModels.some((m: any) => m.model === requestedModel)
          ? requestedModel
          : fallbackModel;
        const nodeName = String(item?.name ?? `节点 ${index + 1}`).slice(0, 40);
        const roleText = String(item?.role ?? '执行子任务').slice(0, 160);
        const taskText = String(item?.task ?? roleText).trim().slice(0, 240) || roleText;
        const deliverable = String(item?.deliverable ?? '').trim().slice(0, 120) || `${nodeName}的产出`;
        const accepted = (Array.isArray(item?.acceptance) ? item.acceptance : [])
          .map((line: unknown) => String(line).trim().slice(0, 140))
          .filter(Boolean)
          .slice(0, 3);
        // 验收不足两条就补通用条目——宁可多一条可判定的，也不要留空。
        for (const fallback of defaultAcceptance(deliverable, nodeName)) {
          if (accepted.length >= 2) break;
          if (!accepted.includes(fallback)) accepted.push(fallback);
        }
        return {
          id: String(item?.id ?? `n${index + 1}`).replace(/[^\w-]/g, '').slice(0, 24) || `n${index + 1}`,
          name: nodeName,
          role: roleText,
          task: taskText,
          deliverable,
          acceptance: accepted,
          connectionId,
          model,
          effort: effortValues.has(String(item?.effort)) ? String(item?.effort) : 'medium',
        };
      });
    if (nodes.length === 0) throw new Error('workflow_nodes_missing');

    // 同名节点在画布上无法区分，验收时也对不上号——统一去重。
    const seenNames = new Set<string>();
    for (const node of nodes) {
      let unique = node.name;
      let suffix = 2;
      while (seenNames.has(unique)) {
        unique = `${node.name} ${suffix}`;
        suffix += 1;
      }
      seenNames.add(unique);
      node.name = unique;
    }

    const ids = new Set(['orchestrator', ...nodes.map((node: any) => node.id)]);
    const kinds = new Set(['assign', 'handoff', 'review', 'context']);
    const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
      .slice(0, 30)
      .filter((item: any) => ids.has(String(item?.source)) && ids.has(String(item?.target)))
      .map((item: any, index: number) => ({
        id: `wf-e${index + 1}`,
        source: String(item.source),
        target: String(item.target),
        kind: kinds.has(String(item?.kind)) ? String(item.kind) : 'assign',
        label: String(item?.label ?? '任务').slice(0, 40),
      }));

    // 每个执行节点都必须从主控拿到明确的派活边，否则画布判定它没有任务来源。
    for (const node of nodes) {
      const assigned = edges.some(
        (edge) => edge.target === node.id && edge.source === 'orchestrator' && edge.kind === 'assign'
      );
      if (!assigned) {
        edges.push({
          id: `wf-e${edges.length + 1}`,
          source: 'orchestrator',
          target: node.id,
          kind: 'assign',
          label: `任务 · ${node.name}`,
        });
      }
    }

    // 目标保真的确定性兜底：目标里点名的交付形态（PPT/文档/表格…），必须出现在
    // 至少一个节点的交付物里。模型忘了就把形态补到交付节点上——提升目标层级
    // 可以，更换交付形态不行。补了什么会写进 notes，让用户看得见。
    const FORM_KEYWORDS = ['PPT', '幻灯', 'slides', 'Word', '文档', '表格', '代码', '邮件', '报告', '清单', '视频', '海报', '长图', '备忘录', '指南', '手册', '文案', '脚本'];
    const formMentions =
      goal.match(
        /(做|写|产出|生成|输出|交付|准备|整理|制作)[^。；;]{0,24}(PPT|幻灯|slides|Word|文档|表格|代码|邮件|报告|清单|视频|海报|长图|备忘录|指南|手册|文案|脚本)/gi
      ) ?? [];
    const wantedForms = [
      ...new Set(
        formMentions.flatMap((mention) =>
          FORM_KEYWORDS.filter((keyword) => mention.toLowerCase().includes(keyword.toLowerCase()))
        )
      ),
    ];
    if (wantedForms.length > 0) {
      const covered = nodes.some((node) =>
        wantedForms.some((form) => String(node.deliverable).toLowerCase().includes(form.toLowerCase()))
      );
      if (!covered) {
        // 交付节点 = 不再向下游交付任何东西的节点；找不到就取排最后的。
        const downstream = new Set(
          edges.filter((edge) => edge.kind === 'handoff' || edge.kind === 'review').map((edge) => edge.source)
        );
        const delivery = nodes.find((node) => !downstream.has(node.id)) ?? nodes[nodes.length - 1];
        const formText = wantedForms.join('/');
        delivery.deliverable = `${delivery.deliverable}（形态：${formText}）`.slice(0, 140);
        const formAcceptance = `最终交付物保持${formText}形态，不得替换为其他形式`;
        if (!delivery.acceptance.includes(formAcceptance)) delivery.acceptance.push(formAcceptance);
        planNotes.push(
          `目标点名的交付形态（${formText}）没出现在任何交付物里，已补到「${delivery.name}」并加为验收`
        );
      }
    }

    return context.json({
      ok: true,
      workflow: {
        summary: String(parsed.summary ?? goal).slice(0, 200),
        nodes,
        edges,
        // 审校者提出的问题：界面直接显示，用户不必猜分工为什么不合适。
        // revised=true 表示这些问题已经在返回的计划里改过了。
        notes: planNotes,
        revised: planRevised,
      },
    });
  } catch (error) {
    console.error('[workflow] failed', error);
    return context.json(
      { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error), []) },
      502
    );
  }
});

app.post('/api/files', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const raw = String(body?.data ?? '');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0) return context.json({ error: 'empty_file' }, 400);
  if (buffer.length > 8 * 1024 * 1024) return context.json({ error: 'file_too_large' }, 413);

  const original = String(body?.name ?? 'file');
  const safeName =
    original.replace(/[^\w.\-一-龥]/g, '_').slice(0, 120) || 'file';
  const id = randomUUID();
  const dir = join(stateDir, 'files');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}-${safeName}`);
  writeFileSync(filePath, buffer);

  const isText =
    /^text\//.test(String(body?.type ?? '')) ||
    /\.(md|txt|json|csv|ts|tsx|js|jsx|py|yaml|yml|html|css|log)$/i.test(safeName);
  const preview = isText ? buffer.toString('utf8').slice(0, 1200) : '';

  return context.json({
    ok: true,
    file: { id, name: safeName, size: buffer.length, preview, path: filePath },
  });
});

/** 工作区：一张画布 + 一份运行历史。 */
app.get('/api/workspaces', (context) => {
  const includeArchived = context.req.query('includeArchived') === '1';
  const runningByWorkspace = new Map<string, number>();
  for (const run of store.running()) {
    const key = run.workspaceId ?? 'main';
    runningByWorkspace.set(key, (runningByWorkspace.get(key) ?? 0) + 1);
  }
  const items = (includeArchived ? workspaces.list() : workspaces.listActive()).map((meta) => ({
    ...meta,
    canvasExists: canvasFor(meta.id).exists(),
    running: runningByWorkspace.get(meta.id) ?? 0,
  }));
  return context.json({
    ok: true,
    current: workspaces.current(),
    items,
    archived: includeArchived
      ? undefined
      : workspaces.listArchived().map((meta) => ({ ...meta, canvasExists: canvasFor(meta.id).exists() })),
  });
});

/** 关标签页：软删除进「历史画布」，可从历史恢复或彻底删除。 */
app.post('/api/workspaces/:id/archive', (context) => {
  const id = context.req.param('id');
  const result = workspaces.archive(id);
  if (!result.ok) {
    return context.json({ ok: false, error: result.reason }, result.reason === 'not_found' ? 404 : 409);
  }
  audit.record({ actor: actorOf(context), action: 'workspace.archive', target: id });
  return context.json({ ok: true, current: result.current });
});

app.post('/api/workspaces/:id/restore', (context) => {
  const id = context.req.param('id');
  const result = workspaces.restore(id);
  if (!result.ok) return context.json({ ok: false, error: result.reason }, 404);
  audit.record({ actor: actorOf(context), action: 'workspace.restore', target: id });
  return context.json({ ok: true });
});

const NAME_ENCODING_HINT =
  '名字里有无法解码的字节（U+FFFD）。通常是调用方用了非 UTF-8 编码发送请求——Windows 控制台默认 GBK，请改用 UTF-8 或直接用界面/Node 的 fetch。';

app.post('/api/workspaces', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const raw = typeof body?.name === 'string' ? body.name : '';
  if (raw.trim()) {
    const checked = checkWorkspaceName(raw);
    if (!checked.ok) {
      return context.json(
        {
          ok: false,
          error: checked.reason === 'encoding' ? 'name_encoding' : 'name_empty',
          hint: NAME_ENCODING_HINT,
        },
        400
      );
    }
  }
  const meta = workspaces.create(raw.trim() || undefined);
  audit.record({ actor: actorOf(context), action: 'workspace.create', target: meta.id, detail: { name: meta.name } });
  return context.json({ ok: true, workspace: meta });
});

app.patch('/api/workspaces/:id', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  // 只改公共指令时允许不带 name。
  const wantsName = body && typeof body.name === 'string' && body.name.trim().length > 0;
  if (wantsName) {
    const raw = String(body.name);
    const checked = checkWorkspaceName(raw);
    if (!checked.ok) {
      return context.json(
        {
          ok: false,
          error: checked.reason === 'encoding' ? 'name_encoding' : 'name_empty',
          hint: NAME_ENCODING_HINT,
        },
        400
      );
    }
    const renamed = workspaces.rename(context.req.param('id'), checked.name);
    if (!renamed) return context.json({ ok: false, error: 'workspace_not_found' }, 404);
  }
  if (body && typeof body.instructions === 'string') {
    const updated = workspaces.setInstructions(context.req.param('id'), body.instructions);
    if (!updated) return context.json({ ok: false, error: 'workspace_not_found' }, 404);
  }
  if (body && typeof body.rootDir === 'string') {
    const updated = workspaces.setRootDir(context.req.param('id'), body.rootDir);
    if (!updated) return context.json({ ok: false, error: 'root_dir_invalid' }, 400);
  }
  const meta = workspaces.get(context.req.param('id'));
  if (!meta) return context.json({ ok: false, error: 'workspace_not_found' }, 404);
  audit.record({
    actor: actorOf(context),
    action: wantsName ? 'workspace.rename' : 'workspace.instructions',
    target: meta.id,
  });
  return context.json({ ok: true, workspace: meta });
});

app.delete('/api/workspaces/:id', (context) => {
  const id = context.req.param('id');
  const result = workspaces.remove(id);
  if (!result.ok) {
    return context.json({ ok: false, error: result.reason }, result.reason === 'last_workspace' ? 409 : 404);
  }
  canvasStores.delete(id);
  audit.record({ actor: actorOf(context), action: 'workspace.remove', target: id });
  return context.json({ ok: true, current: workspaces.current() });
});

app.post('/api/workspaces/:id/activate', (context) => {
  const id = context.req.param('id');
  if (!workspaces.setCurrent(id)) return context.json({ ok: false, error: 'workspace_not_found' }, 404);
  audit.record({ actor: actorOf(context), action: 'workspace.activate', target: id });
  return context.json({ ok: true, current: id });
});

app.get('/api/canvas', (context) => {
  const store = canvasFor(workspaceOf(context));
  const document = store.read();
  const exists = store.exists();
  return context.json({
    ok: true,
    canvas: exists ? document : null,
    revision: document.revision,
  });
});

app.put('/api/canvas', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return context.json({ error: 'nodes_and_edges_required' }, 400);
  }
  try {
    const document = canvasFor(workspaceOf(context)).write({
      orchestratorId: String(body.orchestratorId ?? ''),
      nodes: body.nodes,
      edges: body.edges,
      baseRevision: typeof body.revision === 'number' ? body.revision : undefined,
    });
    audit.record({
      actor: actorOf(context),
      action: 'canvas.put',
      target: `r${document.revision}`,
      detail: { nodes: document.nodes.length, edges: document.edges.length },
    });
    return context.json({ ok: true, revision: document.revision });
  } catch (error) {
    if (error instanceof CanvasConflict) {
      return context.json(
        {
          ok: false,
          error: 'canvas_conflict',
          revision: error.serverRevision,
          canvas: error.serverDocument,
        },
        409
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return context.json({ ok: false, error: message }, message === 'canvas_too_large' ? 413 : 400);
  }
});

app.get('/api/canvas/summary', (context) => {
  const summary = canvasSummary(canvasFor(workspaceOf(context)).read());
  return context.body(summary, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
});

app.get('/api/canvas/svg', (context) => {
  const svg = canvasSvg(canvasFor(workspaceOf(context)).read());
  return context.body(svg, 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store',
  });
});

/**
 * A canvas you cannot hand to anyone else is a dead end. This produces a
 * standalone page (or Markdown) with the diagram inlined, so the board can be
 * attached to a PR, a doc, or a chat without the app running.
 */
app.get('/api/canvas/export', (context) => {
  const document = canvasFor(workspaceOf(context)).read();
  const format = context.req.query('format');
  if (format === 'md') {
    const markdown =
      '# 牵丝画布\n\n' +
      '导出于 ' +
      new Date().toLocaleString('zh-CN') +
      '\n\n```text\n' +
      canvasSummary(document) +
      '\n```\n';
    return context.body(markdown, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': 'attachment; filename="qiansi-canvas.md"',
    });
  }
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>牵丝画布</title><style>' +
    'body{margin:0;background:#0b1622;color:#e6edf6;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}' +
    'header{padding:20px 28px;border-bottom:1px solid #1c2836;display:flex;gap:12px;align-items:baseline}' +
    'h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.06em}' +
    'header span{color:#7c8ba1;font-size:12px}' +
    'main{padding:20px 28px 40px}svg{max-width:100%;height:auto;border:1px solid #1c2836;border-radius:12px}' +
    'pre{margin-top:28px;padding:18px 20px;background:#0e1621;border:1px solid #1c2836;border-radius:12px;' +
    'color:#9fb0c6;font-size:12.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word}' +
    'footer{padding:0 28px 28px;color:#5b6b80;font-size:11px}' +
    '</style></head><body><header><h1>牵丝 · 画布</h1><span>' +
    document.nodes.length +
    ' 节点 / ' +
    document.edges.length +
    ' 连线 · r' +
    document.revision +
    '</span></header><main>' +
    canvasSvg(document) +
    '<pre>' +
    escapeHtml(canvasSummary(document)) +
    '</pre></main><footer>由牵丝导出于 ' +
    escapeHtml(new Date().toLocaleString('zh-CN')) +
    '</footer></body></html>';
  return context.body(html, 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
});

/**
 * The single write path for agents: small, batched, and each op reports its own
 * error so one bad op never discards the rest of the batch.
 */
app.post('/api/canvas/ops', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const ops = Array.isArray(body?.ops) ? (body.ops as CanvasOp[]) : [];
  if (!ops.length) return context.json({ ok: false, error: 'ops_required' }, 400);
  if (ops.length > 200) return context.json({ ok: false, error: 'too_many_ops' }, 400);
  // A name decoded from non-UTF-8 bytes arrives as U+FFFD and would be stored
  // verbatim — the same mojibake bug that once hit workspace names.
  const garbled = ops.some((op) => {
    if (op.op === 'update_node') return JSON.stringify(op.patch ?? {}).includes('�');
    if (op.op === 'add_node') return JSON.stringify(op.node?.data ?? {}).includes('�');
    return false;
  });
  if (garbled) {
    return context.json(
      {
        ok: false,
        error: 'name_encoding',
        hint: '节点名里有无法解码的字节（U+FFFD）。请用 UTF-8 发送请求，不要从 GBK 控制台粘贴中文。',
      },
      400
    );
  }
  try {
    const result = canvasFor(workspaceOf(context)).apply(ops);
    if (result.applied > 0) {
      audit.record({
        actor: actorOf(context),
        action: 'canvas.ops',
        target: `r${result.document.revision}`,
        detail: {
          applied: result.applied,
          ops: ops.slice(0, 12).map((op) => (op as { op?: string })?.op ?? 'unknown'),
          errors: result.errors.length,
        },
      });
    }
    return context.json({
      ok: result.errors.length === 0,
      applied: result.applied,
      errors: result.errors,
      revision: result.document.revision,
      summary: canvasSummary(result.document),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return context.json({ ok: false, error: message }, message === 'canvas_too_large' ? 413 : 400);
  }
});

app.delete('/api/files/:id', (context) => {
  const id = context.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return context.json({ error: 'invalid_id' }, 400);
  const dir = join(stateDir, 'files');
  if (!existsSync(dir)) return context.json({ ok: true });
  const match = readdirSync(dir).find((name) => name.startsWith(`${id}-`));
  if (match) {
    try {
      unlinkSync(join(dir, match));
    } catch {
      // already removed or locked; the node is gone either way
    }
  }
  return context.json({ ok: true });
});

app.post('/api/approvals', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const record: ApprovalRecord = {
    id: randomUUID(),
    action: String(body?.action ?? 'unknown action').slice(0, 500),
    risk: String(body?.risk ?? 'unknown').slice(0, 100),
    costEstimate: Number(body?.costEstimate ?? 0),
    status: 'pending',
    createdAt: Date.now(),
  };
  approvals.set(record.id, record);
  persistApprovals();
  audit.record({
    actor: actorOf(context),
    action: 'approval.request',
    target: record.id,
    detail: { risk: record.risk, action: record.action.slice(0, 120) },
  });
  return context.json(record);
});

app.get('/api/approvals', (context) =>
  context.json({
    items: [...approvals.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
  })
);

/**
 * 需要人工的统一收件箱（借鉴 DSH 的 notices/面板哲学：面板先列需要人的事）。
 * 聚合四类信号：待审批、评委标记需人工、失败的任务、被中断的运行。
 * 健康状态不占空间——没有待处理时就是空列表。
 */
// ---------------------------------------------------------------------------
// 自我优化
// ---------------------------------------------------------------------------

app.get('/api/selfopt/meta', async (context) => {
  const rootDir = String(context.req.query('rootDir') ?? '') || defaultSelfOptRoot();
  return context.json(await selfOpt.meta(rootDir));
});

app.get('/api/selfopt/forecast', async (context) => {
  const query = context.req.query();
  const mode = String(query.mode ?? 'repair') as SelfOptMode;
  const level = String(query.level ?? 'L1') as SelfOptLevel;
  if (!findMode(mode) || !findLevel(level)) {
    return context.json({ ok: false, error: 'unknown_mode_or_level' }, 400);
  }
  const budget = Number(query.budget ?? 120_000);
  const findings = query.findings ? Number(query.findings) : undefined;
  const rootDir = String(query.rootDir ?? '') || defaultSelfOptRoot();
  const forecast = await selfOpt.forecast({ rootDir, mode, level, budget, findings });
  return context.json({ ok: true, forecast });
});

app.post('/api/selfopt/start', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const mode = String(body?.mode ?? 'repair') as SelfOptMode;
  const level = String(body?.level ?? 'L1') as SelfOptLevel;
  if (!findMode(mode) || !findLevel(level)) {
    return context.json({ ok: false, error: 'unknown_mode_or_level' }, 400);
  }
  const rootDir = String(body?.rootDir ?? '') || defaultSelfOptRoot();
  try {
    const session = await selfOpt.start({
      rootDir,
      mode,
      level,
      maxTokens: Number(body?.maxTokens ?? 120_000),
      maxRounds: Number(body?.maxRounds ?? 3),
      findings: body?.findings ? Number(body.findings) : undefined,
      allowDirty: body?.allowDirty === true,
      actor: actorOf(context),
    });
    // 自省过程放到独立画布：体检、问题、改法都成为节点，可随时查看。
    const repoName = basename(session.rootDir) || 'project';
    const canvasWs = workspaces.create(`自省 · ${repoName}`.slice(0, 40));
    selfoptCanvases.clear();
selfoptSyncAt.clear();
selfoptCanvases.set(session.id, canvasWs.id);
    publishSelfOpt(session);
    audit.record({
      actor: actorOf(context),
      action: 'selfopt.start',
      target: session.id,
      detail: {
        mode,
        level,
        rootDir: session.rootDir,
        budget: session.budget,
        forecast: session.forecast?.expected,
      },
    });
    return context.json({ ok: true, session, canvasWorkspaceId: canvasWs.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'selfopt_in_progress' || message === 'worktree_dirty' ? 409 : 400;
    return context.json({ ok: false, error: message }, status);
  }
});

app.post('/api/selfopt/stop', (context) => {
  const stopped = selfOpt.stop();
  audit.record({ actor: actorOf(context), action: 'selfopt.stop', target: selfOpt.current()?.id });
  return context.json({ ok: true, stopped, session: selfOpt.current() });
});

app.get('/api/selfopt/status', async (context) => {
  const roster = await availableSelfOptModels().catch(() => [] as string[]);
  return context.json({
    ok: true,
    session: (() => {
      const current = selfOpt.current();
      if (!current) return null;
      return { ...current, canvasWorkspaceId: selfoptCanvases.get(current.id) ?? null };
    })(),
    meta: { rootDir: defaultSelfOptRoot(), roster, ...describeSelfOpt() },
  });
});

app.get('/api/selfopt/versions', async (context) => {
  const rootDir = String(context.req.query('rootDir') ?? '') || defaultSelfOptRoot();
  return context.json(await selfOpt.versions(rootDir));
});

app.get('/api/selfopt/versions/:id/diff', async (context) => {
  const rootDir = String(context.req.query('rootDir') ?? '') || defaultSelfOptRoot();
  return context.json(await selfOpt.diffOf(rootDir, context.req.param('id')));
});

app.post('/api/selfopt/versions/:id/switch', async (context) => {
  const rootDir = String(context.req.query('rootDir') ?? '') || defaultSelfOptRoot();
  const result = await selfOpt.switchTo(rootDir, context.req.param('id'));
  return context.json(result, result.ok ? 200 : 409);
});

app.post('/api/selfopt/restore', async (context) => {
  const rootDir = String(context.req.query('rootDir') ?? '') || defaultSelfOptRoot();
  const result = await selfOpt.restore(rootDir);
  return context.json(result, result.ok ? 200 : 409);
});

app.get('/api/attention', (context) => {
  const wsId = workspaceOf(context);
  const pendingApprovals = [...approvals.values()]
    .filter((item) => item.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt);

  const judgeReviews: Array<{
    runId: string;
    goal: string;
    taskId: string;
    reasons: string[];
    at: number;
  }> = [];
  const failedRuns: Array<{ runId: string; goal: string; at: number; tasks: string[] }> = [];
  const interrupted: Array<{ runId: string; goal: string; at: number; tasks: string[] }> = [];
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (const item of store.list()) {
    if (item.startedAt < dayAgo) continue;
    const record = store.get(item.runId);
    if (!record) continue;
    if ((record.workspaceId ?? 'main') !== wsId) continue;
    const tasks = (record.plan?.subtasks ?? []).map((task) => task.id);
    if (record.status === 'failed') {
      failedRuns.push({ runId: record.runId, goal: record.goal, at: record.finishedAt ?? 0, tasks });
      continue;
    }
    if (record.status === 'aborted') {
      interrupted.push({ runId: record.runId, goal: record.goal, at: record.finishedAt ?? 0, tasks });
      continue;
    }
    for (const envelope of record.events) {
      const event = envelope.event as {
        type?: string;
        taskId?: string;
        result?: { needsHuman?: boolean; reasons?: string[] };
      };
      if (event.type !== 'task.acceptance' || !event.result?.needsHuman) continue;
      judgeReviews.push({
        runId: record.runId,
        goal: record.goal,
        taskId: String(event.taskId ?? ''),
        reasons: (event.result.reasons ?? []).slice(0, 2),
        at: envelope.ts,
      });
    }
  }

  const total =
    pendingApprovals.length + judgeReviews.length + failedRuns.length + interrupted.length;
  return context.json({
    ok: true,
    total,
    approvals: pendingApprovals.slice(0, 10).map((item) => ({
      id: item.id,
      action: item.action,
      risk: item.risk,
      costEstimate: item.costEstimate,
      createdAt: item.createdAt,
    })),
    judgeReviews: judgeReviews.slice(-10).reverse(),
    failedRuns: failedRuns.slice(-10).reverse(),
    interrupted: interrupted.slice(-10).reverse(),
  });
});

app.get('/api/approvals/:id', (context) => {
  const record = approvals.get(context.req.param('id'));
  if (!record) return context.json({ error: 'not_found' }, 404);
  return context.json(record);
});

app.post('/api/approvals/:id/resolve', async (context) => {
  const record = approvals.get(context.req.param('id'));
  if (!record) return context.json({ error: 'not_found' }, 404);
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const decision = body?.decision === 'approved' ? 'approved' : body?.decision === 'denied' ? 'denied' : '';
  if (!decision) return context.json({ error: 'decision_must_be_approved_or_denied' }, 400);
  record.status = decision;
  record.note = typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined;
  record.resolvedAt = Date.now();
  persistApprovals();
  audit.record({
    actor: actorOf(context),
    action: 'approval.resolve',
    target: record.id,
    detail: { decision, note: record.note },
  });
  return context.json(record);
});

app.get('/api/external', (context) => context.json({ items: externalCalls }));

app.get('/api/activity', async (context) =>
  streamSSE(context, async (stream) => {
    const subscriber = (event: ExternalCallEvent) => {
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    };
    activitySubscribers.add(subscriber);
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'heartbeat', data: '{}' });
    }, 15000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      activitySubscribers.delete(subscriber);
    });

    await new Promise<void>(() => {});
  })
);

app.get('/api/audit', (context) => {
  const limit = Math.max(1, Math.min(2000, Number(context.req.query('limit') ?? 200)));
  const items = audit.tail(limit);
  return context.json({ ok: true, count: items.length, items });
});

app.get('/api/usage', (context) =>
  context.json({
    gateway: gatewayUsage.snapshot(),
    pendingApprovals: [...approvals.values()].filter((item) => item.status === 'pending').length,
    external: {
      byAgent: Object.fromEntries(externalUsageByAgent),
      bySession: Object.fromEntries(externalUsageBySession),
    },
  })
);

app.post('/api/feedback', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const message = String(body?.message ?? '').trim();
  if (!message) return context.json({ error: 'message_required' }, 400);

  const record = {
    createdAt: new Date().toISOString(),
    message: message.slice(0, 4000),
    contact: String(body?.contact ?? '').slice(0, 200),
    version: APP_VERSION,
  };
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, 'feedback.jsonl'), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return context.json({ ok: true });
});

app.post('/api/commands', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const commandId = String(body?.commandId ?? '');
  if (!commandId) {
    return context.json({ error: 'commandId is required' }, 400);
  }

  const cached = idempotency.get(commandId);
  if (cached) return context.json(cached);

  if (body?.type === 'run.stop') {
    const stopAdmission = policy.admit(actorOf(context), 'run.stop');
    if (!stopAdmission.allowed) {
      audit.record({
        actor: actorOf(context),
        action: 'policy.denied',
        target: 'run.stop',
        detail: { reason: stopAdmission.reason },
      });
      return context.json(
        { error: 'not_admitted', scope: 'run.stop', reason: stopAdmission.reason },
        403
      );
    }
    const runId = String(body?.payload?.runId ?? '');
    const controller = runAborts.get(runId);
    if (!controller) {
      return context.json({ error: 'run_not_found' }, 404);
    }
    store.markManualStop(runId);
    controller.abort();
    if (activeLiveRunId === runId) activeLiveRunId = null;
    // Every stop is recorded, because stopping is allowed to anyone holding the
    // token — that is only safe if it always leaves a trace.
    audit.record({ actor: actorOf(context), action: 'run.stop', target: runId });
    const response = { ok: true, runId, stopped: true };
    idempotency.set(commandId, response);
    return context.json(response);
  }

  if (body?.type !== 'run.start') {
    return context.json({ error: 'unsupported_command' }, 400);
  }

  const runId = randomUUID();
  const mode = body?.payload?.mode === 'live' ? 'live' : 'demo';

  // Who is asking for this run, and does the policy let them? A refusal here is
  // the difference between "an agent can start a paid run whenever it likes"
  // and "an agent can start one because someone allowed it".
  const runActor = actorOf(context);
  const runAdmission = policy.admit(runActor, 'run.start');
  if (!runAdmission.allowed) {
    audit.record({
      actor: runActor,
      action: 'policy.denied',
      target: 'run.start',
      detail: { reason: runAdmission.reason },
    });
    return context.json(
      {
        error: 'not_admitted',
        scope: 'run.start',
        actor: runActor,
        reason: runAdmission.reason,
        policyVersion: runAdmission.policyVersion,
      },
      403
    );
  }

  const requestedBudget = (body?.payload?.budget ?? {}) as Record<string, unknown>;
  const budget = {
    // 带工具的真实运行一分钟就能花掉 6 万 token：原来的 20 万总量 / 6 万每分钟
    // 会把正常的多节点工具运行掐死在半路（实测 74k/min 触发后 C2–C5 全灭）。
    maxTotalTokens: Number(requestedBudget.maxTotalTokens ?? 400000),
    maxTokensPerModel: Number(requestedBudget.maxTokensPerModel ?? 250000),
    maxTokensPerMinute: Number(requestedBudget.maxTokensPerMinute ?? 250000),
    maxCallsPerTask: Number(requestedBudget.maxCallsPerTask ?? 6),
  };

  const orchestratorId = String(body?.payload?.orchestratorId ?? '');
  const team = Array.isArray(body?.payload?.team)
    ? (body.payload.team as Array<Record<string, unknown>>).slice(0, 20)
    : [];
  const teamContext = [
    team
      .filter((member) => member && member.name)
      .map(
        (member) =>
          `- ${member.id === orchestratorId ? '[主控] ' : ''}${String(member.name)} (${String(
            member.role ?? ''
          )}): ${String(member.provider ?? '')}/${String(member.model ?? '')}, effort ${String(
            member.effort ?? ''
          )}`
      )
      .join('\n'),
    // 工作区公共指令（借鉴 DSH 的 team sections）：注入每个 worker 的系统提示。
    workspaces.get(workspaceOf(context))?.instructions
      ? `工作区公共指令（必须遵守）：\n${workspaces.get(workspaceOf(context))?.instructions}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (mode === 'live') {
    const requestedGoal =
      typeof body?.payload?.goal === 'string' ? String(body.payload.goal).trim().slice(0, 500) : '';
    const liveRunPlan = requestedGoal ? { ...livePlan, goal: requestedGoal } : livePlan;
    const credentials = (body?.payload?.credentials ?? {}) as Record<string, string | undefined>;
    const vaultDeepseek = await vault.get('conn-deepseek');
    const vaultMinimax = await vault.get('conn-minimax');
    const vaultRelay = await vault.get('conn-claude-relay');
    const vaultMoonshot =
      (await vault.get('conn-moonshot')) ?? (await vault.get('conn-kimi'));
    const vaultZhipu = await vault.get('conn-zhipu');
    const vaultQwen = await vault.get('conn-qwen');
    const vaultOpenai = await vault.get('conn-openai');
    const deepseekKey = String(credentials.deepseek ?? vaultDeepseek ?? process.env.DEEPSEEK_API_KEY ?? '');
    const minimaxKey = String(credentials.minimax ?? vaultMinimax ?? process.env.MINIMAX_API_KEY ?? '');
    const moonshotKey = String(credentials.moonshot ?? vaultMoonshot ?? process.env.MOONSHOT_API_KEY ?? '');
    const zhipuKey = String(credentials.zhipu ?? vaultZhipu ?? process.env.ZHIPUAI_API_KEY ?? '');
    const qwenKey = String(credentials.qwen ?? vaultQwen ?? process.env.DASHSCOPE_API_KEY ?? '');
    const openaiKey = String(credentials.openai ?? vaultOpenai ?? process.env.OPENAI_API_KEY ?? '');
    const relayKey = String(credentials.relay ?? vaultRelay ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '');
    const keyBySlot: Record<KeySlot, string> = {
      deepseek: deepseekKey,
      minimax: minimaxKey,
      moonshot: moonshotKey,
      zhipu: zhipuKey,
      qwen: qwenKey,
      openai: openaiKey,
      relay: relayKey,
    };
    // Managed keys are canonical: the active key — or the next one with quota
    // left — wins over the legacy vault/env resolution above, and its id is
    // what the usage is booked against.
    const keyIdBySlot: Partial<Record<KeySlot, string>> = {};
    for (const slot of Object.keys(keyBySlot) as KeySlot[]) {
      const credential = await slotCredential(slot);
      if (credential) {
        keyBySlot[slot] = credential.secret;
        keyIdBySlot[slot] = credential.keyId;
      }
    }

    /**
     * What is drawn on the board is what runs: nodes become model profiles
     * routed through the catalog (one key serves its whole model family), and
     * the orchestrator's outgoing wires become subtasks. A canvas that cannot
     * run is refused outright — falling back to a built-in demo would look
     * like it worked.
     */
    // 运行归属于发起它的工作区；产物必须写回同一张画布。
    const runWorkspace = workspaceOf(context);
    const canvasDocument = canvasFor(runWorkspace).read();
    const canvasFiles = collectCanvasFiles(canvasDocument, stateDir);
    const allowDemoFallback = body?.payload?.allowDemoFallback === true;
    let resumePrepared: {
      profiles: CapabilityProfile[];
      plan: Plan;
      slotByProfile: Map<string, KeySlot>;
      autoResume: boolean;
      depth: number;
      prevOutputs: Record<string, string>;
    } | null = null;
    let canvasPrepared: { canvasPlan: ReturnType<typeof buildPlanFromCanvas> } | null = null;

    /**
     * ── 断点续跑（长期项目的核心）──
     * resumeOf 指向上一轮运行：只跑没完成的任务，已完成产出通过 seedOutputs
     * 预注入为本轮的上游。续跑绕过画布重新规划，沿用上一轮的计划与模型。
     */
    const resumeOf = typeof body?.payload?.resumeOf === 'string' ? body.payload.resumeOf : '';
    const autoResumeFlag = body?.payload?.autoResume === true;

    if (resumeOf) {
      await ensureQuotaSeeded();
      const prev = store.get(resumeOf);
      if (!prev) {
        return context.json({ ok: false, error: 'resume_run_not_found', resumeOf }, 404);
      }
      if ((prev.workspaceId ?? 'main') !== runWorkspace) {
        return context.json(
          { ok: false, error: 'resume_workspace_mismatch', resumeOf, hint: '续跑必须回到原工作区。' },
          409
        );
      }
      if (prev.status === 'running') {
        return context.json({ ok: false, error: 'resume_source_running', resumeOf }, 409);
      }
      if (!prev.plan || !prev.plan.subtasks?.length) {
        return context.json({ ok: false, error: 'resume_no_plan', resumeOf }, 400);
      }

      const resumeDepth = prev.resumeDepth ?? 0;
      const built = buildResumePlan({
        prevPlan: prev.plan,
        prevOutputs: prev.outputs ?? {},
        resumeDepth,
      });
      if (!built.pending.length) {
        return context.json({
          ok: false,
          error: 'nothing_to_resume',
          done: built.skippedDone.length,
          hint: '上一轮所有任务都已有产出；要重跑请直接运行，而不是续跑。',
        });
      }

      const pendingProfiles = built.plan.subtasks
        .map((task) => task.profileId)
        .filter((id, index, all) => all.indexOf(id) === index)
        .map((profileId) => {
          const fromPrev = (prev as unknown as { profiles?: CapabilityProfile[] }).profiles?.find(
            (profile) => profile.id === profileId
          );
          // 档案缺失时按画布节点当前模型兜底（续跑允许用上新换的模型/Key）。
          // id 必须保持计划里的 canvas-<nodeId>，否则 orchestrator 找不到档案。
          if (fromPrev) return { ...fromPrev, id: profileId };
          const nodeId = built.plan.subtasks.find((task) => task.profileId === profileId)?.assignedNodeId;
          const nodeModel = nodeId
            ? String(canvasDocument.nodes.find((node) => node.id === nodeId)?.data?.model ?? '')
            : '';
          return nodeModel
            ? { ...profileForModel(nodeModel), id: profileId }
            : { ...profileForModel('claude-haiku-4-5'), id: profileId };
        });

      audit.record({
        actor: actorOf(context),
        action: 'run.resume',
        target: runId,
        detail: {
          resumedFrom: resumeOf,
          depth: resumeDepth + 1,
          pending: built.pending.length,
          skipped: built.skippedDone.length,
        },
      });

      resumePrepared = {
        profiles: pendingProfiles,
        plan: built.plan,
        slotByProfile: new Map(
          pendingProfiles.map((profile) => [profile.id, familyOf(profile.model)?.slot ?? 'relay'])
        ),
        autoResume: prev.autoResume ?? autoResumeFlag,
        depth: resumeDepth + 1,
        prevOutputs: prev.outputs ?? {},
      };
    } else {
      const canvasPlan = buildPlanFromCanvas(canvasDocument, requestedGoal, {
        files: canvasFiles,
      });

      if (!canvasPlan && !allowDemoFallback) {
        const diagnosis = diagnoseCanvas(canvasDocument);
        audit.record({
          actor: actorOf(context),
          action: 'run.refused',
          target: 'canvas_not_runnable',
          detail: { reasons: diagnosis.reasons },
        });
        return context.json(
          {
            error: 'canvas_not_runnable',
            reasons: diagnosis.reasons,
            hint: '在画布上至少放两个带模型的节点并设好主控再运行；只想看流程可以传 allowDemoFallback: true 跑内置演示。',
          },
          422
        );
      }

      resumePrepared = null;
      canvasPrepared = { canvasPlan };
    }

    const canvasPlan = resumePrepared ? null : canvasPrepared!.canvasPlan;
    const profilesToRun = resumePrepared ? resumePrepared.profiles : canvasPlan?.profiles ?? liveProfiles;
    const planSource: 'canvas' | 'builtin' = resumePrepared ? 'canvas' : canvasPlan ? 'canvas' : 'builtin';
    runPlanSource.set(runId, planSource);

    /**
     * The 主控 node produces nothing — it routes. Its model is used for the
     * acceptance gate only when it is a cheap tier; otherwise the catalog's
     * cheapest reachable model takes the job, because a gate that costs as
     * much as the work it gates saves nothing.
     */
    const orchestratorModel = String(
      canvasDocument.nodes.find((node) => node.id === canvasDocument.orchestratorId)?.data
        ?.model ?? ''
    );
    const orchestratorSlot = orchestratorModel ? resolveModelRoute(orchestratorModel).slot : null;
    const routerPick = resumePrepared
      ? null
      : orchestratorModel &&
          isCheapModel(orchestratorModel) &&
          orchestratorSlot &&
          keyBySlot[orchestratorSlot]
        ? { slot: orchestratorSlot, model: orchestratorModel }
        : routerChoice(keyBySlot);

    const basePlan = resumePrepared ? resumePrepared.plan : canvasPlan?.plan ?? liveRunPlan;
    const baseRationale = !resumePrepared && routerPick
      ? `${basePlan.rationale ?? ''} 分派闸门：${routerPick.model}（只判定明显通过，拿不准交给完整评委）。`.trim()
      : basePlan.rationale;

    /**
     * Quota preflight: a lane whose family is out of budget moves to the
     * cheapest family that still has some, before the run starts rather than
     * failing halfway with a 429.
     */
    const slotByProfile = resumePrepared
      ? resumePrepared.slotByProfile
      : canvasPlan?.slotByProfile ??
        new Map(profilesToRun.map((profile) => [profile.id, familyOf(profile.model)?.slot ?? 'relay']));
    const requestedStrategy = body?.payload?.strategy;
    const runStrategy =
      requestedStrategy === 'performance' || requestedStrategy === 'cost' || requestedStrategy === 'subscription'
        ? requestedStrategy
        : quota.strategy();
    const substitutions = substituteExhausted({
      plan: basePlan,
      profiles: profilesToRun,
      slotByProfile,
      hasKey: (slot) => Boolean(keyBySlot[slot]),
      headroom: (slot) => quota.headroom(slot),
      strategy: runStrategy,
      billingOf: (slot) => quota.billingOf(slot),
      priceOf: (slot) => {
        const price = quota.prices()[slot];
        return (price.in + price.out) / 2;
      },
    });
    const planToRun =
      substitutions.length > 0
        ? {
            ...basePlan,
            rationale: `${baseRationale ?? ''} 额度改派：${substitutions
              .map((item) => `${item.nodeId ?? item.taskId} ${item.fromModel}→${item.toModel}`)
              .join('、')}。`.trim(),
          }
        : routerPick
          ? { ...basePlan, rationale: baseRationale }
          : basePlan;

    // relay is always required: the acceptance judge runs on it even when every
    // worker node is served by another key.
    const needed = new Set<KeySlot>(canvasPlan ? ['relay'] : ['deepseek', 'minimax', 'relay']);
    for (const slot of slotByProfile.values()) needed.add(slot);

    const missing: string[] = [];
    for (const slot of needed) {
      if (!keyBySlot[slot]) missing.push(slot);
    }
    if (missing.length > 0) {
      return context.json({ error: 'live_mode_missing_credentials', missing }, 503);
    }

    if (activeLiveRunId) {
      audit.record({
        actor: actorOf(context),
        action: 'run.rejected',
        target: 'run_in_progress',
        detail: { active: activeLiveRunId },
      });
      return context.json(
        {
          error: 'run_in_progress',
          runId: activeLiveRunId,
          hint: '已有一个真实运行在进行。等它结束，或先 POST run.stop 停掉它。',
        },
        409
      );
    }
    activeLiveRunId = runId;

    audit.record({
      actor: actorOf(context),
      action: 'run.start',
      target: runId,
      detail: {
        mode,
        planSource,
        tasks: planToRun.subtasks.length,
        models: profilesToRun.map((profile) => profile.model).slice(0, 8),
        files: fileSummary(canvasFiles) || undefined,
        strategy: runStrategy,
        searchNodes: profilesToRun.filter((profile) => profile.webSearch).length || undefined,
        substitutions: substitutions.length
          ? substitutions.map((item) => `${item.taskId}:${item.fromSlot}->${item.toSlot}`)
          : undefined,
        keys: keyIdBySlot,
      },
    });

    store.create(runId, planToRun.goal, runWorkspace, planSource, {
      resumedFrom: resumePrepared ? resumeOf : undefined,
      resumeDepth: resumePrepared?.depth,
      autoResume: resumePrepared ? resumePrepared.autoResume : autoResumeFlag,
      profiles: profilesToRun,
    });
    if (resumePrepared) {
      // 预注入上一轮已完成任务的产出：续跑任务的依赖解析直接取到上游。
      store.seedOutputs(runId, resumePrepared.prevOutputs);
    }
    const mandate: Mandate = {
      runId,
      actor: runActor,
      admission: runAdmission.admission === 'explicit' ? 'explicit' : 'inferred',
      policyVersion: runAdmission.policyVersion,
      scopes: runAdmission.scopes,
      tasks: planToRun.subtasks.length,
      createdAt: Date.now(),
      needsReview: runAdmission.admission === 'inferred',
    };
    store.setMandate(runId, mandate);
    if (mandate.needsReview) {
      audit.record({
        actor: runActor,
        action: 'run.needs_review',
        target: runId,
        detail: { reason: runAdmission.reason },
      });
    }
    const apiKeys: Record<string, string> = {
      'live-deepseek': keyBySlot.deepseek,
      'live-minimax': keyBySlot.minimax,
      'live-sonnet': keyBySlot.relay,
      'live-opus': keyBySlot.relay,
      'live-haiku': keyBySlot.relay,
    };
    // 两种路径（画布规划 / 断点续跑）都按「档案 → 槽位 → Key」装配，
    // 续跑没有 canvasPlan 时同样拿得到自己的 Key。
    for (const profile of profilesToRun) {
      const slot = slotByProfile.get(profile.id);
      apiKeys[profile.id] = slot ? keyBySlot[slot] : relayKey;
    }
    const controller = new AbortController();
    runAborts.set(runId, controller);

    // 领导层默认用旗舰模型（借鉴「决策层-执行层」分工）：
    // 显式 judgeModel > 主控节点模型 > deepseek-v4-pro > relay sonnet。
    // 便宜闸门仍只筛明显通过的，拿不准的才交给旗舰当评委。
    const requestedJudgeModel = String(body?.payload?.judgeModel ?? '').trim();
    const judgeCandidates = [requestedJudgeModel, orchestratorModel, 'deepseek-v4-pro'].filter(
      Boolean
    ) as string[];
    let judgeTarget: { profile: CapabilityProfile; apiKey: string } = {
      profile: liveProfiles.find((profile) => profile.id === 'live-sonnet')!,
      apiKey: relayKey,
    };
    let judgeSlot: KeySlot = 'relay';
    for (const candidate of judgeCandidates) {
      const family = familyOf(candidate);
      if (!family) continue;
      const key = keyBySlot[family.slot];
      if (!key) continue;
      judgeTarget = { profile: profileForModel(candidate), apiKey: key };
      judgeSlot = family.slot;
      break;
    }
    audit.record({
      actor: 'server',
      action: 'run.judge',
      target: runId,
      detail: { model: judgeTarget.profile.model, slot: judgeSlot },
    });

    // 节点工具：文件读写、终端、画布查询、联网。工作目录取画布设置，
    // 没设就用服务端目录；payload.tools === false 可整体关闭。
    const toolWorkspaceId = workspaceOf(context);
    const toolRootDir = workspaces.get(toolWorkspaceId)?.rootDir || process.cwd();
    const nodeToolbox =
      body?.payload?.tools === false
        ? undefined
        : buildNodeToolbox({
            rootDir: toolRootDir,
            workspaceId: toolWorkspaceId,
            runId,
            canvas: () => canvasFor(toolWorkspaceId).read(),
            workspaces: () =>
              workspaces.list().map((item) => ({
                id: item.id,
                name: item.name,
                archivedAt: item.archivedAt,
              })),
            runs: () =>
              store.list().map((item) => ({
                runId: item.runId,
                status: item.status,
                goal: item.goal,
                workspaceId: item.workspaceId,
              })),
            runResult: (id) => store.snapshot(id) ?? { error: 'run_not_found', runId: id },
            search: (query, maxResults) => webSearch.search({ query, maxResults }),
            audit: (entry) =>
              audit.record({
                actor: 'node-tool',
                action: entry.action,
                target: entry.target,
                detail: entry.detail,
              }),
          });

    const orchestrator = new Orchestrator({
      profiles: profilesToRun,
      adapters: {
        'openai-chat': new OpenAIChatAdapter(),
        'anthropic-messages': new AnthropicMessagesAdapter(),
      },
      apiKeys,
      // Independent lanes run in parallel; dependsOn still serializes chains.
      // 1 used to make a heavy matrix task block a light one for minutes.
      concurrency: 3,
      maxRetries: 1,
      // 45s repeatedly aborted thinking models mid-stream the moment a real
      // research pack was injected (5398 reasoning deltas then a hard abort);
      // 120s still aborted deepseek-v4-pro at ~30k reasoning chars with zero
      // answer text. 240s gives heavy lanes room; parallel lanes absorb it.
      taskTimeoutMs: 240_000,
      // Thinking models burn reasoning out of the same completion budget; 4096
      // let a heavy matrix task think until the answer had no room left.
      maxOutputTokens: 12288,
      budget,
      teamContext,
      signal: controller.signal,
      runId,
      // 断点续跑：上一轮已完成任务的产出（也用于让调度器视为已完成）。
      ...(resumePrepared ? { seedOutputs: resumePrepared.prevOutputs } : {}),
      // 只有 profile.webSearch === true 的节点才会被 ToolAdapter 包一层。
      search: webSearch.search,
      // 有工具箱时所有节点都能调用文件/终端/画布/联网工具。
      toolbox: nodeToolbox,
      accept: createRoutedJudge({
        router: routerPick
          ? {
              profile: profileForModel(routerPick.model, '分派闸门'),
              apiKey: keyBySlot[routerPick.slot],
            }
          : undefined,
        full: judgeTarget,
        teamContext,
        onUsage: (usage) => {
          const slot =
            usage.stage === 'full' ? judgeSlot : familyOf(usage.model)?.slot ?? 'relay';
          quota.record({
            slot,
            keyId: keyIdBySlot[slot] ?? 'default',
            model: usage.model,
            tokens: usage.input + usage.output,
            source: 'judge',
          });
        },
      }),
    });
    const gateCounts = { structural: 0, cheap: 0, full: 0 };
    orchestrator.on((event) => {
      store.append(runId, redactRunEvent(event));
      if (event.type === 'usage') {
        // The event carries the profile id (canvas-<nodeId>), not the model
        // name — resolve the slot from the plan map first, or every worker's
        // spend would be booked against the relay.
        const slot =
          slotByProfile.get(event.modelId) ?? familyOf(event.modelId)?.slot ?? 'relay';
        quota.record({
          slot,
          keyId: keyIdBySlot[slot] ?? 'default',
          model: event.modelId,
          tokens: event.input + event.output,
          source: 'run',
        });
      }
      if (event.type === 'task.acceptance' && event.result.gate) gateCounts[event.result.gate] += 1;
      if (event.type !== 'run.finished') return;
      runAborts.delete(runId);
      if (activeLiveRunId === runId) activeLiveRunId = null;
      // 当前运行结束了：把排队中的托管画布拉起来跑。
      void drainRunQueue();
      audit.record({
        actor: 'server',
        action: 'run.gates',
        target: runId,
        detail: { ...gateCounts, router: routerPick?.model ?? null },
      });
      // 失败归因与自动重试计划：先算清楚「为什么失败、还会不会重试」，
      // 再决定回写画布（授权被撤销时只记录、不写画布）。
      const finishedRecord = store.get(runId);
      let pendingCount = 0;
      let willRetry = false;
      if (finishedRecord?.autoResume && !finishedRecord.manualStop && event.status !== 'done') {
        const outputsNow = store.snapshot(runId)?.outputs ?? {};
        pendingCount = planToRun.subtasks.filter(
          (task) => !String(outputsNow[task.id] ?? '').trim()
        ).length;
        willRetry = pendingCount > 0 && (finishedRecord.resumeDepth ?? 0) < 2;
      }
      let failureSummary: RunFailureSummary | null = null;
      if (finishedRecord && event.status !== 'done') {
        failureSummary = buildFailureSummary({
          record: finishedRecord,
          plan: planToRun,
          status: event.status,
          retryScheduled: willRetry,
        });
        store.setFailureSummary(runId, failureSummary);
        audit.record({
          actor: 'server',
          action: 'run.failure_summary',
          target: runId,
          detail: {
            headline: failureSummary.headline,
            reasons: failureSummary.reasons.slice(0, 3),
            attempt: failureSummary.attempt,
            maxAttempts: failureSummary.maxAttempts,
            retryScheduled: willRetry,
          },
        });
      }
      if (planSource !== 'canvas') {
        // 没有画布回写可做：记账为已处理，启动补投时不再考虑它。
        effects.mark(runId, 'writeback');
        effects.mark(runId, 'deliverables');
        return;
      }
      // A mandate is re-checked before it is used again. If the policy tightened
      // while the run was going, the run still finishes, but it no longer gets
      // to write back what it produced.
      const revalidated = policy.revalidate(store.getMandate(runId), 'canvas.write');
      if (!revalidated.ok) {
        audit.record({
          actor: 'server',
          action: 'mandate.revoked',
          target: runId,
          detail: { reason: revalidated.reason },
        });
        // 授权已撤销：记账为已处理，补投不得绕过策略写回画布。
        effects.mark(runId, 'writeback');
        effects.mark(runId, 'deliverables');
        return;
      }
      // No studio window is necessarily open when an agent starts a run, so the
      // server is the one that puts the artifacts back on the board.
      const snapshot = store.snapshot(runId);
      const applied = writeRunArtifacts(
        canvasFor(runWorkspace),
        planToRun,
        snapshot?.outputs ?? {},
        event.status !== 'done'
      );
      effects.mark(runId, 'writeback');
      if (applied > 0) {
        audit.record({
          actor: 'server',
          action: 'canvas.writeback',
          target: runId,
          detail: { nodes: applied, status: event.status },
        });
      }
      // 失败总结也放回画布：用户不用翻运行记录就能看到为什么失败、还会不会重试。
      if (failureSummary) publishFailureSummaryNode(runWorkspace, failureSummary);
      // 跑完之后 Qiansi 自己把项目打开看一眼：用户视角验收（可关）。
      if (event.status === 'done' && body?.payload?.userView !== false) {
        maybeAutoUserView(runWorkspace, runId);
      }
      // 每个任务的完整产出落成 .md 文件：弹窗看过就没了，文件才是交付物。
      try {
        const saved = saveRunDeliverables({
          stateDir,
          workspaceId: runWorkspace,
          runId,
          goal: planToRun.goal,
          plan: planToRun,
          outputs: snapshot?.outputs ?? {},
        });
        if (saved.length > 0) {
          audit.record({
            actor: 'server',
            action: 'deliverables.saved',
            target: runId,
            detail: { files: saved.length, dir: join('deliverables', runWorkspace, runId) },
          });
        }
        effects.mark(runId, 'deliverables');
      } catch {
        // 交付物写不出来不影响运行结果本身；账本没记，下次启动补投
      }

      /**
       * 领导层复盘（旗舰模型）：检验成果、给建议；成果远远达不到目标时
       * 自动发起多模型讨论。异步执行，不阻塞运行结束的收尾。
       */
      void (async () => {
        try {
          const record = store.get(runId);
          const acceptances = (record?.events ?? [])
            .map((envelope) => envelope.event)
            .filter((event) => event.type === 'task.acceptance')
            .map((event) => event as { taskId?: string; result?: { score?: number; reasons?: string[] } });
          const outcomes = collectOutcomes(planToRun, snapshot?.outputs ?? {}, acceptances);
          const summary = summarizeOutcomes(outcomes);

          let verdict: LeadershipVerdict | null = null;
          try {
            const review = await completeChat(
              vault,
              {
                model: judgeTarget.profile.model,
                apiKey: judgeTarget.apiKey,
                protocol: judgeTarget.profile.protocol,
                baseUrl: judgeTarget.profile.baseUrl,
              },
              [
                {
                  role: 'system',
                  content: '你是多 AI 编排的决策者。只输出一个 JSON 对象，不要解释，不要 Markdown。',
                },
                { role: 'user', content: buildReviewPrompt(planToRun.goal, outcomes) },
              ],
              { maxTokens: 2400, timeoutMs: 60000 }
            );
            quota.record({
              slot: judgeSlot,
              keyId: keyIdBySlot[judgeSlot] ?? 'default',
              model: judgeTarget.profile.model,
              tokens: review.usage.total,
              source: 'judge',
            });
            verdict = normalizeVerdict(parseModelJson(review.text, 'review_output'), summary);
          } catch {
            // 复盘调用失败不影响运行；下面的规则兜底决定是否讨论
          }

          const action = verdict?.action ?? decideAction(summary);
          const stored = {
            verdict: verdict?.verdict ?? (action === 'discuss' ? 'weak' : 'ok'),
            score: verdict?.score ?? summary.avgScore ?? 0.5,
            summary: verdict?.summary ?? '',
            suggestions: verdict?.suggestions ?? [],
            action,
            model: judgeTarget.profile.model,
            at: Date.now(),
          };
          store.setReview(runId, stored);
          audit.record({
            actor: 'server',
            action: 'run.review',
            target: runId,
            detail: {
              verdict: stored.verdict,
              action,
              model: stored.model,
              suggestions: stored.suggestions.length,
            },
          });

          if (action !== 'discuss') return;

          // 自动讨论：参与者取画布上的 worker 模型（去重，最多 3 个）。
          const workspaceCanvas = canvasFor(runWorkspace).read();
          const seenModels = new Set<string>();
          const participants: DiscussParticipant[] = [];
          for (const node of workspaceCanvas.nodes) {
            const data = node.data ?? {};
            const kind = String(data.kind ?? '');
            const model = String(data.model ?? '');
            if (!model || model === 'library') continue;
            if (kind === 'library' || kind === 'region' || kind === 'artifact' || kind === 'orchestrator') continue;
            if (seenModels.has(model)) continue;
            seenModels.add(model);
            participants.push({
              id: node.id,
              name: String(data.name ?? model),
              model,
              connectionId: String(data.connectionId ?? '') || undefined,
              protocol: String(data.protocol ?? '') || undefined,
              baseUrl: String(data.baseUrl ?? '') || undefined,
            });
            if (participants.length >= 3) break;
          }
          if (participants.length < 2) {
            audit.record({
              actor: 'server',
              action: 'discussion.skipped',
              target: runId,
              detail: { reason: 'less_than_two_models' },
            });
            return;
          }

          const discussion = await runDiscussion({
            topic: buildDiscussionTopic(planToRun.goal, summary, verdict),
            rounds: 1,
            styleId: 'peer',
            participants,
          });
          const transcript = discussion.rounds
            .flatMap((round) =>
              round.messages.map((message) => `[第 ${round.round} 轮] ${message.name}（${message.model}）：${message.content}`)
            )
            .join('\n\n');
          canvasFor(runWorkspace).apply([
            {
              op: 'add_node',
              node: {
                id: `discussion-${runId.slice(0, 8)}`,
                type: 'artifact',
                position: { x: 140, y: 620 },
                data: {
                  kind: 'artifact',
                  name: `讨论 · 为什么没达标（${runId.slice(0, 6)}）`,
                  role: '领导层自动发起',
                  provider: '',
                  model: '',
                  effort: 'off',
                  status: 'idle',
                  accent: '#e0a458',
                  taskId: '',
                  output: transcript.slice(0, 4000),
                  acceptance: { pass: true, score: 1, reasons: ['AI 讨论'] },
                  metric: '自动',
                },
              },
            },
          ]);
          audit.record({
            actor: 'server',
            action: 'discussion.auto',
            target: runId,
            detail: { participants: participants.length, rounds: discussion.effectiveRounds },
          });
        } catch (error) {
          audit.record({
            actor: 'server',
            action: 'run.review_failed',
            target: runId,
            detail: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      })();

      // 自动续跑（长期项目）：失败或中断且还有没产出的任务 → 排下一次续跑，
      // 上限 2 轮（首跑 + 2 次重试），避免在注定失败的任务上无限烧钱。
      // 跨重启由启动补排负责；retryScheduled 已写进失败总结。
      if (finishedRecord?.autoResume && !finishedRecord.manualStop && event.status !== 'done') {
        if (willRetry) {
          audit.record({
            actor: 'server',
            action: 'run.auto_resume_scheduled',
            target: runId,
            detail: { depth: (finishedRecord.resumeDepth ?? 0) + 1, pending: pendingCount },
          });
          scheduleAutoResume(runId);
        } else if (pendingCount > 0) {
          audit.record({
            actor: 'server',
            action: 'run.auto_resume_exhausted',
            target: runId,
            detail: { depth: finishedRecord.resumeDepth ?? 0, pending: pendingCount },
          });
        }
      }
    });
    void orchestrator.run(planToRun).catch(() => {
      if (activeLiveRunId === runId) activeLiveRunId = null;
      store.append(runId, { type: 'run.finished', runId, status: 'failed' });
    });
  } else {
    const requestedPlan = body?.payload?.plan ?? demoPlan;
    const requestedGoal =
      typeof body?.payload?.goal === 'string' ? String(body.payload.goal).trim().slice(0, 500) : '';
    const plan = requestedGoal ? { ...requestedPlan, goal: requestedGoal } : requestedPlan;
    store.create(runId, String(plan.goal ?? 'demo'), workspaceOf(context), 'builtin');
    const controller = new AbortController();
    runAborts.set(runId, controller);

    const adapter = new DemoAdapter();
    const orchestrator = new Orchestrator({
      profiles: demoProfiles,
      adapters: { 'openai-chat': adapter, 'anthropic-messages': adapter },
      concurrency: 2,
      taskTimeoutMs: 60000,
      maxOutputTokens: 1024,
      budget,
      teamContext,
      signal: controller.signal,
      runId,
    });
    orchestrator.on((event) => {
      store.append(runId, redactRunEvent(event));
      if (event.type === 'run.finished') {
        runAborts.delete(runId);
        // 演示运行也落 deliverables：零成本地验收这条路径，且演示图同样有成果可拿。
        try {
          const snapshot = store.snapshot(runId);
          saveRunDeliverables({
            stateDir,
            workspaceId: workspaceOf(context),
            runId,
            goal: String(plan.goal ?? 'demo'),
            plan,
            outputs: snapshot?.outputs ?? {},
          });
          effects.mark(runId, 'deliverables');
        } catch {
          // 交付物失败不影响演示
        }
        effects.mark(runId, 'writeback');
      }
    });
    void orchestrator.run(plan).catch(() => {
      store.append(runId, { type: 'run.finished', runId, status: 'failed' });
    });
  }

  const response = { ok: true, runId, mode };
  idempotency.set(commandId, response);
  return context.json(response);
});

/**
 * 把一个任务的完整产出落成真实文件。画布的「存为文件」按钮直接调这里——
 * 之前前端调一个不存在的路由，按钮永远是 404。
 */
app.post('/api/deliverables/:taskId', async (context) => {
  const taskId = context.req.param('taskId');
  const body = (await context.req.json().catch(() => null)) as { runId?: string } | null;
  const ordered = body?.runId
    ? [store.get(body.runId)].filter((item): item is NonNullable<typeof item> => Boolean(item))
    : store.list().slice(0, 30).map((item) => store.get(item.runId)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const run = ordered.find((item) => String(item.outputs?.[taskId] ?? '').trim().length > 0);
  if (!run) return context.json({ error: 'run_or_task_not_found' }, 404);
  try {
    const files = saveRunDeliverables({
      stateDir,
      workspaceId: run.workspaceId ?? 'main',
      runId: run.runId,
      goal: run.goal,
      plan: run.plan,
      outputs: run.outputs,
    });
    const found = files.find((item) => item.taskId === taskId);
    if (!found) return context.json({ error: 'task_not_found' }, 404);
    audit.record({
      actor: actorOf(context),
      action: 'deliverable.save',
      target: run.runId,
      detail: { taskId, bytes: found.bytes },
    });
    return context.json({ ok: true, file: found.file, bytes: found.bytes });
  } catch (error) {
    return context.json(
      { error: redactSecrets(error instanceof Error ? error.message : String(error), []) },
      500
    );
  }
});

app.get('/api/runs', (context) => {
  const wanted = context.req.header('x-qiansi-workspace') ?? context.req.query('ws');
  const items = store.list();
  // 旧记录没有 workspaceId，视为主画布。
  const filtered = wanted
    ? items.filter((item) => (item.workspaceId ?? 'main') === workspaces.resolve(wanted).id)
    : items;
  return context.json({ items: filtered });
});

/**
 * Live snapshot of the run currently in flight, for any client that did not
 * start it — an agent driving the canvas through MCP, or a second window.
 * Task statuses are folded from the event log because the stored plan keeps
 * every subtask at `pending`.
 */
app.get('/api/runs/active', (context) => {
  // 任何来源的运行都算：画布发起、agent 触发、演示模式、接续会话的自动运行。
  // 只看 activeLiveRunId 会漏掉 demo 运行，界面就完全没有进度。
  const wanted = context.req.header('x-qiansi-workspace') ?? context.req.query('ws');
  const wsId = wanted ? workspaces.resolve(wanted).id : null;
  const belongs = (run: { workspaceId?: string }): boolean =>
    !wsId || (run.workspaceId ?? 'main') === wsId;

  const record =
    store.running().find((run) => belongs(run)) ??
    (activeLiveRunId && belongs(store.get(activeLiveRunId) ?? {}) ? store.get(activeLiveRunId) : undefined);

  const fold = (run: NonNullable<ReturnType<typeof store.get>>) => {
    const statuses = new Map<string, 'pending' | 'running' | 'done' | 'failed'>();
    for (const envelope of run.events) {
      const event = envelope.event as { type: string; taskId?: string };
      if (!event.taskId) continue;
      if (event.type === 'task.started') statuses.set(event.taskId, 'running');
      else if (event.type === 'task.completed') statuses.set(event.taskId, 'done');
      else if (event.type === 'task.failed') statuses.set(event.taskId, 'failed');
    }
    return (run.plan?.subtasks ?? []).map((task) => ({
      taskId: task.id,
      nodeId: task.assignedNodeId ?? null,
      title: task.title,
      effort: task.effort,
      status: statuses.get(task.id) ?? 'pending',
    }));
  };

  if (!record) {
    // 运行的最后一秒可能刚好在页面切走时结束：给出 30 秒内最近完成的一轮，
    // 客户端据此显示「刚刚完成」而不是一片空白。
    const recentRun = store.recentFinished(600_000);
    const finished = recentRun && belongs(recentRun) ? recentRun : undefined;
    if (!finished) return context.json({ ok: true, run: null, recent: null });
    return context.json({
      ok: true,
      run: null,
      recent: {
        runId: finished.runId,
        status: finished.status,
        goal: finished.goal,
        startedAt: finished.startedAt,
        finishedAt: finished.finishedAt ?? Date.now(),
        tokens: finished.usage?.total ?? 0,
        tasks: fold(finished),
        failureSummary: finished.failureSummary
          ? {
              ...finished.failureSummary,
              retryScheduled:
                Boolean(finished.failureSummary.retryScheduled) &&
                !store.hasResumedChild(finished.runId),
            }
          : null,
        attempt: (finished.resumeDepth ?? 0) + 1,
        maxAttempts: finished.autoResume ? 3 : 1,
      },
    });
  }

  const tasks = fold(record);

  return context.json({
    ok: true,
    run: {
      runId: record.runId,
      status: record.status,
      goal: record.goal,
      startedAt: record.startedAt,
      tokens: record.usage?.total ?? 0,
      tasks,
    },
  });
});

/**
 * The structured contract an agent (or a script) needs after starting a run:
 * did it finish, what did each task produce, where did the plan come from.
 */
app.get('/api/runs/:id/result', (context) => {
  const runId = context.req.param('id');
  const snapshot = store.snapshot(runId);
  if (!snapshot) return context.json({ error: 'not_found' }, 404);
  const outputs = (snapshot.outputs ?? {}) as Record<string, string>;
  const tasks = (snapshot.plan?.subtasks ?? []).map(
    (task: { id: string; title: string; assignedNodeId?: string; status?: string; acceptanceCriteria?: string }) => {
      const output = outputs[task.id] ?? '';
      // The stored plan is the one the engine was handed; its subtask statuses
      // are never mutated, so derive the real outcome from what came back.
      const status = output
        ? 'done'
        : snapshot.status === 'failed'
          ? 'failed'
          : snapshot.status === 'done'
            ? 'done'
            : 'pending';
      return {
        id: task.id,
        title: task.title,
        nodeId: task.assignedNodeId ?? null,
        status,
        acceptance: task.acceptanceCriteria ?? '',
        output,
        chars: output.length,
      };
    }
  );
  // 失败原因、第几次尝试、还会不会自动重试：界面用它在运行条上给出重试入口。
  // 失败总结是失败那一刻的快照：已经续跑过之后，「已排队重试」就不成立了。
  const failureSummary = snapshot.failureSummary
    ? {
        ...snapshot.failureSummary,
        retryScheduled:
          Boolean(snapshot.failureSummary.retryScheduled) && !store.hasResumedChild(runId),
      }
    : null;
  return context.json({
    ok: true,
    runId,
    status: snapshot.status,
    goal: snapshot.goal,
    planSource: runPlanSource.get(runId) ?? 'builtin',
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt ?? null,
    usage: snapshot.usage,
    mandate: snapshot.mandate ?? null,
    review: snapshot.review ?? null,
    failureSummary,
    attempt: (snapshot.resumeDepth ?? 0) + 1,
    maxAttempts: snapshot.autoResume ? 3 : 1,
    autoResume: Boolean(snapshot.autoResume),
    resumedFrom: snapshot.resumedFrom ?? null,
    tasks,
    canvasUrl: `/api/runs/${runId}/events`,
  });
});

app.get('/api/runs/:id/snapshot', (context) => {
  const snapshot = store.snapshot(context.req.param('id'));
  if (!snapshot) return context.json({ error: 'not_found' }, 404);
  return context.json(snapshot);
});

/* ── 失败诊断与主动重跑 ─────────────────────────────────────────────
 * 运行失败时，用户要能在一个地方看到「为什么失败、环境哪里坏了、现在能不能
 * 重跑」，并且直接修好环境后重跑。诊断只读；重跑走原有 /api/commands，
 * 与自动续跑共用一套次数上限和排队机制。
 */

function workspaceRootFor(workspaceId: string): { rootDir: string; source: 'workspace' | 'server' } {
  const configured = workspaces.get(workspaceId)?.rootDir?.trim();
  return configured
    ? { rootDir: resolve(configured), source: 'workspace' }
    : { rootDir: process.cwd(), source: 'server' };
}

/** 用户视角验收结果写成画布卡片：固定 id，多次验收原地更新。 */
function publishUserViewNode(workspaceId: string, report: UserViewReport): void {
  try {
    const store = canvasFor(workspaceId);
    const document = store.read();
    const id = 'user-view-report';
    const lines = [
      `结论：${report.summary}`,
      `项目：${report.kind} · ${report.url || report.rootDir}`,
      ...report.checks.map(
        (check) => `${check.ok ? '✓' : '✗'} ${check.label}${check.detail ? `：${check.detail}` : ''}`
      ),
      report.shots.length
        ? `截图：${report.shots.map((shot) => `${shot.label} ${shot.file}`).join('；')}`
        : '',
      '在运行条下方点「用户视角」可以看截图和逐项结果。',
    ].filter(Boolean);
    const patch = {
      kind: 'artifact',
      name: '用户视角验收',
      role: report.verdict === 'pass' ? '通过' : report.verdict === 'fail' ? '未通过' : '无法验收',
      provider: 'local',
      model: 'local',
      effort: 'off',
      status: report.verdict === 'pass' ? 'done' : 'failed',
      accent: report.verdict === 'pass' ? '#4ade80' : '#f87171',
      taskId: 'user-view',
      output: lines.join('\n').slice(0, 4000),
      artifact: report.summary,
      metric: report.verdict === 'pass' ? '通过' : '未通过',
    };
    const ops = document.nodes.some((node) => node.id === id)
      ? [{ op: 'update_node' as const, id, patch }]
      : [
          {
            op: 'add_node' as const,
            node: { id, type: 'artifact' as const, position: { x: 80, y: 640 }, data: patch },
          },
        ];
    store.apply(ops);
  } catch {
    // 展示失败不影响验收结果本身
  }
}

/**
 * 运行成功后自动做一次用户视角验收：项目能自动启动且画布设置了工作目录时，
 * 真的把项目跑起来看画面。payload.userView === false 可关闭。
 */
function maybeAutoUserView(workspaceId: string, runId: string): void {
  const root = workspaceRootFor(workspaceId);
  if (root.source !== 'workspace') return;
  const probe = detectProject(root.rootDir);
  if (!probe.runnable || probe.kind === 'electron') return;
  void runUserView({ rootDir: root.rootDir, workspaceId, runId, timeoutMs: 120000 })
    .then((report) => {
      publishUserViewNode(workspaceId, report);
      audit.record({
        actor: 'server',
        action: 'user-view.auto',
        target: runId,
        detail: {
          verdict: report.verdict,
          kind: report.kind,
          url: report.url,
          failed: report.checks.filter((check) => !check.ok).map((check) => check.name),
        },
      });
    })
    .catch(() => undefined);
}

app.get('/api/runs/:id/diagnosis', async (context) => {
  const runId = context.req.param('id');
  const record = store.get(runId);
  if (!record) return context.json({ ok: false, error: 'not_found' }, 404);
  const workspaceId = record.workspaceId ?? 'main';
  const root = workspaceRootFor(workspaceId);
  const probe = detectProject(root.rootDir);
  const diagnosis = await buildRunDiagnosis({
    record,
    workspaceId,
    rootDir: root.rootDir,
    rootDirSource: root.source,
    disabledSlots: readDisabledSlots(),
    keyReady: async (slot) => Boolean(await slotCredential(slot)),
    userViewAvailable: probe.runnable && probe.kind !== 'electron',
    activeRunId: activeLiveRunId,
    hasResumedChild: store.hasResumedChild(runId),
  });
  return context.json(diagnosis);
});

app.post('/api/runs/:id/rerun', async (context) => {
  const runId = context.req.param('id');
  const record = store.get(runId);
  if (!record) return context.json({ ok: false, error: 'run_not_found' }, 404);
  if (record.status === 'running') {
    return context.json({ ok: false, error: 'run_still_running' }, 409);
  }
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const mode = body?.mode === 'fresh' ? 'fresh' : 'resume';
  const workspaceId = record.workspaceId ?? workspaceOf(context);

  // 顺手修环境：给了 rootDir 就先存到画布上，重跑直接用新目录。
  if (body && typeof body.rootDir === 'string' && body.rootDir.trim()) {
    const updated = workspaces.setRootDir(workspaceId, body.rootDir.trim());
    if (!updated) return context.json({ ok: false, error: 'root_dir_invalid' }, 400);
  }
  if (!record.plan?.subtasks?.length) {
    return context.json(
      { ok: false, error: 'no_plan', hint: '这轮运行没有计划记录；请回到画布重新运行。' },
      400
    );
  }

  const payload: Record<string, unknown> = { mode: 'live', autoResume: true };
  if (mode === 'resume') payload.resumeOf = runId;
  else payload.goal = record.goal;

  let response: Response;
  try {
    response = await fetch(`${serverOrigin()}/api/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qiansi-token': token,
        'x-qiansi-workspace': workspaceId,
      },
      body: JSON.stringify({
        commandId: `rerun-${mode}-${runId}-${randomUUID()}`,
        type: 'run.start',
        payload,
      }),
    });
  } catch (error) {
    return context.json(
      { ok: false, error: 'rerun_request_failed', hint: error instanceof Error ? error.message : String(error) },
      502
    );
  }
  const data = (await response.json().catch(() => null)) as Record<string, any> | null;

  if (response.ok && data?.runId) {
    audit.record({
      actor: actorOf(context),
      action: 'run.rerun',
      target: runId,
      detail: { mode, newRunId: data.runId, workspaceId },
    });
    return context.json({ ok: true, runId: data.runId, mode, workspaceId });
  }

  // 已有运行在跑：排队，当前运行一结束自动开始。不让「重跑」本身也失败。
  if (data?.error === 'run_in_progress') {
    const queued = queueRun(workspaceId, record.goal, mode === 'resume' ? runId : undefined);
    audit.record({
      actor: actorOf(context),
      action: 'run.rerun.queued',
      target: runId,
      detail: { mode, queued },
    });
    return context.json({
      ok: true,
      queued,
      runId: null,
      mode,
      workspaceId,
      hint: queued ? '已排队：当前运行结束后自动开始。' : '同一种重跑已经在队列里了。',
    });
  }

  const missing = Array.isArray(data?.missing) ? data.missing : undefined;
  return context.json(
    {
      ok: false,
      error: data?.error ?? `HTTP ${response.status}`,
      missing,
      hint: data?.hint ?? undefined,
      reasons: data?.reasons ?? undefined,
    },
    (response.status >= 400 ? response.status : 502) as 502
  );
});

app.post('/api/user-view', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const runId = typeof body?.runId === 'string' && body.runId ? body.runId : null;
  const record = runId ? store.get(runId) : null;
  const workspaceId = record?.workspaceId ?? workspaceOf(context);
  const root = workspaceRootFor(workspaceId);
  const rootDir =
    typeof body?.rootDir === 'string' && body.rootDir.trim()
      ? resolve(body.rootDir.trim())
      : root.rootDir;
  const url = typeof body?.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
  const probe = detectProject(rootDir);
  if (!probe.runnable && !url) {
    return context.json(
      {
        ok: false,
        error: 'project_not_runnable',
        kind: probe.kind,
        reason: probe.reason,
        rootDir,
        hint: '给画布设置一个能启动的工作目录，或传入已经在运行的 url。',
      },
      422
    );
  }
  const report = await runUserView({ rootDir, workspaceId, runId, url });
  publishUserViewNode(workspaceId, report);
  audit.record({
    actor: actorOf(context),
    action: 'user-view.check',
    target: workspaceId,
    detail: {
      verdict: report.verdict,
      kind: report.kind,
      rootDir: report.rootDir,
      failed: report.checks.filter((check) => !check.ok).map((check) => check.name),
    },
  });
  return context.json({ ok: report.ok, report });
});

app.get('/api/user-view/latest', (context) => {
  const wanted = context.req.header('x-qiansi-workspace') ?? context.req.query('ws');
  const workspaceId = wanted ? workspaces.resolve(wanted).id : null;
  return context.json({ ok: true, report: latestUserView(workspaceId) });
});

app.get('/api/user-view/:id', (context) => {
  const report = readUserView(context.req.param('id'));
  if (!report) return context.json({ ok: false, error: 'not_found' }, 404);
  return context.json({ ok: true, report });
});

app.get('/api/user-view/:id/shot/:label', (context) => {
  const id = context.req.param('id');
  const label = context.req.param('label');
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return context.json({ error: 'bad_id' }, 400);
  if (label !== 'desktop' && label !== 'mobile') return context.json({ error: 'bad_label' }, 400);
  const file = userViewShotFile(id, label);
  if (!existsSync(file)) return context.json({ error: 'not_found' }, 404);
  return new Response(new Uint8Array(readFileSync(file)), {
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
  });
});

app.get('/api/runs/:id/events', async (context) => {
  const runId = context.req.param('id');
  const record = store.get(runId);
  if (!record) return context.json({ error: 'not_found' }, 404);

  const last = Number(context.req.header('last-event-id') ?? context.req.query('lastEventId') ?? 0) || 0;

  return streamSSE(context, async (stream) => {
    let closed = false;
    const send = async (envelope: RunEnvelope) => {
      if (closed) return;
      await stream.writeSSE({
        id: String(envelope.seq),
        event: envelope.event.type,
        data: JSON.stringify(envelope),
      });
    };

    for (const envelope of record.events) {
      if (envelope.seq > last) await send(envelope);
    }

    if (record.status !== 'running') {
      await stream.writeSSE({ event: 'end', data: '{}' });
      return;
    }

    const unsubscribe = store.subscribe(runId, (envelope) => {
      void send(envelope);
    });
    const heartbeat = setInterval(() => {
      if (!closed) void stream.writeSSE({ event: 'heartbeat', data: '{}' });
    }, 15000);

    stream.onAbort(() => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>(() => {});
  });
});

app.use('/v1/*', async (context, next) => {
  const authorization = context.req.header('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const header =
    context.req.header('x-qiansi-token') ?? context.req.header('x-agentweave-token');
  if (bearer !== token && header !== token) {
    return context.json({ error: { message: 'unauthorized', type: 'auth_error' } }, 401);
  }
  const admission = policy.admit(actorOf(context), 'gateway.use');
  if (!admission.allowed) {
    audit.record({
      actor: actorOf(context),
      action: 'policy.denied',
      target: context.req.path,
      detail: { scope: 'gateway.use', reason: admission.reason },
    });
    return context.json(
      { error: { message: `not_admitted: ${admission.reason}`, type: 'auth_error' } },
      403
    );
  }
  return next();
});

app.get('/v1/models', (context) =>
  context.json({
    object: 'list',
    data: gatewayModels.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.slot,
      label: model.label,
    })),
  })
);

app.post('/v1/chat/completions', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const modelId = String(body?.model ?? '');
  await ensureQuotaSeeded();
  const resolution = await resolveGatewayModel(modelId, vault, (slot) => quota.pick(slot));

  if (!resolution) {
    return context.json(
      { error: { message: `unknown model: ${modelId}`, type: 'invalid_request_error' } },
      404
    );
  }
  if (!resolution.apiKey) {
    return context.json(
      {
        error: {
          message: `no credential for ${resolution.model.keyRef}; add it to the vault`,
          type: 'auth_error',
        },
      },
      503
    );
  }

  const usageCheck = gatewayUsage.check();
  if (!usageCheck.ok) {
    return context.json(
      {
        error: {
          message: `gateway tokens/min ${usageCheck.perMinute} exceeded`,
          type: 'rate_limit_error',
        },
      },
      429
    );
  }

  const messages = toNormalizedMessages(
    Array.isArray(body?.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  );
  const maxTokens = Math.min(
    Number(body?.max_tokens ?? 1024) || 1024,
    resolution.profile.maxOutput
  );
  const request = buildChatRequest(resolution.profile, messages, 'medium', {
    apiKey: resolution.apiKey,
    maxTokens,
  });
  // OpenAI-compatible clients can opt in with `"web_search": true` (or the
  // namespaced form). Off by default: search is a network action.
  const wantsSearch = body?.web_search === true || body?.qiansi_web_search === true;
  const adapter = wantsSearch
    ? new SearchToolAdapter(resolution.adapter, { search: webSearch.search })
    : resolution.adapter;

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const stream = Boolean(body?.stream);
  const sessionId =
    context.req.header('x-qiansi-session') ??
    context.req.header('x-agentweave-session') ??
    `session-${randomUUID()}`;
  const agent =
    context.req.header('x-qiansi-agent') ??
    context.req.header('x-agentweave-agent') ??
    'external-agent';
  const purpose =
    context.req.header('x-qiansi-purpose') ??
    context.req.header('x-agentweave-purpose') ??
    modelId;

  if (!stream) {
    let text = '';
    let input = 0;
    let output = 0;
    for await (const event of adapter.stream(request)) {
      if (event.type === 'text-delta') text += event.text;
      else if (event.type === 'usage') {
        input += event.input;
        output += event.output;
      } else if (event.type === 'error') {
        return context.json(
          { error: { message: event.message, type: 'upstream_error' } },
          502
        );
      }
    }
    gatewayUsage.add(input + output);
    quota.record({
      slot: resolution.model.slot,
      keyId: resolution.keyId,
      model: modelId,
      tokens: input + output,
      source: 'gateway',
    });
    recordExternalCall({
      sessionId,
      agent,
      purpose,
      model: modelId,
      output: text,
      inputTokens: input,
      outputTokens: output,
    });
    return context.json({
      id,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    });
  }

  return streamSSE(context, async (stream) => {
    let text = '';
    let input = 0;
    let output = 0;
    for await (const event of adapter.stream(request)) {
      if (event.type === 'text-delta') {
        text += event.text;
        await stream.writeSSE({
          data: JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
          }),
        });
      } else if (event.type === 'usage') {
        input += event.input;
        output += event.output;
      } else if (event.type === 'error') {
        await stream.writeSSE({
          data: JSON.stringify({
            error: { message: event.message, type: 'upstream_error' },
          }),
        });
        break;
      }
    }
    gatewayUsage.add(input + output);
    quota.record({
      slot: resolution.model.slot,
      keyId: resolution.keyId,
      model: modelId,
      tokens: input + output,
      source: 'gateway',
    });
    recordExternalCall({
      sessionId,
      agent,
      purpose,
      model: modelId,
      output: text,
      inputTokens: input,
      outputTokens: output,
    });
    await stream.writeSSE({
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
      }),
    });
    await stream.writeSSE({ data: '[DONE]' });
  });
});

// 优先仓库内的构建产物：VS Code 扩展会把 QIANSI_STUDIO_DIR 指到它安装时的副本，
// 那份副本会越来越旧，用户于是看到几个月前的界面。
const studioCandidates = [
  join(process.cwd(), 'apps', 'studio', 'dist'),
  join(process.cwd(), '..', 'studio', 'dist'),
  process.env.QIANSI_STUDIO_DIR,
].filter((item): item is string => Boolean(item));
const studioDir = studioCandidates.find((item) => existsSync(join(item, 'index.html'))) ?? studioCandidates[0]!;

// Anything under /api or /v1 that no route claimed is a 404 JSON, never the SPA.
// This must sit before the static catch-all, which would otherwise swallow it.
app.all('/api/*', (context) =>
  context.json({ error: 'not_found', path: context.req.path }, 404)
);
app.all('/v1/*', (context) =>
  context.json({ error: { message: 'not_found', type: 'not_found_error' } }, 404)
);

if (existsSync(join(studioDir, 'index.html'))) {
  app.use('/*', serveStatic({ root: studioDir }));
  app.get('*', serveStatic({ root: studioDir, path: 'index.html' }));
}

app.notFound((context) => context.text('not found', 404));

/**
 * 启动补投（Outbox）：上次进程死在「运行结束、副作用未做」之间时，按账本把
 * 回写与交付物补一遍。两者皆幂等，重复执行不会产生重复内容。
 */
function repairPendingEffects(): void {
  let repaired = 0;
  for (const item of store.list().slice(0, 100)) {
    const record = store.get(item.runId);
    if (!record || !record.planSource || !record.finishedAt || !record.plan) continue;
    const kinds: Array<'writeback' | 'deliverables'> =
      record.planSource === 'canvas' ? ['writeback', 'deliverables'] : ['deliverables'];
    const missing = effects.missing(record.runId, kinds);
    if (!missing.length) continue;
    const workspaceId = record.workspaceId ?? 'main';
    try {
      if (missing.includes('writeback')) {
        writeRunArtifacts(
          canvasFor(workspaceId),
          record.plan,
          record.outputs ?? {},
          record.status !== 'done'
        );
      }
      if (missing.includes('deliverables')) {
        saveRunDeliverables({
          stateDir,
          workspaceId,
          runId: record.runId,
          goal: record.goal,
          plan: record.plan,
          outputs: record.outputs ?? {},
        });
      }
      for (const kind of missing) effects.mark(record.runId, kind);
      repaired += 1;
    } catch {
      // 失败的补投下次启动再试（账本仍未记账）
    }
  }
  if (repaired > 0) {
    audit.record({ actor: 'server', action: 'effects.repair', detail: { runs: repaired } });
    console.log(`[qiansi] repaired side effects for ${repaired} run(s)`);
  }
}

repairPendingEffects();

// 启动补排：被上次进程中断、且带自动续跑意图的运行，开机后自己接着跑。
for (const runId of interruptedRuns) {
  const record = store.get(runId);
  if (record?.autoResume && (record.resumeDepth ?? 0) < 2) {
    audit.record({
      actor: 'server',
      action: 'run.auto_resume_scheduled',
      target: runId,
      detail: { depth: (record.resumeDepth ?? 0) + 1, reason: 'boot_recovery' },
    });
    scheduleAutoResume(runId, 8000);
  }
}

const port = Number(process.env.QIANSI_PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  boundPort = info.port;
  console.log(`[qiansi] server http://127.0.0.1:${info.port}`);
  // The packaged desktop app picks a free port, so agents cannot assume 8787.
  // Publishing the live port here is what lets the MCP server and hooks find us.
  try {
    writeFileSync(join(stateDir, 'server-port'), String(info.port), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // a read-only state dir is not fatal: agents fall back to QIANSI_URL/8787
  }
  if (process.env.QIANSI_TOKEN) {
    console.log('[qiansi] token from QIANSI_TOKEN');
  } else {
    console.log(`[qiansi] token file: ${tokenPath}`);
  }
});
