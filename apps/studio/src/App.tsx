import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MarkerType,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { ChatDrawer } from './components/ChatDrawer';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DiscussionModal } from './components/DiscussionModal';
import { ModelEditor } from './components/ModelEditor';
import { NodeInspector } from './components/NodeInspector';
import { ApprovalsModal } from './components/ApprovalsModal';
import { ArtifactModal } from './components/ArtifactModal';
import { ExternalModal } from './components/ExternalModal';
import { RunReport } from './components/RunReport';
import { SettingsModal } from './components/SettingsModal';
import { Toolbar } from './components/Toolbar';
import { initialModels, type ModelDraft } from './data/models';
import { loadSettings, saveSettings, type AppSettings } from './data/settings';
import { layeredLayout } from './data/layout';
import {
  initialEdges,
  initialNodes,
  modelPresets,
  type AgentNodeData,
  type EffortLevel,
  type LibraryFile,
  type RegionMode,
  type StudioNode,
} from './data/demoGraph';
import type {
  ChatMessage,
  ExternalCallEvent,
  RunSummary,
  RunTaskView,
  Selection,
} from './types';

interface ChoiceOption {
  id: string;
  label: string;
  consequence: string;
}

interface Choice {
  title: string;
  detail: string;
  options: ChoiceOption[];
}

function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, at: now() };
}

function seedMessages(): Record<string, ChatMessage[]> {
  return {
    orchestrator: [
      message('assistant', '我是主控。给我一个目标，我会拆解任务、按各节点能力分派，并在验收失败时打回。'),
    ],
    researcher: [message('assistant', '资料员就绪。我会多源核实，输出带来源的事实清单。')],
    writer: [message('assistant', '写手就绪。给我结构，我给你可交付的初稿。')],
    reviewer: [message('assistant', '审校就绪。我只看证据与验收标准，不做创作。')],
  };
}

