import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
import { DemoAdapter, demoPlan, demoProfiles } from './demo.js';
import { completeChat, type ChatConnection } from './chat.js';
import { gatewayModels, GatewayUsage, resolveGatewayModel, toNormalizedMessages } from './gateway.js';
import { createLiveJudge, livePlan, liveProfiles } from './live.js';
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
const tokenPath = join(stateDir, 'server-token');
const token =
  process.env.QIANSI_TOKEN ?? process.env.AGENTWEAVE_TOKEN ?? randomBytes(24).toString('hex');
if (!process.env.QIANSI_TOKEN && !process.env.AGENTWEAVE_TOKEN) {
  writeFileSync(tokenPath, token, { mode: 0o600 });
}

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
  if (cookie !== token && header !== token) {
    return context.json({ error: 'unauthorized' }, 401);
  }
  return next();
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
  return context.json({ ok: true });
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

app.post('/api/vault/set', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const ref = String(body?.ref ?? '').trim();
  const value = String(body?.value ?? '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(ref) || !value) {
    return context.json({ error: 'ref_and_value_required' }, 400);
  }
  await vault.set(ref, value);
  return context.json({ ok: true, ref });
});

app.post('/api/vault/remove', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
  const ref = String(body?.ref ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(ref)) {
    return context.json({ error: 'invalid_ref' }, 400);
  }
  await vault.remove(ref);
  return context.json({ ok: true, ref });
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
  const file = join(stateDir, 'canvas.json');
  if (!existsSync(file)) return context.json({ ok: true, canvas: null });
  try {
    return context.json({ ok: true, canvas: JSON.parse(readFileSync(file, 'utf8')) });
  } catch {
    return context.json({ ok: true, canvas: null });
  }
});

app.put('/api/canvas', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return context.json({ error: 'nodes_and_edges_required' }, 400);
  }
  const payload = JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    orchestratorId: String(body.orchestratorId ?? ''),
    nodes: body.nodes.slice(0, 300),
    edges: body.edges.slice(0, 600),
  });
  if (payload.length > 5 * 1024 * 1024) {
    return context.json({ error: 'canvas_too_large' }, 413);
  }
  const file = join(stateDir, 'canvas.json');
  const temp = join(stateDir, 'canvas.json.tmp');
  writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
  return context.json({ ok: true });
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
    const runId = String(body?.payload?.runId ?? '');
    const controller = runAborts.get(runId);
    if (!controller) {
      return context.json({ error: 'run_not_found' }, 404);
    }
    controller.abort();
    const response = { ok: true, runId, stopped: true };
    idempotency.set(commandId, response);
    return context.json(response);
  }

  if (body?.type !== 'run.start') {
    return context.json({ error: 'unsupported_command' }, 400);
  }

  const runId = randomUUID();
  const mode = body?.payload?.mode === 'live' ? 'live' : 'demo';
  const requestedBudget = (body?.payload?.budget ?? {}) as Record<string, unknown>;
  const budget = {
    maxTotalTokens: Number(requestedBudget.maxTotalTokens ?? 200000),
    maxTokensPerModel: Number(requestedBudget.maxTokensPerModel ?? 100000),
    maxTokensPerMinute: Number(requestedBudget.maxTokensPerMinute ?? 20000),
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
    const credentials = (body?.payload?.credentials ?? {}) as Record<string, string | undefined>;
    const vaultDeepseek = await vault.get('conn-deepseek');
    const vaultMinimax = await vault.get('conn-minimax');
    const vaultRelay = await vault.get('conn-claude-relay');
    const deepseekKey = String(credentials.deepseek ?? vaultDeepseek ?? process.env.DEEPSEEK_API_KEY ?? '');
    const minimaxKey = String(credentials.minimax ?? vaultMinimax ?? process.env.MINIMAX_API_KEY ?? '');
    const relayKey = String(credentials.relay ?? vaultRelay ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '');

    const missing: string[] = [];
    if (!deepseekKey) missing.push('deepseek');
    if (!minimaxKey) missing.push('minimax');
    if (!relayKey) missing.push('relay');
    if (missing.length > 0) {
      return context.json({ error: 'live_mode_missing_credentials', missing }, 503);
    }

    store.create(runId, livePlan.goal);
    const apiKeys: Record<string, string> = {
      'live-deepseek': deepseekKey,
      'live-minimax': minimaxKey,
      'live-sonnet': relayKey,
      'live-opus': relayKey,
      'live-haiku': relayKey,
    };
    const controller = new AbortController();
    runAborts.set(runId, controller);

    const orchestrator = new Orchestrator({
      profiles: liveProfiles,
      adapters: {
        'openai-chat': new OpenAIChatAdapter(),
        'anthropic-messages': new AnthropicMessagesAdapter(),
      },
      apiKeys,
      concurrency: 1,
      maxRetries: 1,
      taskTimeoutMs: 45000,
      maxOutputTokens: 512,
      budget,
      teamContext,
      signal: controller.signal,
      runId,
      accept: createLiveJudge(relayKey, teamContext),
    });
    orchestrator.on((event) => {
      store.append(runId, event);
      if (event.type === 'run.finished') runAborts.delete(runId);
    });
    void orchestrator.run(livePlan).catch(() => {
      store.append(runId, { type: 'run.finished', runId, status: 'failed' });
    });
  } else {
    const plan = body?.payload?.plan ?? demoPlan;
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
      store.append(runId, event);
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
  return next();
});

app.get('/v1/models', (context) =>
  context.json({
    object: 'list',
    data: gatewayModels.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: 'qiansi',
    })),
  })
);

app.post('/v1/chat/completions', async (context) => {
  const body = (await context.req.json().catch(() => null)) as Record<string, any> | null;
  const modelId = String(body?.model ?? '');
  const resolution = await resolveGatewayModel(modelId, vault);

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

if (existsSync(join(studioDir, 'index.html'))) {
  app.use('/*', serveStatic({ root: studioDir }));
  app.get('*', serveStatic({ root: studioDir, path: 'index.html' }));
}

const port = Number(process.env.QIANSI_PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`[qiansi] server http://127.0.0.1:${info.port}`);
  if (process.env.QIANSI_TOKEN) {
    console.log('[qiansi] token from QIANSI_TOKEN');
  } else {
    console.log(`[qiansi] token file: ${tokenPath}`);
  }
});
