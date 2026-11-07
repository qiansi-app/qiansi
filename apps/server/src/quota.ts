import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeySlot } from './model-catalog.js';

/**
 * Per-key quota and usage, in the shape CC Switch taught people to expect:
 * every subscription (key) has a period and a limit, you can see how much is
 * left, and the one that runs out rotates to the next instead of failing the
 * run. Usage is estimated locally from token counts — providers rarely expose a
 * balance API, and a wrong number you can see beats no number at all.
 */

export type KeyPeriod = 'day' | 'month';
export type UsageSource = 'run' | 'judge' | 'gateway' | 'chat';

export interface KeyQuota {
  period: KeyPeriod;
  limitTokens: number;
}

export interface ManagedKey {
  /** Stable id within its slot; also the suffix of its vault ref. */
  id: string;
  label: string;
  /** Where the secret lives. Default keys reuse the family's original ref. */
  vaultRef: string;
  enabled: boolean;
  /** null = unlimited */
  quota: KeyQuota | null;
  createdAt: number;
  lastUsedAt?: number;
}

export interface SlotRecord {
  keys: ManagedKey[];
  activeKeyId: string;
}

export interface UsageRecord {
  ts: number;
  slot: KeySlot;
  keyId: string;
  model: string;
  tokens: number;
  costCny: number;
  source: UsageSource;
}

export interface QuotaFile {
  version: 1;
  slots: Partial<Record<KeySlot, SlotRecord>>;
  usage: UsageRecord[];
  /** CNY per 1M tokens, by slot. Estimates; override here to match your bill. */
  prices?: Partial<Record<KeySlot, { in: number; out: number }>>;
}

export interface KeyView {
  id: string;
  label: string;
  vaultRef: string;
  enabled: boolean;
  quota: KeyQuota | null;
  spentTokens: number;
  spentCny: number;
  limitTokens: number | null;
  percent: number | null;
  state: 'unlimited' | 'ok' | 'warn' | 'exhausted';
  active: boolean;
  lastUsedAt?: number;
}

export interface SlotView {
  slot: KeySlot;
  label: string;
  activeKeyId: string;
  keys: KeyView[];
  headroomTokens: number;
  state: 'ok' | 'warn' | 'exhausted' | 'unconfigured';
  periodResetsAt: number | null;
}

const DEFAULT_PRICES: Record<KeySlot, { in: number; out: number }> = {
  // Rough public list prices in CNY per 1M tokens. Quota math stays useful even
  // when these drift; quota.json can override them per slot.
  deepseek: { in: 1, out: 4 },
  minimax: { in: 1, out: 4 },
  moonshot: { in: 4, out: 16 },
  zhipu: { in: 1, out: 4 },
  qwen: { in: 2, out: 6 },
  openai: { in: 18, out: 72 },
  relay: { in: 15, out: 75 },
};

const MAX_USAGE = 5000;

