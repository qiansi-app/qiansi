#!/usr/bin/env node
/**
 * Installs the Qiansi DSH bundle into a profile.
 *
 * The bundle's patch is static: it resolves its own MCP server through the
 * profile's module graph at boot
 *
 *   !!js process.getBuiltinModule('node:module').createRequire(baseUrl)
 *        .resolve('qiansi-dsh/mcp/server.mjs')
 *
 * so there is nothing to generate and no absolute path to bake. This script
 * only creates a runnable profile, installs the bundle, and checks the result.
 *
 *   node dsh/qiansi/install.mjs --profile qiansi --template headless
 *   node dsh/qiansi/install.mjs --verify qiansi
 *   node dsh/qiansi/install.mjs --desktop --print
 *   node dsh/qiansi/install.mjs --desktop
 *   node dsh/qiansi/install.mjs --desktop --remove
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// 打包内必须自带 MCP server；仓库 checkout 里还要与源文件保持一致。
const bundled = join(here, 'mcp', 'server.mjs');
if (!existsSync(bundled)) {
  console.error(`缺少 ${bundled}；发布包应当自带 mcp/server.mjs`);
  process.exit(1);
}
const source = join(repo, 'packages', 'mcp', 'server.mjs');
if (existsSync(source)) {
  const strip = (text) =>
    text
      .split('\n')
      .filter((line) => !line.startsWith('// Generated from '))
      .join('\n')
      .trim();
  if (strip(readFileSync(source, 'utf8')) !== strip(readFileSync(bundled, 'utf8'))) {
    console.warn('提示：dsh/qiansi/mcp/server.mjs 与 packages/mcp/server.mjs 不一致，先跑 npm run plugin:sync');
  }
}
if (!existsSync(join(here, 'cordis.patch.yml'))) {
  console.error('缺少 cordis.patch.yml（bundle 层）');
  process.exit(1);
}

// 内置服务：发布包里必须有；仓库 checkout 里没有就先打一次（需要根目录的 esbuild）。
const serverBundle = join(here, 'server', 'server.cjs');
if (!existsSync(serverBundle)) {
  const buildScript = join(here, 'build-server.mjs');
  if (existsSync(join(repo, 'node_modules', 'esbuild'))) {
    console.log('内置服务还没有打包，先执行 build-server.mjs…');
    const build = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
    if (build.status !== 0) {
      console.error('内置服务打包失败；插件将只能复用已在运行的牵丝。');
    }
  } else {
    console.warn('提示：缺少 server/server.cjs 且仓库里没有 esbuild，插件只能复用已在运行的牵丝。');
  }
}

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

// `dsh plugin add` initializes a base-only profile, which has no app and
// therefore cannot boot. `--template <headless|web|tui>` first materializes
// the profile from that shipped template so the result is actually runnable.
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
  const code = run('dsh', ['plugin', '--profile', profile, 'add', `link:${here}`]);
  if (code !== 0) {
    console.error('install failed; check that `dsh` is on PATH and the registry is reachable');
    process.exit(code);
  }
  // bundle 的 dependencies 已声明 @deepseek-ai/dsh-mcp-client（hoisted 安装）。
  // 少数非 hoisted 布局下依赖可能不可达，这里补一次显式安装；失败只警告。
  const bridge = run('dsh', [
    'plugin',
    '--profile',
    profile,
    'add',
    '@deepseek-ai/dsh-mcp-client@0.2.2-rc.1',
  ]);
  if (bridge !== 0) {
    console.warn('提示：显式安装 MCP 桥失败；若启动后没有 mcp__qiansi__* 工具，再手动安装该包。');
  }
}

// Optionally verify: dump the composed profile and grep for our entries.
// 不加 --patch —— 装进 profile 后，bundle 自己的 cordis.patch.yml 就是层。
const verify = flag('verify') ?? profile;
if (verify) {
  console.log(`\ncomposing profile "${verify}"…`);
  const result = spawnSync('dsh', ['--profile', verify, '--dump-config'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
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

// Desktop app: the CLI refuses to manage its profile ("managed exclusively
// by the Electron application"), but cordis.patch.yml is documented as the
// user layer and is applied after every bundle. The desktop profile has no
// qiansi-dsh package in its module graph, so this path still uses an absolute
// entry into the repo checkout.
if (args.includes('--desktop')) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
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
  const entry = bundled.replace(/\\/g, '/');
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
  const withoutComments = current.replace(/^[ \t]*#.*$/gm, '').trim();
  const base = withoutComments === '[]' ? current.replace(/\[\][ \t]*(\r?\n)?$/, '') : current;
  const trimmed = base.replace(/\s*$/, '');

  copyFileSync(patchFile, backup);
  writeFileSync(patchFile, `${trimmed}${trimmed.trim() ? '\n\n' : '\n'}${block}`, 'utf8');
  console.log(`已写入 ${patchFile}\n备份：${backup}`);
  console.log('重启 DeepSeek Harness 后，会话里会出现 mcp__qiansi__* 工具。');
  console.log('（插件自带画布服务：本机没有牵丝在跑时，它会自己拉起一个。）');
  process.exit(0);
}

console.log(`\nnext:
  dsh --profile ${profile ?? '<name>'}            # boot; the bundled canvas server starts on demand
  QIANSI_DSH_DEBUG=1 dsh --profile ${profile ?? '<name>'}   # same, with our status line on stderr`);
