/**
 * 自带画布服务。
 *
 * 这个组合包不只是一个 MCP 客户端：`server/server.cjs` 是牵丝服务端用 esbuild
 * 打成的单文件（无原生模块），随包发布。DSH 启动时先探测本机有没有已经跑着的
 * 牵丝（桌面版、VS Code 面板、`npm run server:start` 都算），没有就把自带的
 * 这个拉起来，再回报端口。这样「装完插件就能用」不再依赖用户另外启动应用。
 *
 * 设计约束：
 *   - 只探测、不争抢：已经能应答的服务一律复用，绝不再起第二个；
 *   - 端口不硬编码：优先 QIANSI_PORT / 端口文件，被占用时在附近找一个空闲的；
 *   - 服务是共享资源：DSH 退出后继续跑（桌面版、VS Code 面板都能接管），
 *     需要停用 `qiansi-dsh server stop`；
 *   - 日志落到 ~/.qiansi/logs/server.log，起不来时把最后几行原样带回去。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function stateDir() {
  return process.env.QIANSI_HOME ?? join(homedir(), '.qiansi');
}

export function serverBundlePath() {
  return join(here, 'server', 'server.cjs');
}

export function logPath() {
  return join(stateDir(), 'logs', 'server.log');
}

/** 显式指定了 QIANSI_HOME，就只看这一个目录：测试/第二实例不该读到真实数据。 */
function explicitHome() {
  return process.env.QIANSI_HOME?.trim() || null;
}

/** 端口文件是服务端写的“我实际绑在哪个端口”，可能指向一个已经退出的进程。 */
export function readPortFile() {
  const dirs = explicitHome()
    ? [stateDir()]
    : [stateDir(), join(homedir(), '.qiansi'), join(homedir(), '.agentweave')];
  for (const dir of dirs) {
    try {
      const value = Number(readFileSync(join(dir, 'server-port'), 'utf8').trim());
      if (Number.isInteger(value) && value > 0 && value < 65536) return value;
    } catch {
      // 换下一个位置
    }
  }
  return null;
}

export function readToken() {
  const fromEnv = process.env.QIANSI_TOKEN ?? process.env.AGENTWEAVE_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(stateDir(), 'server-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export async function probe(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) ?? {};
  } catch {
    return null;
  }
}

/** DSH 启动时事件循环被插件加载挤满，一次 1.5 秒的探测会误判成“服务没起”。 */
export async function healthy(port) {
  if (await probe(port, 4000)) return true;
  await new Promise((resolve) => setTimeout(resolve, 800));
  return Boolean(await probe(port, 6000));
}

function portable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function firstFreePort(preferred) {
  for (let port = preferred; port < preferred + 25 && port < 65535; port += 1) {
    if (await portable(port)) return port;
  }
  return null;
}

async function tailLog(lines = 4) {
  try {
    const text = readFileSync(logPath(), 'utf8').trimEnd().split('\n');
    return text.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 确保本机有一个能应答的牵丝服务。
 *
 * 候选端口的顺序是「显式指定 → QIANSI_PORT → 端口文件 → fallbackPorts」。
 * 只有全都没人应答时才会拉起内置服务；`fallbackPorts: []` 用于隔离测试，
 * 避免连到机器上另一个实例。
 *
 * @returns {Promise<{ok:boolean, port:number|null, started:boolean, pid?:number, reason?:string}>}
 */
export async function ensureServer({ port, timeoutMs = 30_000, fallbackPorts = [8787] } = {}) {
  const candidates = [port, process.env.QIANSI_PORT, readPortFile(), ...fallbackPorts]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);

  // 1. 已经有服务在跑（桌面版 / VS Code 面板 / 上一次插件拉起的）——直接复用。
  for (const candidate of new Set(candidates)) {
    if (await healthy(candidate)) return { ok: true, port: candidate, started: false };
  }

  // 2. 没有人应答，用包内自带的 bundle 起一个。
  const bundle = serverBundlePath();
  if (!existsSync(bundle)) {
    return {
      ok: false,
      port: null,
      started: false,
      reason: `本包缺少内置服务 ${bundle}`,
    };
  }

  const preferred = candidates[0] ?? 8787;
  const bindPort = await firstFreePort(preferred);
  if (!bindPort) {
    return { ok: false, port: null, started: false, reason: `端口 ${preferred} 附近没有空闲端口` };
  }

  let fd;
  try {
    mkdirSync(dirname(logPath()), { recursive: true });
    fd = openSync(logPath(), 'a');
    const child = spawn(process.execPath, [bundle], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, QIANSI_PORT: String(bindPort), QIANSI_DSH_SPAWNED: '1' },
    });
    child.unref();
    const pid = child.pid;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await probe(bindPort, 1000)) {
        // 服务端会把实际端口写进 server-port，动画顺序无关紧要，读一次以准为准。
        return { ok: true, port: bindPort, started: true, pid };
      }
      if (child.exitCode !== null) {
        return {
          ok: false,
          port: null,
          started: false,
          reason: `内置服务启动即退出（code ${child.exitCode}）\n${await tailLog()}`,
        };
      }
    }
    return {
      ok: false,
      port: null,
      started: false,
      reason: `${Math.round(timeoutMs / 1000)} 秒内没有就绪\n${await tailLog()}`,
    };
  } catch (error) {
    return {
      ok: false,
      port: null,
      started: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 停止本机服务（和 `qiansi stop` 走同一条管理接口）。 */
export async function stopServer(port) {
  const target = port ?? readPortFile() ?? 8787;
  try {
    const response = await fetch(`http://127.0.0.1:${target}/api/admin/stop`, {
      method: 'POST',
      headers: { 'x-qiansi-token': readToken() },
      signal: AbortSignal.timeout(4000),
    });
    return { ok: response.ok, port: target, status: response.status };
  } catch (error) {
    return { ok: false, port: target, reason: error instanceof Error ? error.message : String(error) };
  }
}
