#!/usr/bin/env node
/**
 * Prepares the Qiansi DSH bundle.
 *
 *   node dsh/qiansi/install.mjs                    # generate cordis.patch.yml
 *   node dsh/qiansi/install.mjs --profile qiansi --template headless
 *                                                  # create a runnable profile and install into it
 *   node dsh/qiansi/install.mjs --verify qiansi    # compose the profile and show our entries
 *
 * The patch is generated rather than shipped because DSH evaluates `args` at
 * boot, before the bundle knows its own path; baking the absolute path in at
 * install time is the only deterministic option.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

// 1. Bundle its own copy of the MCP server: the profile links this directory,
//    so the child process must live inside it.
const mcpDir = join(here, 'mcp');
mkdirSync(mcpDir, { recursive: true });
const mcpSource = join(repo, 'packages', 'mcp', 'server.mjs');
const mcpTarget = join(mcpDir, 'server.mjs');
copyFileSync(mcpSource, mcpTarget);
console.log(`mcp server → ${mcpTarget}`);

// 2. Generate the patch with the absolute entry path.
const template = readFileSync(join(here, 'cordis.patch.yml.tpl'), 'utf8');
const entry = mcpTarget.replace(/\\/g, '/');
const patch = template.replace('__QIANSI_MCP_ENTRY__', entry);
const patchPath = join(here, 'cordis.patch.yml');
writeFileSync(patchPath, patch, 'utf8');
console.log(`patch → ${patchPath}`);
console.log(`  entry: ${entry}`);

const profile = flag('profile');
const templateName = flag('template');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  return result.status ?? 1;
}

// 3. Optionally install into a profile.
//    `dsh plugin add` initializes a base-only profile, which has no app and
//    therefore cannot boot. `--template <headless|web|tui>` first materializes
//    the profile from that shipped template so the result is actually runnable.
if (profile && templateName) {
  console.log(`\ninitializing profile "${profile}" from template "${templateName}"…`);
  const init = spawnSync(
    'dsh',
    ['--profile', profile, '--from-default-profile', templateName, '--dump-config'],
    { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 }
  );
  if (init.status !== 0) {
    console.error(init.stderr?.trim() || `template "${templateName}" not available`);
    process.exit(init.status ?? 1);
  }
}

if (profile) {
  console.log(`\ninstalling into profile "${profile}"…`);
  let code = run('dsh', ['plugin', '--profile', profile, 'add', `link:${here}`]);
  if (code !== 0) {
    console.error('install failed; check that `dsh` is on PATH and the registry is reachable');
    process.exit(code);
  }
  // 桥接包没有 dsh.bundle，不会成为 profile 层；必须显式装进 profile，
  // 否则补丁里引用的 '@deepseek-ai/dsh-mcp-client' 解析不到。
  code = run('dsh', ['plugin', '--profile', profile, 'add', '@deepseek-ai/dsh-mcp-client@0.2.2-rc.1']);
  if (code !== 0) {
    console.error('mcp bridge install failed; the MCP tools will not register without it');
    process.exit(code);
  }
}

// 4. Optionally verify: dump the composed profile and grep for our entries.
//    不加 --patch —— 装进 profile 后，bundle 自己的 cordis.patch.yml 就是层。
const verify = flag('verify') ?? profile;
if (verify) {
  console.log(`\ncomposing profile "${verify}"…`);
  const result = spawnSync(
    'dsh',
    ['--profile', verify, '--dump-config'],
    { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 }
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const lines = output.split(/\r?\n/);
  const hits = lines.filter((line) => /qiansi/i.test(line));
  console.log(result.status === 0 ? 'dump-config: OK' : `dump-config exited ${result.status}`);
  for (const line of hits.slice(0, 12)) console.log(`  ${line.trim()}`);
  if (!hits.length) {
    console.error('  no qiansi entries in the composed config — patch did not apply');
    process.exit(1);
  }
}

console.log(`\nnext:
  dsh --profile ${profile ?? '<name>'}            # boot; mcp__qiansi__* appear once the canvas service is up
  QIANSI_DSH_DEBUG=1 dsh --profile ${profile ?? '<name>'}   # same, with our status line on stderr`);
