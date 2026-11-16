#!/usr/bin/env node
/**
 * 校验 dsh/marketplace/index.json 是否符合 DSH 插件市场索引格式 1。
 *
 *   优先使用本机 DSH 自带的官方校验器（@deepseek-ai/dsh-plugin-market-index）；
 *   没装 DSH 时退化为结构检查（字段、图标大小、安装目标），仍然能挡住常见错误。
 *
 *   node dsh/marketplace/validate.mjs [index.json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(process.argv[2] ?? join(here, 'index.json'));
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const value = JSON.parse(readFileSync(file, 'utf8'));
const indexUrl = 'https://raw.githubusercontent.com/qiansi-app/qiansi/main/dsh/marketplace/index.json';

// 1. 官方校验器（存在就用，它才是真源）
const candidates = [
  join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-plugin-market-index',
    'lib',
    'index.js'
  ),
  join(homedir(), '.dsh', 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js'),
].filter((path) => path && existsSync(path));

let official = null;
for (const path of candidates) {
  try {
    official = await import(pathToFileURL(path).href);
    break;
  } catch {
    // 换下一个候选
  }
}

if (official) {
  try {
    const parsed = official.parseMarketIndex(value, indexUrl);
    check('官方校验器通过', true);
    console.log(
      `  INFO format=${parsed.format} plugins=${parsed.plugins.length} versions=${parsed.plugins
        .map((plugin) => plugin.versions.length)
        .join(',')}`
    );
    for (const plugin of parsed.plugins) {
      const version = plugin.versions[0];
      const target = official.marketInstallTarget(plugin.name, version);
      console.log(`  INFO ${plugin.name}@${version.version} → ${JSON.stringify(target)}`);
    }
  } catch (error) {
    check('官方校验器通过', false, error instanceof Error ? error.message : String(error));
  }
} else {
  console.log('  INFO 未找到本机 DSH，改用结构检查');
  check('format=1', value.format === 1);
  check('title 带 en 回退', Boolean(value.title?.en));
  check('plugins 非空', Array.isArray(value.plugins) && value.plugins.length > 0);
  for (const plugin of value.plugins ?? []) {
    check(`${plugin.name}: 有 npm 名称`, typeof plugin.name === 'string' && plugin.name.length > 0);
    check(`${plugin.name}: 版本非空`, Array.isArray(plugin.versions) && plugin.versions.length > 0);
    for (const version of plugin.versions ?? []) {
      check(
        `${plugin.name}@${version.version}: 精确 SemVer`,
        /^\d+\.\d+\.\d+$/.test(version.version ?? '')
      );
      check(
        `${plugin.name}@${version.version}: 安装源合法`,
        version.source?.type === 'npm' || version.source?.type === 'git'
      );
      check(
        `${plugin.name}@${version.version}: publishTimestamp 是 Unix 秒`,
        Number.isInteger(version.publishTimestamp) && version.publishTimestamp > 1_500_000_000
      );
    }
    if (typeof plugin.icon === 'string' && plugin.icon.startsWith('data:')) {
      const base64 = plugin.icon.split(',')[1] ?? '';
      check(`${plugin.name}: 内联图标 ≤32KiB`, Buffer.from(base64, 'base64').length <= 32 * 1024);
    }
  }
}

console.log(failed === 0 ? '\nMARKET INDEX OK' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
