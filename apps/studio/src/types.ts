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
