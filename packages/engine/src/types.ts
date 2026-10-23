export type Effort = 'off' | 'low' | 'medium' | 'high' | 'max';

export type Protocol = 'openai-chat' | 'anthropic-messages';

export type EffortDialect =
  | 'openai-reasoning-effort'
  | 'anthropic-thinking-budget'
  | 'qwen-enable-thinking'
  | 'kimi-thinking'
  | 'glm-thinking'
  | 'minimax-output-effort'
  | 'deepseek-model-switch'
  | 'none';

export interface Modalities {
  vision?: boolean;
  tools?: boolean;
  json?: boolean;
  imageGen?: boolean;
  videoGen?: boolean;
  tts?: boolean;
}

export interface CapabilityProfile {
  id: string;
  label: string;
  provider: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  modalities: Modalities;
  effort: {
    dialect: EffortDialect;
    values?: string[];
    budgetRange?: [number, number];
    canDisable: boolean;
    notes?: string;
  };
  endpoints?: Record<string, string>;
  cost?: { inputPerMTok: number; outputPerMTok: number };
  strengths?: Record<string, number>;
  domesticReachable?: boolean;
  measured?: {
    latencyP50Ms?: number;
    latencyP95Ms?: number;
    successRateEwma?: number;
    cooldownUntil?: string;
  };
}

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface NormalizedChatRequest {
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  model: string;
  messages: NormalizedMessage[];
  tools?: ToolSpec[];
  effort: Effort;
  budgetTokens?: number;
  maxTokens?: number;
  providerParams?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type NormalizedStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'toolcall-delta'; id: string; name?: string; argsDelta?: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'done'; reason: 'stop' | 'length' | 'tool_calls' | 'aborted' };

export interface ChatAdapter {
  stream(request: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent>;
}

export type ToolCapability =
  | 'fs.read'
  | 'fs.write'
  | 'shell'
  | 'browser'
  | 'screen'
  | 'network';

export interface ToolPolicy {
  allow: ToolCapability[];
  approval: 'always' | 'per-run' | 'auto';
  workspaceRoot?: string;
  networkAllowlist?: string[];
}

export interface ModelConnection {
  id: string;
  label: string;
  profileId: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  /** Reference into the OS vault; never the raw key. */
  apiKeyRef: string;
  enabled: boolean;
  toolPolicy: ToolPolicy;
}

/** Injected by the desktop shell (safeStorage/DPAPI) or a 0600 local vault. */
export interface VaultPort {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

export interface ProbeCheck {
  name: 'reachable' | 'streaming' | 'text' | 'reasoning' | 'usage' | 'tools' | 'json' | 'effort';
  ok: boolean;
  detail?: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  checks: ProbeCheck[];
  error?: string;
}

export type NodeKind = 'orchestrator' | 'agent';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  role: string;
  profileId: string;
  /** Optional link to a user-editable model connection. */
  connectionId?: string;
  toolPolicy?: ToolPolicy;
  effort: Effort;
  position: { x: number; y: number };
}

export type WireKind = 'assign' | 'handoff' | 'review' | 'context';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: WireKind;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'blocked';

export interface Subtask {
  id: string;
  title: string;
  description: string;
  assignedNodeId: string;
  profileId: string;
  effort: Effort;
  acceptanceCriteria: string;
  machineCheckable: boolean;
  dependsOn: string[];
  status: TaskStatus;
  attempts: number;
  artifacts?: string[];
}

export interface Plan {
  goal: string;
  subtasks: Subtask[];
  rationale?: string;
}

export interface AcceptanceResult {
  pass: boolean;
  score: number;
  reasons: string[];
  suggestedFix?: string;
  /** True when the judge could not produce a usable verdict and a human should look. */
  needsHuman?: boolean;
}

export interface ChoiceOption {
  id: string;
  label: string;
  consequence: string;
  estimatedCostUsd?: number;
}

export interface ChoiceCard {
  id: string;
  title: string;
  detail: string;
  options: ChoiceOption[];
  taskId?: string;
}

export interface BudgetPolicy {
  maxTotalTokens?: number;
  maxTokensPerModel?: number;
  maxTokensPerMinute?: number;
  maxCallsPerTask?: number;
}

export interface UsageSnapshot {
  total: number;
  byModel: Record<string, { input: number; output: number }>;
}

export type RunEvent =
  | { type: 'run.started'; runId: string; goal: string }
  | { type: 'plan.created'; plan: Plan }
  | { type: 'task.queued'; taskId: string; nodeId: string }
  | { type: 'task.started'; taskId: string; nodeId: string; effort: Effort; attempt: number }
  | { type: 'text.delta'; taskId: string; nodeId: string; text: string }
  | { type: 'reasoning.delta'; taskId: string; nodeId: string; text: string }
  | { type: 'task.acceptance'; taskId: string; result: AcceptanceResult }
  | { type: 'task.completed'; taskId: string; output: string; artifacts?: string[] }
  | { type: 'task.revised'; taskId: string; nextEffort: Effort; reason: string }
  | { type: 'task.failed'; taskId: string; error: string }
  | {
      type: 'usage';
      taskId: string;
      nodeId: string;
      modelId: string;
      input: number;
      output: number;
      total: number;
      runTotal: number;
    }
  | {
      type: 'budget.exceeded';
      scope: 'run' | 'model' | 'rate' | 'calls';
      detail: string;
      runTotal: number;
    }
  | { type: 'choice.requested'; card: ChoiceCard }
  | { type: 'choice.resolved'; cardId: string; optionId: string }
  | { type: 'run.finished'; runId: string; status: 'done' | 'aborted' | 'failed' };

export interface RunResult {
  runId: string;
  status: 'done' | 'aborted' | 'failed';
  outputs: Record<string, string>;
}
