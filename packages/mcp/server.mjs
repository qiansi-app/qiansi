#!/usr/bin/env node
/**
 * Qiansi MCP server (stdio, zero dependencies).
 *
 * Tools:
 *   list_models          list the model pool exposed by the local gateway
 *   call_model           call a subordinate model through the gateway
 *   get_usage            token usage and pending approvals
 *   request_approval     ask the human to approve a risky action
 *   describe_canvas      compact text view of the canvas (start here)
 *   get_canvas           full canvas JSON
 *   get_canvas_svg       canvas as a standalone SVG
 *   add_node             add a model/task/artifact node
 *   update_node          patch a node's data
 *   connect_nodes        wire two nodes (assign | handoff | review | context)
 *   remove_node          delete a node and its edges
 *   set_orchestrator     choose which node is the main model
 *   adapt_canvas         make THIS session the orchestrator and prepare a run
 *   run_canvas           start one orchestration run from the canvas
 *   get_run_result       structured per-task result of a run
 *
 * Resources:
 *   qiansi://canvas          full canvas JSON
 *   qiansi://canvas/summary  text summary
 *   qiansi://canvas.svg      SVG diagram, rendered inline by Claude Code
 *
 * Configure in Claude Code:
 *   claude mcp add qiansi -- node <repo>/packages/mcp/server.mjs
 *
 * Token: QIANSI_TOKEN or ~/.qiansi/server-token
 * Base URL: QIANSI_URL (default http://127.0.0.1:8787)
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The packaged desktop app picks a free port on every launch and publishes it to
 * ~/.qiansi/server-port. Resolve the URL per request so a restart on a different
 * port never leaves the agent pointing at a dead one.
 */
function readPort() {
  for (const dir of ['.qiansi', '.agentweave']) {
    try {
      const value = Number(readFileSync(join(homedir(), dir, 'server-port'), 'utf8').trim());
      if (Number.isInteger(value) && value > 0 && value < 65536) return value;
    } catch {
      // try the next location
    }
  }
  return 8787;
}

function baseUrl() {
  const fixed = process.env.QIANSI_URL ?? process.env.AGENTWEAVE_URL;
  return (fixed ?? `http://127.0.0.1:${readPort()}`).replace(/\/+$/, '');
}
const sessionId = randomUUID();
const agent = process.env.QIANSI_AGENT ?? process.env.AGENTWEAVE_AGENT ?? 'claude-code';

function readToken() {
  if (process.env.QIANSI_TOKEN) return process.env.QIANSI_TOKEN;
  if (process.env.AGENTWEAVE_TOKEN) return process.env.AGENTWEAVE_TOKEN;
  for (const dir of ['.qiansi', '.agentweave']) {
    try {
      return readFileSync(join(homedir(), dir, 'server-token'), 'utf8').trim();
    } catch {
      // try the next location
    }
  }
  return '';
}

function serverVersion() {
  try {
    const root = new URL('../../package.json', import.meta.url);
    return JSON.parse(readFileSync(root, 'utf8')).version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function headers(extra = {}) {
  // Read per request: the app rewrites server-token on every launch, so a token
  // cached at MCP startup goes stale the first time the user restarts Qiansi.
  const token = readToken();
  return {
    authorization: `Bearer ${token}`,
    'x-qiansi-token': token,
    'x-agentweave-token': token,
    'x-qiansi-session': sessionId,
    'x-agentweave-session': sessionId,
    'x-qiansi-agent': agent,
    'x-agentweave-agent': agent,
    'content-type': 'application/json',
    ...extra,
  };
}

const offline = () =>
  new Error(
    `连不上牵丝本地服务 ${baseUrl()}。请先打开牵丝应用（或运行 npm run dev:server 后再试）。`
  );

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...options,
      headers: headers(options.headers),
    });
  } catch {
    throw offline();
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const reason = Array.isArray(data.reasons) ? `（${data.reasons.join('；')}）` : '';
    throw new Error(
      `HTTP ${response.status}: ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error ?? data)}${reason}`
    );
  }
  return data;
}

