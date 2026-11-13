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
 * 链路：体检（跑类型检查/测试、读 git 与 TODO）→ 复盘（多个模型各带一个视角独立产出问题清单）
 * → 互审（互相质询：确认、修正或驳回）→ 综合（旗舰模型合并去重、排出终稿）
 * → 执行（逐条改代码、换一个模型复核 diff、校验、提交）→ 记录（版本快照，可切换）。
 * 只有一个可用模型时，互审与综合跳过，退回单模型复盘。
 * 其中「对标（联网找竞品与论文）」仅在 value / evolve 等 search: true 模式下启用，见 SELFOPT_MODES 的 search 字段。
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

/**
 * 本轮评审团用几个模型：多模型互审是默认做法，环境变量可调。
 * 档位越高看得越深，但 L5 会多轮，控制每个模型都要付的固定成本。
 */
export function panelSizeFor(level: LevelSpec): number {
  const env = Number(process.env.QIANSI_SELFOPT_PANEL ?? '');
  const base =
    level.id === 'L1' ? 2 : level.id === 'L2' ? 3 : level.id === 'L3' ? 3 : level.id === 'L4' ? 4 : 3;
  return clampNumber(Number.isFinite(env) && env > 0 ? Math.round(env) : base, 1, 5);
}

/** 同一家厂商的模型归一组：评审团优先凑齐不同厂商，再看同厂商的第二个模型。 */
function vendorOf(model: string): string {
  const id = String(model ?? '').toLowerCase();
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('minimax') || id.startsWith('abab')) return 'minimax';
  if (id.startsWith('glm') || id.startsWith('zhipu') || id.startsWith('chatglm')) return 'zhipu';
  if (id.startsWith('kimi') || id.startsWith('moonshot')) return 'moonshot';
  if (id.startsWith('qwen')) return 'qwen';
  if (id.startsWith('claude') || id.startsWith('fable')) return 'claude';
  if (id.startsWith('gpt') || /^o[134]-/.test(id)) return 'openai';
  return id.split(/[-_/]/)[0] ?? id;
}

/** 复盘视角：同一份证据，不同模型被要求从不同方向找问题。 */
const REFLECT_LENSES: Array<{ id: string; label: string; focus: string }> = [
  {
    id: 'correctness',
    label: '正确性',
    focus: '以缺陷猎人的方式阅读证据：找真实报错、崩溃、逻辑错误、回归与类型漏洞。',
  },
  {
    id: 'adversarial',
    label: '对抗',
    focus: '假设现有实现是错的：找边界值、并发与竞态、失败路径、安全与资源问题，并说明触发条件。',
  },
  {
    id: 'usability',
    label: '体验',
    focus: '站在使用者视角：找误导的提示、缺失的空状态、文档与实现不一致、重复劳动。',
  },
  {
    id: 'evolution',
    label: '演进',
    focus: '站在维护者视角：结合最近改动、TODO 与外部对标，找该做而未做、做了却半途而废的事。',
  },
];

export function describeSelfOpt() {
  return {
    modes: SELFOPT_MODES,
    levels: SELFOPT_LEVELS,
    defaultBudget: { tokens: 120_000, rounds: 3 },
    panel: {
      sizeEnv: 'QIANSI_SELFOPT_PANEL',
      modelsEnv: 'QIANSI_SELFOPT_MODELS',
      note: '多个可用模型组成评审团：各自独立复盘 → 交叉质询 → 综合纠错；只有一个模型时退回单模型复盘。',
    },
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
  /** 评审团规模：每个模型各自复盘一次，再互审一次。 */
  panel?: number;
  history?: ForecastHistory[];
}): SelfOptForecast {
  const mode = findMode(input.mode) ?? SELFOPT_MODES[0];
  const level = findLevel(input.level) ?? SELFOPT_LEVELS[0];
  const budget = Math.max(1000, Math.round(input.budget || 120_000));
  const findings = clampNumber(Math.round(input.findings ?? 4), 1, 12);
  const panel = clampNumber(Math.round(input.panel ?? panelSizeFor(level)), 1, 5);

  const survey = 1_500;
  const search = mode.search ? 6_000 : 0;
  // 每位评审独立复盘一次；两人以上再付一轮互审（每位评一次 + 一次综合）。
  const reflect = 9_000 * panel;
  const critique = panel >= 2 ? panel * 2_500 + 6_000 : 0;
  const proposeOnly = level.id === 'L2' ? findings * 2_500 : 0;
  const perApply =
    level.id === 'L3' ? 9_000 : level.id === 'L4' ? 14_000 : level.id === 'L5' ? 10_000 : 0;
  // 写代码的档位每条改动多一次独立复核（只给 diff，成本很小）。
  const perReview = level.writes ? 1_200 : 0;

  const round = survey + search + reflect + critique + proposeOnly + findings * (perApply + perReview);
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
    `复盘 ${panel > 1 ? `${panel} 位评审 ` : ''}${reflect}`,
    critique ? `互审 ${critique}` : '',
    proposeOnly ? `建议 ${proposeOnly}` : '',
    perApply ? `实现 ${findings}×${perApply}` : '',
    perReview ? `复核 ${findings}×${perReview}` : '',
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
    options: { maxTokens: number; timeoutMs: number; model?: string }
  ) => Promise<{ text: string; usage: { total: number }; model?: string }>;
  /** 可用模型清单：评审团从这里取不同厂商的模型。 */
  roster?: () => Promise<Array<{ model: string; label?: string }>>;
  search?: (query: string, maxResults: number) => Promise<Array<{ title: string; url: string; snippet?: string }>>;
  runShell?: (cmdLine: string, timeoutMs: number, cwd: string) => Promise<ShellResult>;
  runGit?: (args: string[], cwd: string) => Promise<ShellResult>;
  /** 每次状态变化回调：用它把体检/问题同步到画布。 */
  onProgress?: (session: SelfOptSession) => void;
}