export function periodStart(period: KeyPeriod, now = Date.now()): number {
  const date = new Date(now);
  if (period === 'day') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function periodEnd(period: KeyPeriod, now = Date.now()): number {
  const date = new Date(now);
  const next =
    period === 'day'
      ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
      : new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return next.getTime();
}

export class QuotaStore {
  private readonly file: string;
  private data: QuotaFile;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'keys.json');
    this.data = this.load();
  }

  private load(): QuotaFile {
    if (!existsSync(this.file)) return { version: 1, slots: {}, usage: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<QuotaFile>;
      return {
        version: 1,
        slots: parsed.slots ?? {},
        usage: Array.isArray(parsed.usage) ? parsed.usage : [],
        prices: parsed.prices,
      };
    } catch {
      return { version: 1, slots: {}, usage: [] };
    }
  }

  private persistNow(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Usage lands in bursts; batch the disk writes so a run does not fsync per token. */
  private schedulePersist(): void {
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      try {
        this.persistNow();
      } catch {
        // a failed write must not take the server down; the next one retries
      }
    }, 800);
    this.dirtyTimer.unref?.();
  }

  flush(): void {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
    try {
      this.persistNow();
    } catch {
      // best effort
    }
  }

  /**
   * Makes sure every family that already has a secret on disk also has a
   * managed key entry, so quota controls exist without a re-entry of keys.
   */
  seed(
    families: Array<{ slot: KeySlot; label: string; vaultRef: string; envPresent?: boolean }>,
    presentRefs: string[]
  ): void {
    let changed = false;
    for (const family of families) {
      // A key kept in an environment variable is just as real as one in the
      // vault — it must show up with quota controls, not as "unconfigured".
      if (!presentRefs.includes(family.vaultRef) && !family.envPresent) continue;
      const existing = this.data.slots[family.slot];
      if (existing?.keys.some((key) => key.vaultRef === family.vaultRef)) continue;
      const key: ManagedKey = {
        id: 'default',
        label: `${family.label} 主账号`,
        vaultRef: family.vaultRef,
        enabled: true,
        quota: null,
        createdAt: Date.now(),
      };
      this.data.slots[family.slot] = {
        keys: [...(existing?.keys ?? []).filter((item) => item.id !== 'default'), key],
        activeKeyId: existing?.activeKeyId ?? 'default',
      };
      changed = true;
    }
    if (changed) this.flush();
  }

  slot(slot: KeySlot): SlotRecord | undefined {
    return this.data.slots[slot];
  }

  vaultRefFor(slot: KeySlot, keyId: string): string | undefined {
    return this.data.slots[slot]?.keys.find((key) => key.id === keyId)?.vaultRef;
  }

  addKey(slot: KeySlot, input: { id: string; label: string; vaultRef: string; quota: KeyQuota | null }): ManagedKey {
    const record = this.data.slots[slot] ?? { keys: [], activeKeyId: '' };
    if (record.keys.some((key) => key.id === input.id)) {
      throw new Error(`key ${input.id} already exists in ${slot}`);
    }
    const key: ManagedKey = {
      id: input.id,
      label: input.label,
      vaultRef: input.vaultRef,
      enabled: true,
      quota: input.quota,
      createdAt: Date.now(),
    };
    record.keys.push(key);
    if (!record.activeKeyId) record.activeKeyId = key.id;
    this.data.slots[slot] = record;
    this.flush();
    return key;
  }

  updateKey(
    slot: KeySlot,
    keyId: string,
    patch: { label?: string; enabled?: boolean; quota?: KeyQuota | null; vaultRef?: string }
  ): ManagedKey | undefined {
    const key = this.data.slots[slot]?.keys.find((item) => item.id === keyId);
    if (!key) return undefined;
    if (typeof patch.label === 'string' && patch.label.trim()) key.label = patch.label.trim();
    if (typeof patch.enabled === 'boolean') key.enabled = patch.enabled;
    if (patch.quota !== undefined) key.quota = patch.quota;
    if (typeof patch.vaultRef === 'string' && patch.vaultRef.trim()) key.vaultRef = patch.vaultRef.trim();
    this.flush();
    return key;
  }

  removeKey(slot: KeySlot, keyId: string): boolean {
    const record = this.data.slots[slot];
    if (!record) return false;
    const before = record.keys.length;
    record.keys = record.keys.filter((key) => key.id !== keyId);
    if (record.keys.length === before) return false;
    if (record.activeKeyId === keyId) record.activeKeyId = record.keys[0]?.id ?? '';
    this.flush();
    return true;
  }

  setActive(slot: KeySlot, keyId: string): boolean {
    const record = this.data.slots[slot];
    if (!record || !record.keys.some((key) => key.id === keyId)) return false;
    record.activeKeyId = keyId;
    this.flush();
    return true;
  }

  record(input: { slot: KeySlot; keyId: string; model: string; tokens: number; source: UsageSource }): UsageRecord {
    const price = this.data.prices?.[input.slot] ?? DEFAULT_PRICES[input.slot];
    const costCny = (input.tokens / 1_000_000) * ((price.in + price.out) / 2);
    const record: UsageRecord = {
      ts: Date.now(),
      slot: input.slot,
      keyId: input.keyId,
      model: input.model,
      tokens: Math.max(0, Math.round(input.tokens)),
      costCny: Math.round(costCny * 10000) / 10000,
      source: input.source,
    };
    this.data.usage.push(record);
    if (this.data.usage.length > MAX_USAGE) {
      this.data.usage = this.data.usage.slice(-MAX_USAGE);
    }
    const key = this.data.slots[input.slot]?.keys.find((item) => item.id === input.keyId);
    if (key) key.lastUsedAt = record.ts;
    this.schedulePersist();
    return record;
  }

  spent(slot: KeySlot, keyId: string, now = Date.now()): { tokens: number; costCny: number } {
    const key = this.data.slots[slot]?.keys.find((item) => item.id === keyId);
    if (!key) return { tokens: 0, costCny: 0 };
    const since = key.quota ? periodStart(key.quota.period, now) : 0;
    let tokens = 0;
    let costCny = 0;
    for (const record of this.data.usage) {
      if (record.slot !== slot || record.keyId !== keyId) continue;
      if (record.ts < since) continue;
      tokens += record.tokens;
      costCny += record.costCny;
    }
    return { tokens, costCny: Math.round(costCny * 100) / 100 };
  }

  private keyState(key: ManagedKey, spentTokens: number): KeyView['state'] {
    if (!key.quota) return 'unlimited';
    const ratio = key.quota.limitTokens > 0 ? spentTokens / key.quota.limitTokens : 1;
    if (ratio >= 1) return 'exhausted';
    if (ratio >= 0.8) return 'warn';
    return 'ok';
  }

  view(slot: KeySlot, label: string): SlotView {
    const record = this.data.slots[slot];
    if (!record || record.keys.length === 0) {
      return {
        slot,
        label,
        activeKeyId: '',
        keys: [],
        headroomTokens: 0,
        state: 'unconfigured',
        periodResetsAt: null,
      };
    }
    const keys: KeyView[] = record.keys.map((key) => {
      const spent = this.spent(slot, key.id);
      const limit = key.quota?.limitTokens ?? null;
      return {
        id: key.id,
        label: key.label,
        vaultRef: key.vaultRef,
        enabled: key.enabled,
        quota: key.quota,
        spentTokens: spent.tokens,
        spentCny: spent.costCny,
        limitTokens: limit,
        percent: limit && limit > 0 ? Math.min(100, Math.round((spent.tokens / limit) * 100)) : null,
        state: this.keyState(key, spent.tokens),
        active: key.id === record.activeKeyId,
        lastUsedAt: key.lastUsedAt,
      };
    });
    const usable = keys.filter((key) => key.enabled && key.state !== 'exhausted');
    const headroomTokens = usable.reduce((sum, key) => {
      if (key.limitTokens === null) return Number.POSITIVE_INFINITY;
      return sum + Math.max(0, key.limitTokens - key.spentTokens);
    }, 0);
    const active = keys.find((key) => key.active);
    const state: SlotView['state'] =
      usable.length === 0 ? 'exhausted' : active?.state === 'warn' || usable.some((k) => k.state === 'warn') ? 'warn' : 'ok';
    const activeKey = record.keys.find((key) => key.id === record.activeKeyId);
    return {
      slot,
      label,
      activeKeyId: record.activeKeyId,
      keys,
      headroomTokens: Number.isFinite(headroomTokens) ? headroomTokens : -1,
      state: usable.some((key) => key.state === 'unlimited') ? 'ok' : state,
      periodResetsAt: activeKey?.quota ? periodEnd(activeKey.quota.period) : null,
    };
  }

  /**
   * The key a call should use right now. If the active one is out of quota,
   * rotates to the next enabled key with headroom and remembers the choice.
   */
  pick(slot: KeySlot): { keyId: string; vaultRef: string; rotatedFrom?: string } | null {
    const record = this.data.slots[slot];
    if (!record || record.keys.length === 0) return null;
    const usable = record.keys.filter((key) => {
      if (!key.enabled) return false;
      return this.keyState(key, this.spent(slot, key.id).tokens) !== 'exhausted';
    });
    if (usable.length === 0) return null;
    const active = usable.find((key) => key.id === record.activeKeyId);
    if (active) return { keyId: active.id, vaultRef: active.vaultRef };
    const next = usable[0]!;
    const rotatedFrom = record.activeKeyId || undefined;
    record.activeKeyId = next.id;
    this.flush();
    return { keyId: next.id, vaultRef: next.vaultRef, rotatedFrom };
  }

  /** Sum of remaining tokens across enabled keys; -1 when any is unlimited. */
  headroom(slot: KeySlot): number {
    const record = this.data.slots[slot];
    if (!record) return 0;
    let total = 0;
    for (const key of record.keys) {
      if (!key.enabled) continue;
      if (!key.quota) return -1;
      const spent = this.spent(slot, key.id).tokens;
      total += Math.max(0, key.quota.limitTokens - spent);
    }
    return total;
  }

  recent(limit = 50): UsageRecord[] {
    return this.data.usage.slice(-Math.max(1, Math.min(limit, 500)));
  }

  prices(): Record<KeySlot, { in: number; out: number }> {
    return { ...DEFAULT_PRICES, ...(this.data.prices ?? {}) } as Record<KeySlot, { in: number; out: number }>;
  }
}
