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
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  AnthropicMessagesAdapter,
  OpenAIChatAdapter,
  Orchestrator,
  buildChatRequest,
  probeConnection,
  redactSecrets,
  type CapabilityProfile,
  type Protocol,
} from '@qiansi/engine';
import { AuditLog } from './audit.js';
import {
  CanvasConflict,
  CanvasStore,
  canvasSummary,
  canvasSvg,
  writeRunArtifacts,
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
import { QuotaStore } from './quota.js';
import { substituteExhausted } from './quota-plan.js';
import { part, summarize, type HealthPart, type StatusReport } from './status.js';
import { RunStore, type RunEnvelope } from './store.js';
import { ensureStateDir } from './state-dir.js';
import { DpapiVault } from './vault.js';
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
  return (changed ? next : record) as unknown as T;
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
const canvasStore = new CanvasStore(stateDir);
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
    const document = canvasStore.read();
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
  setTimeout(() => process.exit(0), 150);
  return context.json({ ok: true, stopping: true, manuallyStopped: true });
});

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
async function keysSnapshot() {
  await ensureQuotaSeeded();
  return modelFamilies().map((family) => ({
    ...quota.view(family.slot, family.label),
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
    quota.addKey(slot, { id, label, vaultRef, quota: readQuotaInput(body?.quota) });
  } catch (error) {
    return context.json(
      { ok: false, error: error instanceof Error ? error.message : 'add_failed' },
      409
    );
  }
  audit.record({ actor: actorOf(context), action: 'keys.add', target: `${slot}/${id}` });
  return context.json({ ok: true, id, vaultRef, slots: await keysSnapshot() });
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
        timeoutMs: 45000,
      }
    );
    return context.json({ ok: true, ...result });
  } catch (error) {
    return context.json(
      { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error), []) },
      502
    );
  }
});