export type SelfOptStageId =
  | 'survey'
  | 'benchmark'
  | 'reflect'
  | 'critique'
  | 'apply'
  | 'verify'
  | 'snapshot';

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
  /** 提出这条问题的模型。 */
  proposedBy?: string;
  /** 其他模型的互审意见：确认、修正或驳回。 */
  reviews?: Array<{ by: string; verdict: 'confirm' | 'revise' | 'refute'; note?: string }>;
  /** 落地证据：校验命令及结果。 */
  checks?: Array<{ cmd: string; ok: boolean; detail?: string }>;
  /** 落地证据：独立复核结论。 */
  review?: { ok: boolean; by?: string; note?: string };
  /** 落地证据：提交的文件清单与 diff 摘要（统一 diff 只留前 4000 字）。 */
  diffStat?: string;
  diff?: string;
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
  /** 本轮评审团的模型（至少两个才启用互审）。 */
  panel?: string[];
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
  /** 最近一次模型调用实际由哪个模型完成（显式指定模型不可用时会降级）。 */
  private lastChatModel?: string;
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
    const level = findLevel(input.level) ?? SELFOPT_LEVELS[0];
    return forecastSelfOpt({
      mode: input.mode,
      level: input.level,
      budget: input.budget ?? 120_000,
      findings: input.findings,
      panel: panelSizeFor(level),
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
    const panel = await this.resolvePanel(level);
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
      panel,
      forecast: forecastSelfOpt({
        mode: mode.id,
        level: level.id,
        budget: maxTokens,
        findings: options.findings,
        panel: Math.max(1, panel.length),
        history: this.history(rootDir),
      }),
      requestedFindings: options.findings ? Math.max(1, Math.min(12, Math.round(options.findings))) : undefined,
      log: [],
    };
    if (panel.length < 2) {
      const critique = session.stages.find((stage) => stage.id === 'critique');
      if (critique) {
        critique.status = 'skipped';
        critique.detail = '只有一个可用模型，跳过互审';
      }
    }
    this.session = session;
    this.stopped = false;
    this.save(session);
    this.log(session, `开始：${mode.label}/${level.label}，预算 ${maxTokens} tokens`);
    this.log(
      session,
      panel.length >= 2
        ? `评审团：${panel.join(' / ')} —— 各自独立复盘，再交叉质询、综合纠错`
        : '评审团只有一个模型（配置多家 key 后自动启用互审）'
    );

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

  /**
   * 组评审团：优先不同厂商，凑不满再补同厂商的第二个模型。
   * QIANSI_SELFOPT_MODELS 可直接指定（逗号分隔），用于实验与验收。
   */
  private async resolvePanel(level: LevelSpec): Promise<string[]> {
    const want = panelSizeFor(level);
    if (want < 2) return [];
    const forced = String(process.env.QIANSI_SELFOPT_MODELS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    let roster: Array<{ model: string }> = forced.map((model) => ({ model }));
    if (roster.length === 0 && this.deps.roster) {
      try {
        roster = await this.deps.roster();
      } catch {
        roster = [];
      }
    }
    const unique: string[] = [];
    for (const entry of roster) {
      const id = String(entry?.model ?? '').trim();
      if (id && !unique.includes(id)) unique.push(id);
    }
    const picked: string[] = [];
    const seenVendors = new Set<string>();
    for (const model of unique) {
      if (picked.length >= want) break;
      const vendor = vendorOf(model);
      if (seenVendors.has(vendor)) continue;
      seenVendors.add(vendor);
      picked.push(model);
    }
    for (const model of unique) {
      if (picked.length >= want) break;
      if (!picked.includes(model)) picked.push(model);
    }
    return picked;
  }

  private initialStages(mode: ModeSpec, level: LevelSpec): SelfOptStage[] {
    return [
      { id: 'survey', label: '体检', status: 'pending' },
      { id: 'benchmark', label: '对标', status: mode.search ? 'pending' : 'skipped' },
      { id: 'reflect', label: '复盘', status: 'pending' },
      { id: 'critique', label: '互审', status: 'pending' },
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
    try {
      this.deps.onProgress?.(session);
    } catch {
      // 展示层失败不影响自省本身
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

        let findings = await this.runStage(session, 'reflect', () =>
          this.propose(session, mode, level, survey, digest, benchmark, rounds)
        );
        if (findings && findings.length > 0 && (session.panel?.length ?? 0) >= 2) {
          findings = await this.runStage(session, 'critique', () =>
            this.critique(session, mode, level, findings as SelfOptFinding[])
          );
        }
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
      // 失败时不能标 done——那会把「没改任何东西」显示成「执行完成」。
      for (const stage of session.stages) {
        if (stage.status === 'running') {
          stage.status = this.stopped ? 'skipped' : session.status === 'failed' ? 'failed' : 'done';
          if (session.status === 'failed' && !stage.detail) {
            stage.detail = session.error?.slice(0, 200) ?? '本轮中止';
          }
          stage.finishedAt = Date.now();
        }
      }
      if (level.writes && session.status === 'failed') {
        for (const finding of session.findings) {
          if (finding.status === 'proposed') {
            finding.status = 'failed';
            finding.note = `未执行：${(session.error ?? '本轮中止').slice(0, 240)}`;
          }
        }
      }
      session.finishedAt = Date.now();
      this.save(session);
      this.writeReport(session);
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

  private sessionsDir(rootDir: string): string {
    const dir = join(this.projectDir(rootDir), 'sessions');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 每轮结束写一份人读的报告：每条问题改了什么、跑过哪些校验、
   * 复核结论、diff 摘要、提交 hash。界面只显示标题时，用户没法判断
   * 「到底优化了什么、有没有落地」，报告就是那份可核对的证据。
   */
  private writeReport(session: SelfOptSession): void {
    try {
      const applied = session.findings.filter((finding) => finding.status === 'applied');
      const failed = session.findings.filter((finding) => finding.status === 'failed');
      const skipped = session.findings.filter((finding) => finding.status === 'skipped');
      const started = new Date(session.startedAt).toISOString();
      const finished = session.finishedAt ? new Date(session.finishedAt).toISOString() : '—';
      const lines: string[] = [
        `# 自我优化报告 · ${session.id}`,
        '',
        `- 仓库：\`${session.rootDir}\``,
        `- 模式/档位：${session.mode} / ${session.level}`,
        `- 状态：**${session.status}**${session.error ? `（${session.error}）` : ''}`,
        `- 时间：${started} → ${finished}`,
        `- 用量：${session.usedTokens} tokens · ${session.round} 轮`,
        `- 基线：${session.baseCommit ?? '—'} @ ${session.baseBranch ?? '—'}`,
        `- 结果：发现 ${session.findings.length} 条 · 落地 ${applied.length} 条 · 失败 ${failed.length} 条 · 跳过 ${skipped.length} 条 · 提交 ${session.versions.length} 个`,
        '',
        '## 阶段',
        '',
        '| 阶段 | 状态 | 说明 |',
        '|---|---|---|',
        ...session.stages.map(
          (stage) =>
            `| ${stage.label} | ${stage.status} | ${(stage.detail ?? '').replace(/\|/g, '/').slice(0, 160)} |`
        ),
        '',
        '## 逐条明细',
        '',
      ];
      for (const finding of session.findings) {
        lines.push(`### [${finding.severity}/${finding.kind}] ${finding.title}`);
        lines.push('');
        lines.push(`- 状态：**${finding.status}**${finding.note ? ` — ${finding.note}` : ''}`);
        if (finding.commit) lines.push(`- 提交：\`${finding.commit}\``);
        if (finding.files.length) lines.push(`- 目标文件：${finding.files.map((file) => `\`${file}\``).join('、')}`);
        lines.push(`- 依据：${finding.evidence.replace(/\n/g, ' ').slice(0, 600)}`);
        lines.push(`- 改法：${finding.proposal.replace(/\n/g, ' ').slice(0, 600)}`);
        lines.push(`- 验收：${finding.acceptance.replace(/\n/g, ' ').slice(0, 400)}`);
        if (finding.checks?.length) {
          lines.push(
            `- 校验：${finding.checks.map((check) => `${check.cmd} ${check.ok ? '通过' : '失败'}${check.detail ? `（${check.detail.slice(0, 160)}）` : ''}`).join('；')}`
          );
        }
        if (finding.review) {
          lines.push(
            `- 独立复核：${finding.review.ok ? '通过' : '驳回'}${finding.review.by ? `（${finding.review.by}）` : ''}${finding.review.note ? ` — ${finding.review.note.slice(0, 240)}` : ''}`
          );
        }
        if (finding.diffStat) {
          lines.push('', '```', finding.diffStat, '```');
        }
        if (finding.diff) {
          lines.push('', '<details><summary>diff（截断）</summary>', '', '```diff', finding.diff, '```', '', '</details>');
        }
        lines.push('');
      }
      writeFileSync(join(this.sessionsDir(session.rootDir), `${session.id}.md`), lines.join('\n'), 'utf8');
    } catch {
      // 报告写不出来不影响优化本身
    }
  }

  /** 报告正文：JSON 里没有的细节（校验、复核、diff）都在这里。 */
  report(rootDir: string, id: string): string | null {
    try {
      return readFileSync(join(this.sessionsDir(rootDir), `${id.replace(/[^\w-]/g, '')}.md`), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * 落地核验：版本里记录的提交是否仍在当前分支上。
   * 只信 git，不信记忆——这样用户能直接看到 n/m 条优化真的存在于代码里。
   */
  async landing(rootDir: string): Promise<{
    ok: boolean;
    branch: string;
    head: string;
    items: Array<{
      id: string;
      title: string;
      short: string;
      files: string[];
      createdAt: number;
      exists: boolean;
      landed: boolean;
      subject?: string;
    }>;
  }> {
    const versions = await this.versions(rootDir);
    const branchResult = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], rootDir);
    const headResult = await this.git(['rev-parse', '--short', 'HEAD'], rootDir);
    const items = [];
    for (const version of versions.versions ?? []) {
      const exists = (await this.git(['cat-file', '-e', `${version.commit}^{commit}`], rootDir)).code === 0;
      const ancestor =
        exists &&
        (await this.git(['merge-base', '--is-ancestor', version.commit, 'HEAD'], rootDir)).code === 0;
      const subject = exists
        ? (await this.git(['log', '-1', '--format=%s', version.commit], rootDir)).stdout.trim()
        : undefined;
      items.push({
        id: version.id,
        title: version.title,
        short: version.short,
        files: version.files,
        createdAt: version.createdAt,
        exists,
        landed: ancestor,
        subject,
      });
    }
    return {
      ok: true,
      branch: branchResult.stdout.trim(),
      head: headResult.stdout.trim(),
      items,
    };
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

  private async chatJson<T>(
    session: SelfOptSession,
    stageId: SelfOptStageId,
    system: string,
    user: string,
    maxTokens: number,
    model?: string
  ): Promise<{ data: T | null; model?: string }> {
    const stage = this.stage(session, stageId);
    const call = async (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
      const result = await this.deps.chat(messages, { maxTokens, timeoutMs: 150_000, model });
      this.lastChatModel = result.model ?? model;
      this.charge(session, result.usage.total);
      stage.tokens = (stage.tokens ?? 0) + result.usage.total;
      return { text: result.text, model: result.model ?? model };
    };

    const first = await call([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const parsed = parseJson<T>(first.text);
    if (parsed) return { data: parsed, model: first.model };

    const retry = await call([
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: first.text.slice(0, 5000) || '（空输出）' },
      {
        role: 'user',
        content:
          '你上次的输出无法解析为 JSON（可能被截断或夹带了说明文字）。只输出一个完整的 JSON 对象本身，从 { 开始到 } 结束，不要任何其他文字，字段与上面要求一致。',
      },
    ]);
    const second = parseJson<T>(retry.text);
    if (!second) {
      this.log(
        session,
        `${stageId} 的 JSON 解析失败，原始输出前 300 字：${(retry.text || first.text).slice(0, 300).replace(/\s+/g, ' ')}`
      );
    }
    return { data: second, model: retry.model ?? first.model };
  }

  // -- 复盘（评审团） ------------------------------------------------------

  private reflectPrompt(
    mode: ModeSpec,
    level: LevelSpec,
    survey: SurveyReport,
    digest: string,
    benchmark: string,
    round: number,
    lens: { label: string; focus: string },
    seat: { index: number; total: number },
    maxFindings: number
  ): { system: string; user: string; maxFindings: number } {
    const system = [
      '你是牵丝的自我优化复盘官。',
      `你的评审视角：${lens.label} —— ${lens.focus}`,
      `模式：${mode.label}（${mode.does.join('；')}）。明确不做：${mode.avoids.join('；')}。`,
      `程度：${level.label}（${level.blurb}）。`,
      '只依据下面提供的证据下判断：可以指出证据里的问题，可以提出由这些证据直接推出的改进；不要引用不存在的文件、接口或数字。',
      `本轮共有 ${seat.total} 位评审各自独立复盘，稍后会互相质询。只输出你最确定的问题，把最严重的放前面。`,
      '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
    ].join('\n');

    const user = [
      `## 体检证据\n${digest}`,
      benchmark ? `## 外部对标\n${benchmark}` : '',
      `## 仓库\n分支 ${survey.branch} · 脏文件 ${survey.dirty.length} · 第 ${round} 轮 · 你是第 ${seat.index} 位评审`,
      `## 输出格式
{"summary":"一句中文总评","findings":[{"id":"f1","title":"短标题","kind":"bug|security|perf|ux|docs|value|research","area":"模块或文件","severity":"high|medium|low","evidence":"来自上面证据的具体依据","proposal":"具体怎么改","risk":"low|medium|high","acceptance":"怎么算改好了","estTokens":8000,"files":["可能涉及的文件"]}]}

规则：
1. 最多 ${maxFindings} 条，按严重度排序，严重的放前面；
2. kind 必须落在模式允许的范围内：${mode.kinds.join(', ')}；
3. evidence 必须能在上面的证据里找到对应，不许编造；
4. 如果证据不足以支持任何改动，findings 返回空数组；
5. 每条 proposal 要能直接落到文件和函数上，不要写「优化架构」这种空话；
6. 从你的视角看不到的问题不要硬凑，留给其他评审。`,
    ]
      .filter(Boolean)
      .join('\n\n');

    return { system, user: user.slice(0, 60_000), maxFindings };
  }

  private toFindings(
    parsed: { summary?: string; findings?: Array<Record<string, unknown>> } | null,
    maxFindings: number,
    mode: ModeSpec,
    session: SelfOptSession,
    round: number,
    suffix: string
  ): SelfOptFinding[] {
    if (!parsed) return [];
    const allowed = new Set<string>(mode.kinds);
    const findings: SelfOptFinding[] = [];
    for (const [index, raw] of (parsed.findings ?? []).slice(0, maxFindings).entries()) {
      const kind = String(raw?.kind ?? 'bug') as FindingKind;
      if (!allowed.has(kind)) continue;
      findings.push({
        id: `${session.id}-r${round}-${suffix}-f${index + 1}`,
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
    return findings;
  }

  /** 复盘：每位评审用不同视角独立找问题；只有一位就是原来的单模型复盘。 */
  private async propose(
    session: SelfOptSession,
    mode: ModeSpec,
    level: LevelSpec,
    survey: SurveyReport,
    digest: string,
    benchmark: string,
    round: number
  ): Promise<SelfOptFinding[]> {
    const panel = session.panel ?? [];
    const seats = panel.length >= 2 ? panel : [''];
    const maxFindings = Math.min(session.requestedFindings ?? (level.writes ? 4 : 6), 12);
    const results = await Promise.allSettled(
      seats.map(async (model, index) => {
        const lens = REFLECT_LENSES[index % REFLECT_LENSES.length]!;
        const prompt = this.reflectPrompt(mode, level, survey, digest, benchmark, round, lens, {
          index: index + 1,
          total: seats.length,
        }, maxFindings);
        const result = await this.chatJson<{ summary?: string; findings?: Array<Record<string, unknown>> }>(
          session,
          'reflect',
          prompt.system,
          prompt.user,
          8000,
          model || undefined
        );
        if (model && result.model && result.model !== model) {
          this.log(session, `评审 ${model} 不可用，由 ${result.model} 代答（${lens.label}视角）`);
        }
        const list = this.toFindings(result.data, prompt.maxFindings, mode, session, round, `p${index + 1}`);
        for (const item of list) item.proposedBy = result.model ?? (model || undefined);
        if (result.data?.summary) {
          this.log(session, `${lens.label}视角：${String(result.data.summary).slice(0, 120)}`);
        }
        return list;
      })
    );

    const merged: SelfOptFinding[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') merged.push(...result.value);
      else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.log(session, `第 ${index + 1} 位评审失败：${message.slice(0, 160)}`);
      }
    });
    if (merged.length === 0) return [];
    const rank = (severity: string) => (severity === 'high' ? 0 : severity === 'medium' ? 1 : 2);
    merged.sort((a, b) => rank(a.severity) - rank(b.severity));
    const capped = merged.slice(0, 12);
    const stage = this.stage(session, 'reflect');
    stage.detail = `${seats.length > 1 ? `${seats.length} 位评审` : '单模型'}产出 ${capped.length} 条候选`;
    this.save(session);
    return capped;
  }

  /** 互审：每位评审逐条确认 / 修正 / 驳回别人提的问题。 */
  private async reviewAs(
    session: SelfOptSession,
    model: string,
    proposals: SelfOptFinding[]
  ): Promise<number> {
    const candidates = proposals.filter((item) => item.proposedBy !== model);
    if (candidates.length === 0) return 0;
    const payload = candidates.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      severity: item.severity,
      area: item.area,
      evidence: item.evidence.slice(0, 400),
      proposal: item.proposal.slice(0, 500),
      acceptance: item.acceptance.slice(0, 200),
    }));
    const system = [
      '你是牵丝自我优化的互审评审。',
      '下面这些候选问题由其他模型提出。逐条判断它是否站得住：',
      'confirm = 证据成立、值得处理；',
      'revise = 方向对但依据/改法/验收有误，给出修正；',
      'refute = 证据不足或判断错误，说明理由。',
      '只依据给出的内容判断，不臆造新证据；宁可 confirm，也不要因为风格不合就驳回。',
      '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
    ].join('\n');
    const user = [
      `## 候选问题\n${JSON.stringify(payload, null, 1).slice(0, 40_000)}`,
      `## 输出格式
{"reviews":[{"id":"候选 id","verdict":"confirm|revise|refute","note":"一句理由","proposal":"修正后的改法（revise 时必填）","evidence":"修正后的依据（可选）","acceptance":"修正后的验收（可选）","severity":"high|medium|low（可选）"}]}`,
    ].join('\n\n');
    const result = await this.chatJson<{ reviews?: Array<Record<string, unknown>> }>(
      session,
      'critique',
      system,
      user,
      2500,
      model
    );
    if (!result.data) return 0;
    let count = 0;
    for (const raw of result.data.reviews ?? []) {
      const target = proposals.find((item) => item.id === String(raw?.id ?? ''));
      if (!target) continue;
      const verdict = String(raw?.verdict ?? '');
      if (!['confirm', 'revise', 'refute'].includes(verdict)) continue;
      const note = String(raw?.note ?? '').slice(0, 300);
      target.reviews = target.reviews ?? [];
      target.reviews.push({ by: result.model ?? model, verdict: verdict as 'confirm' | 'revise' | 'refute', note });
      count += 1;
      if (verdict === 'revise') {
        const proposal = String(raw?.proposal ?? '').trim();
        const evidence = String(raw?.evidence ?? '').trim();
        const acceptance = String(raw?.acceptance ?? '').trim();
        const severity = String(raw?.severity ?? '');
        if (proposal) target.proposal = proposal.slice(0, 800);
        if (evidence) target.evidence = evidence.slice(0, 600);
        if (acceptance) target.acceptance = acceptance.slice(0, 300);
        if (['high', 'medium', 'low'].includes(severity)) {
          target.severity = severity as SelfOptFinding['severity'];
        }
      }
    }
    return count;
  }

  /** 综合：旗舰模型合并重复、采纳修正、复核驳回，产出终稿。 */
  private async synthesize(
    session: SelfOptSession,
    mode: ModeSpec,
    level: LevelSpec,
    kept: SelfOptFinding[],
    dropped: SelfOptFinding[]
  ): Promise<SelfOptFinding[] | null> {
    const panel = session.panel ?? [];
    const model = panel[0];
    if (!model) return null;
    const maxFindings = Math.min(session.requestedFindings ?? (level.writes ? 4 : 6), 12);
    const brief = (item: SelfOptFinding) => ({
      title: item.title,
      kind: item.kind,
      severity: item.severity,
      area: item.area,
      evidence: item.evidence.slice(0, 400),
      proposal: item.proposal.slice(0, 500),
      acceptance: item.acceptance.slice(0, 200),
      proposedBy: item.proposedBy ?? '',
      reviews: item.reviews ?? [],
    });
    const system = [
      '你是牵丝自我优化的主持人。几位评审已经各自提出候选问题并互相质询，现在由你合稿。',
      '只依据下面的候选、互审意见与证据下结论；不要引入候选之外的新问题。',
      '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
    ].join('\n');
    const user = [
      `## 模式与程度\n模式：${mode.label}（允许类别：${mode.kinds.join(', ')}）；程度：${level.label}。`,
      `## 存活候选\n${JSON.stringify(kept.map(brief), null, 1).slice(0, 40_000)}`,
      dropped.length
        ? `## 被互审驳回的候选\n${JSON.stringify(dropped.map(brief), null, 1).slice(0, 16_000)}`
        : '',
      `## 输出格式
{"summary":"一句中文总评","findings":[{"title":"短标题","kind":"bug|security|perf|ux|docs|value|research","area":"模块或文件","severity":"high|medium|low","evidence":"来自候选的具体依据","proposal":"具体怎么改","risk":"low|medium|high","acceptance":"怎么算改好了","estTokens":8000,"files":["可能涉及的文件"]}]}

规则：
1. 指向同一处问题（同一文件/函数/现象）的候选合并成一条，保留证据最扎实的表述；
2. 最多 ${maxFindings} 条，按严重度排序；
3. 互审修正过依据/改法/验收的，采用修正后的版本；
4. 被驳回的候选默认不要；只有明确判定驳回理由站不住、并在 evidence 里写出了理由，才恢复；
5. kind 必须落在 ${mode.kinds.join(', ')} 之内；
6. evidence 必须来自候选内容，不许编造。`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await this.chatJson<{ summary?: string; findings?: Array<Record<string, unknown>> }>(
      session,
      'critique',
      system,
      user,
      6000,
      model
    );
    if (!result.data) return null;
    const final = this.toFindings(result.data, maxFindings, mode, session, session.round, 'syn');
    if (final.length === 0 && kept.length > 0) {
      this.log(session, '综合结果为空，沿用互审后的候选');
      return null;
    }
    const lookup = new Map<string, SelfOptFinding>();
    for (const item of [...kept, ...dropped]) lookup.set(item.title.trim(), item);
    for (const item of final) {
      const source =
        lookup.get(item.title.trim()) ??
        [...kept, ...dropped].find(
          (candidate) => candidate.area && item.area && candidate.area === item.area
        );
      if (source) {
        item.proposedBy = source.proposedBy;
        item.reviews = source.reviews;
      } else {
        item.proposedBy = result.model ?? model;
      }
    }
    if (result.data.summary) {
      this.stage(session, 'critique').detail = `${String(result.data.summary).slice(0, 200)} · 终稿 ${final.length} 条`;
    }
    return final;
  }

  private async critique(
    session: SelfOptSession,
    mode: ModeSpec,
    level: LevelSpec,
    proposals: SelfOptFinding[]
  ): Promise<SelfOptFinding[]> {
    const panel = session.panel ?? [];
    const stage = this.stage(session, 'critique');
    if (panel.length < 2) {
      stage.status = 'skipped';
      stage.detail = '只有一个可用模型，跳过互审';
      this.save(session);
      return proposals;
    }
    try {
      const results = await Promise.allSettled(panel.map((model) => this.reviewAs(session, model, proposals)));
      let reviewed = 0;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') reviewed += result.value;
        else {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.log(session, `评审 ${panel[index]} 互审失败：${message.slice(0, 160)}`);
        }
      });

      const kept: SelfOptFinding[] = [];
      const dropped: SelfOptFinding[] = [];
      for (const finding of proposals) {
        const reviews = finding.reviews ?? [];
        const approves = reviews.filter((review) => review.verdict !== 'refute');
        if (reviews.length > 0 && approves.length === 0) dropped.push(finding);
        else kept.push(finding);
      }
      if (dropped.length > 0) {
        this.log(
          session,
          `互审驳回 ${dropped.length} 条：${dropped
            .map((item) => item.title)
            .slice(0, 3)
            .join('；')}`
        );
      }

      let final = kept;
      if (kept.length > 0 || dropped.length > 0) {
        const synthesized = await this.synthesize(session, mode, level, kept, dropped);
        if (synthesized) final = synthesized;
      }
      const revised = proposals.reduce(
        (sum, item) => sum + (item.reviews ?? []).filter((review) => review.verdict === 'revise').length,
        0
      );
      stage.detail = `${panel.length} 位互审 · ${reviewed} 条意见 · 驳回 ${dropped.length} · 修正 ${revised} · 终稿 ${final.length}`;
      this.log(
        session,
        `互审完成：${reviewed} 条意见，驳回 ${dropped.length} 条，终稿 ${final.length} 条`
      );
      this.save(session);
      return final;
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        stage.detail = '预算用尽，沿用候选清单';
        this.log(session, '互审预算用尽，沿用候选清单');
        return proposals;
      }
      const message = error instanceof Error ? error.message : String(error);
      stage.detail = `互审出错，沿用候选：${message.slice(0, 120)}`;
      this.log(session, `互审出错，沿用候选清单：${message.slice(0, 160)}`);
      return proposals;
    }
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

    let proposal: { data: { changes?: Array<Record<string, unknown>>; note?: string } | null; model?: string };
    try {
      proposal = await this.chatJson<{ changes?: Array<Record<string, unknown>>; note?: string }>(
        session,
        'apply',
        system,
        user.slice(0, 60_000),
        8000
      );
    } catch (error) {
      // 实现模型挂了（空正文/超时）：把当前这条标成失败再向上抛，
      // 否则界面只看到「待处理」，既没落地也没有原因。
      finding.status = 'failed';
      finding.note = `实现模型不可用：${error instanceof Error ? error.message : String(error)}`.slice(0, 400);
      this.save(session);
      throw error;
    }
    const changes = (proposal.data?.changes ?? []).slice(0, level.maxFilesPerFinding);
    if (changes.length === 0) {
      finding.status = 'skipped';
      finding.note = String(proposal.data?.note ?? '模型认为无法安全实现').slice(0, 200);
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
      finding.checks = [];
      for (const cmd of checks.slice(0, 3)) {
        const check = await this.runShell(cmd, DEFAULT_TIMEOUT, session.rootDir);
        finding.checks.push({
          cmd,
          ok: check.code === 0,
          detail: check.code === 0 ? undefined : this.summarizeCheck(check).slice(0, 300),
        });
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

      // 独立复核：换一个模型只看 diff，挡住「检查能过但改错了」的情况。
      const review = await this.reviewChange(session, finding, touched);
      finding.review = review
        ? { ok: review.ok, by: review.by, note: review.problems.slice(0, 3).join('；').slice(0, 300) }
        : { ok: true, note: '单模型评审团：跳过独立复核（校验命令已通过）' };
      if (review && !review.ok) {
        verifyStage.status = 'failed';
        verifyStage.detail = '独立复核驳回';
        await rollback();
        finding.status = 'failed';
        finding.note = `复核驳回：${review.problems.slice(0, 3).join('；').slice(0, 400)}`;
        this.save(session);
        return false;
      }

      // 密钥扫描：提交前最后一道闸。
      const staged = await this.git(['add', '--', ...touched], session.rootDir);
      if (staged.code !== 0) throw new Error(`git_add_failed:${staged.stderr.slice(0, 200)}`);
      const diffStat = await this.git(['diff', '--cached', '--stat'], session.rootDir);
      finding.diffStat = diffStat.stdout.trim().slice(0, 1200) || touched.join('、');
      const diff = await this.git(['diff', '--cached', '--unified=0'], session.rootDir);
      finding.diff = diff.stdout.slice(0, 4000);
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

  /**
   * 独立模型复核 diff：实现者与复核者不是同一个模型。
   * 复核失败（网络/预算）不阻塞主流程，只有明确 `ok:false` 才回滚。
   */
  private async reviewChange(
    session: SelfOptSession,
    finding: SelfOptFinding,
    files: string[]
  ): Promise<{ ok: boolean; problems: string[]; by?: string } | null> {
    const panel = session.panel ?? [];
    if (panel.length < 2) return null;
    const diff = await this.git(['diff', '--', ...files], session.rootDir);
    if (diff.code !== 0 || !diff.stdout.trim()) return null;
    const reviewer = panel.find((model) => model !== this.lastChatModel) ?? panel[0]!;
    const system = [
      '你是牵丝自我优化的独立改动复核者。',
      '你只判断给出的 diff 是否：(1) 只动了与问题直接相关的行；(2) 没有引入新错误或行为突变；(3) 能满足验收标准；(4) 没有夹带密钥、调试残留或无关改动。',
      '证据不足时判通过，不要因为风格不同就驳回。',
      '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
    ].join('\n');
    const user = [
      `## 问题\n标题：${finding.title}\n依据：${finding.evidence}\n改法：${finding.proposal}\n验收：${finding.acceptance}`,
      `## 改动 diff\n${diff.stdout.slice(0, 12_000)}`,
      `## 输出格式
{"ok":true|false,"problems":[{"severity":"high|medium|low","note":"指出具体哪一行、为什么"}]}`,
    ].join('\n\n');
    try {
      const result = await this.chatJson<{ ok?: boolean; problems?: Array<Record<string, unknown>> }>(
        session,
        'verify',
        system,
        user,
        1200,
        reviewer
      );
      if (!result.data) return null;
      const problems = (result.data.problems ?? [])
        .map((item) => String(item?.note ?? item ?? ''))
        .filter(Boolean)
        .slice(0, 5);
      const ok = result.data.ok !== false;
      this.log(
        session,
        `改动复核（${result.model ?? reviewer}）：${ok ? '通过' : `驳回 ${problems[0] ?? ''}`}`
      );
      return { ok, problems, by: result.model ?? reviewer };
    } catch (error) {
      this.log(
        session,
        `改动复核失败，按校验结果继续：${error instanceof Error ? error.message.slice(0, 160) : String(error)}`
      );
      return null;
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

  /** 历史优化会话：界面用它回看「上次优化改了什么」，而不是只认内存里的当前轮。 */
  listSessions(rootDir: string) {
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
            applied: (data.findings ?? []).filter((finding) => finding.status === 'applied').length,
            failed: (data.findings ?? []).filter((finding) => finding.status === 'failed').length,
            versions: data.versions?.length ?? 0,
            error: data.error,
            hasReport: existsSync(join(dir, `${data.id}.md`)),
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
