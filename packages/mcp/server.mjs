#!/usr/bin/env node
/**
 * Qiansi MCP server (stdio, zero dependencies).
 *
 * Tools:
 *   list_models          list the model pool exposed by the local gateway
 *   call_model           call a subordinate model through the gateway
 *   get_usage            token usage and pending approvals
 *   request_approval     ask the human to approve a risky action
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

const baseUrl = (
  process.env.QIANSI_URL ??
  process.env.AGENTWEAVE_URL ??
  'http://127.0.0.1:8787'
).replace(/\/+$/, '');
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

const token = readToken();

function headers(extra = {}) {
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

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: headers(options.headers),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error ?? data)}`
    );
  }
  return data;
}

const tools = [
  {
    name: 'list_models',
    description:
      'List the Qiansi model pool. Each id can be passed to call_model. Models are governed by the canvas budgets.',
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
];

async function callTool(name, args = {}) {
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
          capabilities: { tools: {} },
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
