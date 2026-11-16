/**
 * 端到端验收：隔离实例里跑一次会写文件的编排，确认产物账本与纠错数据都真的落下来了。
 *
 *   QIANSI_HOME=<隔离目录> QIANSI_PORT=8983 QIANSI_E2E_PROJECT=<工作目录> node scripts/e2e-artifacts.mjs
 *
 * 只碰隔离目录与临时项目目录；跑完自己把服务收掉。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = 'E:/AgentWeave';
const home = process.env.QIANSI_HOME;
const port = Number(process.env.QIANSI_PORT ?? 8983);
const project = process.env.QIANSI_E2E_PROJECT;
if (!home || !project) {
  console.error('需要 QIANSI_HOME 与 QIANSI_E2E_PROJECT');
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
  cwd: repo,
  env: { ...process.env, QIANSI_PORT: String(port), QIANSI_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
let serverLog = '';
server.stdout.on('data', (text) => (serverLog += text));
server.stderr.on('data', (text) => (serverLog += text));

let token = '';
async function waitHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // 还没起来
    }
    await sleep(600);
  }
  return false;
}

function headers(workspace) {
  return {
    'content-type': 'application/json',
    'x-qiansi-token': token,
    ...(workspace ? { 'x-qiansi-workspace': workspace } : {}),
  };
}

async function api(path, options = {}, workspace) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers(workspace), ...(options.headers ?? {}) } });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

try {
  if (!(await waitHealth())) {
    console.error('服务没起来：\n' + serverLog.slice(-2000));
    process.exit(1);
  }
  const tokenFile = join(home, 'server-token');
  for (let i = 0; i < 20 && !existsSync(tokenFile); i += 1) await sleep(200);
  token = readFileSync(tokenFile, 'utf8').trim();

  console.log('环境');
  const health = await api('/api/health');
  check('隔离实例健康', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body).slice(0, 120));

  const catalog = await api('/api/models/catalog');
  const catalogs = catalog.body?.catalogs ?? {};
  const models = Object.values(catalogs)
    .flatMap((entry) => (entry?.models ?? []).map((model) => (typeof model === 'string' ? model : model?.id)))
    .filter(Boolean);
  const chosen =
    models.find((id) => /deepseek/i.test(id) && /flash/i.test(id)) ??
    models.find((id) => /deepseek/i.test(id)) ??
    'deepseek-flash';
  check('选定模型', Boolean(chosen), `catalog=${models.length} 个 · 用 ${chosen}`);

  console.log('建工作区');
  const created = await api('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: `artifacts-e2e-${Date.now() % 100000}` }),
  });
  const workspaceId = created.body?.workspace?.id;
  check('工作区已创建', Boolean(workspaceId), JSON.stringify(created.body).slice(0, 200));
  await api(`/api/workspaces/${workspaceId}`, {
    method: 'PATCH',
    body: JSON.stringify({ rootDir: project }),
  });

  console.log('搭画布');
  const ops = [
    {
      op: 'add_node',
      node: {
        id: 'lead',
        type: 'agent',
        position: { x: 60, y: 120 },
        data: { kind: 'agent', name: '主控', role: '主控', model: chosen, provider: 'deepseek', effort: 'low', status: 'idle' },
      },
    },
    {
      op: 'add_node',
      node: {
        id: 'writer',
        type: 'agent',
        position: { x: 420, y: 120 },
        data: {
          kind: 'agent',
          name: '落文件',
          role: '执行',
          model: chosen,
          provider: 'deepseek',
          effort: 'low',
          status: 'idle',
          task: '用 write_file 在工作目录下写两个文件：out/notes.md（三行说明）和 out/data.csv（两列五行）。写完用 list_dir 确认它们存在。',
        },
      },
    },
    { op: 'add_edge', edge: { id: 'e1', source: 'lead', target: 'writer' } },
    { op: 'set_orchestrator', id: 'lead' },
  ];
  const applied = await api('/api/canvas/ops', { method: 'POST', body: JSON.stringify({ ops }) }, workspaceId);
  check('画布已搭好', applied.status === 200 && applied.body?.ok !== false, JSON.stringify(applied.body).slice(0, 200));

  console.log('跑编排（真实模型）');
  const started = await api(
    '/api/commands',
    {
      method: 'POST',
      body: JSON.stringify({ commandId: randomUUID(), type: 'run.start', payload: { mode: 'live' } }),
    },
    workspaceId
  );
  const runId = started.body?.runId;
  check('运行已受理', Boolean(runId), JSON.stringify(started.body).slice(0, 300));

  let status = '';
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const active = await api(`/api/runs/active?ws=${encodeURIComponent(workspaceId)}`, {}, workspaceId);
    status = active.body?.status ?? active.body?.run?.status ?? '';
    if (!active.body || active.body?.active === false || ['done', 'failed', 'aborted'].includes(status)) break;
  }
  const snapshot = await api(`/api/runs/${runId}/result`, {}, workspaceId);
  check('运行结束', ['done', 'failed'].includes(snapshot.body?.status ?? ''), `${snapshot.body?.status} / active=${status}`);

  console.log('产物账本');
  const artifacts = await api(`/api/runs/${runId}/artifacts`, {}, workspaceId);
  const files = artifacts.body?.files ?? [];
  check('账本有产物', files.length >= 2, JSON.stringify(files).slice(0, 300));
  check('notes.md 入账', files.some((file) => file.path.endsWith('out/notes.md')), JSON.stringify(files.map((f) => f.path)));
  check('data.csv 入账', files.some((file) => file.path.endsWith('out/data.csv')), JSON.stringify(files.map((f) => f.path)));
  check('带上任务归属', files.every((file) => typeof file.taskId === 'string' && file.taskId.length > 0));
  check('带上绝对路径', files.every((file) => typeof file.absolutePath === 'string' && file.absolutePath.length > 3));

  const preview = await api(`/api/artifacts/preview?path=${encodeURIComponent(files[0]?.absolutePath ?? '')}`, {}, workspaceId);
  check('预览接口可读产物', preview.status === 200, `${preview.status}`);
  const deny = await api(`/api/artifacts/preview?path=${encodeURIComponent(join(project, '..', 'windows', 'win.ini'))}`);
  check('未登记路径被拒绝', deny.status === 404, `${deny.status}`);

  const aggregate = await api('/api/artifacts?limit=5', {}, workspaceId);
  check('聚合接口含本轮', (aggregate.body?.runs ?? []).some((run) => run.runId === runId), JSON.stringify(aggregate.body?.runs?.map((r) => r.runId)));

  console.log('纠错数据');
  const events = await api(`/api/runs/${runId}/events`, {}, workspaceId);
  const list = events.body?.events ?? [];
  const revised = list.filter((entry) => entry.type === 'task.revised');
  const completed = list.filter((entry) => entry.type === 'task.completed');
  check('completed 事件带 files', completed.every((entry) => Array.isArray(entry.files)), JSON.stringify(completed[0]?.files ?? null).slice(0, 200));
  console.log(`  INFO 纠错次数：${revised.length}${revised.length ? ' · 原因：' + (revised[0].reasons ?? []).join('；') : ''}`);
} catch (error) {
  console.error('e2e 失败：', error);
} finally {
  server.kill();
  await sleep(500);
  const failed = results.filter((entry) => !entry.ok);
  console.log(failed.length === 0 ? '\nARTIFACTS E2E OK' : `\n${failed.length} check(s) failed`);
  if (failed.length) process.exitCode = 1;
}
