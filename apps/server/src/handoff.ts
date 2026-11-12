import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from '@qiansi/engine';

/**
 * 接续外部 agent 的会话：从 Claude Code / Codex 的真实记录里取最近的工作，
 * 加上项目自身的事实，合成一份可以注入画布运行的资料包。
 *
 * 一切都在本地完成。会话文件可能几十 MB，所以只从文件尾部读一段；内容在进入
 * 资料包之前统一过 redactSecrets——会话里贴过 key 是常态，不能跟着进提示词。
 */

export type HandoffSource = 'claude-code' | 'codex';

export interface HandoffSession {
  source: HandoffSource;
  file: string;
  sessionId: string;
  /** 会话所属项目目录（从会话记录里的 cwd 读出来）。 */
  projectCwd?: string;
  updatedAt: number;
  messageCount: number;
  userAsks: string[];
  conclusions: string[];
  tools: string[];
  hasErrors: boolean;
}

export interface HandoffProject {
  cwd: string;
  branch: string;
  files: string[];
  readme: string;
  packageName: string;
  scripts: string[];
  dirty: boolean;
}

export interface HandoffPack {
  markdown: string;
  bytes: number;
  session: HandoffSession | null;
  project: HandoffProject | null;
  notes: string[];
}

/** Claude Code encodes a project path by replacing every non-alphanumeric with '-'. */
export function encodeProjectDir(cwd: string): string {
  // 尾部分隔符会让编码结果多一个 '-'，和真实目录名对不上，静默落到别的项目。
  return String(cwd ?? '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase();
}

function newestJsonl(dir: string, depth = 0): string | null {
  if (!existsSync(dir) || depth > 4) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const entry of entries) {
    const full = join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const nested = newestJsonl(full, depth + 1);
      if (nested) {
        const nestedInfo = statSync(nested);
        if (!best || nestedInfo.mtimeMs > best.mtime) {
          best = { path: nested, mtime: nestedInfo.mtimeMs };
        }
      }
      continue;
    }
    if (!entry.endsWith('.jsonl')) continue;
    if (!best || info.mtimeMs > best.mtime) best = { path: full, mtime: info.mtimeMs };
  }
  return best?.path ?? null;
}

/** Reads only the tail of a file — transcripts reach tens of megabytes. */
function readTail(file: string, maxBytes: number): string {
  const info = statSync(file);
  const start = Math.max(0, info.size - maxBytes);
  const length = info.size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  // The first line is almost certainly cut in half; drop it when we trimmed.
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') return record.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as Record<string, unknown>).type === 'tool_use'
        ? String((part as Record<string, unknown>).name ?? '')
        : ''
    )
    .filter(Boolean);
}

/**
 * 真用户消息的判定：Claude Code 的 jsonl 里 tool_result 也挂着 role=user，
 * 不滤掉的话，「Tool loaded.」这类工具返回会被当成用户需求交给编排器。
 */
export function isRealUserText(entry: Record<string, unknown>, text: string): boolean {
  if (!text) return false;
  const message = entry.message as { content?: unknown } | undefined;
  if (Array.isArray(message?.content)) {
    const blocks = message.content as Array<Record<string, unknown>>;
    if (blocks.some((block) => block?.type === 'tool_result')) return false;
    if (!blocks.some((block) => block?.type === 'text')) return false;
  }
  const stripped = text.trim();
  if (stripped.length < 8) return false;
  // 系统注入与命令回显不是用户的话
  if (/^<[^>]+>|^Caveat:/.test(stripped)) return false;
  // 整行都是方括号标记的也是系统噪音：[Request interrupted by user …] 等
  if (/^\[[^\]]+\]$/.test(stripped)) return false;
  if (stripped.startsWith('[command-name]')) return false;
  // 纯 ASCII 短词（Tool loaded. / (no content)）不是需求
  if (!/[一-龥]|[a-zA-Z]{4,}/.test(stripped)) return false;
  return true;
}

