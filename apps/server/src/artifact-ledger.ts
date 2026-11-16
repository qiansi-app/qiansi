/**
 * 产物账本的服务端部分：任务前后对比工作目录 + 归因 + 落盘。
 *
 * 归因的两条线：
 *   1. `tool.called` 事件里 write_file 的参数直接给出相对路径，解析成绝对路径，
 *      这是「模型明确写了这个文件」，最可信；
 *   2. 任务前后的目录快照差异，负责兜住 run_command 生成的文件（PDF、截图、导出包）。
 *
 * 并行任务共享同一个工作目录，所以还有一层「先到先得」：谁先报出某个文件，
 * 这个文件就归谁，别的任务的快照差异里剔除它，避免两个节点都声称同一个 PDF。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { TaskFile } from '@qiansi/engine';

import {
  classifyArtifact,
  diffSnapshots,
  displayPath,
  mergeCandidates,
  scanDirectory,
  type ArtifactCandidate,
  type SnapshotEntry,
} from './artifacts.js';

export interface RunArtifact extends TaskFile {
  taskId: string;
  nodeId?: string;
  createdAt: number;
}

export interface RunArtifactRecord {
  runId: string;
  workspaceId: string;
  updatedAt: number;
  files: RunArtifact[];
}

const SCAN_LIMITS = { maxDepth: 6, maxFiles: 5000 } as const;

/** 一次运行内的文件归因：拍快照、记显式写入、算差异。 */
export class RunFileWatcher {
  private readonly snapshots = new Map<string, Map<string, SnapshotEntry>>();
  private readonly explicitWrites = new Map<string, Set<string>>();
  private readonly claimed = new Set<string>();
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  get rootDir(): string {
    return this.root;
  }

  /** `tool.called` 里 write_file 成功时调用：这个任务明确写了这个文件。 */
  noteWrite(taskId: string, rawPath: string): void {
    try {
      const absolute = resolve(this.root, rawPath);
      const set = this.explicitWrites.get(taskId) ?? new Set<string>();
      set.add(absolute);
      this.explicitWrites.set(taskId, set);
    } catch {
      // 路径无法解析就交给快照兜底
    }
  }

  /** 任务开始前拍一次快照（同一任务只拍第一次）。 */
  before(taskId: string): void {
    if (this.snapshots.has(taskId)) return;
    try {
      this.snapshots.set(taskId, scanDirectory(this.root, SCAN_LIMITS));
    } catch {
      this.snapshots.set(taskId, new Map());
    }
  }

  /** 任务结束时算出这个任务产出/改动的文件。 */
  after(taskId: string): TaskFile[] {
    const before = this.snapshots.get(taskId) ?? new Map<string, SnapshotEntry>();
    let now = new Map<string, SnapshotEntry>();
    try {
      now = scanDirectory(this.root, SCAN_LIMITS);
    } catch {
      return [];
    }
    const explicit = this.explicitWrites.get(taskId) ?? new Set<string>();
    const candidates: ArtifactCandidate[] = [];
    for (const candidate of diffSnapshots(before, now, 'command')) {
      if (explicit.has(candidate.absolutePath)) {
        candidates.push({ ...candidate, source: 'write_file' });
        continue;
      }
      // 别的任务先认领过的文件不算这一个任务的产出。
      if (this.claimed.has(candidate.absolutePath)) continue;
      candidates.push(candidate);
    }
    for (const absolutePath of explicit) {
      if (candidates.some((candidate) => candidate.absolutePath === absolutePath)) continue;
      const entry = now.get(absolutePath);
      if (!entry || entry.bytes === 0) continue;
      candidates.push({
        absolutePath,
        bytes: entry.bytes,
        mtime: entry.mtime,
        kind: classifyArtifact(absolutePath),
        source: 'write_file',
      });
    }
    const merged = mergeCandidates(candidates);
    const files: TaskFile[] = merged.map((candidate) => ({
      path: displayPath(this.root, candidate.absolutePath),
      absolutePath: candidate.absolutePath,
      bytes: candidate.bytes,
      mtime: Math.round(candidate.mtime),
      kind: candidate.kind,
      source: candidate.source,
    }));
    for (const file of files) {
      if (file.absolutePath) this.claimed.add(file.absolutePath);
    }
    return files;
  }
}

/** 按运行落盘：`<stateDir>/artifacts/<runId>.json`，重启后仍能查。 */
export class ArtifactLedger {
  constructor(private readonly dir: string) {}

  private file(runId: string): string {
    return join(this.dir, `${runId}.json`);
  }

  load(runId: string): RunArtifactRecord | null {
    try {
      return JSON.parse(readFileSync(this.file(runId), 'utf8')) as RunArtifactRecord;
    } catch {
      return null;
    }
  }

  save(record: RunArtifactRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file(record.runId), JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // 落盘失败不该影响运行
    }
  }

  /** 追加一批产物（同一路径覆盖旧记录）。 */
  add(runId: string, workspaceId: string, taskId: string, nodeId: string | undefined, files: TaskFile[]): RunArtifactRecord {
    const record =
      this.load(runId) ?? { runId, workspaceId, updatedAt: Date.now(), files: [] as RunArtifact[] };
    record.workspaceId = workspaceId || record.workspaceId;
    const byPath = new Map(record.files.map((file) => [file.absolutePath ?? file.path, file]));
    const createdAt = Date.now();
    for (const file of files) {
      byPath.set(file.absolutePath ?? file.path, { ...file, taskId, nodeId, createdAt });
    }
    record.files = [...byPath.values()].sort((a, b) => b.createdAt - a.createdAt);
    record.updatedAt = createdAt;
    this.save(record);
    return record;
  }

  list(limit = 20): RunArtifactRecord[] {
    try {
      const names = readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);
      return names
        .map((name) => {
          try {
            return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as RunArtifactRecord;
          } catch {
            return null;
          }
        })
        .filter((record): record is RunArtifactRecord => Boolean(record))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }
}
