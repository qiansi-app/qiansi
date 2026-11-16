#!/usr/bin/env node
/**
 * 把「做牵丝」这次会话蒸馏成可交接的数据包，供另一台机器（SSH 实例）上的
 * Qoder / Claude 接手。
 *
 *   node scripts/pack-handoff.mjs                       # 打包本会话 + 项目文档 + 记忆
 *   node scripts/pack-handoff.mjs --all                 # 所有牵丝会话
 *   node scripts/pack-handoff.mjs --push user@host      # 打包后 scp 到远端
 *   node scripts/pack-handoff.mjs --raw                 # 额外带上原始 JSONL（很大）
 *
 * 设计要点：
 *   - 原始记录 140MB 起步，直接搬过去既传不动、模型也读不了，所以逐行流式解析，
 *     只留「谁说了什么、调了什么工具、结论是什么」，工具返回压成一行摘要；
 *   - 全量脱敏：这次会话里出现过 npm 令牌明文，任何形似密钥的串一律替换；
 *   - 产出带清单与校验和，远端可离线核对。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const repo = resolve(value('repo', process.cwd()));
const sessionDir = resolve(value('sessions', join(homedir(), '.claude', 'projects', 'e-------')));
const memoryDir = resolve(value('memory', join(sessionDir, 'memory')));
const currentSession = value('session', '2c2bf8e7-57b4-4e18-8b35-157ed3168bdf');
const outDir = resolve(
  value('out', join(repo, 'dist', `qiansi-handoff-${new Date().toISOString().slice(0, 10)}`))
);
const includeRaw = flag('raw');
const pushTarget = value('push', '');
const maxText = Number(value('max-text', 1200));

// ── 脱敏 ────────────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  // 阈值放低：会话里真实出现过「grep 前 8 位」「命令被截断只剩 3 位」的残片，
  // 长阈值会漏掉它们。
  [/npm_[A-Za-z0-9]{6,}/g, 'npm_[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]'],
  [/ghp_[A-Za-z0-9]{10,}/g, 'ghp_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{10,}/g, 'github_pat_[REDACTED]'],
  [/AKIA[0-9A-Z]{12,}/g, 'AKIA[REDACTED]'],
  [/xox[baprs]-[A-Za-z0-9-]{6,}/g, 'xox[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ.[REDACTED]'],
  [/((?:api[_-]?key|access[_-]?token|authToken|secret|password)["'\s:=]{1,6})([A-Za-z0-9_\-+/=]{12,})/gi, '$1[REDACTED]'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1[REDACTED]'],
];
let redactions = 0;
/** 写入后仍可见的 [REDACTED] 标记数：给人核对的是这个数，不是正则命中数。 */
let visibleRedactions = 0;
function redact(text) {
  if (!text) return text;
  let output = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, ...rest) => {
      redactions += 1;
      return typeof replacement === 'string' ? replacement.replace('$1', rest[0] ?? '') : '[REDACTED]';
    });
  }
  // 被截断/引用的令牌残片（不足 6 位）不满足上面的长度阈值，但只要它出现在
  // 认证参数旁边就照样抹掉——`:_authToken=npm_Ikfw…` 这种正是审计抓到的形态。
  output = output.replace(/((?:authToken|Authorization|Bearer|token=)\s*[:=]?\s*)npm_([A-Za-z0-9]{1,})/gi, (match, prefix) => {
    redactions += 1;
    return `${prefix}npm_[REDACTED]`;
  });
  return output;
}

/** 清单里的路径必须是 POSIX：Linux 的 sha256sum 把反斜杠当普通字符。 */
const toPosix = (path) => String(path).split(/[\\/]/).filter(Boolean).join('/');