/**
 * 从文件尾分块回扫，直到找到 wantAsks 条「真正的用户文本消息」。
 * 会话文件可能有上百 MB（工具输出很大），固定窗口会整段错过最新需求。
 */
function collectRecentAsks(file: string, wantAsks = 4, maxBytes = 256 * 1024 * 1024): string[] {
  const info = statSync(file);
  const chunkSize = 1024 * 1024;
  const asks: string[] = [];
  let pos = info.size;
  let scanned = 0;
  let carry = "";
  const parseAsk = (line: string): string | null => {
    if (!line.includes(USER_ROLE_MARK)) return null;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const message = entry.message as { content?: unknown } | undefined;
      const content = message?.content;
      const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
      if (blocks.some((block) => block?.type === "tool_result")) return null;
      const text = Array.isArray(content)
        ? blocks.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join(NEWLINE)
        : typeof content === "string"
          ? content
          : "";
      const stripped = text.trim();
      if (stripped.length < 8 || stripped.startsWith("<") || /^\[[^\]]+\]$/.test(stripped)) return null;
      return stripped;
    } catch {
      return null;
    }
  };
  while (pos > 0 && scanned < maxBytes && asks.length < wantAsks) {
    const len = Math.min(chunkSize, pos);
    pos -= len;
    scanned += len;
    const buffer = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, len, pos);
    } finally {
      closeSync(fd);
    }
    const combined = buffer.toString("utf8") + carry;
    const parts = combined.split(LINE_BREAK);
    carry = pos > 0 ? (parts.shift() ?? "") : "";
    for (let index = parts.length - 1; index >= 0 && asks.length < wantAsks; index -= 1) {
      const ask = parseAsk(parts[index]);
      if (ask) asks.unshift(ask);
    }
  }
  if (pos === 0 && carry.trim() && asks.length < wantAsks) {
    const ask = parseAsk(carry);
    if (ask) asks.unshift(ask);
  }
  return asks;
}
export function recentClaudeAsks(file: string, want = 3): string[] {
  try {
    return collectRecentAsks(file, want);
  } catch {
    return [];
  }
}

const LINE_BREAK = String.fromCharCode(10);
const NEWLINE = String.fromCharCode(10);
const USER_ROLE_MARK = String.fromCharCode(34) + "role" + String.fromCharCode(34) + ":" + String.fromCharCode(34) + "user" + String.fromCharCode(34);

/**
 * 读最近一段 Claude Code 会话。
 *
 * 指定 cwd 时只读该项目的会话（没有就说明没有，不拿别的项目顶替）；
 * 没有指定时读**全局最新**的那个——用户刚在别的项目里和 agent 说话，
 * 服务端的 cwd 却还停在启动目录，按 cwd 找会接管到几周前的旧会话。
 */
export function readClaudeSession(cwd?: string): HandoffSession | null {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const file = cwd
    ? newestJsonl(join(projectsRoot, encodeProjectDir(cwd)))
    : newestJsonl(projectsRoot);
  return file ? readClaudeSessionFile(file) : null;
}

/** 全机器最新的 Claude Code 会话文件（实时接管用来判断盯哪个文件）。 */
export function latestClaudeSessionFile(): string | null {
  return newestJsonl(join(homedir(), '.claude', 'projects'));
}

