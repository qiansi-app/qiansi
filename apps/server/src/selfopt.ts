import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * 自我优化（自省循环）。
 *
 * 一轮 = 体检（跑类型检查/测试、读 git 与 TODO）→ 对标（联网找竞品与论文）
 * → 复盘（旗舰模型基于证据产出问题清单）→ 执行（逐条改代码、校验、提交）
 * → 记录（版本快照，可切换）。
 *
 * 三条设计约束，其它都从这里推：
 * 1. 只依据证据下判断：复盘提示里给什么，就只能引用什么，避免模型编造 API。
 * 2. 改动必须可回滚：逐条改动、逐条校验、逐条提交；任一步失败就 checkout 回去。
 * 3. 密钥永不入仓：提交前扫一遍暂存差异，命中即中止并回滚。
 */

export type SelfOptMode = 'repair' | 'harden' | 'polish' | 'value' | 'evolve';
export type SelfOptLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type FindingKind = 'bug' | 'security' | 'perf' | 'ux' | 'docs' | 'value' | 'research';

export interface ModeSpec {
  id: SelfOptMode;
  label: string;
  blurb: string;
  /** 这一档允许处理的问题类别；越往上越宽。 */
  kinds: FindingKind[];
  /** 是否允许联网找竞品/论文。 */
  search: boolean;
  /** 写到界面上的「做什么 / 不做什么」。 */
  does: string[];
  avoids: string[];
}

export interface LevelSpec {
  id: SelfOptLevel;
  label: string;
  blurb: string;
  /** 是否允许改文件。 */
  writes: boolean;
  /** 是否允许提交（只有能提交的档位才产生版本）。 */
  commits: boolean;
  /** 是否按预算循环多轮。 */
  iterates: boolean;
  /** 单条问题最多改几个文件。 */
  maxFilesPerFinding: number;
}

export const SELFOPT_MODES: ModeSpec[] = [
  {
    id: 'repair',
    label: '修错',
    blurb: '只修真实报错：类型错误、失败测试、崩溃、明显缺陷',
    kinds: ['bug'],
    search: false,
    does: ['修类型错误与失败测试', '修崩溃与明显逻辑缺陷', '补必要的边界判断'],
    avoids: ['不改架构', '不调依赖版本', '不做产品/商业判断', '不联网'],
  },
  {
    id: 'harden',
    label: '加固',
    blurb: '修错 + 安全、可靠性、性能',
    kinds: ['bug', 'security', 'perf'],
    search: false,
    does: ['修错', '补安全边界与输入校验', '去掉明显的性能退化', '补失败路径处理'],
    avoids: ['不改变对外行为', '不做界面改版', '不联网'],
  },
  {
    id: 'polish',
    label: '打磨',
    blurb: '加固 + 体验细节、文档、错误提示',
    kinds: ['bug', 'security', 'perf', 'ux', 'docs'],
    search: false,
    does: ['加固', '改错误提示与空状态', '补/改文档', '整理重复代码'],
    avoids: ['不新增功能模块', '不改产品定位', '不联网'],
  },
  {
    id: 'value',
    label: '增值',
    blurb: '打磨 + 竞品对标、定位与增长假设',
    kinds: ['bug', 'security', 'perf', 'ux', 'docs', 'value'],
    search: true,
    does: ['打磨', '联网对标竞品', '找定位与增长上的差距', '把差距转成可执行的小改动'],
    avoids: ['不编造市场数据', '不做需要后端服务的功能', '不承诺做不到的事'],
  },
  {
    id: 'evolve',
    label: '探索',
    blurb: '增值 + 论文与前沿技术实验',
    kinds: ['bug', 'security', 'perf', 'ux', 'docs', 'value', 'research'],
    search: true,
    does: ['增值', '联网读论文与技术进展', '做隔离的小实验', '实验不达标就丢弃'],
    avoids: ['不把未验证的实验合进主线', '不引入重依赖', '不编造引用'],
  },
];

export const SELFOPT_LEVELS: LevelSpec[] = [
  { id: 'L1', label: '巡检', blurb: '只体检和出报告，不改任何文件', writes: false, commits: false, iterates: false, maxFilesPerFinding: 0 },
  { id: 'L2', label: '建议', blurb: '出报告 + 每条问题的具体改法（只给，不落盘）', writes: false, commits: false, iterates: false, maxFilesPerFinding: 0 },
  { id: 'L3', label: '小步', blurb: '自动改低风险项，每项单独校验并提交', writes: true, commits: true, iterates: false, maxFilesPerFinding: 3 },
  { id: 'L4', label: '深改', blurb: '允许跨文件重构，仍逐项校验提交', writes: true, commits: true, iterates: false, maxFilesPerFinding: 12 },
  { id: 'L5', label: '持续', blurb: '按预算循环：改完一批再复盘一批，直到预算或目标耗尽', writes: true, commits: true, iterates: true, maxFilesPerFinding: 6 },
];

export function findMode(id: string): ModeSpec | undefined {
  return SELFOPT_MODES.find((item) => item.id === id);
}

export function findLevel(id: string): LevelSpec | undefined {
  return SELFOPT_LEVELS.find((item) => item.id === id);
}

export function describeSelfOpt() {
  return {
    modes: SELFOPT_MODES,
    levels: SELFOPT_LEVELS,
    defaultBudget: { tokens: 120_000, rounds: 3 },
    safety: [
      '只在 git 仓库里运行；工作区不干净时，写代码的档位直接拒绝',
      '每次提交前扫描暂存差异，发现疑似密钥即中止并回滚',
      '只改仓库内文件，不越出目录',
      '从不自动 push；版本只留在本地分支与标签上',
      '任何一步校验失败都会把这一条改动 checkout 回去',
    ],
  };
}

// ---------------------------------------------------------------------------
// 预算预测
// ---------------------------------------------------------------------------

export interface ForecastHistory {
  mode: string;
  level: string;
  expected: number;
  actual: number;
}

export interface SelfOptForecast {
  mode: SelfOptMode;
  level: SelfOptLevel;
  budget: number;
  findings: number;
  rounds: number;
  low: number;
  expected: number;
  high: number;
  /** 预测偏高还是偏低，以及预估的轮数是否受预算限制。 */
  overBudget: boolean;
  cappedByBudget: boolean;
  basis: string;
  calibratedFrom: number;
  calibrationRatio: number;
}