const clip = (text, max = maxText) => {
  const clean = String(text ?? '').replace(/\r/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…（截断，原 ${clean.length} 字）` : clean;
};

// ── 会话蒸馏 ────────────────────────────────────────────────────────────
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const preferred = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'];
  for (const key of preferred) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return `${key}=${input[key]}`;
    }
  }
  return JSON.stringify(input);
}

async function distillSession(file) {
  const lines = [];
  let entries = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const toolTally = new Map();
  let firstTs = '';
  let lastTs = '';

  const stream = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of stream) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    entries += 1;
    const ts = entry.timestamp ?? '';
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    const type = entry.type ?? '';
    const message = entry.message;
    if (type !== 'user' && type !== 'assistant') continue;
    if (!message) continue;
    const content = message.content;
    const when = ts ? ts.slice(0, 19).replace('T', ' ') : '';
    const side = entry.isSidechain ? ' (子代理)' : '';

    if (typeof content === 'string') {
      const text = clip(redact(content));
      if (!text.trim()) continue;
      if (type === 'user') userMessages += 1;
      else assistantMessages += 1;
      lines.push(`\n**[${when}] ${type === 'user' ? '用户' : '助手'}${side}**\n\n${text}\n`);
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = clip(redact(block.text));
        if (text.trim()) parts.push(text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        const text = clip(redact(block.thinking), 400);
        if (text.trim()) parts.push(`（思考）${text}`);
      } else if (block.type === 'tool_use') {
        toolCalls += 1;
        toolTally.set(block.name, (toolTally.get(block.name) ?? 0) + 1);
        parts.push(`→ 工具 \`${block.name}\` ${clip(redact(summarizeToolInput(block.name, block.input)), 160)}`);
      } else if (block.type === 'tool_result') {
        // 工具返回占体积的绝大部分，只留「有没有出错」这一个事实。
        const failed = block.is_error === true;
        parts.push(failed ? '← 工具返回：失败' : '← 工具返回：完成');
      } else if (block.type === 'image') {
        parts.push('［图片］');
      }
    }
    if (!parts.length) continue;
    if (type === 'user') userMessages += 1;
    else assistantMessages += 1;
    lines.push(`\n**[${when}] ${type === 'user' ? '用户' : '助手'}${side}**\n\n${parts.join('\n\n')}\n`);
  }

  const header = [
    `# 会话 ${basename(file, '.jsonl')}`,
    '',
    `- 原始条目：${entries}`,
    `- 用户 / 助手消息：${userMessages} / ${assistantMessages}`,
    `- 工具调用：${toolCalls}`,
    `- 时间范围：${firstTs || '?'} → ${lastTs || '?'}`,
    `- 工具分布：${[...toolTally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => `${name}×${count}`)
      .join('、')}`,
    '',
    '> 工具返回已压成「完成/失败」；密钥类字符串已替换为 [REDACTED]。',
    '',
  ].join('\n');
  return { text: header + lines.join(''), stats: { entries, userMessages, assistantMessages, toolCalls } };
}

// ── 文件工具 ────────────────────────────────────────────────────────────
const manifest = [];
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function writeOut(relPath, content) {
  const target = join(outDir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  writeFileSync(target, data);
  // 清单路径统一 POSIX：Linux 的 sha256sum 不认反斜杠。
  manifest.push({ path: toPosix(relPath), bytes: data.length, sha256: sha256(data) });
}

function copyInto(relPath, sourcePath) {
  const data = readFileSync(sourcePath);
  writeOut(relPath, data);
}

function copyDirInto(relPrefix, sourceDir, filter = () => true) {
  if (!existsSync(sourceDir)) return 0;
  let count = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const sourcePath = join(sourceDir, entry.name);
    if (!filter(sourcePath)) continue;
    copyInto(join(relPrefix, entry.name), sourcePath);
    count += 1;
  }
  return count;
}

/** 递归拷贝（docs/decisions 这种子目录也要带上，README 里全是指向它们的链接）。 */
function copyTreeInto(relPrefix, sourceDir, filter = () => true) {
  if (!existsSync(sourceDir)) return 0;
  let count = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      count += copyTreeInto(join(relPrefix, entry.name), sourcePath, filter);
      continue;
    }
    if (!entry.isFile() || !filter(sourcePath)) continue;
    copyInto(join(relPrefix, entry.name), sourcePath);
    count += 1;
  }
  return count;
}

// ── 主流程 ──────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });

const sessionFiles = existsSync(sessionDir)
  ? readdirSync(sessionDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(sessionDir, name))
      .filter((file) => flag('all') || file.includes(currentSession))
  : [];
if (!sessionFiles.length) {
  console.error(`找不到会话记录：${sessionDir}`);
  process.exit(1);
}

