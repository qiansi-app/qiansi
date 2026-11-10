import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  probeConnection,
  redactSecrets,
  type CapabilityProfile,
  type Protocol,
} from '@qiansi/engine';

/**
 * `qiansi status` speaks the same four exit codes as the server's health report:
 *
 *   0  healthy, or deliberately stopped
 *   1  not running / not answering — a restart may fix it
 *   2  running but broken — a restart will not fix it
 *   3  running but waiting for configuration
 *
 * That is the whole point of the command: a cron entry or a supervising agent
 * can branch on $? instead of parsing prose.
 */

const stateDir = join(homedir(), '.qiansi');
const manualStopMarker = join(stateDir, 'manual-stop');

interface StatusReport {
  code: 0 | 1 | 2 | 3;
  state: string;
  version: string;
  uptimeSeconds: number;
  manuallyStopped: boolean;
  parts: Record<string, { state: string; detail?: string }>;
  errors: string[];
  setup: string[];
  warnings: string[];
  load: { activeRunId: string | null; activeRunAgeMs: number | null; runningTasks: number };
}

function serverBase(): string {
  const fromEnv = process.env.QIANSI_URL ?? process.env.AGENTWEAVE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  try {
    const port = readFileSync(join(stateDir, 'server-port'), 'utf8').trim();
    if (port) return `http://127.0.0.1:${port}`;
  } catch {
    // fall through to the default port
  }
  return 'http://127.0.0.1:8787';
}

function readToken(): string {
  const fromEnv = process.env.QIANSI_TOKEN ?? process.env.AGENTWEAVE_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(stateDir, 'server-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function fetchStatus(
  timeoutMs = 4000
): Promise<StatusReport | { unreachable: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverBase()}/api/status`, {
      headers: { 'x-qiansi-token': readToken() },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { unreachable: `HTTP ${response.status}` };
    }
    return (await response.json()) as StatusReport;
  } catch (error) {
    return { unreachable: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function printReport(report: StatusReport): void {
  const minutes = Math.floor(report.uptimeSeconds / 60);
  console.log(
    `qiansi ${report.version} · ${report.state} · 已运行 ${minutes}m · ${
      report.manuallyStopped ? '人为停止' : '运行中'
    }`
  );
  for (const [name, value] of Object.entries(report.parts)) {
    const detail = value.detail ? ` — ${value.detail}` : '';
    console.log(`  ${value.state === 'error' ? '✗' : value.state === 'ready' ? '✓' : '·'} ${name}${detail}`);
  }
  for (const item of report.setup) console.log(`  需要配置：${item}`);
  for (const item of report.warnings) console.log(`  提醒：${item}`);
  if (report.load.activeRunId) {
    console.log(`  在跑的运行：${report.load.activeRunId}（${report.load.runningTasks} 个任务）`);
  }
}

async function commandStatus(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const respectStop = argv.includes('--respect-stop');
  const report = await fetchStatus();

  if ('unreachable' in report) {
    const stopped = existsSync(manualStopMarker);
    if (json) {
      console.log(JSON.stringify({ code: stopped && respectStop ? 0 : 1, manuallyStopped: stopped, error: report.unreachable }, null, 2));
    } else if (stopped) {
      console.log('qiansi 已人为停止（找到 manual-stop 标记），保持不动。');
    } else {
      console.error(`qiansi 没有在运行：${report.unreachable}`);
      console.error(`服务地址：${serverBase()}`);
    }
    // A deliberate stop is not a fault — but only a caller that asks for
    // --respect-stop gets to treat it as healthy. A naive supervisor should
    // still see exit 1 and be able to bring the server back.
    if (stopped) return respectStop ? 0 : 1;
    return 1;
  }

  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report.code;
}

async function commandStop(): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${serverBase()}/api/admin/stop`, {
      method: 'POST',
      headers: { 'x-qiansi-token': readToken() },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
    if (!response.ok) {
      console.error(`停止失败：${body.error ?? response.status}${body.reason ? ` — ${body.reason}` : ''}`);
      return 1;
    }
    console.log('已请求停止，服务会自己退出。');
    return 0;
  } catch {
    // The server is already down; recording the intent keeps a watchdog quiet.
    try {
      writeFileSync(manualStopMarker, new Date().toISOString(), { encoding: 'utf8' });
    } catch {
      // nothing else to do
    }
    console.log('服务本来就没在运行，已记下「人为停止」标记。');
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
}

async function commandStart(): Promise<number> {
  const existing = await fetchStatus(1500);
  if (!('unreachable' in existing)) {
    console.log(`已经在运行：${serverBase()}`);
    return existing.code;
  }

  const entry = join(repoRoot(), 'apps', 'server', 'src', 'index.ts');
  if (!existsSync(entry)) {
    console.error(`找不到服务入口：${entry}`);
    console.error('打包版请直接打开牵丝桌面应用；源码版请在仓库根目录运行 npm run dev:server。');
    return 1;
  }

  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: repoRoot(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, QIANSI_DETACHED: '1' },
  });
  child.unref();
  console.log(`已启动（pid ${child.pid}），等待它就绪…`);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const report = await fetchStatus(1500);
    if (!('unreachable' in report)) {
      console.log(`已就绪：${serverBase()}（exit ${report.code}）`);
      return report.code;
    }
  }
  console.error('30 秒内没有起来，请看 apps/server 的启动输出。');
  return 1;
}

