import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const explicitHome = process.env.QIANSI_HOME?.trim() || null;
const defaultDir = join(homedir(), '.qiansi');
const currentDir = explicitHome ?? defaultDir;
const legacyDir = join(homedir(), '.agentweave');

/**
 * 状态目录。默认 ~/.qiansi；`QIANSI_HOME` 指到别处时用它，并且不做旧目录迁移——
 * 显式指定通常意味着测试或第二实例，不该把用户真实数据搬过去。
 */
export function ensureStateDir(): string {
  if (!explicitHome && !existsSync(currentDir) && existsSync(legacyDir)) {
    // Moves the pre-rename data directory once. The DPAPI vault and run history
    // are bound to the Windows user, so a rename keeps both usable.
    try {
      renameSync(legacyDir, currentDir);
    } catch {
      cpSync(legacyDir, currentDir, { recursive: true });
    }
  }
  mkdirSync(currentDir, { recursive: true });
  return currentDir;
}