const transcriptStats = [];
for (const file of sessionFiles) {
  const id = basename(file, '.jsonl');
  process.stdout.write(`蒸馏 ${id} … `);
  const started = Date.now();
  const { text, stats } = await distillSession(file);
  writeOut(join('transcripts', `${id}.md`), text);
  const visibleMarkers = (text.match(/\[REDACTED\]/g) ?? []).length;
  visibleRedactions += visibleMarkers;
  transcriptStats.push({
    id,
    ...stats,
    chars: text.length,
    bytes: Buffer.byteLength(text),
    redactedMarkers: visibleMarkers,
  });
  console.log(`${(text.length / 1024).toFixed(0)} KB / ${stats.toolCalls} 次工具调用 / ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (includeRaw) {
    const gz = await import('node:zlib');
    const raw = readFileSync(file);
    const compressed = gz.gzipSync(raw, { level: 9 });
    writeOut(join('raw', `${id}.jsonl.gz`), compressed);
  }
}

// 项目文档与历史
const docsCount = copyTreeInto('project/docs', join(repo, 'docs'), (file) => extname(file) === '.md');
copyInto('project/CHANGELOG.md', join(repo, 'CHANGELOG.md'));
copyInto('project/README.md', join(repo, 'README.md'));
for (const extra of ['README.zh-CN.md', 'LICENSE']) {
  if (existsSync(join(repo, extra))) copyInto(join('project', extra), join(repo, extra));
}
let gitLog = '';
try {
  gitLog = execFileSync('git', ['-C', repo, 'log', '--oneline', '-n', '400'], { encoding: 'utf8' });
} catch {
  gitLog = '（读不到 git 历史）';
}
const gitCommitCount = gitLog.split('\n').filter((line) => line.trim()).length;
writeOut('project/git-log.txt', redact(gitLog));

// 记忆
const memoryFiles = existsSync(memoryDir)
  ? readdirSync(memoryDir).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').length
  : 0;
let memoryIndexed = 0;
try {
  memoryIndexed = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('- [')).length;
} catch {
  memoryIndexed = 0;
}
const memoryCount = copyDirInto('memory', memoryDir, (file) => extname(file) === '.md');

// 交接说明
writeOut(
  'PROJECT.md',
  [
    '# 牵丝 Qiansi · 交接说明',
    '',
    '这套数据来自「搭建牵丝」的完整开发会话，目标是让另一台机器上的 Qoder（或任何 agent）',
    '接着往下做，而不用重新摸索。',
    '',
    '## 本包不含源码',
    '',
    '代码在 GitHub（Public）：`git clone https://github.com/qiansi-app/qiansi.git` 后 `npm install`。',
    '实例连不上 github.com 时用 tarball 或镜像；生成这个包的脚本 `scripts/pack-handoff.mjs` 也在仓库里。',
    '',
    '## 环境要求',
    '',
    '- **Node ≥ 22.3（建议 24）**、npm ≥ 10、git；低于这个版本 `npm install` 或启动会直接失败；',
    '- **模型 Key**：Windows 桌面版用 DPAPI 保险库；**Linux 没有 DPAPI**，改用环境变量',
    '  `DEEPSEEK_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `MINIMAX_API_KEY` / `MOONSHOT_API_KEY` / `ZHIPU_API_KEY`',
    '  （完整表见 `project/docs/server-api.md`）；',
    '- **端口**：服务只监听 `127.0.0.1:8787`，Studio 在 `5173`。在 SSH 实例上看界面：',
    '',
    '  ```bash',
    '  ssh -L 5173:127.0.0.1:5173 -L 8787:127.0.0.1:8787 user@your-host',
    '  # 然后本机浏览器打开 http://127.0.0.1:5173',
    '  ```',
    '',
    '## 目录',
    '',
    '| 路径 | 内容 |',
    '|---|---|',
    '| `transcripts/` | 会话蒸馏稿：每轮谁说了什么、调用了什么工具、结论是什么 |',
    '| `project/` | README（中英）、CHANGELOG、docs 全量（含 `decisions/` 三份 ADR）、LICENSE、最近提交 |',
    '| `memory/` | 长期记忆（环境坑、约定、口径） |',
    '| `MANIFEST.json` / `MANIFEST.sha256` | 每个文件的 sha256 与体积（路径为 POSIX，Linux 可直接校验） |',
    '',
    '## 接手顺序',
    '',
    '0. `git clone` 仓库并 `npm install`；',
    `1. 读 \`project/README.md\` 与 \`project/CHANGELOG.md\` 最近三条——功能现状与轮次记录都在里面（仓库共 ${gitCommitCount} 次提交，全文在 \`project/git-log.txt\`）；`,
    `2. 读 \`memory/MEMORY.md\`（${memoryIndexed} 条索引，包内 ${memoryFiles} 条记忆）——踩过的坑都在这里；`,
    '3. 跑验收：`project/docs/acceptance.md` 列了每项检查的命令、覆盖点与期望输出；',
    '4. 需要细节时按关键词在 `transcripts/` 里搜：`rg -n "关键词" transcripts/`。',
    '',
    '## 重要口径',
    '',
    '- 密钥不入库、不进日志：本包已把形似密钥的串替换为 `[REDACTED]`；',
    '- 隔离测试用 `QIANSI_HOME` + 独立端口：**Linux 上不要用 `USERPROFILE`**（那是 Windows 的旧办法），',
    '  停进程用 `ss -ltnp | grep <port>` 取 pid 再 `kill`；',
    '- npm 发布：账号 **weiweiwei357**，令牌由项目所有者持有、不入包；GitHub 账号是 **weiweiwei567**，两者不是同一个；',
    '- 工具返回在这份蒸馏稿里只保留「完成/失败」，需要原文请回原始会话。',
    '',
  ].join('\n')
);

