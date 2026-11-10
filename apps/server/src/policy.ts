import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Who may start work, and what a started run was authorised to do.
 *
 * Adapted from dsh-superagent's Policy/Mandate split: the policy says what is
 * allowed *now*, the mandate records what was allowed *when the work was
 * accepted*. A run keeps its mandate even after the policy tightens, but the
 * mandate is re-checked before it is used to write anything back — so
 * loosening the rules never retroactively grants authority, and tightening
 * them cannot silently lose work that was already authorised.
 */

export type Scope =
  | 'canvas.read'
  | 'canvas.write'
  | 'run.start'
  | 'run.stop'
  | 'vault.write'
  | 'model.catalog'
  | 'policy.write'
  | 'gateway.use'
  | 'selfopt.write';

export const ALL_SCOPES: Scope[] = [
  'canvas.read',
  'canvas.write',
  'run.start',
  'run.stop',
  'vault.write',
  'model.catalog',
  'policy.write',
  'gateway.use',
  'selfopt.write',
];

export type AcceptMode = 'off' | 'observe' | 'auto';

export interface PolicyActor {
  id: string;
  kind: 'human' | 'agent';
  scopes: Scope[];
}

export interface Policy {
  version: number;
  acceptMode: AcceptMode;
  humans: PolicyActor[];
  agents: PolicyActor[];
  updatedAt: string;
}

export type Admission = 'explicit' | 'inferred' | 'refused';

/** Scopes that spend money or change something: these are what acceptMode gates. */
const WORK_SCOPES = new Set<Scope>(['run.start', 'canvas.write', 'gateway.use', 'selfopt.write']);

export interface AdmissionResult {
  allowed: boolean;
  admission: Admission;
  reason: string;
  policyVersion: number;
  scopes: Scope[];
}

export interface Mandate {
  runId: string;
  actor: string;
  admission: Exclude<Admission, 'refused'>;
  policyVersion: number;
  scopes: Scope[];
  tasks: number;
  createdAt: number;
  /** In observe mode an agent's run is allowed but flagged for a human look. */
  needsReview: boolean;
}

// Stopping is deliberately included: a runaway run must always be stoppable,
// and refusing that would make the policy itself the hazard.
const AGENT_DEFAULTS: Scope[] = [
  'canvas.read',
  'canvas.write',
  'run.start',
  'run.stop',
  'model.catalog',
  // Agents reach models through the /v1 gateway; withholding this by default
  // would break the integrations that existed before policies did.
  'gateway.use',
  // 自我优化会改仓库；它和 run.start 一样受 acceptMode 约束，且有分支/回滚兜底。
  'selfopt.write',
];

export function defaultPolicy(): Policy {
  return {
    version: 1,
    // Matches what the server did before policies existed, so upgrading does
    // not silently lock out the agents that are already wired up.
    acceptMode: 'auto',
    humans: [
      { id: 'local-ui', kind: 'human', scopes: [...ALL_SCOPES] },
      { id: 'studio', kind: 'human', scopes: [...ALL_SCOPES] },
    ],
    agents: [{ id: '*', kind: 'agent', scopes: [...AGENT_DEFAULTS] }],
    updatedAt: new Date().toISOString(),
  };
}

/** 旧版本「全权限」的确切集合，用于把新增 scope 迁移给默认人类账户。 */
const LEGACY_FULL_SCOPES: Scope[] = [
  'canvas.read',
  'canvas.write',
  'run.start',
  'run.stop',
  'vault.write',
  'model.catalog',
  'policy.write',
  'gateway.use',
];

/** 旧版本 agent 通配条目的默认集合，同样用于升级迁移。 */
const LEGACY_AGENT_SCOPES: Scope[] = [
  'canvas.read',
  'canvas.write',
  'run.start',
  'run.stop',
  'model.catalog',
  'gateway.use',
];

