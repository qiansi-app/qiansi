#!/usr/bin/env node
/**
 * Prepares the Qiansi DSH bundle.
 *
 *   node dsh/qiansi/install.mjs                    # generate cordis.patch.yml
 *   node dsh/qiansi/install.mjs --profile qiansi --template headless
 *                                                  # create a runnable profile and install into it
 *   node dsh/qiansi/install.mjs --verify qiansi    # compose the profile and show our entries
 *   node dsh/qiansi/install.mjs --desktop --print  # show the desktop-app layer, write nothing
 *   node dsh/qiansi/install.mjs --desktop          # append it to the desktop profile's user layer
 *   node dsh/qiansi/install.mjs --desktop --remove # take it back out
 *
 * The patch is generated rather than shipped because DSH evaluates `args` at
 * boot, before the bundle knows its own path; baking the absolute path in at
 * install time is the only deterministic option.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

// 5. Desktop app: the CLI refuses to manage its profile ("managed exclusively
//    by the Electron application"), but cordis.patch.yml is documented as the
//    user layer and is applied after every bundle. One insert entry is enough:
//    @deepseek-ai/dsh-mcp-client resolves from the dsh installation, so the
//    desktop profile needs no pnpm install and no package.json change.
if (args.includes('--desktop')) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  // --patch-file 指向别处，方便在模板 profile 上演练同一段 YAML。
  const patchFile =
    flag('patch-file') ?? join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  if (!existsSync(patchFile)) {
    console.error(`找不到桌面版 profile 的用户层：${patchFile}`);
    console.error('先启动一次 DeepSeek Harness（桌面版），它会生成这个文件。');
    process.exit(1);
  }

  const START = '# >>> qiansi-mcp (install.mjs)';
  const END = '# <<< qiansi-mcp (install.mjs)';
  const nodePath = process.execPath.replace(/\\/g, '/');
  const block = [
    START,
    '- insert:',
    '    # 牵丝画布 MCP：工具以 mcp__qiansi__* 注册。',
    '    # 不需要 pnpm 安装——@deepseek-ai/dsh-mcp-client 随 dsh 安装目录解析。',
    '    - id: qiansi-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: qiansi',
    '        transport: stdio',
    `        command: '${nodePath}'`,
    '        args:',
    `          - '${entry}'`,
    '        env:',
    '          QIANSI_AGENT: dsh',
    '        toolCallTimeoutMs: 120000',
    END,
    '',
  ].join('\n');

  const current = readFileSync(patchFile, 'utf8');
  const hasBlock = current.includes(START);

  if (args.includes('--print')) {
    console.log(block);
    process.exit(0);
  }

  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const backup = `${patchFile}.bak-${Date.now()}`;

  if (args.includes('--remove')) {
    if (!hasBlock) {
      console.log('桌面版的用户层里没有牵丝，无需移除。');
      process.exit(0);
    }
    copyFileSync(patchFile, backup);
    writeFileSync(
      patchFile,
      current.replace(new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n?`), ''),
      'utf8'
    );
    console.log(`已移除。备份：${backup}\n重启 DeepSeek Harness 生效。`);
    process.exit(0);
  }

  if (hasBlock) {
    console.log('桌面版用户层里已经有牵丝了，跳过。要移除用 --desktop --remove。');
    process.exit(0);
  }

  // 模板 profile 的用户层是「注释 + []」；直接往后追加会变成两个根节点。
  // 只有空数组时把 [] 摘掉再写。
  const withoutComments = current.replace(/^[ \t]*#.*$/gm, '').trim();
  const base = withoutComments === '[]' ? current.replace(/\[\][ \t]*(\r?\n)?$/, '') : current;
  const trimmed = base.replace(/\s*$/, '');

  copyFileSync(patchFile, backup);
  writeFileSync(patchFile, `${trimmed}${trimmed.trim() ? '\n\n' : '\n'}${block}`, 'utf8');
  console.log(`已写入 ${patchFile}\n备份：${backup}`);
  console.log('重启 DeepSeek Harness 后，会话里会出现 mcp__qiansi__* 工具。');
  console.log('（牵丝服务要先跑起来；没起时插件不会注册任何工具。）');
  process.exit(0);
}

console.log(`\nnext:
  dsh --profile ${profile ?? '<name>'}            # boot; mcp__qiansi__* appear once the canvas service is up
  QIANSI_DSH_DEBUG=1 dsh --profile ${profile ?? '<name>'}   # same, with our status line on stderr`);
