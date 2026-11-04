#!/usr/bin/env node
/**
 * Codex SessionStart hook: inject a compact canvas snapshot into the session so
 * the agent never has to guess what is on the board.
 *
 * Silent on every failure (app closed, no token, timeout) so a broken canvas
 * never blocks a Codex session from starting.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function readToken() {
  if (process.env.QIANSI_TOKEN) return process.env.QIANSI_TOKEN;
  for (const dir of ['.qiansi', '.agentweave']) {
    try {
      return readFileSync(join(homedir(), dir, 'server-token'), 'utf8').trim();
    } catch {
      // try the next location
    }
  }
  return '';
}

/** The packaged app picks a free port; it publishes the live one to server-port. */
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

const base = (
  process.env.QIANSI_URL ??
  process.env.AGENTWEAVE_URL ??
  `http://127.0.0.1:${readPort()}`
).replace(/\/+$/, '');

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 2500);

try {
  const response = await fetch(`${base}/api/canvas/summary`, {
    headers: { 'x-qiansi-token': readToken() },
    signal: controller.signal,
  });
  if (response.ok) {
    const text = (await response.text()).trim();
    if (text) {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: `【牵丝画布现状】\n${text}\n\n画布地址：${base}（用户可以在牵丝应用里直接拖动、缩放、编辑；MCP 工具 qiansi 可读写）`,
          },
        })}\n`
      );
    }
  }
} catch {
  // app not running or timed out: stay silent
} finally {
  clearTimeout(timer);
}
