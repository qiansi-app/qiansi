/**
 * Qiansi as a DSH bundle.
 *
 * The tools themselves come from @deepseek-ai/dsh-mcp-client, which speaks MCP
 * to the Qiansi server and registers every tool as mcp__qiansi__<name>. This
 * plugin only reports whether the canvas service is reachable, because the most
 * common failure is simply "the app is not running yet" — and a one-line hint in
 * the log is worth more than a stack trace from the MCP child process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function stateDir() {
  return process.env.QIANSI_HOME ?? join(homedir(), '.qiansi');
}

function readPort() {
  try {
    const value = Number(readFileSync(join(stateDir(), 'server-port'), 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {
    // no port file: the app has never run on this machine
  }
  return Number(process.env.QIANSI_PORT ?? 8787);
}

async function probe(port, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DSH 启动时事件循环被插件加载挤满，1.5 秒的探测会误判成「服务没起」。
 * 给一次更宽的重试，仍然失败才下结论。
 */
async function healthy(port) {
  if (await probe(port, 4000)) return true;
  await new Promise((resolve) => setTimeout(resolve, 800));
  return probe(port, 6000);
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
  const port = readPort();
  const up = await healthy(port);
  if (up) {
    report(
      ctx,
      'info',
      `[qiansi] canvas reachable at http://127.0.0.1:${port} — tools are mcp__${config.serverName ?? 'qiansi'}__*`
    );
  } else {
    report(
      ctx,
      'warn',
      `[qiansi] 画布服务没有应答 http://127.0.0.1:${port}。` +
        '先启动牵丝（桌面版 / VS Code 画布面板 / npm run server:start），再重启 DSH；' +
        '服务没起时 mcp__qiansi__* 工具不会注册。'
    );
  }
  // The plugin holds no resources of its own; the MCP child is owned by
  // @deepseek-ai/dsh-mcp-client's own entry in cordis.patch.yml.
  return () => undefined;
}

export function describe() {
  return {
    stateDir: stateDir(),
    port: readPort(),
    portFile: existsSync(join(stateDir(), 'server-port')),
  };
}
