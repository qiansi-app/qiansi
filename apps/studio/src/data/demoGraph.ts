import { MarkerType, type Edge, type Node } from '@xyflow/react';

export type NodeStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'blocked';

export type EffortLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export type NodeKind =
  | 'orchestrator'
  | 'agent'
  | 'task'
  | 'artifact'
  | 'file'
  | 'library'
  | 'region'
  | 'external';

export interface LibraryFile {
  id: string;
  name: string;
  size: number;
  preview?: string;
}


/** Direction a drawn project region exchanges work with the main workflow. */
export type RegionMode = 'open' | 'inbound' | 'outbound' | 'closed';

export interface AgentNodeData extends Record<string, unknown> {
  name: string;
  role: string;
  provider: string;
  model: string;
  effort: EffortLevel;
  status: NodeStatus;
  kind: NodeKind;
  accent: string;
  metric?: string;
  connectionId?: string;
  protocol?: string;
  baseUrl?: string;
  taskId?: string;
  /** Node that produced this task/artifact, used when pinning artifacts to a wire. */
  sourceNodeId?: string;
  task?: string;
  artifact?: string;
  metrics?: string;
  retry?: string;
  effortSource?: string;
  /** Task / artifact nodes */
  output?: string;
  acceptance?: { pass: boolean; score?: number; reasons?: string[]; needsHuman?: boolean };
  onOpen?: (taskId: string) => void;
  /** File nodes */
  fileName?: string;
  fileSize?: number;
  fileId?: string;
  filePreview?: string;
  /** Library nodes */
  libraryFiles?: LibraryFile[];
  isPublic?: boolean;
  /** Region nodes */
  regionMode?: RegionMode;
  regionWidth?: number;
  regionHeight?: number;
  /** Shared actions, injected at render time */
  onDelete?: () => void;
  onMakeOrchestrator?: () => void;
  hidden?: boolean;
}


export type StudioNode = Node<AgentNodeData>;

const nodeDefaults = {
  type: 'agent' as const,
  data: {
    status: 'idle' as NodeStatus,
    effort: 'medium' as EffortLevel,
    kind: 'agent' as const,
  },
};

export const initialNodes: StudioNode[] = [
  {
    ...nodeDefaults,
    id: 'orchestrator',
    deletable: false,
    position: { x: 400, y: 20 },
    data: {
      ...nodeDefaults.data,
      name: '主控',
      role: '拆解目标 · 分派 · 验收',
      provider: 'Claude (relay)',
      model: 'claude-opus-4-8[1M]',
      effort: 'high',
      kind: 'orchestrator',
      accent: '#e0a458',
      metric: '验收 3/3',
      connectionId: 'conn-claude-relay',
      taskId: 'T4',
      task: '正在验收 T4 · 逐条核对验收标准',
      artifact: '全部子任务通过验收。0 次返修，约 3.6k tokens。',
      metrics: '3.6k tok · ¥0.04 · 41s',
      retry: '0/3',
      effortSource: '编排',
    },
  },
  {
    ...nodeDefaults,
    id: 'researcher',
    position: { x: 110, y: 300 },
    data: {
      ...nodeDefaults.data,
      name: '研究员',
      role: '多源检索与核实',
      provider: 'DeepSeek',
      model: 'deepseek-reasoner',
      effort: 'medium',
      accent: '#4d6bfe',
      metric: 'ready',
      connectionId: 'conn-deepseek',
      taskId: 'T1',
      task: '核对第 3 节引用与数据口径',
      artifact: '…差额来自渠道返点，需在结论中单列…',
      metrics: '4.2k tok · ¥0.03 · 12s',
      retry: '0/3',
      effortSource: '编排',
    },
  },
  {
    ...nodeDefaults,
    id: 'writer',
    position: { x: 400, y: 350 },
    data: {
      ...nodeDefaults.data,
      name: '写手',
      role: '长文初稿与改写',
      provider: 'MiniMax',
      model: 'MiniMax-M3.1-Flash',
      effort: 'medium',
      accent: '#ff7a45',
      metric: 'ready',
      connectionId: 'conn-minimax',
      taskId: 'T2',
      task: '按结构写初稿，保留来源标记',
      artifact: '初稿完成：3 节结构、约 900 字，已按验收标准自检。',
      metrics: '3.1k tok · ¥0.02 · 18s',
      retry: '1/3',
      effortSource: '编排',
    },
  },
  {
    ...nodeDefaults,
    id: 'reviewer',
    position: { x: 690, y: 300 },
    data: {
      ...nodeDefaults.data,
      name: '审校',
      role: '事实核查与验收',
      provider: 'Kimi',
      model: 'kimi-k2-thinking',
      effort: 'high',
      accent: '#a78bfa',
      metric: 'ready',
      connectionId: 'conn-kimi',
      taskId: 'T3',
      task: '按验收标准逐条核查',
      artifact: '2 处事实需要补来源，其余通过；建议返修第 2 段。',
      metrics: '1.8k tok · ¥0.01 · 9s',
      retry: '0/3',
      effortSource: '人工',
    },
  },
  {
    ...nodeDefaults,
    id: 'library-public',
    type: 'library',
    position: { x: 40, y: 20 },
    data: {
      ...nodeDefaults.data,
      kind: 'library',
      name: '公共文件库',
      role: '所有节点共享的上下文',
      provider: 'local',
      model: 'library',
      effort: 'off',
      accent: '#38d9c2',
      isPublic: true,
      libraryFiles: [],
    },
  },
];

