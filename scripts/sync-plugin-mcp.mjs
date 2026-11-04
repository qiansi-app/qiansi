#!/usr/bin/env node
/**
 * The Claude Code and Codex plugins are copied into the host's cache on install,
 * so they cannot reach back into the repo with a relative path. They therefore
 * carry their own copy of the MCP server.
 *
 * Run `npm run plugin:sync` after editing packages/mcp/server.mjs, and
 * `npm run plugin:check` (CI) to catch drift.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'mcp', 'server.mjs');
const targets = [
  join(root, 'plugin', 'qiansi', 'mcp', 'server.mjs'),
  join(root, 'codex', 'plugin', 'mcp', 'server.mjs'),
];

const canonical = readFileSync(source, 'utf8');

if (process.argv.includes('--check')) {
  let stale = 0;
  for (const target of targets) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      console.error(`missing: ${target}`);
      stale += 1;
      continue;
    }
    if (current !== canonical) {
      console.error(`out of date: ${target}`);
      stale += 1;
    }
  }
  if (stale > 0) {
    console.error('run `npm run plugin:sync` to refresh the plugin copy');
    process.exit(1);
  }
  console.log('plugin mcp copy is in sync');
  process.exit(0);
}

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`synced ${target}`);
}