const clampNumber = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 可计算的估算：先按结构化成本拼出「一轮」，再乘轮数，最后用历史实测比值校准。
 * 系数来自牵丝自己的运行记录（一次复盘约 9k，一条实现约 9–14k）。
 */
export function forecastSelfOpt(input: {
  mode: SelfOptMode;
  level: SelfOptLevel;
  budget: number;
  findings?: number;
  history?: ForecastHistory[];
}): SelfOptForecast {
  const mode = findMode(input.mode) ?? SELFOPT_MODES[0];
  const level = findLevel(input.level) ?? SELFOPT_LEVELS[0];
  const budget = Math.max(1000, Math.round(input.budget || 120_000));
  const findings = clampNumber(Math.round(input.findings ?? 4), 1, 12);

  const survey = 1_500;
  const search = mode.search ? 6_000 : 0;
  const reflect = 9_000;
  const proposeOnly = level.id === 'L2' ? findings * 2_500 : 0;
  const perApply =
    level.id === 'L3' ? 9_000 : level.id === 'L4' ? 14_000 : level.id === 'L5' ? 10_000 : 0;

  const round = survey + search + reflect + proposeOnly + findings * perApply;
  const rawRounds = level.iterates ? Math.floor(budget / Math.max(1, round)) : 1;
  const rounds = level.iterates ? clampNumber(rawRounds, 1, 8) : 1;
  const cappedByBudget = level.iterates && rawRounds > 8;

  let expected = round * rounds;
  const history = (input.history ?? []).filter(
    (item) => item.mode === mode.id && item.level === level.id && item.expected > 0 && item.actual > 0
  );
  const ratio = history.length
    ? clampNumber(median(history.map((item) => item.actual / item.expected)), 0.4, 3)
    : 1;
  expected = Math.round(expected * ratio);

  const low = Math.round(expected * 0.6);
  const high = Math.round(expected * 1.7);
  const basis = [
    `体检 ${survey}`,
    mode.search ? `对标 ${search}` : '',
    `复盘 ${reflect}`,
    proposeOnly ? `建议 ${proposeOnly}` : '',
    perApply ? `实现 ${findings}×${perApply}` : '',
  ]
    .filter(Boolean)
    .join(' + ');
  return {
    mode: mode.id,
    level: level.id,
    budget,
    findings,
    rounds,
    low,
    expected,
    high,
    overBudget: expected > budget,
    cappedByBudget,
    basis: `${basis} = 每轮 ${round}，${rounds} 轮${history.length ? `，按历史 ×${ratio.toFixed(2)} 校准` : ''}`,
    calibratedFrom: history.length,
    calibrationRatio: Number(ratio.toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// 密钥扫描
// ---------------------------------------------------------------------------

export interface SecretHit {
  rule: string;
  line: string;
}

const SECRET_RULES: Array<{ id: string; re: RegExp }> = [
  { id: 'openai-sk', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'anthropic-sk-ant', re: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/ },
  { id: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'qiansi-token-file', re: /server-token|vault\.json|keys\.json/ },
];

/** 只看新增行（diff 里以 + 开头、非 +++ 的行）。 */
export function scanSecrets(diffText: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const raw of diffText.split(/\r?\n/)) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    for (const rule of SECRET_RULES) {
      if (rule.re.test(line)) {
        hits.push({ rule: rule.id, line: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// JSON 提取（模型输出常夹带说明或被截断）
// ---------------------------------------------------------------------------

export function extractJsonObject(text: string): string | null {
  const source = String(text ?? '').trim();
  if (!source) return null;
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1] ?? '', source];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return candidate.slice(start, index + 1);
      }
    }
  }
  return null;
}

export function parseJson<T>(text: string): T | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SelfOptDeps {
  stateDir: string;
  audit: (entry: { actor: string; action: string; target?: string; detail?: Record<string, unknown> }) => void;
  chat: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: { maxTokens: number; timeoutMs: number }
  ) => Promise<{ text: string; usage: { total: number } }>;
  search?: (query: string, maxResults: number) => Promise<Array<{ title: string; url: string; snippet?: string }>>;
  runShell?: (cmdLine: string, timeoutMs: number, cwd: string) => Promise<ShellResult>;
  runGit?: (args: string[], cwd: string) => Promise<ShellResult>;
}

export type SelfOptStageId = 'survey' | 'benchmark' | 'reflect' | 'apply' | 'verify' | 'snapshot';

export interface SelfOptStage {
  id: SelfOptStageId;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  tokens?: number;
}

export interface SelfOptFinding {
  id: string;
  title: string;
  kind: FindingKind;
  area: string;
  severity: 'high' | 'medium' | 'low';
  evidence: string;
  proposal: string;
  risk: 'low' | 'medium' | 'high';
  acceptance: string;
  estTokens: number;
  files: string[];
  status: 'proposed' | 'applied' | 'skipped' | 'failed';
  note?: string;
  commit?: string;
}

export interface SelfOptVersion {
  id: string;
  commit: string;
  short: string;
  baseCommit: string;
  baseBranch: string;
  mode: SelfOptMode;
  level: SelfOptLevel;
  findingId: string;
  title: string;
  tokens: number;
  files: string[];
  sessionId: string;
  createdAt: number;
}

export interface SelfOptSession {
  id: string;
  rootDir: string;
  mode: SelfOptMode;
  level: SelfOptLevel;
  budget: { maxTokens: number; maxRounds: number };
  status: 'running' | 'done' | 'failed' | 'stopped';
  round: number;
  usedTokens: number;
  startedAt: number;
  finishedAt?: number;
  stages: SelfOptStage[];
  findings: SelfOptFinding[];
  versions: string[];
  baseCommit?: string;
  baseBranch?: string;
  forecast?: SelfOptForecast;
  /** 用户要求的每轮问题数上限；缺省按档位。 */
  requestedFindings?: number;
  error?: string;
  log: string[];
}

export interface SelfOptMeta {
  ok: boolean;
  error?: string;
  rootDir: string;
  branch?: string;
  head?: string;
  dirty?: string[];
  clean?: boolean;
  scripts?: Record<string, string>;
  modes: ModeSpec[];
  levels: LevelSpec[];
  defaultBudget: { tokens: number; rounds: number };
  safety: string[];
}

export interface SelfOptStartOptions {
  rootDir: string;
  mode: SelfOptMode;
  level: SelfOptLevel;
  maxTokens?: number;
  maxRounds?: number;
  findings?: number;
  allowDirty?: boolean;
  actor?: string;
}

interface SurveyReport {
  at: number;
  checks: Array<{ name: string; cmd: string; ok: boolean; code: number; ms: number; summary: string }>;
  branch: string;
  dirty: string[];
  recentCommits: string[];
  recentFiles: string[];
  recentDiff: string;
  todos: Array<{ file: string; line: number; text: string }>;
  files: Array<{ path: string; loc: number; exports: string[]; hot: number }>;
  scripts: Record<string, string>;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|css|md)$/i;
const IGNORED_PATH = /(^|\/)(node_modules|dist|build|\.git|coverage|release)(\/|$)/;
const DEFAULT_TIMEOUT = 240_000;
const MAX_TEXT = 24_000;

function defaultRunShell(cmdLine: string, timeoutMs: number, cwd: string): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmdLine, { cwd, shell: true, windowsHide: true, env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能已经退出
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_TEXT * 4) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_TEXT * 4) stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

