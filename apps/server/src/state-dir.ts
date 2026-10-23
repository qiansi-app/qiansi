import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const currentDir = join(homedir(), '.qiansi');
const legacyDir = join(homedir(), '.agentweave');

/**
 * Moves the pre-rename data directory once. The DPAPI vault and run history
 * are bound to the Windows user, so a rename keeps both usable.
 */
export function ensureStateDir(): string {
  if (!existsSync(currentDir) && existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, currentDir);
    } catch {
      cpSync(legacyDir, currentDir, { recursive: true });
    }
  }
  mkdirSync(currentDir, { recursive: true });
  return currentDir;
}
