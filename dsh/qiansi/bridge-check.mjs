#!/usr/bin/env node
/**
 * 自带服务的自检：插件在不依赖任何外部进程的前提下，能不能把画布拉起来、
 * 复用已有实例、并且不重复起第二个。
 *
 *   node dsh/qiansi/bridge-check.mjs
 *
 * 服务端把状态写在 os.homedir() 下，所以隔离靠覆盖 USERPROFILE/HOME，
 * 并关掉 8787 兜底端口——否则会连到本机另一个真实实例上，测不出东西。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'qiansi-bridge-check-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const port = await freePort();
process.env.QIANSI_PORT = String(port);

const { ensureServer, probe, stopServer, logPath } = await import(
  new URL('./server-bridge.mjs', import.meta.url).href
);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

async function waitDown(ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!(await probe(port, 800))) return true;
  }
  return false;
}

let startedPid = null;
try {
  const first = await ensureServer({ fallbackPorts: [] });
  startedPid = first.pid ?? null;
  check('首次调用把内置服务拉起来', first.ok && first.started, JSON.stringify(first));
  check('端口与 QIANSI_PORT 一致', first.port === port, `${first.port} vs ${port}`);
  check('健康检查应答', Boolean(await probe(port)));

  const second = await ensureServer({ fallbackPorts: [] });
  check('再次调用复用同一实例', second.ok && second.started === false, JSON.stringify(second));
  check('复用时不换端口', second.port === port, `${second.port} vs ${port}`);

  const stopped = await stopServer(port);
  check('stopServer 能停掉服务', stopped.ok || stopped.status === 401, JSON.stringify(stopped));
  if (!stopped.ok && startedPid) process.kill(startedPid);
  check('停止后不再应答', await waitDown());
  startedPid = null;

  // 插件入口本身（DSH 真正调用的 apply）也要能从零把服务拉起来。
  const plugin = await import(new URL('./index.js', import.meta.url).href);
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  await plugin.apply({ logger }, { fallbackPorts: [] });
  const statusLine = logs.join(' | ');
  const pidMatch = statusLine.match(/pid (\d+)/);
  if (pidMatch) startedPid = Number(pidMatch[1]);
  check('插件 apply() 自动拉起服务', /canvas started/.test(statusLine), statusLine);
  check('插件拉起的服务可应答', Boolean(await probe(port)));
  check('插件 describe() 能看到内置服务', plugin.describe().serverBundlePresent === true, JSON.stringify(plugin.describe()));

  await stopServer(port);
  check('插件拉起的服务能停掉', await waitDown());
  console.log(`  INFO log path used: ${logPath()}`);
} finally {
  if (startedPid) {
    try {
      process.kill(startedPid);
    } catch {
      // 已经退出
    }
  }
  rmSync(home, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nBRIDGE OK' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
