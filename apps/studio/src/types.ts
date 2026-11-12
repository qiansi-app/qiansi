export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | null;

export interface RunTaskView {
  taskId: string;
  nodeId: string;
  title?: string;
  model?: string;
  effort?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  output?: string;
  acceptance?: {
    pass: boolean;
    score: number;
    reasons: string[];
    needsHuman?: boolean;
  };
}

export interface RunSummary {
  runId: string;
  status: 'done' | 'failed' | 'aborted';
  total: number;
  passed: number;
  needsHuman: number;
  events: number;
  durationMs: number;
  tokens?: number;
}

/** 运行失败归因：界面展示原因与重试入口时用。 */
export interface RunFailureInfo {
  headline: string;
  reasons: string[];
  failedTasks: Array<{ id: string; title: string; error: string }>;
  attempt: number;
  maxAttempts: number;
  retryScheduled: boolean;
}

/** 失败运行的环境诊断：工作目录、模型 Key、可用的重跑方式。 */
export interface RunDiagnosisModel {
  nodeId: string;
  name: string;
  model: string;
  slot: string;
  disabled: boolean;
  ready: boolean;
  note: string;
}

export interface RunDiagnosis {
  ok: boolean;
  runId: string;
  workspaceId: string;
  status: string;
  goal: string;
  hasPlan: boolean;
  failure: RunFailureInfo | null;
  attempt: number;
  maxAttempts: number;
  tasks: Array<{
    id: string;
    title: string;
    nodeId: string;
    status: 'done' | 'failed' | 'pending';
    error?: string;
  }>;
  environment: {
    rootDir: {
      path: string;
      exists: boolean;
      writable: boolean;
      source: 'workspace' | 'server';
    } | null;
    models: RunDiagnosisModel[];
    missing: string[];
    hints: string[];
  };
  actions: {
    resume: { available: boolean; reason?: string; pending: number };
    fresh: { available: boolean; reason?: string };
    userView: { available: boolean; reason?: string };
  };
  activeRunId: string | null;
}

/** 用户视角验收：真实跑起来、截图、逐项检查。 */
export interface UserViewCheck {  name: string;
  label: string;
  ok: boolean;
  soft?: boolean;
  detail?: string;
}

export interface UserViewReport {
  id: string;
  at: number;
  verdict: 'pass' | 'fail' | 'blocked';
  ok: boolean;
  summary: string;
  kind: string;
  url: string;
  rootDir: string;
  durationMs: number;
  checks: UserViewCheck[];
  shots: Array<{ label: string; file: string; bytes: number; width: number; height: number }>;
  pageText?: string;
  error?: string;
}

export interface ExternalCallEvent {
  type: 'external.call';
  runId: string;
  taskId: string;
  nodeId: string;
  sessionId: string;
  agent: string;
  purpose: string;
  model: string;
  output: string;
  usage: { input: number; output: number; total: number };
  at: number;
}

/** 团队自治档位：调查/草稿只能用只读工具。 */
export type TeamAutonomy = 'investigate' | 'draft' | 'auto' | 'full';

export interface TeamMember {
  id: string;
  name: string;
  /** 唯一职责，一句话。 */
  job: string;
  model?: string;
  autonomy: TeamAutonomy;
  /** 允许使用的工具白名单；不填表示沿用档位限制。 */
  tools?: string[];
  memory: string;
  createdAt?: number;
}

export interface TeamDoc {
  playbook: string;
  members: TeamMember[];
  warnings?: string[];
  cap?: number;
  updatedAt?: number;
}