/**
 * 看门狗（借鉴 DSH 部署文档的 hourly check）：把 status 的退出码变成动作。
 *   服务不可达且非人为停止 → 拉起
 *   退出码 1 → 拉起
 *   退出码 2/3 → 重启无效，报给人（同一组问题只报一次）
 *   人为停止 → 什么都不做
 * --once 只检查一轮（供 cron / 手动验证）。
 */
async function commandWatchdog(argv: string[]): Promise<number> {
  const once = argv.includes('--once');
  const index = argv.indexOf('--interval');
  const seconds = index >= 0 ? Number(argv[index + 1]) : NaN;
  const interval = (Number.isFinite(seconds) && seconds >= 15 ? seconds : 60) * 1000;
  let lastProblem = '';

  for (;;) {
    const report = await fetchStatus();
    if ('unreachable' in report) {
      if (existsSync(manualStopMarker)) {
        if (once) {
          console.log('服务处于「人为停止」，看门狗不动。');
          return 0;
        }
      } else {
        console.log(`[watchdog] 服务不可达（${report.unreachable}），拉起…`);
        const code = await commandStart();
        console.log(`[watchdog] 拉起结束，退出码 ${code}`);
        if (once) return code;
      }
    } else if (report.code === 0) {
      lastProblem = '';
      if (once) {
        console.log('服务健康（0）。');
        return 0;
      }
    } else if (report.code === 1) {
      console.log('[watchdog] 服务报告 1（未运行/不响应），拉起…');
      const code = await commandStart();
      if (once) return code;
    } else {
      const signature = `${report.code}:${(report.errors ?? []).join('|')}:${(report.setup ?? []).join('|')}`;
      if (signature !== lastProblem) {
        lastProblem = signature;
        console.log(`[watchdog] 退出码 ${report.code}：重启无效，需要人工处理。`);
        for (const item of report.errors ?? []) console.log('  ✗', item);
        for (const item of report.setup ?? []) console.log('  需要配置：', item);
      }
      if (once) return report.code;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const args = process.argv.slice(2);
const command = args[0];

if (command === 'status' || command === 'stop' || command === 'start' || command === 'watchdog') {
  const run =
    command === 'status'
      ? commandStatus(args.slice(1))
      : command === 'stop'
        ? commandStop()
        : command === 'watchdog'
          ? commandWatchdog(args.slice(1))
          : commandStart();
  const code = await run;
  process.exit(code);
}

if (command !== 'probe' || !args[1]) {
  console.error(
    [
      'Usage:',
      '  qiansi status [--json] [--respect-stop]',
      '  qiansi watchdog [--interval 秒] [--once]',
      '  qiansi stop',
      '  qiansi start',
      '  qiansi probe <connection.json>',
    ].join('\n')
  );
  process.exit(2);
}

const file = args[1];

let config: Record<string, unknown>;
try {
  config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
} catch (error) {
  console.error(
    `Cannot read ${file}:`,
    error instanceof Error ? error.message : String(error)
  );
  process.exit(2);
}

const protocol: Protocol =
  config.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat';
const apiKeyEnv = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : '';
const apiKey = String(apiKeyEnv ? process.env[apiKeyEnv] ?? '' : config.apiKey ?? '');

const profile: CapabilityProfile = {
  id: 'cli-probe',
  label: String(config.label ?? 'cli-probe'),
  provider: String(config.provider ?? 'custom'),
  protocol,
  baseUrl: String(config.baseUrl ?? ''),
  model: String(config.model ?? ''),
  contextWindow: 128000,
  maxOutput: 8192,
  modalities: { tools: true, json: true },
  effort: { dialect: 'none', canDisable: true },
  domesticReachable: true,
};

if (!profile.baseUrl || !profile.model) {
  console.error('baseUrl and model are required');
  process.exit(2);
}

const result = await probeConnection(profile, apiKey);
console.log(
  JSON.stringify(
    {
      ...result,
      error: result.error ? redactSecrets(result.error, [apiKey]) : undefined,
    },
    null,
    2
  )
);
process.exit(result.ok ? 0 : 1);