writeOut(
  'README.md',
  [
    '# 牵丝交接包',
    '',
    `生成时间：${new Date().toISOString()}`,
    `来源机器：${process.env.COMPUTERNAME ?? 'unknown'} · 仓库：${repo}`,
    '',
    '## 怎么用到 SSH 实例上',
    '',
    '```bash',
    '# 本机（打包机）——脚本在 qiansi 仓库的 scripts/pack-handoff.mjs',
    'node scripts/pack-handoff.mjs --push user@your-host',
    '',
    '# 或者手动',
    'scp -r <本目录> user@your-host:~/qiansi-handoff',
    '```',
    '',
    '远端解包后核对完整性（清单路径是 POSIX 的，Linux/macOS 直接可用）：',
    '',
    '```bash',
    'ssh user@your-host',
    'cd ~/qiansi-handoff',
    'sha256sum -c MANIFEST.sha256',
    '```',
    '',
    '文件多时建议加 `--quiet`，只关心失败项：`sha256sum -c --quiet MANIFEST.sha256`。',
    '',
    '## 在 Qoder 里导入',
    '',
    '1. Qoder 用 **Remote-SSH** 打开远端机器上的项目目录（先 `git clone https://github.com/qiansi-app/qiansi.git`）；',
    '2. 把 `~/qiansi-handoff` 同时加入工作区（或在 Qoder 里打开整个 `qiansi-handoff` 文件夹）；',
    '3. 让 agent 先读 `PROJECT.md`，再按它给的顺序读 README / CHANGELOG / memory / docs/acceptance.md；',
    '4. 需要全文检索时用 `rg -n "关键词" transcripts/`。',
    '',
    '## 统计',
    '',
    `- 会话 ${transcriptStats.length} 份，蒸馏后 ${(transcriptStats.reduce((sum, item) => sum + item.bytes, 0) / 1024).toFixed(0)} KB（磁盘体积）`,
    `- 文档 ${docsCount} 篇（含 decisions/）、记忆 ${memoryCount} 个文件（索引 ${memoryIndexed} 条）`,
    `- 脱敏标记 ${visibleRedactions} 处（写入后可见数）`,
    '',
  ].join('\n')
);

// 清单 + 校验和
writeOut(
  'MANIFEST.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: { repo, sessionDir, memoryDir },
      sessions: transcriptStats,
      redactions: visibleRedactions,
      redactionMatches: redactions,
      files: manifest,
    },
    null,
    2
  )
);
writeOut(
  'MANIFEST.sha256',
  manifest.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n'
);

const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(
  `\n交接包：${outDir}\n  ${manifest.length} 个文件 · ${(totalBytes / 1024 / 1024).toFixed(2)} MB · 脱敏 ${visibleRedactions} 处可见标记（正则命中 ${redactions} 次）`
);

// 自我核对：包里不允许残留任何已知密钥形态
const leaks = [];
const audit = (text, where) => {
  for (const [pattern] of SECRET_PATTERNS) {
    const found = String(text).match(pattern);
    if (found) leaks.push(`${where}: ${found[0].slice(0, 24)}`);
  }
  const contextual = String(text).match(
    /(?:authToken|Authorization|Bearer|token=)\s*[:=]?\s*npm_[A-Za-z0-9]{1,}/i
  );
  if (contextual) leaks.push(`${where}: ${contextual[0].slice(0, 24)}`);
};
for (const entry of manifest) {
  if (!entry.path.endsWith('.md') && !entry.path.endsWith('.json') && !entry.path.endsWith('.txt')) continue;
  try {
    audit(readFileSync(join(outDir, entry.path), 'utf8'), entry.path);
  } catch {
    // 二进制文件跳过
  }
}
console.log(leaks.length === 0 ? '密钥自检：未发现残留' : `密钥自检：发现 ${leaks.length} 处残留\n${leaks.slice(0, 10).join('\n')}`);

if (pushTarget) {
  console.log(`\n推送到 ${pushTarget} …`);
  const remotePath = value('push-path', `~/qiansi-handoff`);
  execFileSync('ssh', [pushTarget, `mkdir -p ${remotePath}`], { stdio: 'inherit' });
  execFileSync('scp', ['-r', `${outDir}/.`, `${pushTarget}:${remotePath}`], { stdio: 'inherit' });
  execFileSync('ssh', [pushTarget, `cd ${remotePath} && (sha256sum -c MANIFEST.sha256 >/dev/null && echo "远端校验：OK" || echo "远端校验：失败")`], {
    stdio: 'inherit',
  });
}

process.exitCode = leaks.length === 0 ? 0 : 1;
