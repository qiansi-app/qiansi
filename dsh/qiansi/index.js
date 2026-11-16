/**
 * Qiansi as a DSH bundle.
 *
 * The tools themselves come from @deepseek-ai/dsh-mcp-client, which speaks MCP
 * to the Qiansi server and registers every tool as mcp__qiansi__<name>. This
 * plugin makes that server exist: if a Qiansi instance already answers (desktop
 * app, VS Code panel, `npm run server:start`), it is reused untouched; otherwise
 * the single-file server bundled inside this package is started here, so a plain
 * `dsh plugin add qiansi-dsh` is enough to make the tools work.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureServer, healthy, logPath, serverBundlePath, stateDir } from './server-bridge.mjs';

function readPort() {
  try {
    const value = Number(readFileSync(join(stateDir(), 'server-port'), 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {
    // no port file: the app has never run on this machine
  }
  return Number(process.env.QIANSI_PORT ?? 8787);
}

export const name = 'qiansi-dsh';

/**
 * 日志走 ctx.logger；但宿主没有日志服务时（或换了 API），
 * 状态插件不能因此变成哑巴——退回 stderr，不污染 headless 的 stdout。
 */
function report(ctx, level, message) {
  // QIANSI_DSH_DEBUG=1 时同时打到 stderr，排查「插件到底有没有起来」用。
  if (process.env.QIANSI_DSH_DEBUG === '1') console.error(message);
  const logger = ctx?.logger;
  if (logger && typeof logger[level] === 'function') {
    logger[level](message);
    return;
  }
  console.error(message);
}

export async function apply(ctx, config = {}) {
  const namespace = config.serverName ?? 'qiansi';
  const tools = `mcp__${namespace}__*`;

  // autoStart: false 退回旧行为——只探测，不起服务。
  const result =
    config.autoStart === false
      ? existingOnly(config)
      : await ensureServer({
          port: config.port === undefined ? undefined : Number(config.port),
          timeoutMs: config.startTimeoutMs ?? 30_000,
          // 默认沿用 8787 兜底端口；隔离测试传 [] 就不会连到本机别的实例。
          fallbackPorts: Array.isArray(config.fallbackPorts)
            ? config.fallbackPorts
            : fallbackPortsFromEnv(),
        });

  if (result.ok) {
    report(
      ctx,
      'info',
      result.started
        ? `[qiansi] canvas started at http://127.0.0.1:${result.port} (bundled server, pid ${result.pid}) — tools are ${tools}`
        : `[qiansi] canvas reachable at http://127.0.0.1:${result.port} — tools are ${tools}`
    );
  } else {
    report(
      ctx,
      'warn',
      `[qiansi] 画布服务没有就绪：${result.reason ?? '未知原因'}。` +
        `内置服务：${serverBundlePath()}；日志：${logPath()}；` +
        `也可以手动启动牵丝（桌面版 / VS Code 画布面板 / npm run server:start）后重启 DSH。`
    );
  }
  // The plugin holds no resources of its own; the MCP child is owned by
  // @deepseek-ai/dsh-mcp-client's own entry in cordis.patch.yml, and the server
  // we started is deliberately left running for the desktop app to reuse.
  return () => undefined;
}

/**
 * QIANSI_DSH_PORT_FALLBACK 用来关掉 8787 兜底：设成空串就只在
 * QIANSI_PORT / 端口文件上找服务，不会挂到本机另一个实例上。
 */
function fallbackPortsFromEnv() {
  const raw = process.env.QIANSI_DSH_PORT_FALLBACK;
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);
}

async function existingOnly(config) {  const port = config.port === undefined ? readPort() : Number(config.port);
  if (await healthy(port)) return { ok: true, port, started: false };
  return {
    ok: false,
    port,
    started: false,
    reason: `自动启动已关闭（autoStart: false），http://127.0.0.1:${port} 没有应答`,
  };
}

export function describe() {
  return {
    stateDir: stateDir(),
    port: readPort(),
    portFile: existsSync(join(stateDir(), 'server-port')),
    serverBundle: serverBundlePath(),
    serverBundlePresent: existsSync(serverBundlePath()),
    logPath: logPath(),
  };
}

/** 便于测试与 CLI 复用。 */
export { ensureServer } from './server-bridge.mjs';
