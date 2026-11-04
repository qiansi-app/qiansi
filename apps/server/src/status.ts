import { APP_VERSION } from './version.js';

/**
 * A health report in the shape a watchdog can act on without reading logs.
 *
 * The exit codes are the contract (borrowed from DeepSeek's dsh-superagent
 * deployment script): a supervisor must be able to tell "restart will fix it"
 * from "restarting is pointless" without parsing prose.
 *
 *   0  running, or intentionally stopped
 *   1  not running / not answering / crashed — a restart may fix it
 *   2  running, but a part is broken — a restart will not fix it
 *   3  running, but waiting for someone to configure it
 */
export type ExitCode = 0 | 1 | 2 | 3;

export type PartState = 'ready' | 'starting' | 'error' | 'setup' | 'paused';

export interface HealthPart {
  state: PartState;
  detail?: string;
  at: number;
}

export interface StatusReport {
  ok: boolean;
  code: ExitCode;
  state: 'ok' | 'error' | 'setup' | 'down';
  version: string;
  uptimeSeconds: number;
  startedAt: number;
  manuallyStopped: boolean;
  parts: Record<string, HealthPart>;
  /** Broken parts, named with their detail. Empty is the normal case. */
  errors: string[];
  /** Things a person must fix. Each one maps to a setting. */
  setup: string[];
  /** Things nobody has to act on yet, but that explain odd behaviour. */
  warnings: string[];
  load: {
    activeRunId: string | null;
    activeRunAgeMs: number | null;
    runningTasks: number;
  };
}

export function part(
  state: PartState,
  detail?: string
): HealthPart {
  return { state, detail, at: Date.now() };
}

/**
 * Folds parts into one exit code. Setup beats error beats ready: a server that
 * is misconfigured should say "configure me" rather than "I am broken",
 * because the fix is different and repeating restarts would only hide it.
 */
export function summarize(input: {
  startedAt: number;
  manuallyStopped: boolean;
  parts: Record<string, HealthPart>;
  setup?: string[];
  warnings?: string[];
  load: StatusReport['load'];
}): StatusReport {
  const setup = input.setup ?? [];
  const warnings = input.warnings ?? [];
  const errors = Object.entries(input.parts)
    .filter(([, value]) => value.state === 'error')
    .map(([name, value]) => `${name}: ${value.detail ?? 'error'}`);

  let code: ExitCode = 0;
  let state: StatusReport['state'] = 'ok';
  if (input.manuallyStopped) {
    // An intentional stop is not a fault: a watchdog must leave it alone.
    code = 0;
    state = 'ok';
  } else if (setup.length > 0) {
    code = 3;
    state = 'setup';
  } else if (errors.length > 0) {
    code = 2;
    state = 'error';
  }

  return {
    ok: code === 0,
    code,
    state,
    version: APP_VERSION,
    uptimeSeconds: Math.round((Date.now() - input.startedAt) / 1000),
    startedAt: input.startedAt,
    manuallyStopped: input.manuallyStopped,
    parts: input.parts,
    errors,
    setup,
    warnings,
    load: input.load,
  };
}

export function exitCodeFor(report: StatusReport): ExitCode {
  return report.code;
}