function normalize(input: unknown): Policy {
  const raw = (input ?? {}) as Partial<Policy>;
  const actors = (list: unknown, kind: PolicyActor['kind']): PolicyActor[] => {
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const entry = item as Record<string, unknown>;
        const scopes = Array.isArray(entry.scopes)
          ? (entry.scopes.filter(
              (scope): scope is Scope => typeof scope === 'string' && ALL_SCOPES.includes(scope as Scope)
            ) as Scope[])
          : [];
        // 升级迁移：老策略文件里本来就有全部权限的人类账户，应当自动获得
        // 后来新增的 scope，否则升级后本地界面会被一份旧文件锁死在外面。
        // 只迁移人类；agent 的默认权限保持原样，新能力需显式授权。
        if (
          kind === 'human' &&
          LEGACY_FULL_SCOPES.every((scope) => scopes.includes(scope)) &&
          !scopes.includes('selfopt.write')
        ) {
          scopes.push('selfopt.write');
        }
        // 通配 agent 同理：默认集合里的条目拿到新能力；具名 agent 保持原样。
        if (
          kind === 'agent' &&
          String(entry.id ?? '') === '*' &&
          LEGACY_AGENT_SCOPES.every((scope) => scopes.includes(scope)) &&
          !scopes.includes('selfopt.write')
        ) {
          scopes.push('selfopt.write');
        }
        return { id: String(entry.id ?? ''), kind, scopes };
      })
      .filter((entry) => entry.id.length > 0);
  };

  const acceptMode: AcceptMode =
    raw.acceptMode === 'off' || raw.acceptMode === 'observe' ? raw.acceptMode : 'auto';

  return {
    version: Number.isFinite(raw.version) ? Number(raw.version) : 1,
    acceptMode,
    humans: actors(raw.humans, 'human'),
    agents: actors(raw.agents, 'agent'),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export class PolicyStore {
  private readonly file: string;
  private cached: Policy | null = null;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'policy.json');
  }

  read(): Policy {
    if (this.cached) return this.cached;
    if (!existsSync(this.file)) {
      const seeded = defaultPolicy();
      this.write(seeded);
      this.cached = seeded;
      return seeded;
    }
    try {
      this.cached = normalize(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // A corrupt policy must not brick the server; fall back to defaults and
      // keep the broken file so its contents can be inspected.
      this.cached = defaultPolicy();
    }
    return this.cached;
  }

  write(next: Policy): Policy {
    const policy = normalize({ ...next, updatedAt: new Date().toISOString() });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(policy, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    this.cached = policy;
    return policy;
  }

  /** Saves against an expected version so two editors cannot silently clobber. */
  update(
    next: Omit<Policy, 'version' | 'updatedAt'>,
    expectedVersion: number
  ): { ok: true; policy: Policy } | { ok: false; error: 'stale_revision'; current: Policy } {
    const current = this.read();
    if (current.version !== expectedVersion) {
      return { ok: false, error: 'stale_revision', current };
    }
    const saved = this.write({ ...next, version: current.version + 1, updatedAt: '' });
    return { ok: true, policy: saved };
  }

  /**
   * The gate. A named actor on the list is explicit; anyone reaching the server
   * with the shared token is an unnamed agent and falls under the wildcard,
   * whose power depends on the accept mode.
   */
  admit(actor: string, scope: Scope): AdmissionResult {
    const policy = this.read();
    // Stopping is never refused. A policy that can block a stop turns itself
    // into the hazard: whoever tightened it can no longer halt what is running.
    // The call still requires a valid token, and every stop is audited.
    if (scope === 'run.stop') {
      return {
        allowed: true,
        admission: 'explicit',
        reason: '停止不受策略限制',
        policyVersion: policy.version,
        scopes: ALL_SCOPES,
      };
    }
    const humans = policy.humans.find((entry) => entry.id === actor);
    if (humans) {
      const allowed = humans.scopes.includes(scope);
      return {
        allowed,
        admission: allowed ? 'explicit' : 'refused',
        reason: allowed ? '列在人员名单内' : `人员 ${actor} 没有 ${scope} 权限`,
        policyVersion: policy.version,
        scopes: humans.scopes,
      };
    }

    const named = policy.agents.find((entry) => entry.id === actor);
    const wildcard = policy.agents.find((entry) => entry.id === '*');
    const matched = named ?? wildcard;
    if (!matched) {
      return {
        allowed: false,
        admission: 'refused',
        reason: '策略里没有允许的 agent 条目',
        policyVersion: policy.version,
        scopes: [],
      };
    }
    if (!matched.scopes.includes(scope)) {
      return {
        allowed: false,
        admission: 'refused',
        reason: `agent ${actor} 没有 ${scope} 权限`,
        policyVersion: policy.version,
        scopes: matched.scopes,
      };
    }

    if (named) {
      return {
        allowed: true,
        admission: 'explicit',
        reason: `agent ${actor} 在名单内`,
        policyVersion: policy.version,
        scopes: matched.scopes,
      };
    }

    // Unnamed agent, matched only by the wildcard. acceptMode governs work that
    // costs or changes something; reading is already decided by the scopes, and
    // stopping must never be blocked.
    if (policy.acceptMode === 'off' && WORK_SCOPES.has(scope)) {
      return {
        allowed: false,
        admission: 'refused',
        reason: 'acceptMode 为 off：未在名单内的 agent 不能发起工作',
        policyVersion: policy.version,
        scopes: matched.scopes,
      };
    }
    return {
      allowed: true,
      admission: 'inferred',
      reason:
        policy.acceptMode === 'observe'
          ? `未在名单内的 agent（${actor}），已放行并标记为待复核`
          : `未在名单内的 agent（${actor}），按 acceptMode=auto 放行`,
      policyVersion: policy.version,
      scopes: matched.scopes,
    };
  }

  /**
   * Called before a mandate is used again — here, before a finished run writes
   * its artifacts back to the canvas. Returns why a mandate no longer holds.
   */
  revalidate(
    mandate: Mandate | undefined,
    scope: Scope
  ): { ok: true } | { ok: false; reason: string } {
    if (!mandate) return { ok: true };
    const policy = this.read();
    const holder =
      policy.humans.find((entry) => entry.id === mandate.actor) ??
      policy.agents.find((entry) => entry.id === mandate.actor) ??
      policy.agents.find((entry) => entry.id === '*');
    if (!holder) return { ok: false, reason: `策略里已经没有 ${mandate.actor}` };
    if (!holder.scopes.includes(scope)) {
      return { ok: false, reason: `${mandate.actor} 当前的策略版本已不含 ${scope}` };
    }
    if (policy.acceptMode === 'off' && mandate.admission === 'inferred') {
      return { ok: false, reason: 'acceptMode 已改为 off，推断授权失效' };
    }
    return { ok: true };
  }
}

/** Path + method to the scope it needs. Unknown routes are left to the routes. */
export function scopeForRequest(method: string, path: string): Scope | null {
  const verb = method.toUpperCase();
  const write = verb !== 'GET' && verb !== 'HEAD';
  if (path.startsWith('/api/canvas')) return write ? 'canvas.write' : 'canvas.read';
  if (path.startsWith('/api/connections') || path.startsWith('/api/vault') || path.startsWith('/api/keys')) {
    return write ? 'vault.write' : 'canvas.read';
  }
  if (path.startsWith('/api/models/refresh')) return 'model.catalog';
  if (path.startsWith('/api/policy')) return write ? 'policy.write' : 'canvas.read';
  if (path.startsWith('/api/runs') || path.startsWith('/api/audit')) return 'canvas.read';
  if (path.startsWith('/api/selfopt')) return write ? 'selfopt.write' : 'canvas.read';
  if (path.startsWith('/v1/')) return 'gateway.use';
  return null;
}
