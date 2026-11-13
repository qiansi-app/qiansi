import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  isInjectedText,
  latestClaudeSessionFile,
  readClaudeSessionFile,
  recentClaudeAsks,
} from './handoff.js';

/**
 * 实时接管：盯着当前 agent 会话文件，用户每发一条新需求，就把它交给
 * 画布自动编排并开跑。
 *
 * 只认「真正的用户文本」——tool_result、系统注入、命令回显都会被
 * collectRecentAsks 过滤掉。启动时把已有的最后一条需求记为已处理，
 * 不会把历史需求全部重跑一遍。
 */

export interface TakeoverInfo {
  file: string;
  sessionId: string;
}

export interface TakeoverDeps {
  onAsk: (ask: string, info: TakeoverInfo) => Promise<void>;
  log?: (line: string) => void;
  /** 轮询间隔，默认 4 秒。 */
  intervalMs?: number;
  /** 需求写入后稳定多久才触发，默认 4 秒。 */
  stableMs?: number;
  /** 同一条需求最多自动重试几次，超过就停下来等用户，默认 3。 */
  maxFailures?: number;
}

export interface TakeoverStatus {
  enabled: boolean;
  file: string;
  sessionId: string;
  lastAsk: string;
  lastFiredAt?: number;
  pendingAsk?: string;
  busy: boolean;
  lastError?: string;
}

const TRIVIAL = /^(继续|好的?|可以|行|嗯+|ok|okay|yes|好滴|收到)[。！!.\s]*$/i;

/**
 * 提问不是工单。一句「qiansi的git仓库在哪」曾被当成任务反复接管，
 * 一晚上开出十几张同名画布。带动作动词的仍然按任务处理
 * （「为什么失败，请修复」里有「修复」）。
 */
const QUESTION_HINT = /[？?]|为什么|怎么|怎样|如何|在哪|哪里|哪儿|是什么|什么|是否|能不能|可不可以|有没有|多少|多久|谁/;
const ACTION_HINT = /(改|做|写|生成|运行|跑|修复|检查|调研|优化|增加|加一下|删|移除|部署|实现|配置|安装|整理|总结|重构|测试|排查|分析|翻译|设计|导出|截图|验收|接管|继续做)/;

function looksLikeQuestion(text: string): boolean {
  return QUESTION_HINT.test(text) && !ACTION_HINT.test(text);
}