/** 读指定会话文件：实时接管盯住一个固定文件时用它。 */
export function readClaudeSessionFile(file: string): HandoffSession | null {
  let raw = '';
  try {
    raw = readTail(file, 512 * 1024);
  } catch {
    return null;
  }

  // 用户消息常常被超大的工具输出压在几十 MB 之外：单独回扫到文件头。
  const userAsks: string[] = collectRecentAsks(file, 4);
  const conclusions: string[] = [];
  const tools = new Set<string>();
  let messageCount = 0;
  let hasErrors = false;
  let sessionId = '';
  let projectCwd = '';

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.sessionId === 'string' && entry.sessionId) sessionId = entry.sessionId;
    if (typeof entry.cwd === 'string' && entry.cwd) projectCwd = entry.cwd;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    const role = message?.role ?? (typeof entry.type === 'string' ? entry.type : '');
    if (!message && !entry.type) continue;
    messageCount += 1;
    const text = asText(message?.content).trim();
    for (const name of toolNames(message?.content)) tools.add(name);
    if (typeof entry.type === 'string' && /error/i.test(entry.type)) hasErrors = true;
    if (!text) continue;
    if (role === 'assistant') {
      if (text.length > 40) conclusions.push(text);
    }
  }

  const info = statSync(file);
  return {
    source: 'claude-code',
    file,
    sessionId: sessionId || file.split(/[\\/]/).pop()?.replace('.jsonl', '') || '',
    projectCwd: projectCwd || undefined,
    updatedAt: info.mtimeMs,
    messageCount,
    userAsks: userAsks.slice(-6),
    conclusions: conclusions.slice(-4),
    tools: [...tools].slice(0, 20),
    hasErrors,
  };
}

export function readCodexSession(): HandoffSession | null {
  const root = join(homedir(), '.codex', 'sessions');
  const file = newestJsonl(root);
  if (!file) return null;
  let raw = '';
  try {
    raw = readTail(file, 256 * 1024);
  } catch {
    return null;
  }
  const userAsks: string[] = [];
  const conclusions: string[] = [];
  const tools = new Set<string>();
  let messageCount = 0;
  let hasErrors = false;
  let projectCwd = '';

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    messageCount += 1;
    const payload = (entry.payload ?? entry) as Record<string, unknown>;
    // Codex 的会话记录也带 cwd；有的话项目事实就跟着它会话走。
    if (typeof payload.cwd === 'string' && payload.cwd) projectCwd = payload.cwd;
    else if (typeof entry.cwd === 'string' && entry.cwd) projectCwd = entry.cwd;
    const type = String(payload.type ?? entry.type ?? '');
    const role = String(payload.role ?? '');
    const text = asText(payload.content ?? payload.text ?? payload.message).trim();
    if (type.includes('error') || /error/i.test(String(payload.status ?? ''))) hasErrors = true;
    if (/function_call|tool/.test(type) && typeof payload.name === 'string') tools.add(payload.name);
    if (!text) continue;
    if (role === 'user' && isRealUserText({ message: payload }, text)) userAsks.push(text);
    if (role === 'assistant' && text.length > 40) conclusions.push(text);
  }

  const info = statSync(file);
  return {
    source: 'codex',
    file,
    sessionId: file.split(/[\\/]/).pop()?.replace('.jsonl', '') ?? '',
    projectCwd: projectCwd || undefined,
    updatedAt: info.mtimeMs,
    messageCount,
    userAsks: userAsks.slice(-6),
    conclusions: conclusions.slice(-4),
    tools: [...tools].slice(0, 20),
    hasErrors,
  };
}

