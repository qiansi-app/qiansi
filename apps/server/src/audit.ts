import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append-only local trail of everything that changes state. Deliberately
 * boring: one JSON object per line, never rewritten, never in the repo.
 * Auditing must never break a request, so every write is best-effort.
 */
export class AuditLog {
  private readonly file: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'audit.jsonl');
  }

  record(entry: Omit<AuditEntry, 'ts'>): void {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      appendFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // a failed audit write must not fail the action it describes
    }
  }

  tail(limit = 200): AuditEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const lines = readFileSync(this.file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(limit, 2000))).map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return { ts: '', actor: '', action: 'unparseable', detail: { line } };
        }
      });
    } catch {
      return [];
    }
  }
}