function mockResult(role: string): string {
  if (role.includes('研究')) return '已完成检索与交叉核实：6 条事实、2 个争议点，来源已标注。';
  if (role.includes('写')) return '初稿完成：3 节结构、约 900 字，已按验收标准自检。';
  if (role.includes('审') || role.includes('验收')) return '验收完成：2 处事实需要补来源，其余通过；建议返修第 2 段。';
  return '子任务完成，产出已写入运行账本。';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function publicLibraryNode(): StudioNode {
  return {
    id: 'library-public',
    type: 'library',
    position: { x: 40, y: 20 },
    data: {
      kind: 'library',
      name: '公共文件库',
      role: '所有节点共享的上下文',
      provider: 'local',
      model: 'library',
      effort: 'off',
      status: 'idle',
      accent: '#38d9c2',
      isPublic: true,
      libraryFiles: [],
    },
  } as StudioNode;
}

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selection, setSelection] = useState<Selection>(null);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>(seedMessages);
  const [running, setRunning] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [models, setModels] = useState<ModelDraft[]>(initialModels);
  const [editorOpen, setEditorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [artifactTaskId, setArtifactTaskId] = useState<string | null>(null);
  const [artifactOverride, setArtifactOverride] = useState<RunTaskView | null>(null);
  const [externalTasks, setExternalTasks] = useState<Record<string, RunTaskView>>({});
  const [externalCalls, setExternalCalls] = useState<ExternalCallEvent[]>([]);
  const [externalModalOpen, setExternalModalOpen] = useState(false);
  const [externalFocus, setExternalFocus] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [runTasks, setRunTasks] = useState<Record<string, RunTaskView>>({});
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [runTokens, setRunTokens] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [orchestratorId, setOrchestratorId] = useState('orchestrator');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [brushMode, setBrushMode] = useState<RegionMode | null>(null);
  const [brushRect, setBrushRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [layouting, setLayouting] = useState(false);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ ids: string[]; label: string } | null>(
    null
  );
  const rfRef = useRef<ReactFlowInstance<StudioNode, any> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const libraryFilesInput = useRef<HTMLInputElement | null>(null);
  const libraryFolderInput = useRef<HTMLInputElement | null>(null);
  const libraryTarget = useRef<string | null>(null);
  const brushStart = useRef<{ x: number; y: number } | null>(null);
  const canvasReady = useRef(false);
  const runToken = useRef(0);
  const streamBuffers = useRef<Record<string, string>>({});
  const taskNodes = useRef<Record<string, string>>({});
  const runTasksRef = useRef<Record<string, RunTaskView>>({});
  const runStartedAt = useRef(0);
  const runEventCount = useRef(0);
  const runTokensRef = useRef(0);
  const externalTasksRef = useRef<Record<string, RunTaskView>>({});
  const externalCallsRef = useRef<ExternalCallEvent[]>([]);
  const nodesRef = useRef<StudioNode[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  const settingsRef = useRef<AppSettings>(settings);

  useEffect(() => {
    void fetch('/api/bootstrap').catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let loaded = false;
      try {
        await fetch('/api/bootstrap');
        const response = await fetch('/api/canvas');
        if (!response.ok) return;
        const data = (await response.json()) as {
          canvas?: {
            nodes?: StudioNode[];
            edges?: Edge[];
            orchestratorId?: string;
          } | null;
        };
        loaded = true;
        const canvas = data.canvas;
        if (!alive || !canvas || !Array.isArray(canvas.nodes) || canvas.nodes.length === 0) return;

        const saved = canvas.nodes
          .filter((node) => node && node.id && node.id !== '__final__')
          .map((node) => {
            if (node.type !== 'region' || node.width || !node.style) return node;
            const width = Number(node.style.width);
            const height = Number(node.style.height);
            return {
              ...node,
              width: Number.isFinite(width) ? width : undefined,
              height: Number.isFinite(height) ? height : undefined,
              style: undefined,
            };
          });
        const withLibrary = saved.some((node) => node.data?.isPublic)
          ? saved
          : [publicLibraryNode(), ...saved];
        const savedIds = new Set(withLibrary.map((node) => node.id));
        setNodes((current) => [
          ...withLibrary,
          ...current.filter((node) => node.id.startsWith('ext-') && !savedIds.has(node.id)),
        ]);
        setEdges((canvas.edges ?? []).filter((edge) => edge.id !== '__final-edge'));
        if (canvas.orchestratorId) setOrchestratorId(canvas.orchestratorId);
      } catch {
        // server unavailable: keep the starter graph and do not overwrite a saved canvas
      } finally {
        if (loaded) canvasReady.current = true;
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!canvasReady.current) return;
    const timer = window.setTimeout(() => {
      const nodesPayload = nodes
        .filter((node) => node.id !== '__final__')
        .map((node) => {
          const {
            onDelete: _onDelete,
            onMakeOrchestrator: _onMakeOrchestrator,
            onOpen: _onOpen,
            onOpenSession: _onOpenSession,
            ...data
          } = node.data as AgentNodeData & {
            onOpenSession?: unknown;
          };
          return { ...node, data };
        });
      const edgesPayload = edges
        .filter((edge) => edge.id !== '__final-edge')
        .map((edge) => ({
          ...edge,
          data: edge.data ? { ...(edge.data as Record<string, unknown>), onOpen: undefined } : edge.data,
        }));
      void fetch('/api/canvas', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orchestratorId, nodes: nodesPayload, edges: edgesPayload }),
      }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [nodes, edges, orchestratorId]);

  useEffect(() => {
    const publicLibraries = nodes.filter(
      (node) => node.type === 'library' && node.data.isPublic
    );
    const targets = nodes.filter(
      (node) => node.data.kind === 'agent' || node.data.kind === 'orchestrator'
    );
    setEdges((current) => {
      const filtered = current.filter(
        (edge) =>
          !edge.id.startsWith('lib-edge-') ||
          publicLibraries.some((library) => library.id === edge.source)
      );
      let next = filtered;
      let changed = next.length !== current.length;
      for (const library of publicLibraries) {
        for (const target of targets) {
          const id = `lib-edge-${library.id}-${target.id}`;
          if (next.some((edge) => edge.id === id)) continue;
          next = [
            ...next,
            {
              id,
              source: library.id,
              target: target.id,
              type: 'smoothstep',
              animated: false,
              label: '公共文件',
              data: { kind: 'context', library: true },
              style: {
                stroke: '#38d9c2',
                strokeWidth: 1.2,
                strokeDasharray: '5 4',
              },
              labelStyle: { fill: '#8b98a8', fontSize: 9.5 },
              labelBgStyle: { fill: '#0e1318', fillOpacity: 0.92 },
            },
          ];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [nodes]);

  useEffect(() => {
    saveSettings(settings);
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.density = settings.density;
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    if (!brushMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setBrushMode(null);
      setBrushRect(null);
      brushStart.current = null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [brushMode]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let alive = true;
    const load = async (bootstrap = false) => {
      try {
        if (bootstrap) await fetch('/api/bootstrap');
        const response = await fetch('/api/approvals');
        if (!response.ok) return;
        const data = (await response.json()) as { items?: Array<{ status: string }> };
        if (!alive) return;
        setPendingApprovals((data.items ?? []).filter((item) => item.status === 'pending').length);
      } catch {
        // server may not be ready yet; the next poll retries
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const patchNode = (id: string, patch: Partial<AgentNodeData>) => {
    setNodes((current) =>
      current.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node))
    );
  };

  const push = (id: string, role: ChatMessage['role'], content: string) => {
    setMessages((current) => ({
      ...current,
      [id]: [...(current[id] ?? []), message(role, content)],
    }));
  };

  const updateTask = (taskId: string, patch: Partial<RunTaskView>) => {
    const current = runTasksRef.current;
    const previous: RunTaskView =
      current[taskId] ?? { taskId, nodeId: 'unknown', status: 'pending' };
    const next = { ...current, [taskId]: { ...previous, ...patch } };
    runTasksRef.current = next;
    setRunTasks(next);
  };

  const resetRunState = () => {
    runTasksRef.current = {};
    setRunTasks({});
    setRunSummary(null);
    runEventCount.current = 0;
    runStartedAt.current = 0;
    runTokensRef.current = 0;
    setRunTokens(0);
    setArtifactTaskId(null);
    setNodes((current) => current.filter((node) => node.id !== '__final__'));
    setEdges((current) =>
      current
        .filter((edge) => edge.id !== '__final-edge')
        .map((edge) =>
          edge.id.startsWith('ext-edge-')
            ? edge
            : {
                ...edge,
                type: 'smoothstep',
                data: { ...edge.data, artifact: undefined, onOpen: undefined },
              }
        )
    );
  };

  const notify = (body: string) => {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('牵丝', { body });
      }
    } catch {
      // notifications can be blocked by the browser; the toast still shows
    }
  };

  const handleSettingsChange = (next: AppSettings) => {
    setSettings(next);
    if (next.notifications && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  };

  const resetAll = () => {
    runToken.current += 1;
    setRunning(false);
    setChoice(null);
    resetRunState();
    streamBuffers.current = {};
    taskNodes.current = {};
    setNodes((current) =>
      current
        .filter((node) => !node.id.startsWith('ext-'))
        .map((node) => ({
          ...node,
          data: {
            ...node.data,
            status: 'idle',
            metric: node.data.kind === 'orchestrator' ? '待命' : 'ready',
            artifact: undefined,
          },
        }))
    );
    setEdges((current) => current.filter((edge) => !edge.id.startsWith('ext-edge-')));
    setExternalTasks({});
    externalTasksRef.current = {};
    setExternalCalls([]);
    externalCallsRef.current = [];
    setExternalModalOpen(false);
    setExternalFocus(null);
    setMessages((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, list]) => [
          key,
          list.filter((item) => !item.id.startsWith('stream-')),
        ])
      )
    );
    push(orchestratorId, 'assistant', '已重置所有节点状态与运行结果。可以开始新一轮。');
    setToast('已重置');
  };

  const findEdgeArtifact = (taskId: string) => {
    for (const edge of edges) {
      const artifact = (
        edge.data as
          | {
              artifact?: {
                taskId: string;
                title?: string;
                output: string;
                acceptance?: AgentNodeData['acceptance'];
              };
            }
          | undefined
      )?.artifact;
      if (artifact?.taskId === taskId) return { artifact, source: edge.source };
    }
    return undefined;
  };

  const openArtifact = (taskId: string) => {
    const direct = runTasksRef.current[taskId] ?? externalTasksRef.current[taskId];
    if (!direct) {
      const found = findEdgeArtifact(taskId);
      if (found) {
        setArtifactOverride({
          taskId,
          nodeId: found.source,
          title: found.artifact.title,
          status: 'done',
          output: found.artifact.output,
          acceptance: found.artifact.acceptance
            ? {
                pass: Boolean(found.artifact.acceptance.pass),
                score: found.artifact.acceptance.score ?? 0,
                reasons: found.artifact.acceptance.reasons ?? [],
                needsHuman: found.artifact.acceptance.needsHuman,
              }
            : undefined,
        });
        setArtifactTaskId(taskId);
        return;
      }
    }
    setArtifactOverride(null);
    setArtifactTaskId(taskId);
  };

  const openArtifactFromNode = (node: StudioNode) => {
    if (!node.data.output) return;
    setArtifactOverride({
      taskId: node.data.taskId ?? node.id,
      nodeId: node.id,
      title: node.data.name,
      model: node.data.model,
      status: 'done',
      output: node.data.output,
      acceptance: node.data.acceptance
        ? {
            pass: Boolean(node.data.acceptance.pass),
            score: node.data.acceptance.score ?? 0,
            reasons: node.data.acceptance.reasons ?? [],
            needsHuman: node.data.acceptance.needsHuman,
          }
        : undefined,
    });
    setArtifactTaskId(node.data.taskId ?? node.id);
  };
  const openSession = (sessionId: string) => {
    setExternalFocus(sessionId);
    setExternalModalOpen(true);
  };

  const requestDelete = (ids: string[], label: string) => setPendingDelete({ ids, label });

  const makeOrchestrator = (id: string) => {
    setOrchestratorId(id);
    setNodes((current) =>
      current.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, kind: 'orchestrator', accent: '#e0a458' } };
        }
        if (node.data.kind === 'orchestrator') {
          return { ...node, data: { ...node.data, kind: 'agent' } };
        }
        return node;
      })
    );
    push(id, 'assistant', '已切换为主控模型。后续拆解、分派、验收由我负责。');
    setToast('主控已切换');
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const ids = new Set(pendingDelete.ids);
    for (const id of ids) {
      const node = nodes.find((item) => item.id === id);
      if (node?.data.kind === 'file' && node.data.fileId) {
        void fetch(`/api/files/${node.data.fileId}`, { method: 'DELETE' }).catch(() => undefined);
      }
      if (node?.data.kind === 'library') {
        for (const file of node.data.libraryFiles ?? []) {
          void fetch(`/api/files/${file.id}`, { method: 'DELETE' }).catch(() => undefined);
        }
      }
    }
    setNodes((current) => {
      const regions = current.filter((node) => ids.has(node.id) && node.type === 'region');
      return current
        .filter((node) => !ids.has(node.id))
        .map((node) => {
          if (!node.parentId || !ids.has(node.parentId)) return node;
          const parent = regions.find((region) => region.id === node.parentId);
          if (!parent) return node;
          return {
            ...node,
            parentId: undefined,
            extent: undefined,
            position: {
              x: parent.position.x + node.position.x,
              y: parent.position.y + node.position.y,
            },
          };
        });
    });
    setEdges((current) =>
      current.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target))
    );
    cleanupDeletedNodes([...ids]);
    setSelection(null);
    setPendingDelete(null);
    setToast(`已删除「${pendingDelete.label}」`);
  };

  const autoLayout = async () => {
    if (layouting) return;
    setLayouting(true);
    try {
      const candidates = nodes.filter(
        (node) => node.type !== 'region' && !node.parentId && !node.data.hidden
      );
      const candidateIds = new Set(candidates.map((node) => node.id));
      const payload = {
        orchestratorId,
        nodes: candidates.map((node) => ({
          id: node.id,
          name: node.data.name,
          kind: node.data.kind,
        })),
        edges: edges
          .filter((edge) => candidateIds.has(edge.source) && candidateIds.has(edge.target))
          .map((edge) => ({ source: edge.source, target: edge.target })),
      };
      const localPositions = layeredLayout(nodes, edges, orchestratorId);
      setNodes((current) =>
        current.map((node) =>
          localPositions[node.id] ? { ...node, position: localPositions[node.id] } : node
        )
      );
      setToast('已先按本地分层排版，主控正在优化…');

      let aiPositions: Record<string, { x: number; y: number }> | null = null;
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 25000);
        const response = await fetch('/api/layout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        window.clearTimeout(timer);
        if (response.ok) {
          const data = (await response.json()) as {
            positions?: Record<string, { x: number; y: number }>;
          };
          if (data.positions && Object.keys(data.positions).length > 0) {
            aiPositions = data.positions;
          }
        }
      } catch {
        // keep the local layout
      }
      if (aiPositions) {
        setNodes((current) =>
          current.map((node) =>
            aiPositions?.[node.id] ? { ...node, position: aiPositions[node.id] } : node
          )
        );
      }
      setToast(aiPositions ? '主控已完成自动排版' : '主控不可用，已保留本地分层排版');
    } finally {
      setLayouting(false);
    }
  };

  const materializeTask = (taskId: string) => {
    const task = runTasks[taskId] ?? externalTasks[taskId];
    if (!task) return;
    const id = `task-${taskId}`;
    if (nodes.some((node) => node.id === id)) {
      setSelection({ kind: 'node', id });
      return;
    }
    const anchor = nodes.find((node) => node.id === task.nodeId);
    setNodes((current) => [
      ...current,
      {
        id,
        type: 'task',
        position: {
          x: (anchor?.position.x ?? 320) + 40,
          y: (anchor?.position.y ?? 320) + 280,
        },
        data: {
          kind: 'task',
          name: task.title,
          role: '子任务',
          provider: '',
          model: task.model ?? '',
          effort: 'medium',
          status: task.status === 'done' ? 'done' : 'idle',
          accent: '#6ea8fe',
          taskId,
          sourceNodeId: task.nodeId,
          output: task.output,
          acceptance: task.acceptance,
          onOpen: openArtifact,
        },
      } as StudioNode,
    ]);
    setToast(`任务「${task.title}」已拉到画布`);
  };

  const materializeArtifact = (taskId: string) => {
    const direct =
      runTasks[taskId] ??
      externalTasks[taskId] ??
      (artifactOverride?.taskId === taskId ? artifactOverride : undefined);
    const edgeArtifact = direct ? undefined : findEdgeArtifact(taskId);
    const task: RunTaskView | undefined =
      direct ??
      (edgeArtifact
        ? {
            taskId,
            nodeId: edgeArtifact.source,
            title: edgeArtifact.artifact.title,
            status: 'done',
            output: edgeArtifact.artifact.output,
            acceptance: edgeArtifact.artifact.acceptance
              ? {
                  pass: Boolean(edgeArtifact.artifact.acceptance.pass),
                  score: edgeArtifact.artifact.acceptance.score ?? 0,
                  reasons: edgeArtifact.artifact.acceptance.reasons ?? [],
                  needsHuman: edgeArtifact.artifact.acceptance.needsHuman,
                }
              : undefined,
          }
        : undefined);
    if (!task?.output) return;
    const id = `artifact-${taskId}`;
    if (nodes.some((node) => node.id === id)) {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? {
                ...node,
                data: {
                  ...node.data,
                  sourceNodeId: node.data.sourceNodeId ?? task.nodeId,
                },
              }
            : node
        )
      );
      setSelection({ kind: 'node', id });
      return;
    }
    setNodes((current) => [
      ...current,
      {
        id,
        type: 'artifact',
        position: { x: 720 + (current.length % 3) * 60, y: 560 + (current.length % 4) * 40 },
        data: {
          kind: 'artifact',
          name: task.title,
          role: '产物',
          provider: '',
          model: task.model ?? '',
          effort: 'off',
          status: 'done',
          accent: '#e0a458',
          taskId,
          sourceNodeId: task.nodeId,
          output: task.output,
          acceptance: task.acceptance,
          onOpen: openArtifact,
        },
      } as StudioNode,
    ]);
    setToast('产物已拉出为独立模块');
  };

  const pinArtifactToWire = (nodeId: string) => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || node.data.kind !== 'artifact' || !node.data.output) return;
    const sourceId =
      node.data.sourceNodeId ??
      (node.data.taskId ? runTasksRef.current[node.data.taskId]?.nodeId : undefined);
    if (!sourceId) {
      setToast('找不到产物的来源节点，无法放回流程线');
      return;
    }
    const edge =
      edges.find((item) => item.source === sourceId && !item.id.startsWith('ext-edge-')) ??
      edges.find((item) => item.source === sourceId);
    if (!edge) {
      setToast('来源节点还没有下游连线，先连一条再放回');
      return;
    }
    const artifact = {
      taskId: node.data.taskId ?? node.id,
      title: node.data.name,
      output: node.data.output,
      acceptance: node.data.acceptance
        ? {
            pass: Boolean(node.data.acceptance.pass),
            score: node.data.acceptance.score ?? 0,
            reasons: node.data.acceptance.reasons ?? [],
            needsHuman: node.data.acceptance.needsHuman,
          }
        : undefined,
    };
    setEdges((current) =>
      current.map((item) =>
        item.id === edge.id
          ? {
              ...item,
              type: 'artifact',
              data: { ...item.data, artifact, onOpen: openArtifact },
            }
          : item
      )
    );
    setNodes((current) => current.filter((item) => item.id !== nodeId));
    setSelection(null);
    setToast('产物已放回流程线，点击连线上的卡片可查看');
    if (!settings.showArtifacts) {
      handleSettingsChange({ ...settings, showArtifacts: true });
    }
  };

  const createRegion = (rect: { left: number; top: number; width: number; height: number }) => {
    const instance = rfRef.current;
    if (!instance) return;
    if (rect.width < 80 || rect.height < 60) return;
    const canvas = document.querySelector('.canvas-wrap')?.getBoundingClientRect();
    const offsetX = canvas?.left ?? 0;
    const offsetY = canvas?.top ?? 0;
    const topLeft = instance.screenToFlowPosition({
      x: rect.left + offsetX,
      y: rect.top + offsetY,
    });
    const bottomRight = instance.screenToFlowPosition({
      x: rect.left + offsetX + rect.width,
      y: rect.top + offsetY + rect.height,
    });
    const width = Math.max(240, bottomRight.x - topLeft.x);
    const height = Math.max(180, bottomRight.y - topLeft.y);
    const id = `region-${crypto.randomUUID().slice(0, 8)}`;
    const regionIndex = nodes.filter((node) => node.type === 'region').length + 1;
    const contained = nodes.filter((node) => {
      if (node.type === 'region' || node.parentId || node.data.hidden) return false;
      const cx = node.position.x + 130;
      const cy = node.position.y + 80;
      return cx >= topLeft.x && cx <= topLeft.x + width && cy >= topLeft.y && cy <= topLeft.y + height;
    });
    const containedIds = new Set(contained.map((node) => node.id));
    const region: StudioNode = {
      id,
      type: 'region',
      position: topLeft,
      width,
      height,
      zIndex: 0,
      selectable: true,
      data: {
        kind: 'region',
        name: `分项目 ${regionIndex}`,
        role: '项目区域',
        provider: '',
        model: '',
        effort: 'off',
        status: 'idle',
        accent: '#2dd4bf',
        regionMode: brushMode ?? 'open',
      },
    };
    setNodes((current) => {
      const rest = current.map((node) =>
        containedIds.has(node.id)
          ? {
              ...node,
              parentId: id,
              position: {
                x: node.position.x - topLeft.x,
                y: node.position.y - topLeft.y,
              },
            }
          : node
      );
      return [region, ...rest];
    });
    setSelection({ kind: 'node', id });
    setBrushMode(null);
    setBrushRect(null);
    setToast(`已创建分项目区域（${contained.length} 个节点）`);
  };

  const regionForNode = (id: string): StudioNode | undefined => {
    const node = nodes.find((item) => item.id === id);
    if (!node?.parentId) return undefined;
    return nodes.find((item) => item.id === node.parentId);
  };

  const detachFromRegion = (id: string) => {
    const node = nodes.find((item) => item.id === id);
    const parent = node?.parentId ? nodes.find((item) => item.id === node.parentId) : undefined;
    if (!node || !parent) return;
    setNodes((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              parentId: undefined,
              extent: undefined,
              position: {
                x: parent.position.x + item.position.x,
                y: parent.position.y + item.position.y,
              },
            }
          : item
      )
    );
    setToast('已移出区域，保留绝对位置');
  };

  const handleNodeDragStop = (node: StudioNode) => {
    if (node.type === 'region') return;
    const parent = node.parentId ? nodes.find((item) => item.id === node.parentId) : undefined;
    const absolute = {
      x: (parent?.position.x ?? 0) + node.position.x,
      y: (parent?.position.y ?? 0) + node.position.y,
    };
    const center = { x: absolute.x + 130, y: absolute.y + 80 };
    const candidates = nodes
      .filter((item) => item.type === 'region' && !item.data.hidden && item.id !== node.id)
      .filter((region) => {
        const width = Number(region.width ?? region.style?.width ?? 0);
        const height = Number(region.height ?? region.style?.height ?? 0);
        return (
          center.x >= region.position.x &&
          center.x <= region.position.x + width &&
          center.y >= region.position.y &&
          center.y <= region.position.y + height
        );
      })
      .sort((a, b) => {
        const area = (item: StudioNode) =>
          Number(item.width ?? item.style?.width ?? 0) *
          Number(item.height ?? item.style?.height ?? 0);
        return area(a) - area(b);
      });
    const target = candidates[0];
    if (target?.id === node.parentId) return;

    setNodes((current) =>
      current.map((item) => {
        if (item.id !== node.id) return item;
        if (!target) {
          return {
            ...item,
            parentId: undefined,
            extent: undefined,
            position: absolute,
          };
        }
        return {
          ...item,
          parentId: target.id,
          extent: undefined,
          position: {
            x: absolute.x - target.position.x,
            y: absolute.y - target.position.y,
          },
        };
      })
    );
    if (target) setToast(`已纳入「${target.data.name}」`);
    else if (parent) setToast('已移出区域');
  };

  const uploadOneFile = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const response = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, type: file.type, data: base64 }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = (await response.json()) as {
      file?: { id: string; name: string; size: number; preview?: string };
    };
    if (!data.file) throw new Error('file_upload_failed');
    return data.file;
  };

  const uploadFile = async (file: File) => {
    try {
      const uploaded = await uploadOneFile(file);
      const position =
        rfRef.current?.screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        }) ?? { x: 240, y: 240 };
      const id = `file-${uploaded.id}`;
      setNodes((current) => [
        ...current,
        {
          id,
          type: 'file',
          position,
          data: {
            kind: 'file',
            name: uploaded.name,
            role: '上下文文件',
            provider: 'local',
            model: 'file',
            effort: 'off',
            status: 'idle',
            accent: '#38d9c2',
            fileId: uploaded.id,
            fileName: uploaded.name,
            fileSize: uploaded.size,
            filePreview: uploaded.preview,
          },
        } as StudioNode,
      ]);
      setToast(`已上传「${uploaded.name}」，把它连到模型或任务节点`);
    } catch (error) {
      setToast(`上传失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const addLibrary = () => {
    const id = `library-${crypto.randomUUID().slice(0, 8)}`;
    const index = nodes.filter((node) => node.type === 'library').length;
    const position =
      rfRef.current?.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }) ?? { x: 240, y: 240 };
    setNodes((current) => [
      ...current,
      {
        id,
        type: 'library',
        position: { x: position.x + index * 24, y: position.y + index * 24 },
        data: {
          kind: 'library',
          name: `文件库 ${index + 1}`,
          role: '文件上下文',
          provider: 'local',
          model: 'library',
          effort: 'off',
          status: 'idle',
          accent: '#38d9c2',
          isPublic: false,
          libraryFiles: [],
        },
      } as StudioNode,
    ]);
    setSelection({ kind: 'node', id });
    setToast('已创建文件库，在右侧检查器添加文件或文件夹');
  };

  const openLibraryPicker = (libraryId: string, folder = false) => {
    libraryTarget.current = libraryId;
    const input = folder ? libraryFolderInput.current : libraryFilesInput.current;
    input?.click();
  };

  const uploadLibraryFiles = async (files: File[], libraryId: string) => {
    const list = files.slice(0, 60);
    if (list.length === 0) return;
    setToast(`正在上传 ${list.length} 个文件…`);
    const added: LibraryFile[] = [];
    let failed = 0;
    for (const file of list) {
      if (file.size > 8 * 1024 * 1024) {
        failed += 1;
        continue;
      }
      try {
        const uploaded = await uploadOneFile(file);
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        added.push({
          id: uploaded.id,
          name: relative || uploaded.name,
          size: uploaded.size,
          preview: uploaded.preview,
        });
      } catch {
        failed += 1;
      }
    }
    setNodes((current) =>
      current.map((node) =>
        node.id === libraryId
          ? {
              ...node,
              data: {
                ...node.data,
                libraryFiles: [...(node.data.libraryFiles ?? []), ...added],
              },
            }
          : node
      )
    );
    setToast(
      added.length
        ? `已加入 ${added.length} 个文件${failed ? `，${failed} 个失败` : ''}`
        : '没有文件上传成功'
    );
  };

  const libraryContextFor = (nodeId: string) => {
    const libraryIds = new Set<string>();
    for (const node of nodes) {
      if (node.type === 'library' && node.data.isPublic) libraryIds.add(node.id);
    }
    for (const edge of edges) {
      if (edge.target !== nodeId) continue;
      const source = nodes.find((node) => node.id === edge.source);
      if (source?.type === 'library') libraryIds.add(source.id);
    }
    const files = nodes
      .filter((node) => libraryIds.has(node.id))
      .flatMap((node) => node.data.libraryFiles ?? []);
    if (files.length === 0) return '';
    return `以下是用户提供的文件上下文：\n${files
      .map((file) => `[${file.name}]\n${file.preview?.trim() || '（二进制文件）'}`)
      .join('\n\n')}`.slice(0, 6000);
  };

  const copyNode = (id: string) => {
    const source = nodes.find((node) => node.id === id);
    if (!source || (source.data.kind !== 'task' && source.data.kind !== 'artifact')) return;
    const copyId = `copy-${crypto.randomUUID().slice(0, 8)}`;
    setNodes((current) => [
      ...current,
      {
        ...source,
        id: copyId,
        selected: false,
        position: { x: source.position.x + 40, y: source.position.y + 40 },
        data: {
          ...source.data,
          name: `${source.data.name} 副本`,
          taskId: source.data.taskId
            ? `copy-${crypto.randomUUID().slice(0, 8)}`
            : source.data.taskId,
          onDelete: undefined,
          onOpen: undefined,
          onMakeOrchestrator: undefined,
        },
      },
    ]);
    setSelection({ kind: 'node', id: copyId });
    setToast('已复制模块，与主流程互不影响');
  };

  const decorateEdgeArtifacts = () => {
    const tasks = Object.values(runTasksRef.current).filter((task) => task.output);
    if (!settings.showArtifacts || tasks.length === 0) return;

    setEdges((current) =>
      current
        .filter((edge) => edge.id !== '__final-edge')
        .map((edge) => {
          if (edge.id.startsWith('ext-edge-')) return edge;
          const task = tasks.find((item) => item.nodeId === edge.source);
          if (!task) {
            return {
              ...edge,
              type: 'smoothstep',
              data: { ...edge.data, artifact: undefined, onOpen: undefined },
            };
          }
          return {
            ...edge,
            type: 'artifact',
            data: {
              ...edge.data,
              artifact: {
                taskId: task.taskId,
                title: task.title,
                output: task.output ?? '',
                acceptance: task.acceptance,
              },
              onOpen: openArtifact,
            },
          };
        })
    );
  };

  const decorateArtifacts = () => {
    decorateEdgeArtifacts();
    const tasks = Object.values(runTasksRef.current).filter((task) => task.output);
    if (!settings.showArtifacts || tasks.length === 0) return;

    const baseEdges = edgesRef.current.filter((edge) => edge.id !== '__final-edge');
    const finalTask = tasks.find(
      (task) => !baseEdges.some((edge) => edge.source === task.nodeId)
    );
    if (!finalTask) return;
    const finalNode = nodes.find((node) => node.id === finalTask.nodeId);
    if (!finalNode) return;

    const artifact = {
      taskId: finalTask.taskId,
      title: finalTask.title,
      output: finalTask.output ?? '',
      acceptance: finalTask.acceptance,
    };

    setNodes((current) => [
      ...current.filter((node) => node.id !== '__final__'),
      {
        id: '__final__',
        type: 'artifact',
        position: { x: finalNode.position.x + 320, y: finalNode.position.y },
        selectable: false,
        deletable: false,
        data: { ...artifact, onOpen: openArtifact },
      } as unknown as StudioNode,
    ]);

    setEdges((current) => [
      ...current.filter((edge) => edge.id !== '__final-edge'),
      {
        id: '__final-edge',
        source: finalTask.nodeId,
        target: '__final__',
        type: 'artifact',
        data: { artifact, onOpen: openArtifact },
        style: { stroke: '#e0a458', strokeWidth: 1.6 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      },
    ]);
  };

  useEffect(() => {
    if (!settings.showArtifacts) {
      setNodes((current) => current.filter((node) => node.id !== '__final__'));
      setEdges((current) =>
        current
          .filter((edge) => edge.id !== '__final-edge')
          .map((edge) => ({
            ...edge,
            type: 'smoothstep',
            data: { ...edge.data, artifact: undefined, onOpen: undefined },
          }))
      );
      return;
    }
    if (Object.keys(runTasksRef.current).length > 0) decorateArtifacts();
    // decorateArtifacts reads the latest refs; this effect only reacts to the toggle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showArtifacts]);

  useEffect(() => {
    let source: EventSource | null = null;

    const handle = (call: ExternalCallEvent) => {
      const already = externalCallsRef.current.some((item) => item.runId === call.runId);
      const nextCalls = already
        ? externalCallsRef.current
        : [call, ...externalCallsRef.current].slice(0, 50);
      if (!already) {
        externalCallsRef.current = nextCalls;
        setExternalCalls(nextCalls);
      }

      const sessionCalls = nextCalls.filter((item) => item.sessionId === call.sessionId);
      const sessionTokens = sessionCalls.reduce(
        (sum, item) => sum + (item.usage?.total ?? 0),
        0
      );
      const extId = `ext-${call.sessionId}`;

      const task: RunTaskView = {
        taskId: call.taskId,
        nodeId: extId,
        title: call.purpose,
        model: call.model,
        status: 'done',
        output: call.output,
        acceptance: { pass: true, score: 1, reasons: ['外部调用'] },
      };
      const nextTasks = { ...externalTasksRef.current, [call.taskId]: task };
      externalTasksRef.current = nextTasks;
      setExternalTasks(nextTasks);

      const list = nodesRef.current;
      const lower = call.model.toLowerCase();
      const candidates = list.filter((node) => node.type === 'agent');
      const target =
        (lower.includes('deepseek') &&
          candidates.find((node) => node.data.provider.toLowerCase().includes('deepseek'))) ||
        (lower.includes('minimax') &&
          candidates.find((node) => node.data.provider.toLowerCase().includes('minimax'))) ||
        candidates.find((node) => node.data.kind === 'orchestrator') ||
        candidates[0];

      if (!target) return;

      const sessionData = {
        agent: call.agent,
        sessionId: call.sessionId,
        callCount: sessionCalls.length,
        tokens: sessionTokens,
        purpose: call.purpose,
        model: call.model,
        output: call.output,
        onOpenSession: openSession,
      };

      setNodes((current) => {
        const existing = current.find((node) => node.id === extId);
        if (existing) {
          return current.map((node) =>
            node.id === extId ? { ...node, data: { ...node.data, ...sessionData } } : node
          );
        }
        const extCount = current.filter((node) => node.id.startsWith('ext-')).length;
        return [
          ...current,
          {
            id: extId,
            type: 'external',
            position: {
              x: target.position.x - 360,
              y: target.position.y + (extCount % 4) * 140,
            },
            selectable: false,
            data: sessionData,
          } as unknown as StudioNode,
        ];
      });

      const artifact = {
        taskId: call.taskId,
        title: call.purpose,
        output: call.output,
        acceptance: { pass: true, score: 1, reasons: ['外部调用'] },
      };
      const showArtifact = settingsRef.current.showArtifacts;
      const edgeId = `ext-edge-${call.sessionId}-${target.id}`;

      setEdges((current) => {
        const existing = current.find((edge) => edge.id === edgeId);
        const edgeData = {
          artifact,
          onOpen: openArtifact,
          sessionId: call.sessionId,
          callCount: sessionCalls.length,
        };
        if (existing) {
          return current.map((edge) =>
            edge.id === edgeId
              ? {
                  ...edge,
                  type: showArtifact ? 'artifact' : 'smoothstep',
                  data: showArtifact ? edgeData : {},
                }
              : edge
          );
        }
        return [
          ...current,
          {
            id: edgeId,
            source: extId,
            target: target.id,
            type: showArtifact ? 'artifact' : 'smoothstep',
            data: showArtifact ? edgeData : {},
            style: { stroke: '#38d9c9', strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          },
        ];
      });

      setToast(`外部调用：${call.agent} → ${call.model} · session 第 ${sessionCalls.length} 次`);
    };

    const start = async () => {
      try {
        await fetch('/api/bootstrap');
      } catch {
        // server may not be running in local demo mode
      }

      try {
        const response = await fetch('/api/external');
        const data = (await response.json()) as { items?: ExternalCallEvent[] };
        for (const item of (data.items ?? []).slice().reverse()) handle(item);
      } catch {
        // ignore
      }

      try {
        source = new EventSource('/api/activity');
        source.addEventListener('external.call', ((event: MessageEvent) => {
          try {
            handle(JSON.parse(event.data) as ExternalCallEvent);
          } catch {
            // ignore malformed activity
          }
        }) as EventListener);
      } catch {
        // ignore
      }
    };

    void start();
    return () => source?.close();
    // refs carry the latest nodes/settings; subscription is intentionally one-shot
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleModelChange = (nodeId: string, connectionId: string) => {
    const model = models.find((item) => item.id === connectionId);
    if (!model) return;
    patchNode(nodeId, { connectionId, provider: model.provider, model: model.model });
    push(
      nodeId,
      'assistant',
      `模型已切换为 ${model.label}（${model.model}）。能力档案与 effort 方言随连接更新。`
    );
  };

  const handleModelsChange = (next: ModelDraft[]) => {
    setModels(next);
    setNodes((current) =>
      current.map((node) => {
        const connectionId = node.data.connectionId;
        const model = next.find((item) => item.id === connectionId);
        return model
          ? { ...node, data: { ...node.data, provider: model.provider, model: model.model } }
          : node;
      })
    );
  };

  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) {
      setToast('不能把节点连到它自己');
      return;
    }
    if (
      edges.some(
        (edge) => edge.source === connection.source && edge.target === connection.target
      )
    ) {
      setToast('这两个节点之间已经有连线了');
      return;
    }
    const sourceRegion = regionForNode(connection.source);
    const targetRegion = regionForNode(connection.target);
    if ((sourceRegion || targetRegion) && sourceRegion?.id !== targetRegion?.id) {
      const region = sourceRegion ?? targetRegion;
      const mode = region?.data.regionMode ?? 'open';
      const leaving = Boolean(sourceRegion) && !targetRegion;
      const entering = !sourceRegion && Boolean(targetRegion);
      const blocked =
        mode === 'closed' || (mode === 'inbound' && leaving) || (mode === 'outbound' && entering);
      if (blocked) {
        const label =
          mode === 'closed' ? '封闭' : mode === 'inbound' ? '单向入' : '单向出';
        setToast(`区域「${region?.data.name}」是${label}，这条连线被阻止`);
        return;
      }
    }
    const source = nodes.find((node) => node.id === connection.source);
    const isFile = source?.type === 'file';
    setEdges((current) =>
      addEdge(
        {
          ...connection,
          id: `e-${crypto.randomUUID().slice(0, 8)}`,
          type: 'smoothstep',
          animated: true,
          label: isFile ? '文件 · context' : 'assign',
          data: { kind: isFile ? 'context' : 'assign' },
          style: { stroke: isFile ? '#38d9c2' : '#6ea8fe', strokeWidth: 1.4 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          labelStyle: { fill: '#8b98a8', fontSize: 9.5 },
          labelBgStyle: { fill: '#0e1318', fillOpacity: 0.92 },
        },
        current
      )
    );
  };

  const addNode = () => {
    const preset = modelPresets[nodes.length % modelPresets.length];
    const connection = models[0];
    const id = `agent-${crypto.randomUUID().slice(0, 6)}`;
    const newNode: StudioNode = {
      id,
      type: 'agent',
      position: {
        x: 120 + ((nodes.length * 110) % 560),
        y: 520 + ((nodes.length * 44) % 180),
      },
      data: {
        name: '新节点',
        role: '待定义角色',
        provider: connection?.provider ?? preset?.provider ?? 'Custom',
        model: connection?.model ?? preset?.model ?? 'openai-compatible',
        effort: 'medium',
        status: 'idle',
        kind: 'agent',
        accent: preset?.accent ?? '#6ea8fe',
        metric: 'ready',
        connectionId: connection?.id,
      },
    };
    setNodes((current) => [...current, newNode]);
    setSelection({ kind: 'node', id });
    setMessages((current) => ({
      ...current,
      [id]: [message('assistant', '我是新加入的节点。点击「能力」配置模型与思考程度，或直接告诉我你的角色。')],
    }));
  };

  const cleanupDeletedNodes = (ids: string[]) => {
    const deleted = new Set(ids);
    const regions = nodes.filter((node) => deleted.has(node.id) && node.type === 'region');
    if (regions.length > 0) {
      setNodes((current) =>
        current.map((node) => {
          if (!node.parentId || !deleted.has(node.parentId)) return node;
          const parent = regions.find((region) => region.id === node.parentId);
          if (!parent) return node;
          return {
            ...node,
            parentId: undefined,
            extent: undefined,
            position: {
              x: parent.position.x + node.position.x,
              y: parent.position.y + node.position.y,
            },
          };
        })
      );
    }
    setMessages((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
    for (const [taskId, nodeId] of Object.entries(taskNodes.current)) {
      if (deleted.has(nodeId)) delete taskNodes.current[taskId];
    }
    if (selection?.kind === 'node' && deleted.has(selection.id)) setSelection(null);
    setSelectedIds((current) => current.filter((id) => !deleted.has(id)));
  };

  const deleteNode = (id: string) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return;
    if (node.data.kind === 'orchestrator') {
      setToast('主控节点不能删除，可先切换主控');
      return;
    }
    requestDelete([id], node.data.name);
  };

  const stop = () => {
    runToken.current += 1;
    setRunning(false);
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: { ...node.data, status: 'idle', metric: '已停止' },
      }))
    );
    push(orchestratorId, 'assistant', '运行已停止。未完成的子任务保留在运行账本里。');
  };

  const runLocalDemo = async () => {
    if (running) return;
    const token = runToken.current + 1;
    runToken.current = token;
    setRunning(true);
    setChoice(null);

    const agents = nodes.filter((node) => node.data.kind === 'agent');
    patchNode(orchestratorId, { status: 'running', metric: '规划中…' });
    push(orchestratorId, 'assistant', '收到目标。读取各节点能力档案，拆解子任务…');
    await wait(700);
    if (runToken.current !== token) return;

    push(
      orchestratorId,
      'assistant',
      `计划已生成：${agents.map((agent) => agent.data.role).join(' → ')}。每个任务的 effort 已按复杂度校准。`
    );

    for (const agent of agents) {
      if (runToken.current !== token) return;
      patchNode(agent.id, { status: 'running', metric: '生成中…' });
      push(agent.id, 'assistant', `已接单：${agent.data.role}。effort=${agent.data.effort}。`);
      await wait(1200);
      if (runToken.current !== token) return;
      patchNode(agent.id, { status: 'done', metric: '1.2k tok · 8.4s' });
      push(agent.id, 'assistant', mockResult(agent.data.role));
    }

    if (runToken.current !== token) return;
    patchNode(orchestratorId, { status: 'done', metric: '验收 3/3 · 0 返修' });
    push(orchestratorId, 'assistant', '全部子任务通过验收。本次运行 3 个子任务、0 次返修，约 3.6k tokens。');
    setRunning(false);
    setChoice({
      title: '下一次同类任务如何分配？',
      detail: '本次运行中，写手与审校的质量评分接近（0.82 / 0.80），这是一次真实取舍。',
      options: [
        { id: 'prefer-writer', label: '优先 MiniMax 写手', consequence: '预计省 18% token，质量略降' },
        { id: 'prefer-reviewer', label: '优先 Kimi 审校', consequence: '质量更稳，成本 +6%' },
        { id: 'ask', label: '每次都问我', consequence: '保留当前行为，不写入偏好' },
      ],
    });

    const demoTasks: Record<string, RunTaskView> = {};
    agents.forEach((agent, index) => {
      const taskId = `local-${index + 1}`;
      demoTasks[taskId] = {
        taskId,
        nodeId: agent.id,
        title: agent.data.role,
        effort: agent.data.effort,
        status: 'done',
        output: mockResult(agent.data.role),
        acceptance: { pass: true, score: 0.8, reasons: [] },
      };
    });
    runTasksRef.current = demoTasks;
    setRunTasks(demoTasks);
    setRunSummary({
      runId: 'local-demo',
      status: 'done',
      total: agents.length,
      passed: agents.length,
      needsHuman: 0,
      events: 0,
      durationMs: 0,
    });
    decorateArtifacts();
    setToast('本地演示完成 · 点击查看结果');
  };

  const appendStream = (nodeId: string, taskId: string, text: string) => {
    const key = `${nodeId}:${taskId}`;
    const buffer = (streamBuffers.current[key] ?? '') + text;
    streamBuffers.current[key] = buffer;
    const id = `stream-${taskId}`;
    setMessages((current) => {
      const list = current[nodeId] ?? [];
      const next: ChatMessage = { id, role: 'assistant', content: buffer, at: now() };
      const exists = list.some((item) => item.id === id);
      return {
        ...current,
        [nodeId]: exists ? list.map((item) => (item.id === id ? next : item)) : [...list, next],
      };
    });
    patchNode(nodeId, {
      status: 'running',
      metric: 'streaming…',
      artifact: buffer.slice(-90),
    });
  };

  const finishStream = (nodeId: string, taskId: string, output: string) => {
    delete streamBuffers.current[`${nodeId}:${taskId}`];
    const id = `stream-${taskId}`;
    setMessages((current) => {
      const list = current[nodeId] ?? [];
      const next: ChatMessage = { id, role: 'assistant', content: output, at: now() };
      return {
        ...current,
        [nodeId]: list.some((item) => item.id === id)
          ? list.map((item) => (item.id === id ? next : item))
          : [...list, next],
      };
    });
    patchNode(nodeId, { status: 'done', metric: 'done', artifact: output.slice(0, 140) });
  };

  const subscribeToRun = (runId: string) => {
    const source = new EventSource(`/api/runs/${runId}/events`);
    const on = (name: string, handler: (event: MessageEvent) => void) =>
      source.addEventListener(name, ((event: MessageEvent) => {
        runEventCount.current += 1;
        handler(event);
      }) as EventListener);

    on('plan.created', (event) => {
      const payload = JSON.parse(event.data) as {
        event: {
          plan: {
            subtasks: Array<{
              id: string;
              assignedNodeId: string;
              title: string;
              effort: string;
            }>;
          };
        };
      };
      const tasks: Record<string, RunTaskView> = {};
      for (const task of payload.event.plan.subtasks) {
        taskNodes.current[task.id] = task.assignedNodeId;
        tasks[task.id] = {
          taskId: task.id,
          nodeId: task.assignedNodeId,
          title: task.title,
          effort: task.effort,
          status: 'pending',
        };
      }
      runTasksRef.current = tasks;
      setRunTasks(tasks);
      push(
        orchestratorId,
        'assistant',
        `计划已生成：${payload.event.plan.subtasks.map((task) => task.id).join(' → ')}。开始分派。`
      );
    });

    on('task.queued', (event) => {
      const payload = JSON.parse(event.data) as { event: { nodeId: string } };
      patchNode(payload.event.nodeId, { status: 'queued', metric: '排队中' });
    });

    on('task.started', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { nodeId: string; taskId: string; effort: string; attempt: number };
      };
      updateTask(payload.event.taskId, {
        status: 'running',
        nodeId: payload.event.nodeId,
        effort: payload.event.effort,
      });
      patchNode(payload.event.nodeId, {
        status: 'running',
        metric: `attempt ${payload.event.attempt + 1} · ${payload.event.effort}`,
      });
      push(
        payload.event.nodeId,
        'assistant',
        `接单 ${payload.event.taskId} · effort=${payload.event.effort}。`
      );
    });

    on('text.delta', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { nodeId: string; taskId: string; text: string };
      };
      appendStream(payload.event.nodeId, payload.event.taskId, payload.event.text);
    });

    on('task.acceptance', (event) => {
      const payload = JSON.parse(event.data) as {
        event: {
          taskId: string;
          result: {
            pass: boolean;
            score: number;
            reasons: string[];
            needsHuman?: boolean;
          };
        };
      };
      const result = payload.event.result;
      const nodeId = taskNodes.current[payload.event.taskId];
      updateTask(payload.event.taskId, {
        acceptance: result,
        status: result.pass ? 'done' : 'running',
      });
      if (nodeId) {
        patchNode(nodeId, {
          status: result.needsHuman ? 'blocked' : result.pass ? 'done' : 'reviewing',
        });
        const verdict = result.needsHuman ? '需人工确认' : result.pass ? '通过' : '未通过';
        push(
          nodeId,
          'assistant',
          `验收${verdict} · score ${result.score.toFixed(2)}${
            result.reasons.length ? ` · ${result.reasons.join('；')}` : ''
          }`
        );
      }
    });

    on('task.revised', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { taskId: string; nextEffort: string; reason: string };
      };
      updateTask(payload.event.taskId, { status: 'running' });
      const nodeId = taskNodes.current[payload.event.taskId];
      if (nodeId) {
        push(
          nodeId,
          'assistant',
          `验收未通过，升到 effort=${payload.event.nextEffort} 重试：${payload.event.reason}`
        );
      }
    });

    on('task.completed', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { nodeId?: string; taskId: string; output: string };
      };
      const existing = runTasksRef.current[payload.event.taskId];
      const nodeId = payload.event.nodeId ?? existing?.nodeId ?? 'unknown';
      updateTask(payload.event.taskId, {
        status: 'done',
        output: payload.event.output,
        nodeId,
      });
      finishStream(nodeId, payload.event.taskId, payload.event.output);
      window.setTimeout(() => decorateEdgeArtifacts(), 30);
    });

    on('task.failed', (event) => {
      const payload = JSON.parse(event.data) as { event: { taskId: string; error: string } };
      const nodeId = taskNodes.current[payload.event.taskId];
      updateTask(payload.event.taskId, { status: 'failed', output: payload.event.error });
      if (nodeId) {
        patchNode(nodeId, { status: 'failed', metric: 'failed' });
        push(nodeId, 'assistant', `任务失败：${payload.event.error}`);
      }
    });

    on('usage', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { nodeId: string; total: number; runTotal: number };
      };
      runTokensRef.current = payload.event.runTotal;
      setRunTokens(payload.event.runTotal);
      patchNode(payload.event.nodeId, { metric: `${payload.event.total} tok` });
    });

    on('budget.exceeded', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { scope: string; detail: string };
      };
      setToast(`预算超限：${payload.event.detail} · 点击查看结果`);
      push(
        orchestratorId,
        'assistant',
        `预算超限（${payload.event.scope}）：${payload.event.detail}`
      );
    });

    on('run.finished', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { status: 'done' | 'failed' | 'aborted' };
      };
      setRunning(false);
      patchNode(orchestratorId, {
        status: payload.event.status === 'done' ? 'done' : 'failed',
        metric: payload.event.status,
      });

      const tasks = Object.values(runTasksRef.current);
      const total = tasks.length;
      const passed = tasks.filter(
        (task) => task.acceptance?.pass && !task.acceptance.needsHuman
      ).length;
      const needsHuman = tasks.filter((task) => task.acceptance?.needsHuman).length;
      const summary: RunSummary = {
        runId,
        status: payload.event.status,
        total,
        passed,
        needsHuman,
        events: runEventCount.current,
        durationMs: runStartedAt.current ? Date.now() - runStartedAt.current : 0,
        tokens: runTokensRef.current,
      };
      setRunSummary(summary);
      decorateArtifacts();

      const text =
        payload.event.status === 'done'
          ? `运行完成：${passed}/${total} 通过${needsHuman ? `，${needsHuman} 项需人工确认` : ''}`
          : `运行结束：${payload.event.status}`;
      setToast(`${text} · 点击查看结果`);
      if (settings.notifications) notify(text);

      push(
        orchestratorId,
        'assistant',
        `${text}。共 ${runEventCount.current} 个事件，用时 ${(summary.durationMs / 1000).toFixed(1)}s。`
      );
      source.close();
    });

    on('end', () => source.close());

    source.onerror = () => {
      push(orchestratorId, 'assistant', '事件流中断，正在自动重连…');
    };
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    setChoice(null);
    resetRunState();
    runStartedAt.current = Date.now();
    patchNode(orchestratorId, { status: 'running', metric: '规划中…' });
    push(orchestratorId, 'assistant', '已向本地服务提交真实运行：调研 → 写作 → 审校。');
    try {
      const credentialFor = (needle: string) => {
        const model = models.find(
          (item) => item.baseUrl.includes(needle) && item.apiKey.trim().length > 0
        );
        return model?.apiKey.trim() || undefined;
      };
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          type: 'run.start',
          payload: {
            mode: 'live',
            credentials: {
              deepseek: credentialFor('deepseek'),
              minimax: credentialFor('minimaxi'),
              relay: credentialFor('127.0.0.1'),
            },
            budget: {
              maxTotalTokens: settings.maxTokensPerRun,
              maxTokensPerMinute: settings.maxTokensPerMinute,
            },
            orchestratorId,
            team: nodes
              .filter((node) => node.data.kind === 'agent' || node.data.kind === 'orchestrator')
              .map((node) => ({
                id: node.id,
                name: node.data.name,
                role: node.data.role,
                provider: node.data.provider,
                model: node.data.model,
                effort: node.data.effort,
              })),
          },
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { runId: string };
      subscribeToRun(data.runId);
    } catch {
      setRunning(false);
      push(orchestratorId, 'assistant', '真实运行启动失败（服务或凭据不可用），切换到本地演示。');
      await runLocalDemo();
    }
  };

  const send = async (nodeId: string, text: string) => {
    push(nodeId, 'user', text);
    const node = nodes.find((item) => item.id === nodeId)?.data;
    const model = models.find((item) => item.id === node?.connectionId);
    const context = libraryContextFor(nodeId);
    const history: Array<{ role: string; content: string }> = (messages[nodeId] ?? [])
      .slice(-10)
      .map((item) => ({ role: item.role, content: item.content }));
    if (context) history.unshift({ role: 'system', content: context });
    history.push({ role: 'user', content: text });
    patchNode(nodeId, { status: 'running', metric: '对话中…' });
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connectionId: node?.connectionId,
          protocol: model?.protocol,
          baseUrl: model?.baseUrl,
          model: node?.model,
          messages: history,
          maxTokens: 900,
        }),
      });
      const data = (await response.json()) as { ok?: boolean; text?: string; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? 'chat_failed');
      push(nodeId, 'assistant', data.text?.trim() || '（模型没有返回内容）');
      patchNode(nodeId, { status: 'idle', metric: 'ready' });
    } catch (error) {
      push(
        nodeId,
        'assistant',
        `调用失败：${error instanceof Error ? error.message : '未知错误'}。检查模型连接或 Key 后重试。`
      );
      patchNode(nodeId, { status: 'failed', metric: '对话失败' });
    }
  };

  const rerun = (nodeId: string) => {
    patchNode(nodeId, { status: 'running', metric: '重跑中…' });
    push(nodeId, 'assistant', '已按当前 effort 重新执行上一次任务，旧的验收结论保留在日志里。');
    window.setTimeout(() => {
      patchNode(nodeId, { status: 'done', metric: '重跑完成 · 1.1k tok' });
    }, 1100);
  };

  const changeEffort = (nodeId: string, effort: EffortLevel) => {
    patchNode(nodeId, { effort });
    push(nodeId, 'assistant', `effort 已手动改为 ${effort}。这次修改会作为偏好信号记录。`);
  };

  const resolveChoice = (option: ChoiceOption) => {
    setChoice(null);
    push(orchestratorId, 'assistant', `你选择了「${option.label}」。已记录为偏好权重，后续同类取舍会自动采用。`);
  };

  const selectedNode =
    selection?.kind === 'node' ? nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge =
    selection?.kind === 'edge' ? edges.find((edge) => edge.id === selection.id) : undefined;
  const externalSessionCount = new Set(externalCalls.map((call) => call.sessionId)).size;

  const hiddenRegionIds = useMemo(
    () =>
      new Set(
        nodes.filter((node) => node.type === 'region' && node.data.hidden).map((node) => node.id)
      ),
    [nodes]
  );
  const visibleNodes = useMemo(
    () =>
      nodes
        .filter((node) => !node.data.hidden)
        .filter((node) => !node.parentId || !hiddenRegionIds.has(node.parentId))
        .filter((node) => node.data.kind !== 'task' || settings.showTasks)
        .filter((node) => node.data.kind !== 'artifact' || settings.showArtifacts)
        .map((node) => ({
          ...node,
          data: {
            ...node.data,
            onDelete:
              node.data.kind === 'orchestrator' || node.type === 'external'
                ? undefined
                : () => requestDelete([node.id], node.data.name),
            onMakeOrchestrator:
              node.data.kind === 'agent' ? () => makeOrchestrator(node.id) : undefined,
            onOpen:
              node.type === 'artifact' && node.data.output
                ? () => openArtifactFromNode(node)
                : node.data.onOpen,
            onOpenSession:
              node.type === 'external'
                ? openSession
                : (node.data as { onOpenSession?: unknown }).onOpenSession,
          },
        })),
    [nodes, settings.showTasks, settings.showArtifacts, hiddenRegionIds]
  );
  const visibleEdges = useMemo(() => {
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    return edges
      .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
      .map((edge) =>
        edge.type === 'artifact'
          ? {
              ...edge,
              data: { ...(edge.data as Record<string, unknown>), onOpen: openArtifact },
            }
          : edge
      );
  }, [edges, visibleNodes]);

  const selectedAgentNodes = selectedIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter(
      (node): node is StudioNode =>
        Boolean(node && (node.data.kind === 'agent' || node.data.kind === 'orchestrator'))
    );
  const discussionParticipants = selectedAgentNodes.slice(0, 5).map((node) => {
    const model = models.find((item) => item.id === node.data.connectionId);
    return {
      id: node.id,
      name: node.data.name,
      model: node.data.model,
      connectionId: node.data.connectionId,
      protocol: model?.protocol,
      baseUrl: model?.baseUrl,
    };
  });
  const discussionContext = (() => {
    const libraryIds = new Set(
      nodes.filter((node) => node.type === 'library' && node.data.isPublic).map((node) => node.id)
    );
    const participantIds = new Set(selectedAgentNodes.map((node) => node.id));
    for (const edge of edges) {
      if (!participantIds.has(edge.target)) continue;
      const source = nodes.find((node) => node.id === edge.source);
      if (source?.type === 'library') libraryIds.add(source.id);
    }
    return nodes
      .filter((node) => libraryIds.has(node.id))
      .flatMap((node) => node.data.libraryFiles ?? [])
      .map((file) => `[${file.name}]\n${file.preview?.trim() || '（二进制文件）'}`)
      .join('\n\n')
      .slice(0, 4000);
  })();

  const isAgentSelection =
    selectedNode?.data.kind === 'agent' || selectedNode?.data.kind === 'orchestrator';
  const drawer = isAgentSelection
    ? {
        mode: 'node' as const,
        title: selectedNode!.data.name,
        subtitle: `${selectedNode!.data.provider} · ${selectedNode!.data.model}`,
        accent: selectedNode!.data.accent,
        node: selectedNode!.data,
        messages: messages[selectedNode!.id] ?? [],
        onMakeOrchestrator:
          selectedNode!.data.kind === 'agent'
            ? () => makeOrchestrator(selectedNode!.id)
            : undefined,
      }
    : selectedEdge
      ? {
          mode: 'edge' as const,
          title: `${selectedEdge.data?.kind ?? 'assign'} 连线`,
          subtitle: `${nodes.find((node) => node.id === selectedEdge.source)?.data.name ?? selectedEdge.source} → ${
            nodes.find((node) => node.id === selectedEdge.target)?.data.name ?? selectedEdge.target
          }`,
          accent: '#38d9c9',
          edge: {
            label: String(selectedEdge.label ?? ''),
            kind: String(selectedEdge.data?.kind ?? 'assign'),
            source: selectedEdge.source,
            target: selectedEdge.target,
          },
          messages: [],
          onMakeOrchestrator: undefined,
        }
      : null;

  const inspectNode =
    selectedNode &&
    selectedNode.type !== 'agent' &&
    selectedNode.type !== 'external' &&
    selectedNode.id !== '__final__'
      ? selectedNode
      : undefined;

  const artifactTask = (() => {
    if (!artifactTaskId) return undefined;
    const direct = runTasks[artifactTaskId] ?? externalTasks[artifactTaskId];
    if (direct) return direct;
    const node = nodes.find((item) => item.id === `artifact-${artifactTaskId}`);
    if (!node?.data.output) return undefined;
    return {
      taskId: artifactTaskId,
      nodeId: node.id,
      title: node.data.name,
      model: node.data.model,
      status: 'done' as const,
      output: node.data.output,
      acceptance: node.data.acceptance
        ? {
            pass: Boolean(node.data.acceptance.pass),
            score: node.data.acceptance.score ?? 0,
            reasons: node.data.acceptance.reasons ?? [],
            needsHuman: node.data.acceptance.needsHuman,
          }
        : undefined,
    };
  })();

  return (
    <div className="app">
      <Toolbar
        running={running}
        nodeCount={visibleNodes.length}
        edgeCount={visibleEdges.length}
        tokens={runTokens}
        onRun={run}
        onStop={stop}
        onAddNode={addNode}
        onOpenModels={() => setEditorOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenReport={() => setReportOpen(true)}
        onReset={resetAll}
        hasReport={Boolean(runSummary)}
        approvalCount={pendingApprovals}
        onOpenApprovals={() => setApprovalsOpen(true)}
        externalCount={externalSessionCount}
        onOpenExternal={() => {
          setExternalFocus(null);
          setExternalModalOpen(true);
        }}
        discussionCount={selectedAgentNodes.length}
        onDiscuss={() => {
          if (selectedAgentNodes.length > 5) {
            setToast('讨论最多 5 个模型，已选取前 5 个');
          }
          setDiscussionOpen(true);
        }}
        onUpload={() => fileInputRef.current?.click()}
        onAddLibrary={addLibrary}
        onAutoLayout={() => void autoLayout()}
        layouting={layouting}
        brushMode={brushMode}
        onBrushMode={setBrushMode}
      />

      <div className="workspace">
        <div className="canvas-wrap">
          <Canvas
            nodes={visibleNodes}
            edges={visibleEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(id) => setSelection({ kind: 'node', id })}
            onEdgeClick={(id) => setSelection({ kind: 'edge', id })}
            onNodesDelete={cleanupDeletedNodes}
            onNodeDragStop={handleNodeDragStop}
            onSelectionChange={(ids) =>
              setSelectedIds((current) =>
                current.length === ids.length &&
                current.every((id, index) => id === ids[index])
                  ? current
                  : ids
              )
            }
            onInit={(instance) => {
              rfRef.current = instance;
            }}
          />
          {brushMode && (
            <div
              className="brush-layer"
              onPointerDown={(event) => {
                const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                if (!bounds) return;
                const start = {
                  x: event.clientX - bounds.left,
                  y: event.clientY - bounds.top,
                };
                brushStart.current = start;
                setBrushRect({ left: start.x, top: start.y, width: 0, height: 0 });
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const start = brushStart.current;
                const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                if (!start || !bounds) return;
                const x = event.clientX - bounds.left;
                const y = event.clientY - bounds.top;
                setBrushRect({
                  left: Math.min(start.x, x),
                  top: Math.min(start.y, y),
                  width: Math.abs(x - start.x),
                  height: Math.abs(y - start.y),
                });
              }}
              onPointerUp={() => {
                if (brushRect && brushRect.width > 40 && brushRect.height > 30) {
                  createRegion(brushRect);
                }
                brushStart.current = null;
                setBrushRect(null);
              }}
              onPointerCancel={() => {
                brushStart.current = null;
                setBrushRect(null);
              }}
            >
              {brushRect && (
                <div
                  className="brush-rect"
                  style={{
                    left: brushRect.left,
                    top: brushRect.top,
                    width: brushRect.width,
                    height: brushRect.height,
                  }}
                />
              )}
              <div className="brush-tip">拖拽划出分项目区域 · 方向在顶栏选择 · Esc 退出</div>
            </div>
          )}
          <div className="canvas-hint">
            Ctrl/⌘ 或 Shift 多选模型发起讨论 · 拖拽端口连线 · 画笔划出分项目区域
          </div>

          {choice && (
            <div className="choice-card">
              <h4>{choice.title}</h4>
              <p>{choice.detail}</p>
              <div className="choice-options">
                {choice.options.map((option) => (
                  <button
                    key={option.id}
                    className="choice-option"
                    onClick={() => resolveChoice(option)}
                  >
                    {option.label}
                    <small>{option.consequence}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {drawer && (
          <ChatDrawer
            mode={drawer.mode}
            title={drawer.title}
            subtitle={drawer.subtitle}
            accent={drawer.accent}
            messages={drawer.messages}
            node={drawer.mode === 'node' ? (drawer.node as AgentNodeData) : undefined}
            edge={drawer.mode === 'edge' ? drawer.edge : undefined}
            models={models}
            onClose={() => setSelection(null)}
            onSend={(text) => {
              if (drawer.mode === 'node' && selectedNode) send(selectedNode.id, text);
            }}
            onEffortChange={(effort) => {
              if (selectedNode) changeEffort(selectedNode.id, effort);
            }}
            onModelChange={(connectionId) => {
              if (selectedNode) handleModelChange(selectedNode.id, connectionId);
            }}
            onOpenModels={() => setEditorOpen(true)}
            onIdentityChange={(patch) => {
              if (selectedNode) patchNode(selectedNode.id, patch);
            }}
            onMakeOrchestrator={drawer.onMakeOrchestrator}
            onDelete={
              selectedNode && selectedNode.data.kind === 'agent'
                ? () => requestDelete([selectedNode.id], selectedNode.data.name)
                : undefined
            }
            onRerun={() => {
              if (selectedNode) rerun(selectedNode.id);
            }}
          />
        )}
        {inspectNode && (
          <NodeInspector
            node={inspectNode}
            onPatch={(patch) => patchNode(inspectNode.id, patch)}
            onDelete={() => deleteNode(inspectNode.id)}
            onDetach={() => detachFromRegion(inspectNode.id)}
            onCopy={
              inspectNode.data.kind === 'task' || inspectNode.data.kind === 'artifact'
                ? () => copyNode(inspectNode.id)
                : undefined
            }
            onPinToWire={
              inspectNode.data.kind === 'artifact'
                ? () => pinArtifactToWire(inspectNode.id)
                : undefined
            }
            onAddFiles={
              inspectNode.data.kind === 'library'
                ? () => openLibraryPicker(inspectNode.id, false)
                : undefined
            }
            onAddFolder={
              inspectNode.data.kind === 'library'
                ? () => openLibraryPicker(inspectNode.id, true)
                : undefined
            }
            onClose={() => setSelection(null)}
          />
        )}
      </div>

      <ModelEditor
        open={editorOpen}
        models={models}
        onChange={handleModelsChange}
        onClose={() => setEditorOpen(false)}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onChange={handleSettingsChange}
        onClose={() => setSettingsOpen(false)}
      />

      <RunReport
        open={reportOpen}
        summary={runSummary}
        tasks={runTasks}
        onClose={() => setReportOpen(false)}
        onMaterializeTask={materializeTask}
        onMaterializeArtifact={materializeArtifact}
      />

      <ApprovalsModal open={approvalsOpen} onClose={() => setApprovalsOpen(false)} />

      <ArtifactModal
        open={Boolean(artifactOverride || artifactTaskId)}
        task={artifactOverride ?? artifactTask}
        onClose={() => {
          setArtifactTaskId(null);
          setArtifactOverride(null);
        }}
        onMaterialize={materializeArtifact}
      />

      <ExternalModal
        open={externalModalOpen}
        calls={externalCalls}
        focusSessionId={externalFocus}
        onOpenArtifact={openArtifact}
        onClose={() => {
          setExternalModalOpen(false);
          setExternalFocus(null);
        }}
      />

      <DiscussionModal
        open={discussionOpen}
        participants={discussionParticipants}
        context={discussionContext}
        onClose={() => setDiscussionOpen(false)}
        onCreateArtifact={(title, output) => {
          const id = `artifact-${crypto.randomUUID().slice(0, 8)}`;
          setNodes((current) => [
            ...current,
            {
              id,
              type: 'artifact',
              position: { x: 780 + (current.length % 4) * 40, y: 120 + (current.length % 5) * 40 },
              data: {
                kind: 'artifact',
                name: title,
                role: '讨论产物',
                provider: '',
                model: '',
                effort: 'off',
                status: 'done',
                accent: '#e0a458',
                taskId: '',
                output,
                acceptance: { pass: true, score: 1, reasons: ['AI 讨论'] },
              },
            } as StudioNode,
          ]);
          setToast('讨论已存为产物模块');
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`删除「${pendingDelete?.label ?? ''}」？`}
        detail="删除后与该节点相连的连线也会移除；区域内的节点会保留并移出区域。"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadFile(file);
          event.target.value = '';
        }}
      />

      <input
        ref={libraryFilesInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          const target = libraryTarget.current;
          if (target && files.length > 0) void uploadLibraryFiles(files, target);
          libraryTarget.current = null;
          event.target.value = '';
        }}
      />

      <input
        ref={(element) => {
          libraryFolderInput.current = element;
          element?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          const target = libraryTarget.current;
          if (target && files.length > 0) void uploadLibraryFiles(files, target);
          libraryTarget.current = null;
          event.target.value = '';
        }}
      />

      {toast && (
        <div
          className="toast"
          onClick={() => {
            if (runSummary) setReportOpen(true);
            else setToast(null);
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
