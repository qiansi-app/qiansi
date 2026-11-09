import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 工作区：一张画布 + 它自己的运行历史。
 *
 * 之前只有一个 `~/.qiansi/canvas.json`，于是不同项目的流程会堆在同一张图上。
 * 现在每个工作区有自己的目录，互不干扰；切换工作区等于换一张白板，旧图原样保留。
 *
 * 磁盘布局：
 *   ~/.qiansi/workspaces.json          索引（当前工作区、名字、顺序）
 *   ~/.qiansi/workspaces/<id>/canvas.json
 *   ~/.qiansi/workspaces/<id>/canvas.revision
 */

export interface WorkspaceMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceFile {
  version: 1;
  current: string;
  items: WorkspaceMeta[];
}

const DEFAULT_ID = 'main';

export class WorkspaceStore {
  private readonly stateDir: string;
  private readonly indexFile: string;
  private data: WorkspaceFile;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.indexFile = join(stateDir, 'workspaces.json');
    mkdirSync(stateDir, { recursive: true });
    this.data = this.loadOrMigrate();
  }

  /**
   * 第一次启动时把旧的单画布迁进来：旧文件就是「主画布」，不丢数据。
   * 迁移只做一次，之后以 workspaces.json 为准。
   */
  private loadOrMigrate(): WorkspaceFile {
    if (existsSync(this.indexFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as Partial<WorkspaceFile>;
        const items = (parsed.items ?? []).filter(
          (item): item is WorkspaceMeta => Boolean(item?.id)
        );
        if (items.length > 0) {
          const current = items.some((item) => item.id === parsed.current)
            ? String(parsed.current)
            : items[0]!.id;
          return { version: 1, current, items };
        }
      } catch {
        // 损坏的索引：重建，但下面的迁移会把旧画布接回来
      }
    }

    const now = Date.now();
    const legacyCanvas = join(this.stateDir, 'canvas.json');
    const legacyRevision = join(this.stateDir, 'canvas.revision');
    const hadLegacy = existsSync(legacyCanvas);
    const meta: WorkspaceMeta = {
      id: DEFAULT_ID,
      name: hadLegacy ? '主画布' : '空白画布',
      createdAt: now,
      updatedAt: now,
    };

    const dir = this.dirOf(DEFAULT_ID);
    mkdirSync(dir, { recursive: true });
    if (hadLegacy) {
      for (const [from, to] of [
        [legacyCanvas, join(dir, 'canvas.json')],
        [legacyRevision, join(dir, 'canvas.revision')],
      ] as const) {
        if (!existsSync(from)) continue;
        try {
          if (!existsSync(to)) renameSync(from, to);
          else rmSync(from, { force: true });
        } catch {
          // 迁移失败也不要丢数据：旧文件留在原地，用户还能手工找回
        }
      }
    }

    const file: WorkspaceFile = { version: 1, current: DEFAULT_ID, items: [meta] };
    this.data = file;
    this.persist();
    return file;
  }

  private persist(): void {
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.indexFile);
  }

  dirOf(id: string): string {
    return join(this.stateDir, 'workspaces', id);
  }

  list(): WorkspaceMeta[] {
    return [...this.data.items].sort((a, b) => a.createdAt - b.createdAt);
  }

  current(): string {
    return this.data.current;
  }

  setCurrent(id: string): boolean {
    if (!this.data.items.some((item) => item.id === id)) return false;
    this.data.current = id;
    this.persist();
    return true;
  }

  get(id: string): WorkspaceMeta | undefined {
    return this.data.items.find((item) => item.id === id);
  }

  /** 未知 id 一律回落到当前工作区：旧客户端不带工作区也不会崩。 */
  resolve(id: string | undefined | null): WorkspaceMeta {
    const wanted = String(id ?? '').trim();
    if (wanted) {
      const found = this.get(wanted);
      if (found) return found;
    }
    return this.get(this.data.current) ?? this.data.items[0]!;
  }

  create(name?: string): WorkspaceMeta {
    const now = Date.now();
    const id = `ws-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const meta: WorkspaceMeta = {
      id,
      name: (name ?? '').trim().slice(0, 40) || `画布 ${this.data.items.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };
    this.data.items.push(meta);
    mkdirSync(this.dirOf(id), { recursive: true });
    this.persist();
    return meta;
  }

  rename(id: string, name: string): WorkspaceMeta | undefined {
    const meta = this.get(id);
    const value = name.trim().slice(0, 40);
    if (!meta || !value) return undefined;
    meta.name = value;
    meta.updatedAt = Date.now();
    this.persist();
    return meta;
  }

  /** 至少留一个工作区；删除当前工作区时把当前切到剩下的第一个。 */
  remove(id: string): { ok: true } | { ok: false; reason: string } {
    if (this.data.items.length <= 1) return { ok: false, reason: 'last_workspace' };
    const index = this.data.items.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, reason: 'not_found' };
    this.data.items.splice(index, 1);
    if (this.data.current === id) this.data.current = this.data.items[0]!.id;
    this.persist();
    try {
      rmSync(this.dirOf(id), { recursive: true, force: true });
    } catch {
      // 目录删不掉不影响索引；下次启动再清
    }
    return { ok: true };
  }

  touch(id: string): void {
    const meta = this.get(id);
    if (!meta) return;
    meta.updatedAt = Date.now();
  }
}