const edgeBase = {
  type: 'smoothstep' as const,
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  labelStyle: { fill: '#8b98a8', fontSize: 9.5, fontWeight: 500 },
  labelBgStyle: { fill: '#0e1318', fillOpacity: 0.92 },
  labelBgPadding: [5, 3] as [number, number],
  labelBgBorderRadius: 4,
};

export const initialEdges: Edge[] = [
  {
    ...edgeBase,
    id: 'e-orch-research',
    source: 'orchestrator',
    target: 'researcher',
    label: '任务 · T1',
    data: { kind: 'assign' },
    style: { stroke: '#6366f1', strokeWidth: 1.6 },
  },
  {
    ...edgeBase,
    id: 'e-orch-writer',
    source: 'orchestrator',
    target: 'writer',
    label: '任务 · T2',
    data: { kind: 'assign' },
    style: { stroke: '#6366f1', strokeWidth: 1.6 },
  },
  {
    ...edgeBase,
    id: 'e-orch-review',
    source: 'orchestrator',
    target: 'reviewer',
    label: '任务 · T3',
    data: { kind: 'assign' },
    style: { stroke: '#6366f1', strokeWidth: 1.6 },
  },
  {
    ...edgeBase,
    id: 'e-research-handoff',
    source: 'researcher',
    target: 'writer',
    label: '产物 · 1 份',
    data: { kind: 'handoff' },
    style: { stroke: '#10b981', strokeWidth: 1.5 },
  },
  {
    ...edgeBase,
    id: 'e-writer-review',
    source: 'writer',
    target: 'reviewer',
    label: '验收 · T2',
    data: { kind: 'review' },
    style: { stroke: '#f59e0b', strokeWidth: 1.5 },
  },
];

export const modelPresets = [
  { provider: 'DeepSeek', model: 'deepseek-reasoner', accent: '#4d6bfe' },
  { provider: 'MiniMax', model: 'MiniMax-M3.1-Flash', accent: '#ff7a45' },
  { provider: 'Kimi', model: 'kimi-k2-thinking', accent: '#a78bfa' },
  { provider: 'Qwen', model: 'qwen3-max', accent: '#34d399' },
  { provider: 'GLM', model: 'glm-4.6', accent: '#60a5fa' },
  { provider: 'Claude', model: 'claude-sonnet-4-6[1M]', accent: '#d97757' },
];