function defaultRunGit(args: string[], cwd: string): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? Number((error as { code: number }).code)
            : 1
          : 0;
        resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

class BudgetExceeded extends Error {
  constructor() {
    super('selfopt_budget_exceeded');
  }
}

export class SelfOptEngine {
  private session: SelfOptSession | null = null;
  private stopped = false;
  private readonly dir: string;

  constructor(private readonly deps: SelfOptDeps) {
    this.dir = join(deps.stateDir, 'selfopt');
    mkdirSync(this.dir, { recursive: true });
  }

  // -- 项目元信息 ----------------------------------------------------------

  private runShell(cmdLine: string, timeoutMs: number, cwd: string): Promise<ShellResult> {
    return (this.deps.runShell ?? defaultRunShell)(cmdLine, timeoutMs, cwd);
  }

  private git(args: string[], cwd: string): Promise<ShellResult> {
    return (this.deps.runGit ?? defaultRunGit)(args, cwd);
  }

  private projectKey(rootDir: string): string {
    return createHash('sha1').update(resolve(rootDir).toLowerCase()).digest('hex').slice(0, 12);
  }

  private projectDir(rootDir: string): string {
    const dir = join(this.dir, this.projectKey(rootDir));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async meta(rootDir: string): Promise<SelfOptMeta> {
    const root = resolve(rootDir);
    const inside = await this.git(['rev-parse', '--is-inside-work-tree'], root);
    const isRepo = inside.code === 0 && inside.stdout.trim() === 'true';
    if (!isRepo) {
      return { ok: false, error: 'not_a_git_repo', rootDir: root, ...describeSelfOpt() };
    }
    const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim();
    const head = (await this.git(['rev-parse', 'HEAD'], root)).stdout.trim();
    const status = (await this.git(['status', '--porcelain'], root)).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    const hasPackage = existsSync(join(root, 'package.json'));
    const scripts: Record<string, string> = {};
    if (hasPackage) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        Object.assign(scripts, pkg.scripts ?? {});
      } catch {
        // 坏掉的 package.json 不影响体检本身
      }
    }
    return {
      ok: true,
      rootDir: root,
      branch,
      head: head.slice(0, 12),
      dirty: status.slice(0, 50),
      clean: status.length === 0,
      scripts,
      ...describeSelfOpt(),
    };
  }

  // -- 预测 ----------------------------------------------------------------

  async forecast(input: { rootDir: string; mode: SelfOptMode; level: SelfOptLevel; budget?: number; findings?: number }) {
    return forecastSelfOpt({
      mode: input.mode,
      level: input.level,
      budget: input.budget ?? 120_000,
      findings: input.findings,
      history: this.history(input.rootDir),
    });
  }

  private history(rootDir: string): ForecastHistory[] {
    const file = join(this.projectDir(rootDir), 'journal.jsonl');
    if (!existsSync(file)) return [];
    try {
      return readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as ForecastHistory;
          } catch {
            return null;
          }
        })
        .filter((item): item is ForecastHistory => Boolean(item && item.expected && item.actual))
        .slice(-40);
    } catch {
      return [];
    }
  }

  // -- 启动 / 停止 ---------------------------------------------------------

  current(): SelfOptSession | null {
    return this.session;
  }

  async start(options: SelfOptStartOptions): Promise<SelfOptSession> {
    if (this.session && this.session.status === 'running') {
      throw new Error('selfopt_in_progress');
    }
    const rootDir = resolve(options.rootDir);
    const mode = findMode(options.mode);
    const level = findLevel(options.level);
    if (!mode) throw new Error('unknown_mode');
    if (!level) throw new Error('unknown_level');

    const meta = await this.meta(rootDir);
    if (!meta.ok) throw new Error('not_a_git_repo');
    if (level.writes && !meta.clean && !options.allowDirty) {
      throw new Error('worktree_dirty');
    }

    const maxTokens = Math.max(5_000, Math.round(options.maxTokens ?? 120_000));
    const session: SelfOptSession = {
      id: `so-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      rootDir,
      mode: mode.id,
      level: level.id,
      budget: {
        maxTokens,
        maxRounds: Math.max(1, Math.min(8, Math.round(options.maxRounds ?? 3))),
      },
      status: 'running',
      round: 0,
      usedTokens: 0,
      startedAt: Date.now(),
      stages: this.initialStages(mode, level),
      findings: [],
      versions: [],
      baseBranch: meta.branch,
      baseCommit: meta.head,
      forecast: forecastSelfOpt({
        mode: mode.id,
        level: level.id,
        budget: maxTokens,
        findings: options.findings,
        history: this.history(rootDir),
      }),
      requestedFindings: options.findings ? Math.max(1, Math.min(12, Math.round(options.findings))) : undefined,
      log: [],
    };
    this.session = session;
    this.stopped = false;
    this.save(session);
    this.log(session, `开始：${mode.label}/${level.label}，预算 ${maxTokens} tokens`);

    void this.execute(session, level, mode).catch((error: unknown) => {
      session.status = 'failed';
      session.error = error instanceof Error ? error.message : String(error);
      session.finishedAt = Date.now();
      this.save(session);
    });

    return session;
  }

  stop(): boolean {
    if (!this.session || this.session.status !== 'running') return false;
    this.stopped = true;
    this.log(this.session, '收到停止请求，当前步骤结束后停下');
    return true;
  }

  private initialStages(mode: ModeSpec, level: LevelSpec): SelfOptStage[] {
    return [
      { id: 'survey', label: '体检', status: 'pending' },
      { id: 'benchmark', label: '对标', status: mode.search ? 'pending' : 'skipped' },
      { id: 'reflect', label: '复盘', status: 'pending' },
      { id: 'apply', label: '执行', status: level.writes ? 'pending' : 'skipped' },
      { id: 'verify', label: '校验', status: level.writes ? 'pending' : 'skipped' },
      { id: 'snapshot', label: '快照', status: level.commits ? 'pending' : 'skipped' },
    ];
  }

  private save(session: SelfOptSession): void {
    try {
      const dir = join(this.projectDir(session.rootDir), 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8');
    } catch {
      // 落盘失败不影响本轮继续
    }
  }

  private log(session: SelfOptSession, text: string): void {
    session.log.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
    if (session.log.length > 400) session.log.splice(0, session.log.length - 400);
    this.save(session);
  }

  private stage(session: SelfOptSession, id: SelfOptStageId): SelfOptStage {
    const found = session.stages.find((item) => item.id === id);
    if (!found) throw new Error(`stage_missing:${id}`);
    return found;
  }

  private async runStage<T>(
    session: SelfOptSession,
    id: SelfOptStageId,
    fn: () => Promise<T>
  ): Promise<T | null> {
    const stage = this.stage(session, id);
    stage.status = 'running';
    stage.startedAt = Date.now();
    this.save(session);
    try {
      const value = await fn();
      stage.status = 'done';
      stage.finishedAt = Date.now();
      this.save(session);
      return value;
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        stage.status = 'done';
        stage.detail = '预算用尽，提前收尾';
        this.log(session, '预算用尽，提前收尾');
        return null;
      }
      stage.status = 'failed';
      stage.detail = error instanceof Error ? error.message : String(error);
      stage.finishedAt = Date.now();
      this.save(session);
      throw error;
    }
  }

  private charge(session: SelfOptSession, tokens: number): void {
    session.usedTokens += Math.max(0, Math.round(tokens));
    if (session.usedTokens > session.budget.maxTokens) throw new BudgetExceeded();
    if (this.stopped) throw new Error('selfopt_stopped');
  }

  // -- 主循环 --------------------------------------------------------------

  private async execute(session: SelfOptSession, level: LevelSpec, mode: ModeSpec): Promise<void> {
    try {
      const survey = await this.runStage(session, 'survey', () => this.survey(session));
      if (!survey) {
        session.status = 'done';
        session.finishedAt = Date.now();
        this.save(session);
        return;
      }
      this.stage(session, 'survey').detail = this.summarizeSurvey(survey);

      let benchmark = '';
      if (mode.search && this.deps.search) {
        benchmark = (await this.runStage(session, 'benchmark', () => this.benchmark(session, mode))) ?? '';
      }

      const digest = this.buildDigest(survey, session.rootDir);
      let rounds = 0;
      do {
        rounds += 1;
        session.round = rounds;
        this.log(session, `第 ${rounds} 轮复盘`);

        const findings = await this.runStage(session, 'reflect', () =>
          this.reflect(session, mode, level, survey, digest, benchmark, rounds)
        );
        if (!findings || findings.length === 0) {
          this.log(session, '本轮没有新问题');
          break;
        }
        session.findings.push(...findings);
        this.save(session);

        if (!level.writes) {
          this.log(session, `产出 ${findings.length} 条建议（本档位不改代码）`);
          break;
        }

        let applied = 0;
        for (const finding of findings) {
          if (this.stopped) break;
          if (session.usedTokens > session.budget.maxTokens * 0.95) break;
          const ok = await this.implement(session, level, finding, survey);
          if (ok) applied += 1;
        }
        this.log(session, `本轮应用 ${applied}/${findings.length} 条`);
        if (!level.iterates || applied === 0) break;
        if (rounds >= session.budget.maxRounds) {
          this.log(session, `达到轮数上限 ${session.budget.maxRounds}，停止`);
          break;
        }
        if (session.usedTokens >= session.budget.maxTokens) break;
      } while (true);

      session.status = this.stopped ? 'stopped' : 'done';
    } catch (error) {
      session.status = this.stopped ? 'stopped' : 'failed';
      session.error = error instanceof Error ? error.message : String(error);
      this.log(session, `结束：${session.error}`);
      this.deps.audit({
        actor: 'selfopt',
        action: 'selfopt.failed',
        target: session.id,
        detail: { error: session.error },
      });
    } finally {
      // 收尾：仍在 running 的阶段统一落定，避免界面出现永远在转的步骤。
      for (const stage of session.stages) {
        if (stage.status === 'running') {
          stage.status = this.stopped ? 'skipped' : 'done';
          stage.finishedAt = Date.now();
        }
      }
      session.finishedAt = Date.now();
      this.save(session);
      this.appendJournal(session);
      this.deps.audit({
        actor: 'selfopt',
        action: 'selfopt.finish',
        target: session.id,
        detail: {
          status: session.status,
          mode: session.mode,
          level: session.level,
          tokens: session.usedTokens,
          findings: session.findings.length,
          versions: session.versions.length,
        },
      });
    }
  }

  private appendJournal(session: SelfOptSession): void {
    try {
      const expected = session.forecast?.expected ?? 0;
      if (expected <= 0) return;
      appendFileSync(
        join(this.projectDir(session.rootDir), 'journal.jsonl'),
        `${JSON.stringify({ mode: session.mode, level: session.level, expected, actual: session.usedTokens, at: Date.now() })}\n`,
        'utf8'
      );
    } catch {
      // 校准数据丢了不影响本轮
    }
  }

  // -- 体检 ----------------------------------------------------------------

  private async survey(session: SelfOptSession): Promise<SurveyReport> {
    const root = session.rootDir;
    const scripts: Record<string, string> = {};
    if (existsSync(join(root, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        Object.assign(scripts, pkg.scripts ?? {});
      } catch {
        // 坏掉的 package.json 只是没有脚本可跑
      }
    }

    const checks: Array<{ name: string; cmd: string }> = [];
    if (scripts.typecheck) checks.push({ name: 'typecheck', cmd: 'npm run typecheck' });
    else if (existsSync(join(root, 'tsconfig.json'))) checks.push({ name: 'typecheck', cmd: 'npx tsc --noEmit' });
    if (scripts.test && !/no test specified/i.test(scripts.test)) checks.push({ name: 'test', cmd: 'npm test' });

    const results: SurveyReport['checks'] = [];
    for (const check of checks) {
      const started = Date.now();
      const result = await this.runShell(check.cmd, DEFAULT_TIMEOUT, root);
      const summary = this.summarizeCheck(result);
      results.push({
        name: check.name,
        cmd: check.cmd,
        ok: result.code === 0,
        code: result.code,
        ms: Date.now() - started,
        summary,
      });
      this.log(session, `${check.name} ${result.code === 0 ? '通过' : '失败'}（${Date.now() - started}ms）`);
    }

    const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim();
    const dirty = (await this.git(['status', '--porcelain'], root)).stdout.split(/\r?\n/).filter(Boolean);
    const recentCommits = (await this.git(['log', '-12', '--pretty=%h %s'], root)).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    const recentFilesRaw = (await this.git(['log', '-20', '--name-only', '--pretty=format:'], root)).stdout;    const hotCount = new Map<string, number>();
    for (const line of recentFilesRaw.split(/\r?\n/)) {
      const path = line.trim();
      if (!path || !CODE_EXT.test(path)) continue;
      hotCount.set(path, (hotCount.get(path) ?? 0) + 1);
    }

    const listed = (await this.git(['ls-files'], root)).stdout.split(/\r?\n/).filter(Boolean);
    const files: SurveyReport['files'] = [];
    for (const path of listed) {
      if (!CODE_EXT.test(path) || IGNORED_PATH.test(path)) continue;
      const absolute = join(root, path.split('/').join(sep));
      let loc = 0;
      const exportsFound: string[] = [];
      try {
        const stat = statSync(absolute);
        if (stat.size > 400_000) continue;
        const text = readFileSync(absolute, 'utf8');
        loc = text.split(/\r?\n/).length;
        if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) {
          const re = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
          let match: RegExpExecArray | null;
          while ((match = re.exec(text)) && exportsFound.length < 8) exportsFound.push(match[1]);
        }
      } catch {
        continue;
      }
      files.push({ path, loc, exports: exportsFound, hot: hotCount.get(path) ?? 0 });
    }
    files.sort((a, b) => b.hot - a.hot || b.loc - a.loc);

    const todos: SurveyReport['todos'] = [];
    const grep = await this.git(['grep', '-n', '-I', '-E', 'TODO|FIXME|HACK', '--', '*.ts', '*.tsx', '*.js', '*.mjs'], root);
    if (grep.code === 0) {
      for (const line of grep.stdout.split(/\r?\n/)) {
        const match = line.match(/^([^:]+):(\d+):(.*)$/);
        if (!match || todos.length >= 30) continue;
        todos.push({ file: match[1], line: Number(match[2]), text: match[3].trim().slice(0, 160) });
      }
    }

    // 最近两次提交的差异：加固/安全问题通常藏在刚改过的代码里。
    let recentDiff = '';
    for (const base of ['HEAD~2', 'HEAD~1']) {
      const diffResult = await this.git(['diff', '--unified=3', base, 'HEAD'], root);
      if (diffResult.code === 0 && diffResult.stdout.trim()) {
        recentDiff = diffResult.stdout.slice(0, 18_000);
        break;
      }
    }

    return {
      at: Date.now(),
      checks: results,
      branch,
      dirty,
      recentCommits,
      recentFiles: [...hotCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([path]) => path),
      recentDiff,
      todos,
      files,
      scripts,
    };
  }

  private summarizeCheck(result: ShellResult): string {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0) return '通过';
    const lines = combined.split(/\r?\n/).filter((line) => line.trim());
    const errors = lines.filter((line) => /error/i.test(line)).slice(0, 8);
    return (errors.length ? errors : lines.slice(-8)).join('\n').slice(0, 2400);
  }

  private summarizeSurvey(survey: SurveyReport): string {
    const failed = survey.checks.filter((item) => !item.ok);
    const parts = [
      `${survey.files.length} 个文件`,
      survey.checks.map((item) => `${item.name}:${item.ok ? 'ok' : 'fail'}`).join(' '),
      survey.todos.length ? `${survey.todos.length} 处 TODO` : '',
      failed.length ? `失败项 ${failed.map((item) => item.name).join(',')}` : '',
    ].filter(Boolean);
    return parts.join(' · ');
  }

  // -- 对标 ----------------------------------------------------------------

  private async benchmark(session: SelfOptSession, mode: ModeSpec): Promise<string> {
    const search = this.deps.search;
    if (!search) return '';
    const root = session.rootDir;
    let name = 'project';
    let description = '';
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        name?: string;
        description?: string;
      };
      name = pkg.name ?? name;
      description = pkg.description ?? '';
    } catch {
      // 没有 package.json 就用仓库目录名
    }
    const queries =
      mode.id === 'evolve'
        ? [
            `${name} ${description} alternatives 2026`,
            'LLM multi-agent orchestration architecture paper 2025 2026',
          ]
        : [`${name} ${description} 竞品 对比`, 'AI agent orchestration canvas competitors 2026'];

    const chunks: string[] = [];
    for (const query of queries) {
      try {
        const hits = await search(query, 5);
        if (hits.length === 0) continue;
        chunks.push(
          `### 查询：${query}\n` +
            hits
              .slice(0, 5)
              .map((hit) => `- ${hit.title} (${hit.url})\n  ${(hit.snippet ?? '').slice(0, 260)}`)
              .join('\n')
        );
      } catch (error) {
        this.log(session, `搜索失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const text = chunks.join('\n\n').slice(0, 9000);
    this.stage(session, 'benchmark').detail = chunks.length ? `${chunks.length} 组结果` : '无可用结果';
    return text;
  }

  // -- 复盘 ----------------------------------------------------------------

  private buildDigest(survey: SurveyReport, rootDir: string): string {
    const structure = survey.files
      .slice(0, 160)
      .map((file) => `${file.path} · ${file.loc} 行${file.exports.length ? ` · ${file.exports.join(',')}` : ''}`)
      .join('\n')
      .slice(0, 12_000);
    const hot = survey.files
      .filter((file) => file.hot > 0)
      .slice(0, 5)
      .map((file) => {
        try {
          const text = readFileSync(join(rootDir, file.path.split('/').join(sep)), 'utf8');
          return `### ${file.path}\n${text.slice(0, 3_000)}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 16_000);
    const checks = survey.checks
      .map((check) => `- ${check.name}（${check.cmd}）→ ${check.ok ? '通过' : `失败\n${check.summary}`}`)
      .join('\n')
      .slice(0, 6_000);
    const todos = survey.todos
      .slice(0, 20)
      .map((todo) => `- ${todo.file}:${todo.line} ${todo.text}`)
      .join('\n')
      .slice(0, 3_000);
    return [
      `## 检查结果\n${checks || '（没有配置检查命令）'}`,
      `## 最近提交\n${survey.recentCommits.slice(0, 12).join('\n')}`,
      // 只看结构看不出加固问题；给复盘官看最近两次改动到底改了什么。
      `## 最近改动（diff）\n${survey.recentDiff || '（无）'}`,
      `## 热点文件\n${survey.recentFiles.slice(0, 12).join('\n')}`,
      `## TODO\n${todos || '（无）'}`,
      `## 结构\n${structure}`,
      hot ? `## 热点文件开头\n${hot}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * 一次模型调用 + 解析；解析失败时把坏输出贴回去让它自纠正一次。
   * 会思考的模型经常把 JSON 截断或夹带说明文字，重试比换模型划算。
   */
  private async chatJson<T>(
    session: SelfOptSession,
    stageId: SelfOptStageId,
    system: string,
    user: string,
    maxTokens: number
  ): Promise<T | null> {
    const stage = this.stage(session, stageId);
    const call = async (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
      const result = await this.deps.chat(messages, { maxTokens, timeoutMs: 150_000 });
      this.charge(session, result.usage.total);
      stage.tokens = (stage.tokens ?? 0) + result.usage.total;
      return result.text;
    };

    const first = await call([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const parsed = parseJson<T>(first);
    if (parsed) return parsed;

    const retry = await call([
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: first.slice(0, 5000) || '（空输出）' },
      {
        role: 'user',
        content:
          '你上次的输出无法解析为 JSON（可能被截断或夹带了说明文字）。只输出一个完整的 JSON 对象本身，从 { 开始到 } 结束，不要任何其他文字，字段与上面要求一致。',
      },
    ]);
    const second = parseJson<T>(retry);
    if (!second) {
      this.log(
        session,
        `${stageId} 的 JSON 解析失败，原始输出前 300 字：${(retry || first).slice(0, 300).replace(/\s+/g, ' ')}`
      );
    }
    return second;
  }

  private async reflect(
    session: SelfOptSession,
    mode: ModeSpec,
    level: LevelSpec,
    survey: SurveyReport,
    digest: string,
    benchmark: string,
    round: number
  ): Promise<SelfOptFinding[]> {
    const maxFindings = Math.min(session.requestedFindings ?? (level.writes ? 4 : 6), 12);
    const system = [
      '你是牵丝的自我优化复盘官。',
      `模式：${mode.label}（${mode.does.join('；')}）。明确不做：${mode.avoids.join('；')}。`,
      `程度：${level.label}（${level.blurb}）。`,
      '只依据下面提供的证据下判断：可以指出证据里的问题，可以提出由这些证据直接推出的改进；不要引用不存在的文件、接口或数字。',
      '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
    ].join('\n');

    const user = [
      `## 体检证据\n${digest}`,
      benchmark ? `## 外部对标\n${benchmark}` : '',
      `## 仓库\n分支 ${survey.branch} · 脏文件 ${survey.dirty.length} · 第 ${round} 轮`,
      `## 输出格式
{"summary":"一句中文总评","findings":[{"id":"f1","title":"短标题","kind":"bug|security|perf|ux|docs|value|research","area":"模块或文件","severity":"high|medium|low","evidence":"来自上面证据的具体依据","proposal":"具体怎么改","risk":"low|medium|high","acceptance":"怎么算改好了","estTokens":8000,"files":["可能涉及的文件"]}]}

规则：
1. 最多 ${maxFindings} 条，按严重度排序，严重的放前面；
2. kind 必须落在模式允许的范围内：${mode.kinds.join(', ')}；
3. evidence 必须能在上面的证据里找到对应，不许编造；
4. 如果证据不足以支持任何改动，findings 返回空数组；
5. 每条 proposal 要能直接落到文件和函数上，不要写「优化架构」这种空话。`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const parsed = await this.chatJson<{ summary?: string; findings?: Array<Record<string, unknown>> }>(
      session,
      'reflect',
      system,
      user.slice(0, 60_000),
      8000
    );
    if (!parsed) return [];
    const allowed = new Set<string>(mode.kinds);
    const findings: SelfOptFinding[] = [];
    for (const [index, raw] of (parsed.findings ?? []).slice(0, maxFindings).entries()) {
      const kind = String(raw?.kind ?? 'bug') as FindingKind;
      if (!allowed.has(kind)) continue;
      findings.push({
        id: `${session.id}-r${round}-f${index + 1}`,
        title: String(raw?.title ?? `问题 ${index + 1}`).slice(0, 80),
        kind,
        area: String(raw?.area ?? '').slice(0, 120),
        severity: (['high', 'medium', 'low'].includes(String(raw?.severity))
          ? String(raw?.severity)
          : 'medium') as SelfOptFinding['severity'],
        evidence: String(raw?.evidence ?? '').slice(0, 600),
        proposal: String(raw?.proposal ?? '').slice(0, 800),
        risk: (['low', 'medium', 'high'].includes(String(raw?.risk))
          ? String(raw?.risk)
          : 'medium') as SelfOptFinding['risk'],
        acceptance: String(raw?.acceptance ?? '').slice(0, 300),
        estTokens: Math.max(500, Math.min(40_000, Number(raw?.estTokens ?? 8_000) || 8_000)),
        files: Array.isArray(raw?.files)
          ? (raw.files as unknown[]).map((item) => String(item)).filter(Boolean).slice(0, 6)
          : [],
        status: 'proposed',
      });
    }
    if (parsed.summary) this.stage(session, 'reflect').detail = String(parsed.summary).slice(0, 240);
    return findings;
  }

  // -- 执行 ----------------------------------------------------------------

  private async implement(
    session: SelfOptSession,
    level: LevelSpec,
    finding: SelfOptFinding,
    survey: SurveyReport
  ): Promise<boolean> {
    const applyStage = this.stage(session, 'apply');
    applyStage.status = 'running';
    applyStage.startedAt ??= Date.now();
    this.save(session);

    const candidates = finding.files.length
      ? survey.files.filter((file) => finding.files.some((hint) => file.path.includes(hint)))
      : survey.files.filter((file) => file.hot > 0 || file.loc > 800);
    const targets = (candidates.length ? candidates : survey.files).slice(0, level.maxFilesPerFinding);
    if (targets.length === 0) {
      finding.status = 'skipped';
      finding.note = '没有可用目标文件';
      this.save(session);
      return false;
    }

    const fileContents = targets
      .map((file) => {
        try {
          const text = readFileSync(join(session.rootDir, file.path.split('/').join(sep)), 'utf8');
          return `### ${file.path}\n\`\`\`\n${text.slice(0, 8_000)}\n\`\`\``;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n\n');

    const system = [
      '你是牵丝的实现者。把一条已确认的问题落成最小改动。',
      '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
      '改法必须保守：只动与问题直接相关的行；不引入新依赖；不改公开接口；不删除既有功能。',
    ].join('\n');
    const user = [
      `## 问题\n标题：${finding.title}\n依据：${finding.evidence}\n改法：${finding.proposal}\n验收：${finding.acceptance}`,
      `## 允许修改的文件\n${targets.map((file) => file.path).join('\n')}`,
      `## 文件内容\n${fileContents}`,
      `## 输出格式
{"changes":[{"file":"路径","oldText":"原文中连续的一段，必须逐字一致","newText":"替换后的内容"}],"note":"一句说明"}

规则：
1. oldText 必须在目标文件里恰好出现一次，包含足够上下文以免命中多处；
2. 只改上面列出的文件，最多 ${level.maxFilesPerFinding} 个；
3. 如果这条问题无法安全实现，返回 {"changes":[],"note":"原因"}；
4. 代码风格与文件保持一致，注释用中文。`,
    ].join('\n\n');

    const parsed = await this.chatJson<{ changes?: Array<Record<string, unknown>>; note?: string }>(
      session,
      'apply',
      system,
      user.slice(0, 60_000),
      8000
    );
    const changes = (parsed?.changes ?? []).slice(0, level.maxFilesPerFinding);
    if (changes.length === 0) {
      finding.status = 'skipped';
      finding.note = String(parsed?.note ?? '模型认为无法安全实现').slice(0, 200);
      this.save(session);
      return false;
    }

    const touched: string[] = [];
    const rollback = async () => {
      if (touched.length) await this.git(['checkout', '--', ...touched], session.rootDir);
    };

    try {
      for (const change of changes) {
        const rawPath = String(change?.file ?? '').replace(/\\/g, '/');
        const target = targets.find((file) => file.path === rawPath || file.path.endsWith(`/${rawPath}`));
        if (!target) throw new Error(`file_not_allowed:${rawPath}`);
        const absolute = join(session.rootDir, target.path.split('/').join(sep));
        const original = readFileSync(absolute, 'utf8');
        const oldText = String(change?.oldText ?? '');
        const newText = String(change?.newText ?? '');
        if (!oldText || oldText === newText) throw new Error(`empty_change:${target.path}`);
        const occurrences = original.split(oldText).length - 1;
        if (occurrences !== 1) throw new Error(`old_text_not_unique:${target.path}:${occurrences}`);
        writeFileSync(absolute, original.replace(oldText, newText), 'utf8');
        if (!touched.includes(target.path)) touched.push(target.path);
      }

      // 校验：改了代码就必须还能通过既定检查。
      // 修错模式最常见的证据就是失败测试，所以 test 必须参与校验——
      // 之前为了省时间把它过滤掉了，等于改完不验。
      const verifyStage = this.stage(session, 'verify');
      verifyStage.status = 'running';
      verifyStage.startedAt ??= Date.now();
      const checks = survey.checks.length
        ? survey.checks.map((check) => check.cmd)
        : ['npx tsc --noEmit'];
      for (const cmd of checks.slice(0, 3)) {
        const check = await this.runShell(cmd, DEFAULT_TIMEOUT, session.rootDir);
        if (check.code !== 0) {
          verifyStage.status = 'failed';
          verifyStage.detail = `${cmd} 未通过`;
          await rollback();
          finding.status = 'failed';
          finding.note = `校验失败：${this.summarizeCheck(check).slice(0, 400)}`;
          this.save(session);
          return false;
        }
      }
      verifyStage.status = 'done';
      verifyStage.finishedAt = Date.now();

      // 密钥扫描：提交前最后一道闸。
      const staged = await this.git(['add', '--', ...touched], session.rootDir);
      if (staged.code !== 0) throw new Error(`git_add_failed:${staged.stderr.slice(0, 200)}`);
      const diff = await this.git(['diff', '--cached', '--unified=0'], session.rootDir);
      const secrets = scanSecrets(diff.stdout);
      if (secrets.length > 0) {
        await this.git(['reset'], session.rootDir);
        await rollback();
        finding.status = 'failed';
        finding.note = `疑似密钥：${secrets.slice(0, 3).map((hit) => hit.rule).join(',')}`;
        this.log(session, `拦截疑似密钥（${finding.note}）`);
        this.save(session);
        return false;
      }

      if (level.commits) {
        const snapshot = this.stage(session, 'snapshot');
        snapshot.status = 'running';
        snapshot.startedAt ??= Date.now();
        const message = [
          `selfopt(${session.mode}/${session.level}): ${finding.title}`,
          '',
          `${finding.id} · ${finding.evidence.slice(0, 400)}`,
          '',
          `Acceptance: ${finding.acceptance.slice(0, 200)}`,
          `Session: ${session.id}`,
        ].join('\n');
        const commit = await this.git(['commit', '-m', message], session.rootDir);
        if (commit.code !== 0) throw new Error(`git_commit_failed:${commit.stderr.slice(0, 200)}`);
        const head = await this.git(['rev-parse', 'HEAD'], session.rootDir);
        const short = head.stdout.trim().slice(0, 8);
        const version: SelfOptVersion = {
          id: `${session.id}-${short}`,
          commit: head.stdout.trim(),
          short,
          baseCommit: session.baseCommit ?? '',
          baseBranch: session.baseBranch ?? '',
          mode: session.mode,
          level: session.level,
          findingId: finding.id,
          title: finding.title,
          tokens: session.usedTokens,
          files: [...touched],
          sessionId: session.id,
          createdAt: Date.now(),
        };
        await this.git(['tag', '-f', `selfopt/${short}`, head.stdout.trim()], session.rootDir);
        this.recordVersion(session.rootDir, version);
        session.versions.push(version.id);
        finding.commit = short;
        snapshot.status = 'done';
        snapshot.finishedAt = Date.now();
        this.log(session, `已提交 ${short} · ${finding.title}`);
      }

      finding.status = 'applied';
      this.save(session);
      return true;
    } catch (error) {
      await rollback();
      finding.status = 'failed';
      finding.note = error instanceof Error ? error.message : String(error);
      this.save(session);
      this.log(session, `实现失败：${finding.note}`);
      return false;
    }
  }

  // -- 版本 ----------------------------------------------------------------

  private versionsPath(rootDir: string): string {
    return join(this.projectDir(rootDir), 'versions.json');
  }

  private recordVersion(rootDir: string, version: SelfOptVersion): void {
    try {
      const file = this.versionsPath(rootDir);
      const list = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as SelfOptVersion[])
        : [];
      list.unshift(version);
      writeFileSync(file, JSON.stringify(list.slice(0, 200), null, 2), 'utf8');
    } catch {
      // 版本索引写不进去不影响已提交的内容
    }
  }

  async versions(rootDir: string) {
    const root = resolve(rootDir);
    const file = this.versionsPath(root);
    const list = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SelfOptVersion[]) : [];
    const head = (await this.git(['rev-parse', 'HEAD'], root)).stdout.trim();
    const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim();
    const dirty = (await this.git(['status', '--porcelain'], root)).stdout.split(/\r?\n/).filter(Boolean);
    return {
      ok: true,
      rootDir: root,
      branch,
      head,
      dirty,
      clean: dirty.length === 0,
      active: list.find((item) => item.commit === head)?.id ?? null,
      versions: list,
      sessions: this.listSessions(root),
    };
  }

  private listSessions(rootDir: string) {
    const dir = join(this.projectDir(rootDir), 'sessions');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SelfOptSession;
          return {
            id: data.id,
            mode: data.mode,
            level: data.level,
            status: data.status,
            tokens: data.usedTokens,
            findings: data.findings?.length ?? 0,
            startedAt: data.startedAt,
            finishedAt: data.finishedAt,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b as { startedAt: number }).startedAt - (a as { startedAt: number }).startedAt)
      .slice(0, 40);
  }

  async diffOf(rootDir: string, id: string) {
    const root = resolve(rootDir);
    const version = (await this.versions(root)).versions.find((item) => item.id === id);
    if (!version) return { ok: false, error: 'version_not_found' };
    const stat = await this.git(['show', '--stat', '--oneline', version.commit], root);
    const diff = await this.git(['show', '--format=', version.commit], root);
    return {
      ok: true,
      version,
      stat: stat.stdout.slice(0, 4_000),
      diff: diff.stdout.slice(0, 24_000),
      truncated: diff.stdout.length > 24_000,
    };
  }

  async switchTo(rootDir: string, id: string) {
    const root = resolve(rootDir);
    const version = (await this.versions(root)).versions.find((item) => item.id === id);
    if (!version) return { ok: false, error: 'version_not_found' };
    const dirty = (await this.git(['status', '--porcelain'], root)).stdout.split(/\r?\n/).filter(Boolean);
    if (dirty.length > 0) return { ok: false, error: 'worktree_dirty', files: dirty.slice(0, 20) };
    const branch = `qiansi/version-${version.short}`;
    const checkout = await this.git(['checkout', '-B', branch, version.commit], root);
    if (checkout.code !== 0) {
      return { ok: false, error: 'checkout_failed', detail: checkout.stderr.slice(0, 400) };
    }
    this.deps.audit({
      actor: 'selfopt',
      action: 'selfopt.switch',
      target: version.id,
      detail: { branch, commit: version.commit },
    });
    return { ok: true, branch, commit: version.commit, version };
  }

  async restore(rootDir: string) {
    const root = resolve(rootDir);
    const file = this.versionsPath(root);
    const list = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SelfOptVersion[]) : [];
    const target = list[0]?.baseBranch || 'main';
    const dirty = (await this.git(['status', '--porcelain'], root)).stdout.split(/\r?\n/).filter(Boolean);
    if (dirty.length > 0) return { ok: false, error: 'worktree_dirty', files: dirty.slice(0, 20) };
    const checkout = await this.git(['checkout', target], root);
    if (checkout.code !== 0) {
      return { ok: false, error: 'checkout_failed', detail: checkout.stderr.slice(0, 400) };
    }
    this.deps.audit({ actor: 'selfopt', action: 'selfopt.restore', target });
    return { ok: true, branch: target };
  }
}