function git(cwd: string, args: string[]): string {
  try {
    // 接续可能从 VS Code 扩展宿主（无控制台）里发起：不隐藏的话每个 git
    // 调用都会在 Windows 上闪一个黑色控制台窗口。
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

export function readProject(cwd: string): HandoffProject | null {
  if (!existsSync(cwd)) return null;
  const readmeFile = ['README.zh-CN.md', 'README.md', 'README'].find((name) =>
    existsSync(join(cwd, name))
  );
  let readme = '';
  if (readmeFile) {
    try {
      readme = readFileSync(join(cwd, readmeFile), 'utf8').slice(0, 2400);
    } catch {
      readme = '';
    }
  }

  let packageName = '';
  let scripts: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
    packageName = String(pkg.name ?? '');
    scripts = Object.keys((pkg.scripts as Record<string, unknown>) ?? {}).slice(0, 12);
  } catch {
    // no package.json: still fine
  }

  const files = git(cwd, ['ls-files'])
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 60);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = Boolean(git(cwd, ['status', '--porcelain']));

  return { cwd, branch, files, readme, packageName, scripts, dirty };
}

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function buildHandoffPack(input: {
  cwd: string;
  source?: HandoffSource | 'auto';
  session?: HandoffSession | null;
  project?: HandoffProject | null;
  /** 指定会话文件：实时接管盯住的那一个。 */
  sessionFile?: string;
}): HandoffPack {
  const notes: string[] = [];
  let session = input.session ?? null;
  if (!session && input.sessionFile) {
    session = readClaudeSessionFile(input.sessionFile);
    if (!session) notes.push(`指定的会话文件不可读：${input.sessionFile}`);
  }
  if (!session) {
    session =
      input.source === 'codex'
        ? readCodexSession()
        : input.source === 'claude-code'
          ? readClaudeSession(input.cwd)
          : // 指定了项目目录就不拿别的项目/来源的会话顶替；留空才全局找最新的。
            input.cwd
            ? readClaudeSession(input.cwd)
            : readClaudeSession() ?? readCodexSession();
    if (!session) notes.push('没有找到可读的 agent 会话记录（Claude Code 或 Codex）。');
  }
  // 会话来自哪个项目，就以哪个项目为「项目事实」；调用方显式指定的 cwd 优先。
  const projectCwd = input.cwd || session?.projectCwd || process.cwd();
  if (!input.cwd && !session?.projectCwd) {
    notes.push(`无法从会话确定项目目录，项目事实按服务端目录 ${process.cwd()} 读取。`);
  }
  const project = input.project ?? readProject(projectCwd);
  if (input.cwd && session?.projectCwd && session.projectCwd !== input.cwd) {
    notes.push(`会话来自 ${session.projectCwd}；项目事实按你指定的 ${input.cwd} 读取。`);
  }

  const ageMinutes = session ? Math.round((Date.now() - session.updatedAt) / 60000) : null;

  const lines: string[] = [
    '# 接续上下文（由牵丝从外部 agent 会话与项目自动提取）',
    '',
    session
      ? `## 来源会话\n- 来源：${session.source}\n- 会话：${session.sessionId}\n- 文件：${session.file}\n- 最近活动：${ageMinutes} 分钟前 · 解析到 ${session.messageCount} 条记录\n- 用过的工具：${session.tools.join('、') || '（未解析到）'}${session.hasErrors ? '\n- 会话中出现过错误' : ''}\n- 注意：以下内容是自动摘录，不是逐字事实来源；关键结论请回原会话核对。`
      : '## 来源会话\n未找到。以下只有项目上下文。',
    '',
  ];

  if (session?.userAsks.length) {
    lines.push('## 用户最近在要求什么（原文摘录）');
    for (const ask of session.userAsks) lines.push(`- ${clip(redactSecrets(ask, []), 400)}`);
    lines.push('');
  }
  if (session?.conclusions.length) {
    lines.push('## agent 最近给出的结论（摘录）');
    for (const conclusion of session.conclusions) {
      lines.push(`- ${clip(redactSecrets(conclusion, []), 700)}`);
    }
    lines.push('');
  }

  if (project) {
    lines.push('## 项目');
    lines.push(`- 目录：${project.cwd}`);
    lines.push(`- 分支：${project.branch || '（非 git 仓库）'}${project.dirty ? ' · 有未提交改动' : ''}`);
    if (project.packageName) lines.push(`- 包名：${project.packageName}`);
    if (project.scripts.length) lines.push(`- 脚本：${project.scripts.join('、')}`);
    if (project.files.length) {
      lines.push(`- 文件（前 ${project.files.length} 条）：`);
      for (const file of project.files) lines.push(`  - ${file}`);
    }
    if (project.readme) {
      lines.push('');
      lines.push('## README 摘录');
      lines.push(clip(redactSecrets(project.readme, []), 2400));
    }
    lines.push('');
  } else {
    notes.push(`项目目录不可读：${input.cwd}`);
  }

  const markdown = `${lines.join('\n')}\n`;
  const safe = redactSecrets(markdown, []);
  return {
    markdown: safe,
    bytes: Buffer.byteLength(safe, 'utf8'),
    session,
    project,
    notes,
  };
}
