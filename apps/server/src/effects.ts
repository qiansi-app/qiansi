import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 副作用收件箱（借鉴 DSH 的 Outbox）：运行结束后的回写画布与落盘 deliverables
 * 是外部副作用，进程死在「运行已结束、副作用还没做」之间时它们就永久丢了。
 *
 * 这里只做最小的账本：每个运行记两条效果是否完成；启动时扫描已完成但缺账的
 * 运行，把副作用重放一遍（回写与写文件都是幂等的）。不做事务队形——本地单
 * 进程，账本加幂等足够。
 */

export type EffectKind = 'writeback' | 'deliverables';

interface EffectsFile {
  version: 1;
  /** runId → 已完成的效果时间戳 */
  done: Record<string, Partial<Record<EffectKind, number>>>;
}

export class EffectsLedger {
  private readonly file: string;
  private data: EffectsFile;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'effects.json');
    this.data = this.load();
  }

  private load(): EffectsFile {
    if (!existsSync(this.file)) return { version: 1, done: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<EffectsFile>;
      return { version: 1, done: parsed.done ?? {} };
    } catch {
      return { version: 1, done: {} };
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }

  mark(runId: string, kind: EffectKind): void {
    const entry = this.data.done[runId] ?? {};
    entry[kind] = Date.now();
    this.data.done[runId] = entry;
    // 账本只保留最近 2000 条，避免无限增长。
    const ids = Object.keys(this.data.done);
    if (ids.length > 2000) {
      for (const old of ids.slice(0, ids.length - 2000)) delete this.data.done[old];
    }
    try {
      this.persist();
    } catch {
      // 账本写不出来只会导致下次启动多补一次幂等副作用
    }
  }

  has(runId: string, kind: EffectKind): boolean {
    return Boolean(this.data.done[runId]?.[kind]);
  }

  missing(runId: string, kinds: EffectKind[]): EffectKind[] {
    return kinds.filter((kind) => !this.has(runId, kind));
  }
}