function isActionable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  // 压缩摘要 / 系统提醒是转录噪音，不是需求。
  if (isInjectedText(trimmed)) return false;
  // 整行都是方括号的行（如 [Request interrupted by user …]）是转录噪音，不是需求。
  if (/^\[[^\]]+\]$/.test(trimmed)) return false;
  if (looksLikeQuestion(trimmed)) return false;
  return !TRIVIAL.test(trimmed);
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export class TakeoverWatcher {
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  private overrideFile = '';
  private file = '';
  private sessionId = '';
  private seen = new Set<string>();
  private pending: { ask: string; hash: string; since: number } | null = null;
  private busy = false;
  private lastAsk = '';
  private firedAt?: number;
  private error?: string;
  private failures = 0;
  /** 失败计数属于哪条需求：换一条需求要从头计数，不能继承上一条的退避。 */
  private failureHash = '';
  /** 失败退避：已有运行在跑时不要每 4 秒重试一遍。 */
  private cooldownUntil = 0;
  private readonly intervalMs: number;
  private readonly stableMs: number;
  private readonly maxFailures: number;

  constructor(private readonly deps: TakeoverDeps) {
    this.intervalMs = Math.max(1000, deps.intervalMs ?? 4000);
    this.stableMs = Math.max(1000, deps.stableMs ?? 4000);
    this.maxFailures = Math.max(1, deps.maxFailures ?? 3);
  }

  status(): TakeoverStatus {
    return {
      enabled: this.enabled,
      file: this.file,
      sessionId: this.sessionId,
      lastAsk: this.lastAsk,
      lastFiredAt: this.firedAt,
      pendingAsk: this.pending?.ask,
      busy: this.busy,
      lastError: this.error,
    };
  }

  start(sessionFile?: string): TakeoverStatus {
    this.overrideFile = String(sessionFile ?? '').trim();
    this.enabled = true;
    this.error = undefined;
    this.failures = 0;
    this.failureHash = '';
    this.cooldownUntil = 0;
    this.baseline();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.deps.log?.(`实时接管已开启 · ${this.file || '（还没有可读会话）'}`);
    return this.status();
  }

  stop(): TakeoverStatus {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending = null;
    this.deps.log?.('实时接管已停止');
    return this.status();
  }

  private resolveFile(): string {
    if (this.overrideFile) return this.overrideFile;
    return latestClaudeSessionFile() ?? '';
  }

  /** 切到一个会话（或首次启动）时，把最后一条需求记为已处理。 */
  private baseline(): void {
    const file = this.resolveFile();
    this.file = file;
    this.pending = null;
    this.seen.clear();
    this.lastAsk = '';
    this.sessionId = '';
    if (!file) return;
    try {
      const session = readClaudeSessionFile(file);
      this.sessionId = session?.sessionId ?? '';
      const asks = recentClaudeAsks(file, 2);
      const latest = asks.at(-1) ?? '';
      if (latest) {
        this.lastAsk = latest;
        this.markSeen(hashText(latest));
      }
    } catch {
      // 会话暂时读不到：下一轮再试
    }
  }

  private markSeen(hash: string): void {
    this.seen.add(hash);
    if (this.seen.size > 40) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
  }

  private tick(): void {
    if (!this.enabled) return;
    if (Date.now() < this.cooldownUntil) return;
    try {
      const file = this.resolveFile();
      if (!file) return;
      if (file !== this.file) {
        this.baseline();
        return;
      }
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        return;
      }
      const asks = recentClaudeAsks(file, 3);
      const latest = asks.at(-1)?.trim() ?? '';
      if (!latest) return;
      const hash = hashText(latest);
      if (this.seen.has(hash)) {
        this.pending = null;
        return;
      }
      if (!this.pending || this.pending.hash !== hash) {
        this.pending = { ask: latest, hash, since: Date.now() };
        this.deps.log?.(`发现新需求，等待写入稳定：${latest.slice(0, 60)}`);
        return;
      }
      const stable = Date.now() - mtime > 1500 && Date.now() - this.pending.since >= this.stableMs;
      if (!stable || this.busy) return;
      if (!isActionable(latest)) {
        if (looksLikeQuestion(latest)) {
          this.deps.log?.(`识别为提问，不建画布：${latest.slice(0, 60)}`);
        }
        this.markSeen(hash);
        this.pending = null;
        return;
      }
      const ask = this.pending.ask;
      const pendingHash = this.pending.hash;
      this.pending = null;
      this.busy = true;
      void this.deps
        .onAsk(ask, { file, sessionId: this.sessionId })
        .then(() => {
          this.firedAt = Date.now();
          this.lastAsk = ask;
          this.markSeen(pendingHash);
          this.failures = 0;
          this.failureHash = '';
          this.cooldownUntil = 0;
          this.error = undefined;
          this.deps.log?.(`已接管新需求：${ask.slice(0, 60)}`);
        })
        .catch((cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (this.failureHash !== pendingHash) {
            this.failureHash = pendingHash;
            this.failures = 0;
          }
          this.failures += 1;
          this.error = message;
          if (this.failures >= this.maxFailures) {
            // 同一条需求连续失败：停下来交给用户，绝不无限重试——
            // 每次重试都会新建一张画布，重试越多标签栏越脏。
            this.markSeen(pendingHash);
            this.pending = null;
            this.failures = 0;
            this.cooldownUntil = 0;
            this.error = `接管失败 ${this.maxFailures} 次，已停止自动重试：${message}`;
            this.deps.log?.(
              `接管放弃（连续 ${this.maxFailures} 次失败）：${message.slice(0, 160)}`
            );
            return;
          }
          // 不记为已处理：等已有运行结束后会再试一次；指数退避，避免 4 秒一撞。
          this.cooldownUntil = Date.now() + Math.min(120000, 15000 * 2 ** (this.failures - 1));
          this.deps.log?.(`接管失败（第 ${this.failures} 次），稍后重试：${message.slice(0, 160)}`);
        })
        .finally(() => {
          this.busy = false;
        });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
}
