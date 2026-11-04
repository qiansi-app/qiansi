#!/usr/bin/env node
/**
 * UserPromptSubmit hook: when the prompt is about the canvas, inject a compact
 * snapshot so Claude starts already knowing what is on the board.
 *
 * Never blocks the session: any failure (app closed, bad token, timeout) just
 * prints nothing and exits 0.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYWORDS =
  /画布|工作流|节点|连线|产物|任务|主控|编排|多\s*AI|牵丝|qiansi|canvas|workflow|orchestrat/i;
const SLASH_COMMAND = /^\/\S+/;

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

function resolveBase() {
  const fixed = process.env.QIANSI_URL ?? process.env.AGENTWEAVE_URL;
  return (fixed ?? `http://127.0.0.1:${readPort()}`).replace(/\/+$/, '');
}

async function readStdin() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  const raw = await readStdin();
  let prompt = '';
  try {
    prompt = String(JSON.parse(raw)?.prompt ?? '');
  } catch {
    return;
  }
  if (!prompt.trim()) return;
  if (SLASH_COMMAND.test(prompt.trim())) return;
  if (!KEYWORDS.test(prompt)) return;

  const base = resolveBase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${base}/api/canvas/summary`, {
      headers: { 'x-qiansi-token': readToken() },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const text = (await response.text()).trim();
    if (!text) return;
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `【牵丝画布现状】\n${text}\n\n画布地址：${base}（用户可以在那里直接拖动、缩放、编辑）`,
        },
      })}\n`
    );
  } catch {
    // app not running, timeout, or malformed response: stay silent
  } finally {
    clearTimeout(timer);
  }
}

await main();