async function requestText(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...options,
      headers: headers(options.headers),
    });
  } catch {
    throw offline();
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

const RESOURCES = [
  {
    uri: 'qiansi://canvas',
    name: 'Qiansi canvas',
    description: 'The full canvas document: nodes, edges, orchestrator and revision.',
    mimeType: 'application/json',
  },
  {
    uri: 'qiansi://canvas/summary',
    name: 'Qiansi canvas summary',
    description: 'Compact text description of the canvas, cheap to read every turn.',
    mimeType: 'text/plain',
  },
  {
    uri: 'qiansi://canvas.svg',
    name: 'Qiansi canvas diagram',
    description: 'The canvas rendered as an SVG diagram.',
    mimeType: 'image/svg+xml',
  },
  {
    uri: 'qiansi://canvas/report',
    name: 'Qiansi canvas report',
    description: 'Markdown export of the canvas: summary plus a note about the diagram.',
    mimeType: 'text/markdown',
  },
];

async function readResource(uri) {
  if (uri === 'qiansi://canvas') {
    const data = await request('/api/canvas');
    return { uri, mimeType: 'application/json', text: JSON.stringify(data.canvas ?? {}, null, 2) };
  }
  if (uri === 'qiansi://canvas/summary') {
    return { uri, mimeType: 'text/plain', text: await requestText('/api/canvas/summary') };
  }
  if (uri === 'qiansi://canvas.svg') {
    return { uri, mimeType: 'image/svg+xml', text: await requestText('/api/canvas/svg') };
  }
  if (uri === 'qiansi://canvas/report') {
    return {
      uri,
      mimeType: 'text/markdown',
      text: await requestText('/api/canvas/export?format=md'),
    };
  }
  throw new Error(`unknown resource: ${uri}`);
}

function appHint() {
  return `画布地址：${baseUrl()}（在牵丝里可以拖动、缩放、直接编辑）`;
}

const tools = [
  {
    name: 'list_models',
    description:
      'List every model the configured keys can call (one key serves a whole family, e.g. a DeepSeek key covers deepseek-chat AND deepseek-reasoner). Any listed id works in call_model, add_node, adapt_canvas or connect the canvas.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'call_model',
    description:
      'Call a subordinate model through the Qiansi gateway (OpenAI-compatible). Use this to delegate work to DeepSeek, MiniMax or the Claude relay.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id from list_models' },
        prompt: { type: 'string', description: 'User message' },
        system: { type: 'string', description: 'Optional system instruction' },
        purpose: { type: 'string', description: 'Short label for the canvas, e.g. "写初稿"' },
        max_tokens: { type: 'number', description: 'Optional output cap' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'get_usage',
    description: 'Return gateway token usage and the number of pending approvals.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_approval',
    description:
      'Ask the human to approve a risky action (shell, file write, external call). Blocks until approved/denied or timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What you want to do, with concrete parameters' },
        risk: { type: 'string', description: 'low | medium | high, plus why' },
        cost_estimate: { type: 'number', description: 'Estimated cost in USD, optional' },
        timeout_seconds: { type: 'number', description: 'Default 120' },
      },
      required: ['action', 'risk'],
    },
  },
  {
    name: 'describe_canvas',
    description:
      'Compact text view of the Qiansi canvas: main model, nodes with their model/role, artifacts, and every edge with its kind. Call this first when the user mentions the canvas, workflow, tasks, artifacts or orchestration.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_canvas',
    description: 'Full canvas JSON. Use describe_canvas instead unless you need exact ids and positions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_canvas_svg',
    description:
      'The canvas as a standalone SVG. Return it to the user when they want to see the workflow as a picture.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_node',
    description:
      'Add a node to the Qiansi canvas. kind is model (an AI that does work), task, or artifact. Position is optional and defaults to the right of the rightmost node.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Node label shown on the canvas' },
        kind: { type: 'string', description: 'model | task | artifact (default model)' },
        role: { type: 'string', description: 'Short description of what this node does' },
        provider: { type: 'string', description: 'Optional key-source hint; the model id decides routing' },
        model: { type: 'string', description: 'Model id from list_models — any model a configured key can call' },
        effort: { type: 'string', description: 'off | low | medium | high' },
        id: { type: 'string', description: 'Optional stable id; generated when omitted' },
        parentId: { type: 'string', description: 'Optional region node id to place it inside' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_node',
    description: 'Patch a node\'s data fields, e.g. rename it or record an artifact with {output}.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object', description: 'Fields to merge into the node data' },
      },
      required: ['id', 'patch'],
    },
  },
  {
    name: 'connect_nodes',
    description:
      'Wire two nodes. kind: assign (hands work to), handoff (passes result), review (checks), context (shares context).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Node id the edge starts from' },
        target: { type: 'string', description: 'Node id the edge points to' },
        kind: { type: 'string', description: 'assign | handoff | review | context' },
        label: { type: 'string', description: 'Optional edge label shown on the wire' },
      },
      required: ['source', 'target'],
    },
  },
  {
    name: 'remove_node',
    description: 'Delete a node and every edge attached to it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'set_orchestrator',
    description: 'Choose which node is the main model that plans and hands out work.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'export_canvas',
    description:
      'Export the canvas. format "html" gives a standalone shareable page with the diagram inlined; "md" gives a Markdown summary. Returns the URL the user can open or send.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'html (default) or md' },
      },
    },
  },
  {
    name: 'get_run_result',
    description:
      'Structured result of a run: status, per-task outputs, token usage and whether the plan came from the canvas or a built-in demo. Poll this after run_canvas instead of asking the user to look.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The runId returned by run_canvas' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'adapt_canvas',
    description:
      'One-click adaptation: make THIS agent session the orchestrator and prepare the board for a run. You know your own model and what the conversation is about — pass them here. Sets the orchestrator node to your model, writes the session summary into its role, wires the standard topology (orchestrator → workers, libraries → orchestrator), and optionally creates worker nodes you list. Call this before run_canvas when the user asks to "适配" or hand the task to the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Your model id, e.g. claude-opus-4-8[1M]' },
        provider: {
          type: 'string',
          description: 'Optional hint (relay | deepseek | minimax | moonshot); routing is decided by the model id via the catalog',
        },
        session_context: {
          type: 'string',
          description: '2-4 sentences: what this session is working on and what the orchestration should achieve',
        },
        workers: {
          type: 'array',
          description: 'Optional worker nodes to create and wire under the orchestrator',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              role: { type: 'string' },
              model: { type: 'string', description: 'Model id from list_models' },
              provider: { type: 'string' },
              effort: { type: 'string' },
            },
            required: ['name', 'model'],
          },
        },
      },
      required: ['model'],
    },
  },
  {
    name: 'run_canvas',
    description:
      'Start one orchestration run from the canvas: the main model plans, the connected models work. Returns a runId. mode "demo" runs a built-in demo plan instead — no real models, nothing written back.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the run should achieve' },
        mode: { type: 'string', description: 'live (real models, needs keys) or demo' },
        max_tokens: { type: 'number', description: 'Total token budget, default 200000' },
      },
    },
  },
  {
    name: 'get_status',
    description:
      'Health of the local Qiansi server as an exit code plus named parts: 0 healthy, 1 down, 2 running but broken, 3 waiting for configuration. Use it instead of guessing whether the app is up, and read `errors`/`setup` to tell the user what to fix. `load.activeRunAgeMs` reveals a run that has stopped emitting events.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_policy',
    description:
      'Who may start runs and what each agent may do on this machine (acceptMode, human list, agent list with scopes). Read this before telling the user an action is forbidden — the refusal comes from here.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  if (name === 'get_status') {
    return request('/api/status');
  }

  if (name === 'get_policy') {
    return request('/api/policy');
  }

  if (name === 'list_models') {
    const data = await request('/v1/models');
    return data.data ?? data;
  }

  if (name === 'call_model') {
    const messages = [];
    if (args.system) messages.push({ role: 'system', content: String(args.system) });
    messages.push({ role: 'user', content: String(args.prompt ?? '') });
    const data = await request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'x-qiansi-purpose': String(args.purpose ?? args.model ?? 'call_model'),
        'x-agentweave-purpose': String(args.purpose ?? args.model ?? 'call_model'),
      },
      body: JSON.stringify({
        model: String(args.model ?? ''),
        messages,
        max_tokens: args.max_tokens ? Number(args.max_tokens) : 1024,
        stream: false,
      }),
    });
    return {
      model: data.model,
      text: data.choices?.[0]?.message?.content ?? '',
      usage: data.usage,
    };
  }

  if (name === 'get_usage') {
    return request('/api/usage');
  }

  if (name === 'request_approval') {
    const record = await request('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({
        action: String(args.action ?? ''),
        risk: String(args.risk ?? ''),
        costEstimate: Number(args.cost_estimate ?? 0),
      }),
    });

    const timeoutMs = Math.max(5, Number(args.timeout_seconds ?? 120)) * 1000;
    const startedAt = Date.now();
    let current = record;
    while (current.status === 'pending' && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      current = await request(`/api/approvals/${record.id}`);
    }
    return {
      approvalId: record.id,
      status: current.status,
      note: current.note,
      timedOut: current.status === 'pending',
    };
  }

  if (name === 'describe_canvas') {
    return { summary: await requestText('/api/canvas/summary'), app: appHint() };
  }

  if (name === 'get_canvas') {
    const data = await request('/api/canvas');
    return { revision: data.revision, canvas: data.canvas, app: appHint() };
  }

  if (name === 'get_canvas_svg') {
    return { svg: await requestText('/api/canvas/svg'), app: appHint() };
  }

  if (name === 'add_node') {
    const kind = String(args.kind ?? 'model');
    const typeByKind = {
      model: 'agent',
      task: 'task',
      artifact: 'artifact',
      region: 'region',
      library: 'library',
      file: 'file',
      external: 'external',
    };
    const current = await request('/api/canvas');
    const existing = Array.isArray(current.canvas?.nodes) ? current.canvas.nodes : [];
    const right = existing.reduce(
      (max, node) => Math.max(max, Number(node.position?.x) || 0),
      0
    );
    const id = String(args.id ?? `${kind}-${Date.now().toString(36)}`);
    const node = {
      id,
      type: typeByKind[kind] ?? 'agent',
      position: {
        x: Number.isFinite(Number(args.x)) ? Number(args.x) : right + 320,
        y: Number.isFinite(Number(args.y)) ? Number(args.y) : 120,
      },
      data: {
        kind,
        name: String(args.name ?? '新节点'),
        role: String(args.role ?? ''),
        provider: String(args.provider ?? 'relay'),
        model: String(args.model ?? ''),
        effort: String(args.effort ?? 'medium'),
        status: 'idle',
      },
    };
    if (args.parentId) node.parentId = String(args.parentId);
    const result = await request('/api/canvas/ops', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'add_node', node }] }),
    });
    return {
      ok: result.ok,
      id,
      errors: result.errors,
      revision: result.revision,
      app: appHint(),
    };
  }

  if (name === 'update_node') {
    const result = await request('/api/canvas/ops', {
      method: 'POST',
      body: JSON.stringify({
        ops: [{ op: 'update_node', id: String(args.id ?? ''), patch: args.patch ?? {} }],
      }),
    });
    return { ok: result.ok, errors: result.errors, revision: result.revision, app: appHint() };
  }

  if (name === 'connect_nodes') {
    const kind = String(args.kind ?? 'assign');
    const colors = {
      assign: '#6366f1',
      handoff: '#10b981',
      review: '#f59e0b',
      context: '#38d9c2',
    };
    const edge = {
      id: `mcp-e-${Date.now().toString(36)}`,
      source: String(args.source ?? ''),
      target: String(args.target ?? ''),
      type: 'smoothstep',
      animated: true,
      label: args.label ? String(args.label) : kind,
      data: { kind },
      style: { stroke: colors[kind] ?? colors.assign, strokeWidth: 1.5 },
      markerEnd: { type: 'arrowclosed', width: 14, height: 14 },
      labelStyle: { fill: '#8b98a8', fontSize: 9.5 },
      labelBgStyle: { fill: '#0e1318', fillOpacity: 0.92 },
    };
    const result = await request('/api/canvas/ops', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'add_edge', edge }] }),
    });
    return {
      ok: result.ok,
      id: edge.id,
      errors: result.errors,
      revision: result.revision,
      app: appHint(),
    };
  }

  if (name === 'remove_node') {
    const result = await request('/api/canvas/ops', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'remove_node', id: String(args.id ?? '') }] }),
    });
    return { ok: result.ok, errors: result.errors, revision: result.revision, app: appHint() };
  }

  if (name === 'set_orchestrator') {
    const result = await request('/api/canvas/ops', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'set_orchestrator', id: String(args.id ?? '') }] }),
    });
    return { ok: result.ok, errors: result.errors, revision: result.revision, app: appHint() };
  }

  if (name === 'export_canvas') {
    const format = args.format === 'md' ? 'md' : 'html';
    const body = await requestText(`/api/canvas/export?format=${format}`);
    return {
      format,
      url: `${baseUrl()}/api/canvas/export?format=${format}`,
      preview: body.slice(0, 400),
      note: '把 url 给用户：html 是可直接分享的独立网页，md 是纯文本摘要。',
    };
  }

  if (name === 'adapt_canvas') {
    const data = await request('/api/canvas');
    const canvas = data.canvas ?? { nodes: [], edges: [], orchestratorId: '' };
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const edges = Array.isArray(canvas.edges) ? canvas.edges : [];

    // Reuse the current orchestrator node in place — adaptation swaps the main
    // model, it does not add a second competing one.
    let orchId = '';
    if (
      canvas.orchestratorId &&
      nodes.some((node) => node.id === canvas.orchestratorId)
    ) {
      orchId = canvas.orchestratorId;
    } else {
      const byKind = nodes.find((node) => node.data?.kind === 'orchestrator');
      orchId = byKind?.id ?? 'session-orchestrator';
    }

    const model = String(args.model ?? '').trim();
    if (!model) throw new Error('model is required');
    const provider = String(args.provider ?? 'relay').toLowerCase();
    const context = String(args.session_context ?? '').slice(0, 500);
    const workerSpecs = Array.isArray(args.workers) ? args.workers.slice(0, 8) : [];

    const ops = [];
    if (nodes.some((node) => node.id === orchId)) {
      ops.push({
        op: 'update_node',
        id: orchId,
        patch: {
          provider,
          model,
          status: 'idle',
          metric: '已适配当前会话',
          ...(context ? { role: `当前会话主控：${context}` } : {}),
        },
      });
    } else {
      const left = nodes.reduce((min, node) => Math.min(min, Number(node.position?.x) || 0), 0);
      ops.push({
        op: 'add_node',
        node: {
          id: orchId,
          type: 'agent',
          position: { x: left - 340, y: 460 },
          data: {
            kind: 'orchestrator',
            name: '当前会话（主控）',
            role: context
              ? `当前会话主控：${context}`
              : '当前会话的主控：拆解目标、分派与验收',
            provider,
            model,
            effort: 'medium',
            status: 'idle',
            accent: '#f59e0b',
          },
        },
      });
    }
    ops.push({ op: 'set_orchestrator', id: orchId });

    const linkedPairs = new Set(edges.map((edge) => `${edge.source}→${edge.target}`));
    for (const [index, spec] of workerSpecs.entries()) {
      const workerId = `adapt-w${index + 1}`;
      if (nodes.some((node) => node.id === workerId)) {
        ops.push({
          op: 'update_node',
          id: workerId,
          patch: {
            name: String(spec.name ?? `工作节点 ${index + 1}`),
            role: String(spec.role ?? ''),
            model: String(spec.model),
            provider: String(spec.provider ?? 'relay'),
            effort: String(spec.effort ?? 'medium'),
            status: 'idle',
          },
        });
      } else {
        const right = nodes.reduce((max, node) => Math.max(max, Number(node.position?.x) || 0), 0);
        ops.push({
          op: 'add_node',
          node: {
            id: workerId,
            type: 'agent',
            position: { x: right + 320, y: 120 + index * 180 },
            data: {
              kind: 'model',
              name: String(spec.name ?? `工作节点 ${index + 1}`),
              role: String(spec.role ?? ''),
              provider: String(spec.provider ?? 'relay'),
              model: String(spec.model),
              effort: String(spec.effort ?? 'medium'),
              status: 'idle',
            },
          },
        });
      }
      ops.push({
        op: 'add_edge',
        edge: {
          id: `adapt-e${index + 1}`,
          source: orchId,
          target: workerId,
          type: 'smoothstep',
          animated: true,
          label: '任务',
          data: { kind: 'assign' },
          style: { stroke: '#6366f1', strokeWidth: 1.5 },
          markerEnd: { type: 'arrowclosed', width: 14, height: 14 },
        },
      });
    }
    for (const library of nodes.filter((node) => node.data?.kind === 'library')) {
      const key = `${library.id}→${orchId}`;
      if (linkedPairs.has(key)) continue;
      ops.push({
        op: 'add_edge',
        edge: {
          id: `adapt-ctx-${library.id}`,
          source: library.id,
          target: orchId,
          type: 'smoothstep',
          animated: true,
          label: '公共文件',
          data: { kind: 'context' },
          style: { stroke: '#38d9c2', strokeWidth: 1.5, dasharray: '6 4' },
          markerEnd: { type: 'arrowclosed', width: 14, height: 14 },
        },
      });
    }

    const result = await request('/api/canvas/ops', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    });
    return {
      ok: result.ok,
      orchestrator: { id: orchId, model, provider },
      workersWired: workerSpecs.length,
      errors: result.errors,
      revision: result.revision,
      summary: result.summary,
      next: `画布已适配。确认分工后调 run_canvas（把 goal 设为本次会话的目标），跑完用 get_run_result 汇报。${appHint()}`,
    };
  }

  if (name === 'get_run_result') {
    const runId = String(args.run_id ?? '');
    if (!runId) throw new Error('run_id is required');
    const result = await request(`/api/runs/${encodeURIComponent(runId)}/result`);
    return { ...result, app: appHint() };
  }

  if (name === 'run_canvas') {
    const data = await request('/api/canvas');
    const canvas = data.canvas ?? { nodes: [], edges: [] };
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const team = nodes
      .filter(
        (node) =>
          node?.data?.kind !== 'region' &&
          node?.data?.kind !== 'library' &&
          node?.data?.model &&
          node.data.model !== 'library'
      )
      .slice(0, 20)
      .map((node) => ({
        id: node.id,
        name: node.data.name ?? node.data.role ?? node.id,
        role: node.data.role ?? '',
        provider: node.data.provider ?? 'relay',
        model: node.data.model,
        effort: node.data.effort ?? 'medium',
      }));
    if (!team.length) {
      return {
        ok: false,
        error: '画布上还没有带模型的节点，先用 add_node 建一个再运行。',
        app: appHint(),
      };
    }
    const orchestratorId =
      canvas.orchestratorId && team.some((member) => member.id === canvas.orchestratorId)
        ? canvas.orchestratorId
        : team[0].id;
    const mode = args.mode === 'demo' ? 'demo' : 'live';
    try {
      const started = await request('/api/commands', {
        method: 'POST',
        body: JSON.stringify({
          commandId: randomUUID(),
          type: 'run.start',
          payload: {
            mode,
            orchestratorId,
            team,
            goal: args.goal ? String(args.goal) : undefined,
            budget: { maxTotalTokens: Number(args.max_tokens ?? 200000) },
          },
        }),
      });
      return {
        ok: true,
        ...started,
        orchestratorId,
        team: team.length,
        result: `${baseUrl()}/api/runs/${started.runId}/result`,
        note:
          mode === 'demo'
            ? '这是演示运行：调用本地假模型，不使用画布计划，也不会写回产物。要看真实结果请用 mode live。'
            : '运行结束后调 get_run_result 拿每个任务的产物；产物会自动写回画布对应节点。',
        app: appHint(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message,
        hint:
          mode === 'live'
            ? 'live 模式需要先在牵丝里配置模型密钥；也可以传 mode: "demo" 空跑一遍看流程。'
            : undefined,
        app: appHint(),
      };
    }
  }

  throw new Error(`unknown tool: ${name}`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`
  );
}

const input = createInterface({ input: process.stdin });

input.on('line', (line) => {
  const text = line.trim();
  if (!text) return;

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }

  void (async () => {
    try {
      if (message.method === 'initialize') {
        respond(message.id, {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'qiansi', version: serverVersion() },
        });
        return;
      }

      if (message.method === 'notifications/initialized') return;
      if (message.method === 'ping') {
        respond(message.id, {});
        return;
      }

      if (message.method === 'tools/list') {
        respond(message.id, { tools });
        return;
      }

      if (message.method === 'resources/list') {
        respond(message.id, { resources: RESOURCES });
        return;
      }

      if (message.method === 'resources/read') {
        const uri = String(message.params?.uri ?? '');
        try {
          const contents = await readResource(uri);
          respond(message.id, { contents: [contents] });
        } catch (error) {
          respondError(
            message.id,
            -32602,
            error instanceof Error ? error.message : String(error)
          );
        }
        return;
      }

      if (message.method === 'tools/call') {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        try {
          const data = await callTool(name, args);
          respond(message.id, {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            isError: false,
          });
        } catch (error) {
          respond(message.id, {
            content: [
              {
                type: 'text',
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          });
        }
        return;
      }

      if (message.id !== undefined) {
        respondError(message.id, -32601, `method not found: ${message.method}`);
      }
    } catch (error) {
      if (message.id !== undefined) {
        respondError(
          message.id,
          -32603,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  })();
});

process.stderr.write('[qiansi-mcp] ready\n');
