/**
 * 产物账本。
 *
 * 用户的原话是「我让他做个 PDF，画布上看不到这个 PDF 在哪」。根因是运行结束只
 * 回一段文字，谁也不知道这次到底往磁盘写了什么。这里把「产物」变成一等数据：
 *
 *   - write_file 落盘的那一刻就知道路径；
 *   - run_command 生成的文件靠任务前后的目录快照对比捞出来（PDF、截图、导出包）；
 *   - save_deliverable 写出的文件直接登记。
 *
 * 纯函数为主，方便单测；持久化和 SSE 推送在 index.ts 接线。
 */
import { readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';

export type ArtifactKind = 'pdf' | 'image' | 'text' | 'data' | 'archive' | 'code' | 'other';
export type ArtifactSource = 'write_file' | 'command' | 'deliverable' | 'scan';

export interface ArtifactRecord {
  id: string;
  runId: string;
  taskId: string;
  nodeId?: string;
  /** 相对 rootDir 的路径（文件在 rootDir 之外时用绝对路径）。 */
  path: string;
  absolutePath: string;
  bytes: number;
  /** 修改时间，毫秒。 */
  mtime: number;
  kind: ArtifactKind;
  source: ArtifactSource;
  createdAt: number;
}

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.md': 'text',
  '.txt': 'text',
  '.csv': 'text',
  '.log': 'text',
  '.json': 'data',
  '.yaml': 'data',
  '.yml': 'data',
  '.xlsx': 'data',
  '.xls': 'data',
  '.docx': 'data',
  '.pptx': 'data',
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.7z': 'archive',
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.mjs': 'code',
  '.py': 'code',
  '.sh': 'code',
  '.html': 'code',
  '.css': 'code',
};

export function classifyArtifact(filePath: string): ArtifactKind {
  return KIND_BY_EXT[extname(filePath).toLowerCase()] ?? 'other';
}

/** 目录扫描时跳过的重灾区：装依赖的目录和版本库。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo',
  'target',
  '.idea',
]);

export interface SnapshotEntry {
  absolutePath: string;
  bytes: number;
  mtime: number;
}

export interface ScanOptions {
  /** 最多下钻几层，默认 6。 */
  maxDepth?: number;
  /** 最多收录多少个文件，默认 5000，防止在巨型目录上失控。 */
  maxFiles?: number;
  /** 只看这个时间点之后改动过的文件；不传则全收。 */
  sinceMs?: number;
}

/**
 * 递归快照一个目录（跳过依赖目录与体积过大的文件树）。
 * 用于「任务开始前 / 结束后」对比，找出这次运行真正产出或改动的文件。
 */
export function scanDirectory(root: string, options: ScanOptions = {}): Map<string, SnapshotEntry> {
  const maxDepth = options.maxDepth ?? 6;
  const maxFiles = options.maxFiles ?? 5000;
  const result = new Map<string, SnapshotEntry>();
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || result.size >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.size >= maxFiles) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = join(dir, entry.name);
      let stat;
      try {
        stat = statSync(absolutePath);
      } catch {
        continue;
      }
      if (options.sinceMs !== undefined && stat.mtimeMs < options.sinceMs) continue;
      result.set(absolutePath, { absolutePath, bytes: stat.size, mtime: stat.mtimeMs });
    }
  };
  walk(root, 0);
  return result;
}

export interface ArtifactCandidate {
  absolutePath: string;
  bytes: number;
  mtime: number;
  kind: ArtifactKind;
  source: ArtifactSource;
}

/**
 * 对比两次快照，给出「新增或内容变了」的文件。
 * 只看新增/变大/修改时间前进的，避免把删掉的东西也算产物。
 */
export function diffSnapshots(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>,
  source: ArtifactSource = 'scan'
): ArtifactCandidate[] {
  const changed: ArtifactCandidate[] = [];
  for (const [absolutePath, entry] of after) {
    const previous = before.get(absolutePath);
    if (previous && previous.bytes === entry.bytes && previous.mtime === entry.mtime) continue;
    if (entry.bytes === 0) continue; // 空文件不算交付物
    changed.push({
      absolutePath,
      bytes: entry.bytes,
      mtime: entry.mtime,
      kind: classifyArtifact(absolutePath),
      source,
    });
  }
  return changed;
}

/** 把绝对路径折算成相对 rootDir 的展示路径；跑出 rootDir 时保留绝对路径。 */
export function displayPath(rootDir: string, absolutePath: string): string {
  try {
    const rel = relative(rootDir, absolutePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return absolutePath;
    return rel.split(sep).join('/');
  } catch {
    return absolutePath;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 同一路径多来源命中时，谁的优先级高（越具体的来源越优先）。 */
const SOURCE_PRIORITY: Record<ArtifactSource, number> = {
  write_file: 4,
  deliverable: 3,
  command: 2,
  scan: 1,
};

/**
 * 合并候选产物：同一路径只留一条，来源取更具体的一个，大小/时间取最新。
 */
export function mergeCandidates(candidates: ArtifactCandidate[]): ArtifactCandidate[] {
  const byPath = new Map<string, ArtifactCandidate>();
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.absolutePath);
    if (!existing) {
      byPath.set(candidate.absolutePath, { ...candidate });
      continue;
    }
    byPath.set(candidate.absolutePath, {
      absolutePath: candidate.absolutePath,
      bytes: Math.max(existing.bytes, candidate.bytes),
      mtime: Math.max(existing.mtime, candidate.mtime),
      kind: existing.kind === 'other' ? candidate.kind : existing.kind,
      source:
        SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]
          ? candidate.source
          : existing.source,
    });
  }
  return [...byPath.values()].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
}
