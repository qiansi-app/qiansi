#!/usr/bin/env node
/**
 * 发布前自检：qiansi-dsh 能不能被 DSH 当成组合包安装、能不能进插件市场索引。
 * 不需要网络，不触发发布。
 *
 *   node dsh/qiansi/pack-check.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
check('包名 qiansi-dsh', pkg.name === 'qiansi-dsh', pkg.name);
check('版本是精确 SemVer', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
check('没有 private 标记', pkg.private !== true);
check('声明 MIT 许可证', pkg.license === 'MIT', pkg.license);
check('声明 dsh.bundle.patch', Boolean(pkg.dsh?.bundle?.patch), JSON.stringify(pkg.dsh));
check('声明 engines.dsh 兼容范围', Boolean(pkg.engines?.dsh), JSON.stringify(pkg.engines));
const nodeEngine = String(pkg.engines?.node ?? '');
check('声明 engines.node ≥22.3（!!js 需要 getBuiltinModule）', /^>=22\.(3|[4-9]|[1-9]\d)/.test(nodeEngine), nodeEngine);
check('声明 npm 关键词 dsh-plugin', (pkg.keywords ?? []).includes('dsh-plugin'));
check('仓库地址带目录', Boolean(pkg.repository?.url && pkg.repository?.directory));

const required = [
  'index.js',
  'bin/cli.mjs',
  'mcp/server.mjs',
  'cordis.patch.yml',
  'install.mjs',
  'README.md',
  'LICENSE',
];
for (const file of required) {
  const path = join(here, file);
  check(`文件存在 ${file}`, existsSync(path) && statSync(path).size > 0);
}
check('files 列表覆盖运行必需文件', (pkg.files ?? []).includes('mcp/server.mjs'));

const patch = existsSync(join(here, 'cordis.patch.yml'))
  ? readFileSync(join(here, 'cordis.patch.yml'), 'utf8')
  : '';
check('patch 含 qiansi-mcp 行', patch.includes('qiansi-mcp'));
check('patch 使用 dsh-mcp-client', patch.includes('@deepseek-ai/dsh-mcp-client'));
check(
  'patch 用 createRequire(baseUrl) 自解析（无需安装器写死路径）',
  patch.includes("createRequire(baseUrl)") && !patch.includes('__QIANSI_MCP_ENTRY__')
);
check('patch 不含绝对路径', !/[A-Za-z]:[\\/](Users|AgentWeave)/.test(patch));

// 工具数量：发布说明写的 43 个必须和实际一致
const toolSource = readFileSync(join(here, 'mcp', 'server.mjs'), 'utf8');
const toolCount = (toolSource.match(/^    name: '[a-z_]+',$/gm) ?? []).length;
check('MCP 工具数量 ≥ 40', toolCount >= 40, String(toolCount));
if (existsSync(join(here, 'README.md'))) {
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  check('README 的工具数量与代码一致', readme.includes(`共 ${toolCount} 个`), `README 未写 ${toolCount}`);
}

// mcp server 与仓库源同步（CI 同样由 plugin:check 检查）
const source = readFileSync(join(root, 'packages', 'mcp', 'server.mjs'), 'utf8');
const bundled = readFileSync(join(here, 'mcp', 'server.mjs'), 'utf8');
const stripBanner = (text) =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('// Generated from '))
    .join('\n');
check('mcp/server.mjs 与源文件一致', stripBanner(bundled).trim() === stripBanner(source).trim());

// 市场索引
const marketPath = join(root, 'dsh', 'marketplace', 'index.json');
check('市场索引存在', existsSync(marketPath));
if (existsSync(marketPath)) {
  const market = JSON.parse(readFileSync(marketPath, 'utf8'));
  check('索引 format=1', market.format === 1);
  check('索引 title 带 en', Boolean(market.title?.en));
  const entry = (market.plugins ?? []).find((plugin) => plugin.name === pkg.name);
  check('索引含 qiansi-dsh', Boolean(entry));
  if (entry) {
    check('索引版本与包一致', (entry.versions ?? []).some((v) => v.version === pkg.version));
    check('索引声明 engines.dsh', Boolean(entry.versions?.[0]?.engines?.dsh));
    check('索引带图标', typeof entry.icon === 'string' && entry.icon.startsWith('data:image/'));
  }
}

console.log(failed === 0 ? '\nPACK OK' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
