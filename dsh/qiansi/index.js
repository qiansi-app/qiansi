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

async function healthy(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
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

export const name = 'qiansi-dsh';

export async function apply(ctx, config = {}) {
  const port = readPort();
  const up = await healthy(port);
  if (up) {
    ctx.logger?.info?.(
      `[qiansi] canvas reachable at http://127.0.0.1:${port} — tools are mcp__${config.serverName ?? 'qiansi'}__*`
    );
  } else {
    ctx.logger?.warn?.(
      `[qiansi] canvas not reachable at http://127.0.0.1:${port}. ` +
        'Start the Qiansi desktop app (or the VS Code canvas panel) first; ' +
        'the MCP bridge will connect on the next host restart.'
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
