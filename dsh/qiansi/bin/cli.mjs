#!/usr/bin/env node
/**
 * qiansi-dsh CLI。
 *
 *   qiansi-dsh mcp            启动 MCP server（DSH 的 patch 用它作为 stdio 子进程）
 *   qiansi-dsh install        把组合包装进 DSH profile（转发 install.mjs）
 *   qiansi-dsh status         探测本机牵丝服务是否可达，打印端口与工具命名空间
 *   qiansi-dsh server start   现在就把内置的牵丝服务拉起来（插件启动时也会自动做）
 *   qiansi-dsh server stop    停止本机服务
 *
 * 发布到 npm 后，DSH 组合包的 patch 可以写 `npx -y qiansi-dsh@<version> mcp`
 * 而不再依赖安装时生成的绝对路径。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureServer, logPath, readPortFile, stopServer } from '../server-bridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? '';
const rest = process.argv.slice(3);

function stateDir() {
  return process.env.QIANSI_HOME ?? join(homedir(), '.qiansi');
}

function readPort() {
  try {
    const value = Number(readFileSync(join(stateDir(), 'server-port'), 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {
    // 没有端口文件：应用还没在本机跑过
  }
  return Number(process.env.QIANSI_PORT ?? 8787);
}

async function status() {
  const port = readPort();
  const url = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      console.log(`qiansi-dsh ${version()} · canvas reachable at ${url} · tools are mcp__qiansi__*`);
      if (body?.version) console.log(`qiansi server version ${body.version}`);
      return 0;
    }
    console.error(`qiansi-dsh: canvas answered HTTP ${response.status} at ${url}`);
    return 1;
  } catch {
    console.error(`qiansi-dsh: canvas not reachable at ${url} — run \`qiansi-dsh server start\`, or let the DSH plugin start it automatically`)
    return 1;
  }
}

async function serverCommand(sub) {
  if (sub === 'start') {
    const result = await ensureServer({});
    if (!result.ok) {
      console.error(`qiansi-dsh: ${result.reason ?? 'could not start the bundled server'}`);
      console.error(`log: ${logPath()}`);
      return 1;
    }
    console.log(
      result.started
        ? `started bundled qiansi server at http://127.0.0.1:${result.port} (pid ${result.pid})`
        : `qiansi already running at http://127.0.0.1:${result.port}`
    );
    console.log(`log: ${logPath()}`);
    return 0;
  }
  if (sub === 'stop') {
    const result = await stopServer(readPortFile() ?? undefined);
    if (!result.ok) {
      console.error(`qiansi-dsh: stop failed at port ${result.port} (${result.reason ?? `HTTP ${result.status}`})`);
      return 1;
    }
    console.log(`stopped qiansi server on port ${result.port}`);
    return 0;
  }
  if (sub === 'status' || sub === undefined) return status();
  console.error('usage: qiansi-dsh server <start|stop|status>');
  return 2;
}

function version() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
}

async function mcp() {
  // 直接在当前进程加载 server：DSH 以 stdio 子进程方式调用它。
  await import(new URL('../mcp/server.mjs', import.meta.url));
}

function install() {
  const script = join(here, '..', 'install.mjs');
  if (!existsSync(script)) {
    console.error('qiansi-dsh: install.mjs is missing from this package');
    return 1;
  }
  const child = spawn(process.execPath, [script, ...rest], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
  return null;
}

async function main() {
  if (command === 'mcp') {
    await mcp();
    return 0;
  }
  if (command === 'install') {
    const pending = install();
    if (pending !== null) return pending;
    return new Promise(() => {}); // install() 退出时自行 process.exit
  }
  if (command === 'status') return status();
  if (command === 'server') return serverCommand(rest[0]);
  console.error('usage: qiansi-dsh <mcp|install|status|server>');
  console.error('  mcp              start the MCP server over stdio (used by the DSH bundle patch)');
  console.error('  install          install this bundle into a DSH profile');
  console.error('  status           probe the local Qiansi server');
  console.error('  server start     start the Qiansi server bundled in this package (the plugin also does this)');
  console.error('  server stop      stop the local Qiansi server');
  console.error('  server status    alias of `status`');
  return 2;
}

main().then((code) => {
  if (typeof code === 'number') process.exit(code);
});
