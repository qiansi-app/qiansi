import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CanvasDocument } from './canvas.js';

const TEXT_EXT = /\.(md|markdown|txt|json|csv|tsv|ts|tsx|js|jsx|py|yaml|yml|html|css|log|xml|sql|sh)$/i;
const MAX_FILES = 8;
const MAX_BYTES_PER_FILE = 24 * 1024;

export interface CanvasFileText {
  id: string;
  name: string;
  text: string;
  truncated: boolean;
}

/**
 * The canvas stores only a file id and a short preview, so a run that wants the
 * real content has to read it back from ~/.qiansi/files. Text files only —
 * binaries would poison the prompt.
 */
export function collectCanvasFiles(
  document: CanvasDocument,
  stateDir: string
): CanvasFileText[] {
  const dir = join(stateDir, 'files');
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const wanted = new Map<string, string>();
  for (const node of document.nodes) {
    const data = node.data ?? {};
    const files = Array.isArray(data.libraryFiles) ? data.libraryFiles : [];
    for (const file of files) {
      const id = typeof file?.id === 'string' ? file.id : '';
      if (!id) continue;
      wanted.set(id, String(file.name ?? 'file'));
    }
    if (typeof data.fileId === 'string' && data.fileId) {
      wanted.set(data.fileId, String(data.name ?? 'file'));
    }
  }
  if (!wanted.size) return [];

  const collected: CanvasFileText[] = [];
  for (const [id, name] of wanted) {
    if (collected.length >= MAX_FILES) break;
    const match = entries.find((entry) => entry.startsWith(`${id}-`));
    if (!match) continue;
    // Trust the name on disk, not the name the canvas claims: a binary renamed
    // to .md in the canvas must not be read into the prompt.
    if (!TEXT_EXT.test(match)) continue;
    const path = join(dir, match);
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size === 0) continue;
      // Read only the budget, never the whole file: a 500MB log should not be
      // pulled into memory just to be truncated.
      const wanted = Math.min(info.size, MAX_BYTES_PER_FILE);
      const buffer = Buffer.alloc(wanted);
      const fd = openSync(path, 'r');
      let read = 0;
      try {
        read = readSync(fd, buffer, 0, wanted, 0);
      } finally {
        closeSync(fd);
      }
      collected.push({
        id,
        name,
        text: buffer.subarray(0, read).toString('utf8'),
        truncated: info.size > MAX_BYTES_PER_FILE,
      });
    } catch {
      // unreadable file: skip it rather than failing the whole run
    }
  }
  return collected;
}

/** Splits a byte budget across tasks so the same files do not multiply the prompt. */
export function filesForTask(
  files: CanvasFileText[],
  taskIndex: number,
  taskCount: number
): string {
  if (!files.length) return '';
  const budget = Math.max(
    8 * 1024,
    Math.min(24 * 1024, Math.floor((80 * 1024) / Math.max(1, taskCount)))
  );
  let used = 0;
  const parts: string[] = [];
  for (const file of files) {
    if (used >= budget) break;
    const room = budget - used;
    let slice = file.text;
    let bytes = Buffer.byteLength(slice, 'utf8');
    if (bytes > room) {
      // Trim by characters until the UTF-8 byte count fits: a Chinese character
      // costs three bytes, so a character budget would overshoot threefold.
      let end = Math.min(slice.length, room);
      slice = slice.slice(0, end);
      bytes = Buffer.byteLength(slice, 'utf8');
      while (bytes > room && end > 0) {
        end = Math.floor(end * 0.9);
        slice = file.text.slice(0, end);
        bytes = Buffer.byteLength(slice, 'utf8');
      }
      slice = `${slice}\n…（已截断）`;
    }
    used += bytes;
    parts.push(`--- ${file.name} ---\n${slice}`);
  }
  if (!parts.length) return '';
  return `参考资料（用户上传，可能与当前子任务不完全相关）：\n${parts.join('\n\n')}\n`;
}

export function fileSummary(files: CanvasFileText[]): string {
  if (!files.length) return '';
  return files.map((file) => `${file.name}${file.truncated ? '（节选）' : ''}`).join('、');
}