app.post('/api/discuss', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const topic = String(body?.topic ?? '').trim().slice(0, 2000);
  const fileContext = String(body?.context ?? '').trim().slice(0, 4000);
  const rounds = Math.min(Math.max(Number(body?.rounds ?? 2) || 2, 1), 3);
  const participants = (Array.isArray(body?.participants) ? body.participants : [])
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

  const history: Array<{ name: string; model: string; content: string }> = [];
  const transcript: Array<{ round: number; messages: typeof history }> = [];
  // Keep one discussion under eight model calls so a bad key or slow provider
  // cannot pin the request for minutes.
  const effectiveRounds = Math.min(
    rounds,
    Math.max(1, Math.floor(8 / Math.max(participants.length, 1)))
  );
  try {
    for (let round = 1; round <= effectiveRounds; round += 1) {
      const roundMessages: typeof history = [];
      for (const participant of participants) {
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
                  '你正在参加一场多 AI 讨论。直接给出观点，引用或反驳前面发言者的具体内容；不要复述主题，不要使用客套话。控制在 300 字以内。',
              },
              {
                role: 'user',
                content: `讨论主题：${topic}\n\n${fileContext ? `文件上下文：\n${fileContext}\n\n` : ''}已有发言：\n${prior}\n\n现在轮到你（${participant.name}，模型 ${participant.model}）发言。`,
              },
            ],
            { maxTokens: 500, timeoutMs: 40000 }
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
    return context.json({
      ok: true,
      rounds: transcript,
      requestedRounds: rounds,
      effectiveRounds,
    });
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
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('layout_output_unparseable');
    const parsed = JSON.parse(match[0]) as { levels?: Record<string, unknown> };
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
    .filter((item: any) => item.connectionId);
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
    const result = await completeChat(
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
            '你是多 AI 工作流的编排器。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
        },
        {
          role: 'user',
          content: `用户目标：${goal}

可用模型：${JSON.stringify(models)}
${fileContext ? `\n用户上传的文件（名称与内容预览）：\n${fileContext}\n` : ''}
请设计一个 3–5 个节点的工作流，并只输出：
{"summary":"一句中文概述","nodes":[{"id":"n1","name":"研究员","role":"要做什么","connectionId":"从上面选择","effort":"low|medium|high"}],"edges":[{"source":"orchestrator","target":"n1","kind":"assign","label":"任务 · 调研"}]}

规则：
1. 主控节点 id 固定为 "orchestrator"，不需要出现在 nodes 里；
2. connectionId 必须是上面列表中的值；
3. 每个工作节点至少有一条来自 orchestrator 的 assign 边；
4. 有依赖的节点之间加 handoff 边，需要验收的加 review 边；
5. effort 按任务复杂度选择；
6. 节点名称、角色用中文，简洁具体。`,
        },
      ],
      { maxTokens: 1400, timeoutMs: 60000 }
    );

    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('workflow_output_unparseable');
    const parsed = JSON.parse(match[0]) as {
      summary?: string;
      nodes?: Array<Record<string, any>>;
      edges?: Array<Record<string, any>>;
    };

    const allowedConnections = new Set(models.map((item: any) => item.connectionId));
    const effortValues = new Set(['off', 'low', 'medium', 'high', 'max']);
    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
      .slice(0, 6)
      .map((item: any, index: number) => {
        const connectionId = String(item?.connectionId ?? '');
        return {
          id: String(item?.id ?? `n${index + 1}`).replace(/[^\w-]/g, '').slice(0, 24) || `n${index + 1}`,
          name: String(item?.name ?? `节点 ${index + 1}`).slice(0, 40),
          role: String(item?.role ?? '执行子任务').slice(0, 160),
          connectionId: allowedConnections.has(connectionId)
            ? connectionId
            : models[index % models.length].connectionId,
          effort: effortValues.has(String(item?.effort)) ? String(item?.effort) : 'medium',
        };
      });
    if (nodes.length === 0) throw new Error('workflow_nodes_missing');

    const ids = new Set(['orchestrator', ...nodes.map((node: any) => node.id)]);
    const kinds = new Set(['assign', 'handoff', 'review', 'context']);
    const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
      .slice(0, 14)
      .filter((item: any) => ids.has(String(item?.source)) && ids.has(String(item?.target)))
      .map((item: any, index: number) => ({
        id: `wf-e${index + 1}`,
        source: String(item.source),
        target: String(item.target),
        kind: kinds.has(String(item?.kind)) ? String(item.kind) : 'assign',
        label: String(item?.label ?? '任务').slice(0, 40),
      }));

    return context.json({
      ok: true,
      workflow: {
        summary: String(parsed.summary ?? goal).slice(0, 200),
        nodes,
        edges,
      },
    });
  } catch (error) {
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

app.get('/api/canvas', (context) => {
  const document = canvasStore.read();
  const exists = existsSync(join(stateDir, 'canvas.json'));
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
    const document = canvasStore.write({
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
  const summary = canvasSummary(canvasStore.read());
  return context.body(summary, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
});

app.get('/api/canvas/svg', (context) => {
  const svg = canvasSvg(canvasStore.read());
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
  const document = canvasStore.read();
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
  try {
    const result = canvasStore.apply(ops);
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
    maxTotalTokens: Number(requestedBudget.maxTotalTokens ?? 200000),
    maxTokensPerModel: Number(requestedBudget.maxTokensPerModel ?? 100000),
    // 20k/min was sized for short chat tasks; one thinking-model attempt with a
    // real document pack blows through it and kills the whole run mid-flight.
    maxTokensPerMinute: Number(requestedBudget.maxTokensPerMinute ?? 60000),
    maxCallsPerTask: Number(requestedBudget.maxCallsPerTask ?? 4),
  };

  const orchestratorId = String(body?.payload?.orchestratorId ?? '');
  const team = Array.isArray(body?.payload?.team)
    ? (body.payload.team as Array<Record<string, unknown>>).slice(0, 20)
    : [];
  const teamContext = team
    .filter((member) => member && member.name)
    .map(
      (member) =>
        `- ${member.id === orchestratorId ? '[主控] ' : ''}${String(member.name)} (${String(
          member.role ?? ''
        )}): ${String(member.provider ?? '')}/${String(member.model ?? '')}, effort ${String(
          member.effort ?? ''
        )}`
    )
    .join('\n');

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
    const canvasDocument = canvasStore.read();
    const canvasFiles = collectCanvasFiles(canvasDocument, stateDir);
    const allowDemoFallback = body?.payload?.allowDemoFallback === true;
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

    const profilesToRun = canvasPlan?.profiles ?? liveProfiles;
    const planSource: 'canvas' | 'builtin' = canvasPlan ? 'canvas' : 'builtin';
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
    const routerPick =
      orchestratorModel &&
      isCheapModel(orchestratorModel) &&
      orchestratorSlot &&
      keyBySlot[orchestratorSlot]
        ? { slot: orchestratorSlot, model: orchestratorModel }
        : routerChoice(keyBySlot);

    const basePlan = canvasPlan?.plan ?? liveRunPlan;
    const baseRationale = routerPick
      ? `${basePlan.rationale ?? ''} 分派闸门：${routerPick.model}（只判定明显通过，拿不准交给完整评委）。`.trim()
      : basePlan.rationale;

    /**
     * Quota preflight: a lane whose family is out of budget moves to the
     * cheapest family that still has some, before the run starts rather than
     * failing halfway with a 429.
     */
    const slotByProfile =
      canvasPlan?.slotByProfile ??
      new Map(profilesToRun.map((profile) => [profile.id, familyOf(profile.model)?.slot ?? 'relay']));
    const substitutions = substituteExhausted({
      plan: basePlan,
      profiles: profilesToRun,
      slotByProfile,
      hasKey: (slot) => Boolean(keyBySlot[slot]),
      headroom: (slot) => quota.headroom(slot),
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
        substitutions: substitutions.length
          ? substitutions.map((item) => `${item.taskId}:${item.fromSlot}->${item.toSlot}`)
          : undefined,
        keys: keyIdBySlot,
      },
    });

    store.create(runId, planToRun.goal);
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
    if (canvasPlan) {
      for (const profile of canvasPlan.profiles) {
        const slot = canvasPlan.slotByProfile.get(profile.id);
        apiKeys[profile.id] = slot ? keyBySlot[slot] : relayKey;
      }
    }
    const controller = new AbortController();
    runAborts.set(runId, controller);

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
      accept: createRoutedJudge({
        router: routerPick
          ? {
              profile: profileForModel(routerPick.model, '分派闸门'),
              apiKey: keyBySlot[routerPick.slot],
            }
          : undefined,
        full: {
          profile: liveProfiles.find((profile) => profile.id === 'live-sonnet')!,
          apiKey: relayKey,
        },
        teamContext,
        onUsage: (usage) => {
          const slot =
            usage.stage === 'full' ? 'relay' : familyOf(usage.model)?.slot ?? 'relay';
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
      audit.record({
        actor: 'server',
        action: 'run.gates',
        target: runId,
        detail: { ...gateCounts, router: routerPick?.model ?? null },
      });
      if (planSource !== 'canvas') return;
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
        return;
      }
      // No studio window is necessarily open when an agent starts a run, so the
      // server is the one that puts the artifacts back on the board.
      const snapshot = store.snapshot(runId);
      const applied = writeRunArtifacts(
        canvasStore,
        planToRun,
        snapshot?.outputs ?? {},
        event.status !== 'done'
      );
      if (applied > 0) {
        audit.record({
          actor: 'server',
          action: 'canvas.writeback',
          target: runId,
          detail: { nodes: applied, status: event.status },
        });
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
    store.create(runId, String(plan.goal ?? 'demo'));
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
      if (event.type === 'run.finished') runAborts.delete(runId);
    });
    void orchestrator.run(plan).catch(() => {
      store.append(runId, { type: 'run.finished', runId, status: 'failed' });
    });
  }

  const response = { ok: true, runId, mode };
  idempotency.set(commandId, response);
  return context.json(response);
});

app.get('/api/runs', (context) => context.json({ items: store.list() }));

/**
 * Live snapshot of the run currently in flight, for any client that did not
 * start it — an agent driving the canvas through MCP, or a second window.
 * Task statuses are folded from the event log because the stored plan keeps
 * every subtask at `pending`.
 */
app.get('/api/runs/active', (context) => {
  if (!activeLiveRunId) return context.json({ ok: true, run: null });
  const record = store.get(activeLiveRunId);
  if (!record) return context.json({ ok: true, run: null });

  const statuses = new Map<string, 'pending' | 'running' | 'done' | 'failed'>();
  for (const envelope of record.events) {
    const event = envelope.event as { type: string; taskId?: string };
    if (!event.taskId) continue;
    if (event.type === 'task.started') statuses.set(event.taskId, 'running');
    else if (event.type === 'task.completed') statuses.set(event.taskId, 'done');
    else if (event.type === 'task.failed') statuses.set(event.taskId, 'failed');
  }

  const tasks = (record.plan?.subtasks ?? []).map((task) => ({
    taskId: task.id,
    nodeId: task.assignedNodeId ?? null,
    title: task.title,
    effort: task.effort,
    status: statuses.get(task.id) ?? 'pending',
  }));

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
    tasks,
    canvasUrl: `/api/runs/${runId}/events`,
  });
});

app.get('/api/runs/:id/snapshot', (context) => {
  const snapshot = store.snapshot(context.req.param('id'));
  if (!snapshot) return context.json({ error: 'not_found' }, 404);
  return context.json(snapshot);
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
    for await (const event of resolution.adapter.stream(request)) {
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
    for await (const event of resolution.adapter.stream(request)) {
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

const studioDir =
  process.env.QIANSI_STUDIO_DIR ?? join(process.cwd(), '..', 'studio', 'dist');

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
