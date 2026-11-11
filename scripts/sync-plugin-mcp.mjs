#!/usr/bin/env node
/**
 * The Claude Code and Codex plugins are copied into the host's cache on install,
 * so they cannot reach back into the repo with a relative path. They therefore
 * carry their own copy of the MCP server.
 *
 * Run `npm run plugin:sync` after editing packages/mcp/server.mjs, and
 * `npm run plugin:check` (CI) to catch drift.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'mcp', 'server.mjs');
const targets = [
  join(root, 'plugin', 'qiansi', 'mcp', 'server.mjs'),
  join(root, 'codex', 'plugin', 'mcp', 'server.mjs'),
];

// 副本头部标注来源：插件被拷进宿主缓存后无法反查仓库路径。
const banner =
  '// Generated from packages/mcp/server.mjs by scripts/sync-plugin-mcp.mjs; do not edit.\n';

/** 把生成说明插在 shebang 之后（shebang 必须留在第一行）。 */
function withBanner(text) {
  if (!text.startsWith('#!')) return banner + text;
  const end = text.indexOf('\n');
  if (end === -1) return `${text}\n${banner}`;
  return `${text.slice(0, end + 1)}${banner}${text.slice(end + 1)}`;
}

const canonical = withBanner(readFileSync(source, 'utf8'));

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
  writeFileSync(target, canonical);
  console.log(`synced ${target}`);
}
