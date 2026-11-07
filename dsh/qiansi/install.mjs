#!/usr/bin/env node
/**
 * Prepares the Qiansi DSH bundle.
 *
 *   node dsh/qiansi/install.mjs                    # generate cordis.patch.yml
 *   node dsh/qiansi/install.mjs --profile qiansi   # ...and install into a DSH profile
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

const dshHome = process.env.DSH_HOME ?? '';
const profile = flag('profile');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  return result.status ?? 1;
}

// 3. Optionally install into a profile. `dsh plugin add link:` runs pnpm and
//    pulls @deepseek-ai/dsh-mcp-client from the registry.
if (profile) {
  console.log(`\ninstalling into profile "${profile}"…`);
  const code = run('dsh', ['plugin', '--profile', profile, 'add', `link:${here}`]);
  if (code !== 0) {
    console.error('install failed; check that `dsh` is on PATH and the registry is reachable');
    process.exit(code);
  }
}

// 4. Optionally verify: dump the composed profile and grep for our entries.
const verify = flag('verify') ?? profile;
if (verify) {
  console.log(`\ncomposing profile "${verify}" with the patch…`);
  const result = spawnSync(
    'dsh',
    ['--profile', verify, '--patch', patchPath, '--dump-config'],
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
  dsh plugin --profile <name> add "link:${here}"
  dsh --profile <name>${dshHome ? '' : ''}   # boot; tools appear as mcp__qiansi__*`);
