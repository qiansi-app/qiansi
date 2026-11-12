import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MarkerType,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
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
import { AttentionModal } from './components/AttentionModal';
import { SelfOptModal } from './components/SelfOptModal';
import { KeysModal } from './components/KeysModal';
import { HandoffModal } from './components/HandoffModal';
import { ArtifactModal } from './components/ArtifactModal';
import { ExternalModal } from './components/ExternalModal';
import { RunProgress } from './components/RunProgress';
import { RunReport } from './components/RunReport';
import { TeamModal } from './components/TeamModal';
import { UserViewModal } from './components/UserViewModal';
import { SettingsModal } from './components/SettingsModal';
import { Toolbar } from './components/Toolbar';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { WorkflowModal, type WorkflowPlan } from './components/WorkflowModal';
import { catalogOf, initialModels, preferredModel, type ModelDraft } from './data/models';
import { loadSettings, saveSettings, type AppSettings } from './data/settings';
import { decideTakeover } from './lib/takeover';
import { currentWorkspace, setCurrentWorkspace, switchWorkspace } from './workspace';
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
  RunDiagnosis,
  RunFailureInfo,
  RunSummary,
  RunTaskView,
  Selection,
  TeamDoc,
  UserViewReport,
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
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selection, setSelection] = useState<Selection>(null);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>(seedMessages);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  /** True while a run started elsewhere (an agent over MCP) is in flight. */
  const [externalRun, setExternalRun] = useState(false);
  const externalRunRef = useRef(false);
  /** 已经补过完成态的运行 id，避免每秒重复提示。 */
  const recentShownRef = useRef<string | null>(null);
  /** 当前在跑的运行 id：停止要通知服务端。 */
  const activeRunIdRef = useRef("");
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  /** 画布区域尺寸变化后重新适配视野：分栏拖动、面板变窄时图形不跑出屏幕。 */
  useEffect(() => {
    const element = canvasWrapRef.current;
    if (!element) return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const instance = rfRef.current;
        if (!instance) return;
        try {
          instance.fitView({ padding: 0.18, duration: 200 });
        } catch {
          // 画布尚未初始化
        }
      }, 250);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  /** 进度条当前显示的是「补显的完成态」：服务端窗口过了就整体撤下。 */
  const recentOnlyRef = useRef(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [models, setModels] = useState<ModelDraft[]>(() => {
    // 连接定义（label/baseUrl/模型目录）落 localStorage：以前只存内存，
    // 刷新后新增或改名的连接全部丢回硬编码的四条。
    try {
      const raw = window.localStorage.getItem('qiansi.models.v1');
      if (raw) {
        const parsed = JSON.parse(raw) as ModelDraft[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 智谱 Coding 套餐 Key 只认 coding 端点；旧缓存里的标准端点
          // 会让所有 GLM 请求报 1113，加载时迁移一次并写回。
          const migrated = parsed.map((model) =>
            model.baseUrl?.includes('open.bigmodel.cn/api/paas/v4') &&
            !model.baseUrl.includes('/coding/')
              ? { ...model, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' }
              : model
          );
          try {
            window.localStorage.setItem('qiansi.models.v1', JSON.stringify(migrated));
          } catch {
            // 隐私模式写不回：本次会话仍用迁移后的内存值
          }
          return migrated;
        }
      }
    } catch {
      // 隐私模式读不了 localStorage：回退默认值
    }
    return initialModels;
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [selfOptOpen, setSelfOptOpen] = useState(false);
  const [attentionCount, setAttentionCount] = useState(0);
  const [handoffOpen, setHandoffOpen] = useState(false);
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
  /** 失败原因与重试进度：运行条上展示，并提供重试入口。 */
  const [failureInfo, setFailureInfo] = useState<RunFailureInfo | null>(null);
  /** 失败环境诊断：工作目录、模型 Key、可选的重跑方式。 */
  const [diagnosis, setDiagnosis] = useState<RunDiagnosis | null>(null);
  const [diagnosisBusy, setDiagnosisBusy] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  /** 用户视角验收：真实启动项目后的截图与检查结果。 */
  const [userView, setUserView] = useState<UserViewReport | null>(null);
  const [userViewBusy, setUserViewBusy] = useState(false);
  const [userViewOpen, setUserViewOpen] = useState(false);
  /** 团队名册与手册：一人一职，编排优先使用，运行注入职责与档位。 */
  const [team, setTeam] = useState<TeamDoc | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [runTokens, setRunTokens] = useState(0);
  /** 补显完成态时用真实结束时间算耗时，而不是定格在 0.0s。 */
  const [recentEndedAt, setRecentEndedAt] = useState(0);
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
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const rfRef = useRef<ReactFlowInstance<StudioNode, any> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const libraryFilesInput = useRef<HTMLInputElement | null>(null);
  const libraryFolderInput = useRef<HTMLInputElement | null>(null);
  const libraryTarget = useRef<string | null>(null);
  const brushStart = useRef<{ x: number; y: number } | null>(null);
  const canvasReady = useRef(false);
  const [canvasLoaded, setCanvasLoaded] = useState(false);
  const canvasRevision = useRef(0);
  const remoteApplying = useRef(false);
  /** True while local edits have not reached the server yet. */
  const dirty = useRef(false);
  /** When the oldest unsaved edit happened; a stale one triggers a re-save. */
  const dirtyAt = useRef(0);
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

  /**
   * Replaces the whole board from a server snapshot. Used on first load, on a
   * 409 conflict, and by the reverse-sync poller, so agent edits land in the
   * canvas without a reload.
   */
  const applyRemoteCanvas = useMemo(
    () =>
      (canvas: { nodes?: StudioNode[]; edges?: Edge[]; orchestratorId?: string } | null) => {
        if (!canvas || !Array.isArray(canvas.nodes)) return;
        if (canvas.nodes.length === 0) {
          setNodes([]);
          setEdges([]);
          setOrchestratorId('');
          return;
        }
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
          // keep the run-time placeholders: the final artifact card and any live
          // external-agent nodes are ours, not the saved document's
          ...current.filter(
            (node) =>
              node.id === '__final__' ||
              (node.id.startsWith('ext-') && !savedIds.has(node.id))
          ),
        ]);
        setEdges((current) => [
          ...(canvas.edges ?? []).filter((edge) => edge.id !== '__final-edge'),
          ...current.filter((edge) => edge.id === '__final-edge'),
        ]);
        if (canvas.orchestratorId) setOrchestratorId(canvas.orchestratorId);
      },
    [setNodes, setEdges]
  );

  useEffect(() => {
    void fetch('/api/bootstrap').catch(() => undefined);
  }, []);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  /** 需要人工的聚合计数：审批 + 需确认 + 失败 + 中断。轻量端点，15 秒一轮。 */
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (stopped || document.hidden) return;
      try {
        const response = await fetch('/api/attention');
        if (!response.ok) return;
        const data = (await response.json()) as { total?: number };
        setAttentionCount(data.total ?? 0);
      } catch {
        // 服务重启中：下一轮再试
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let loaded = false;
      try {
        await fetch('/api/bootstrap');
        const response = await fetch('/api/canvas');
        if (!response.ok) {
          // The starter graph renders below; say so instead of letting a 401
          // look like a fully working canvas showing mysterious content.
          setToast(`连不上本地服务（HTTP ${response.status}），当前显示的是演示画布`);
          return;
        }
        const data = (await response.json()) as {
          canvas?: {
            nodes?: StudioNode[];
            edges?: Edge[];
            orchestratorId?: string;
          } | null;
          revision?: number;
        };
        loaded = true;
        canvasRevision.current = Number(data.revision) || 0;
        if (!alive || !data.canvas || !Array.isArray(data.canvas.nodes)) return;
        applyRemoteCanvas(data.canvas);
      } catch {
        // server unavailable: keep the starter graph and say what is showing
        setToast('连不上本地服务，当前显示的是演示画布');
      } finally {
        if (loaded) {
          canvasReady.current = true;
          setCanvasLoaded(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [applyRemoteCanvas]);

  /**
   * Opening the app should show the whole board, not wherever it happened to be
   * panned last time. Only on the first load — never on the reverse-sync poll.
   */
  useEffect(() => {
    if (!canvasLoaded) return;
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.2, duration: 300 });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [canvasLoaded, fitView]);

  /**
   * Saves the whole board. Shared by the edit-debounce and by the reverse-sync
   * poller's stale-dirty retry, so both get the 409 merge/adopt behaviour.
   */
  const saveCanvas = useCallback(() => {
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
    void (async () => {
      try {
        const response = await fetch('/api/canvas', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            orchestratorId,
            nodes: nodesPayload,
            edges: edgesPayload,
            revision: canvasRevision.current,
          }),
        });
        const data = (await response.json().catch(() => null)) as {
          revision?: number;
          canvas?: { nodes?: StudioNode[]; edges?: Edge[]; orchestratorId?: string } | null;
        } | null;
        if (response.status === 409) {
          // Someone else wrote while we were editing. Merge instead of
          // choosing a winner: keep our board, adopt nodes we never had, and
          // retry against the server's revision.
          const serverRevision = Number(data?.revision) || 0;
          const serverCanvas = data?.canvas ?? null;
          const serverNodes = Array.isArray(serverCanvas?.nodes) ? serverCanvas.nodes : [];
          const serverEdges = Array.isArray(serverCanvas?.edges) ? serverCanvas.edges : [];
          const localIds = new Set(nodesPayload.map((node) => node.id));
          const localEdgeIds = new Set(edgesPayload.map((edge) => edge.id));
          const mergedNodes = [
            ...serverNodes.filter((node) => !localIds.has(node.id)),
            ...nodesPayload,
          ];
          const mergedEdges = [
            ...serverEdges.filter((edge) => !localEdgeIds.has(edge.id)),
            ...edgesPayload,
          ];
          canvasRevision.current = serverRevision;
          let merged = false;
          try {
            const retry = await fetch('/api/canvas', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                orchestratorId,
                nodes: mergedNodes,
                edges: mergedEdges,
                revision: serverRevision,
              }),
            });
            const retryData = (await retry.json().catch(() => null)) as {
              revision?: number;
            } | null;
            merged = retry.ok && typeof retryData?.revision === 'number';
            if (merged) canvasRevision.current = retryData!.revision!;
          } catch {
            merged = false;
          }
          if (merged) {
            dirty.current = false;
            dirtyAt.current = 0;
            setToast('已合并外部改动，保留了你当前的编辑');
            // pull the merged document so nodes the agent added appear
            const fresh = (await fetch('/api/canvas')
              .then((response) => response.json())
              .catch(() => null)) as {
              canvas?: { nodes?: StudioNode[]; edges?: Edge[]; orchestratorId?: string } | null;
              revision?: number;
            } | null;
            if (fresh?.canvas && typeof fresh.revision === 'number') {
              canvasRevision.current = fresh.revision;
              remoteApplying.current = true;
              window.setTimeout(() => {
                remoteApplying.current = false;
              }, 250);
              applyRemoteCanvas(fresh.canvas);
            }
          } else {
            canvasRevision.current = serverRevision;
            remoteApplying.current = true;
            window.setTimeout(() => {
              remoteApplying.current = false;
            }, 250);
            applyRemoteCanvas(serverCanvas);
            dirty.current = false;
            dirtyAt.current = 0;
            setToast('画布已被外部修改，已同步');
          }
          return;
        }
        if (response.ok && typeof data?.revision === 'number') {
          canvasRevision.current = data.revision;
          dirty.current = false;
          dirtyAt.current = 0;
        }
      } catch {
        // offline: the poller retries stale dirty state; the next edit retries too
      }
    })();
  }, [nodes, edges, orchestratorId, applyRemoteCanvas]);

  useEffect(() => {
    if (!canvasReady.current) return;
    if (remoteApplying.current) {
      remoteApplying.current = false;
      return;
    }
    dirty.current = true;
    if (!dirtyAt.current) dirtyAt.current = Date.now();
    const timer = window.setTimeout(saveCanvas, 800);
    return () => window.clearTimeout(timer);
  }, [nodes, edges, orchestratorId, applyRemoteCanvas, saveCanvas]);

  /**
   * Reverse sync: an agent (Claude Code, Codex) writes through the MCP server,
   * the local server bumps `revision`, and this poller pulls the change in
   * without a reload.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!canvasReady.current || document.hidden) return;
      // Local edits not yet saved win the race: pulling the server snapshot now
      // would silently undo what the user just did. But a save that failed
      // (server restarting mid-flight) used to keep `dirty` true forever, which
      // froze this view on a stale board with no retry. Re-save stale dirty
      // state instead — the save path merges or adopts on 409.
      if (dirty.current) {
        if (Date.now() - dirtyAt.current < 5000) return;
        dirtyAt.current = Date.now();
        saveCanvas();
        return;
      }
      void (async () => {
        try {
          const response = await fetch('/api/canvas');
          if (!response.ok) return;
          const data = (await response.json()) as {
            canvas?: { nodes?: StudioNode[]; edges?: Edge[]; orchestratorId?: string } | null;
            revision?: number;
          };
          const revision = Number(data.revision) || 0;
          if (revision <= canvasRevision.current) return;
          canvasRevision.current = revision;
          remoteApplying.current = true;
          window.setTimeout(() => {
            remoteApplying.current = false;
          }, 250);
          applyRemoteCanvas(data.canvas ?? null);
          // The server writes run artifacts back itself; while a run is live that
          // echo is expected, so do not tell the user their board was edited.
          if (!runningRef.current) setToast('画布已同步外部改动');
        } catch {
          // server restarting: try again next tick
        }
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [applyRemoteCanvas, saveCanvas]);

  /**
   * A run started by an agent (through MCP, handoff or the workflow endpoint)
   * never reaches this window's own SSE subscription, so the progress strip
   * would stay empty. Poll the server's active-run snapshot instead and mirror
   * it into the same task map.
   *
   * Hidden pages throttle timers to about once a minute — which is why the
   * strip used to show up late (or not at all for short runs) after switching
   * back to the canvas. Polling immediately on visibility/focus fixes that, and
   * the interval is short enough that a 3-second run still gets a frame.
   */
  useEffect(() => {
    let stopped = false;

    const checkActive = async () => {
      if (runningRef.current || document.hidden || stopped) return;
      try {
        const response = await fetch('/api/runs/active');
        if (!response.ok) return;
        const data = (await response.json()) as {
          run?: {
            runId: string;
            status: string;
            startedAt: number;
            tokens: number;
            tasks: Array<{
              taskId: string;
              nodeId: string | null;
              title: string;
              effort?: string;
              status: 'pending' | 'running' | 'done' | 'failed';
            }>;
          } | null;
          recent?: {
            runId: string;
            status: string;
            goal: string;
            startedAt: number;
            finishedAt: number;
            tokens: number;
            failureSummary?: RunFailureInfo | null;
            attempt?: number;
            maxAttempts?: number;
            tasks: Array<{
              taskId: string;
              nodeId: string | null;
              title: string;
              effort?: string;
              status: 'pending' | 'running' | 'done' | 'failed';
            }>;
          } | null;
        };
        const active = data.run && data.run.status === 'running';
        if (active && data.run) {
          const tasks: Record<string, RunTaskView> = {};
          for (const task of data.run.tasks) {
            tasks[task.taskId] = {
              taskId: task.taskId,
              nodeId: task.nodeId ?? '',
              title: task.title,
              effort: task.effort,
              status: task.status,
            };
          }
          runTasksRef.current = tasks;
          setRunTasks(tasks);
          setRunTokens(data.run.tokens);
          // 正在重试/运行：上一次的失败总结先撤下，避免看起来还在失败。
          setFailureInfo(null);
          runStartedAt.current = data.run.startedAt;
          if (!externalRunRef.current) {
            externalRunRef.current = true;
            setExternalRun(true);
            setToast('外部 Agent 正在画布上运行');
          }
        } else if (externalRunRef.current) {
          externalRunRef.current = false;
          setExternalRun(false);
        } else if (data.recent && recentShownRef.current !== data.recent.runId) {
          // 运行在页面切走时结束了：补一个完成态，而不是什么都不显示。
          recentShownRef.current = data.recent.runId;
          const tasks: Record<string, RunTaskView> = {};
          for (const task of data.recent.tasks) {
            tasks[task.taskId] = {
              taskId: task.taskId,
              nodeId: task.nodeId ?? '',
              title: task.title,
              effort: task.effort,
              status: task.status,
            };
          }
          runTasksRef.current = tasks;
          setRunTasks(tasks);
          setRunTokens(data.recent.tokens);
          runStartedAt.current = data.recent.startedAt;
          setRecentEndedAt(data.recent.finishedAt);
          recentOnlyRef.current = true;
          setExternalRun(false);
          setFailureInfo(data.recent.failureSummary ?? null);
          if (data.recent.failureSummary) {
            const recentId = data.recent.runId;
            window.setTimeout(() => void loadDiagnosis(recentId), 300);
          } else if (data.recent.status === 'done') {
            void refreshUserView();
          }
          // 补显的完成态也要能点「本轮结果」和「重试」：runSummary 是它们的依据。
          const recentValues = Object.values(tasks);
          setRunSummary({
            runId: data.recent.runId,
            status:
              data.recent.status === 'done'
                ? 'done'
                : data.recent.status === 'failed'
                  ? 'failed'
                  : 'aborted',
            total: recentValues.length,
            passed: recentValues.filter((task) => task.status === 'done').length,
            needsHuman: 0,
            events: 0,
            durationMs: Math.max(0, (data.recent.finishedAt ?? 0) - (data.recent.startedAt ?? 0)),
            tokens: data.recent.tokens,
          });
          setToast(
            data.recent.status === 'done'
              ? '上一轮运行刚刚完成'
              : '上一轮运行刚刚结束（未全部成功）'
          );
        } else if (!data.run && !data.recent && recentOnlyRef.current) {
          // 补显的完成态有展示窗口（服务端 10 分钟）；窗口过了就撤下进度条，
          // 而不是让一条定格的旧进度看起来像还在跑。
          recentOnlyRef.current = false;
          runTasksRef.current = {};
          setRunTasks({});
          setRunTokens(0);
          runStartedAt.current = 0;
          setRecentEndedAt(0);
          recentShownRef.current = null;
        }
      } catch {
        // server restarting: try again next tick
      }
    };

    const timer = window.setInterval(() => void checkActive(), 1000);
    const onVisible = () => {
      if (!document.hidden) void checkActive();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    void checkActive();

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

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
    setFailureInfo(null);
    setDiagnosis(null);
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

  const clearCanvas = () => {
    runToken.current += 1;
    setRunning(false);
    setChoice(null);
    resetRunState();
    streamBuffers.current = {};
    taskNodes.current = {};
    setNodes([]);
    setEdges([]);
    setMessages({});
    setSelection(null);
    setSelectedIds([]);
    setExternalTasks({});
    externalTasksRef.current = {};
    setExternalCalls([]);
    externalCallsRef.current = [];
    setExternalModalOpen(false);
    setExternalFocus(null);
    setArtifactTaskId(null);
    setArtifactOverride(null);
    setPendingDelete(null);
    setClearConfirmOpen(false);
    setOrchestratorId('');
    setToast('画板已清空，可以从「添加模型」开始');
  };

  const uploadFilesForWorkflow = async (files: File[]) => {
    const result: LibraryFile[] = [];
    for (const file of files.slice(0, 40)) {
      if (file.size > 8 * 1024 * 1024) continue;
      try {
        const uploaded = await uploadOneFile(file);
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        result.push({
          id: uploaded.id,
          name: relative || uploaded.name,
          size: uploaded.size,
          preview: uploaded.preview,
        });
      } catch {
        // skip files that fail to upload; the rest of the workflow can continue
      }
    }
    return result;
  };

  const fitCanvas = () => {
    const run = () => {
      void fitView({ padding: 0.16, duration: 450, maxZoom: 1.2 });
    };
    // Fit once after the first paint, then again after React Flow has measured
    // nodes that were just repositioned or created.
    window.setTimeout(run, 150);
    window.setTimeout(run, 700);
  };

  const applyWorkflow = (
    plan: WorkflowPlan,
    files: LibraryFile[],
    orchestratorConnectionId: string
  ) => {
    const orchestratorModel = models.find((model) => model.id === orchestratorConnectionId);
    const baseLibrary = publicLibraryNode();
    const library: StudioNode = {
      ...baseLibrary,
      data: { ...baseLibrary.data, libraryFiles: files },
    };
    const palette = ['#4d6bfe', '#ff7a45', '#a78bfa', '#34d399', '#60a5fa', '#f472b6'];
    const used = new Set(['orchestrator']);
    const nodes: StudioNode[] = [library, {
      id: 'orchestrator',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        kind: 'orchestrator',
        name: orchestratorModel?.label ?? '主控',
        role: '拆解 · 分派 · 验收',
        provider: orchestratorModel?.provider ?? 'Custom',
        model: orchestratorModel?.model ?? 'orchestrator',
        effort: 'high',
        status: 'idle',
        accent: '#e0a458',
        metric: '待命',
        connectionId: orchestratorModel?.id,
        protocol: orchestratorModel?.protocol,
        baseUrl: orchestratorModel?.baseUrl,
      },
    }];
    const idMap = new Map<string, string>();
    plan.nodes.forEach((planned, index) => {
      let id = `wf-${planned.id || index + 1}`;
      while (used.has(id)) id = `${id}-${index}`;
      used.add(id);
      idMap.set(planned.id, id);
      const model = models.find((item) => item.id === planned.connectionId) ?? models[0];
      nodes.push({
        id,
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          kind: 'agent',
          name: planned.name,
          role: planned.role,
          // 编排给出的工单、交付物与验收条件随节点走，
          // 生成计划时直接用它们，不再退回同一条通用标准。
          task: planned.task,
          deliverable: planned.deliverable,
          // data.acceptance 已被「运行验收结果」占用，验收条件用 acceptanceCriteria。
          acceptanceCriteria: planned.acceptance,
          provider: model?.provider ?? '',
          model: model?.model ?? planned.connectionId,
          effort: (planned.effort as EffortLevel) ?? 'medium',
          status: 'idle',
          accent: palette[index % palette.length],
          metric: planned.memberName ? `${planned.memberName} · ready` : 'ready',
          connectionId: model?.id,
          protocol: model?.protocol,
          baseUrl: model?.baseUrl,
          ...(planned.memberId
            ? { memberId: planned.memberId, memberName: planned.memberName ?? '' }
            : {}),
        },
      });
    });

    const colors: Record<string, string> = {
      assign: '#6366f1',
      handoff: '#10b981',
      review: '#f59e0b',
      context: '#38d9c2',
    };
    const resolve = (id: string) =>
      id === 'orchestrator' ? 'orchestrator' : idMap.get(id);
    const edges: Edge[] = [];
    plan.edges.forEach((planned, index) => {
      const source = resolve(planned.source);
      const target = resolve(planned.target);
      if (!source || !target || source === target) return;
      edges.push({
        id: `wf-e-${index + 1}`,
        source,
        target,
        type: 'smoothstep',
        animated: true,
        label: planned.label ?? planned.kind,
        data: { kind: planned.kind },
        style: { stroke: colors[planned.kind] ?? '#6366f1', strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        labelStyle: { fill: '#8b98a8', fontSize: 9.5 },
        labelBgStyle: { fill: '#0e1318', fillOpacity: 0.92 },
      });
    });
    const assigned = new Set(
      edges.filter((edge) => edge.source === 'orchestrator').map((edge) => edge.target)
    );
    for (const node of nodes) {
      if (node.id === 'orchestrator' || node.id === library.id) continue;
      if (assigned.has(node.id)) continue;
      edges.push({
        id: `wf-auto-${node.id}`,
        source: 'orchestrator',
        target: node.id,
        type: 'smoothstep',
        animated: true,
        label: '任务',
        data: { kind: 'assign' },
        style: { stroke: colors.assign, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        labelStyle: { fill: '#8b98a8', fontSize: 9.5 },
        labelBgStyle: { fill: '#0e1318', fillOpacity: 0.92 },
      });
    }

    runToken.current += 1;
    setRunning(false);
    // 审校发现的分工问题直接说出来，别让它只留在接口响应里。
    if (plan.notes && plan.notes.length > 0) {
      const head = plan.revised ? '分工已按审校意见调整' : '分工审校';
      setToast(`${head}：${plan.notes.slice(0, 2).join('；')}`);
    }
    resetRunState();
    streamBuffers.current = {};
    taskNodes.current = {};
    setMessages({});
    setSelection(null);
    setSelectedIds([]);
    const positions = layeredLayout(nodes, edges, 'orchestrator');
    const laidOut = nodes.map((node) => ({ ...node, position: positions[node.id] ?? node.position }));
    // 一个工作流一张画布：生成的工作流落到新画布，不覆盖你正在看的这张。
    void (async () => {
      try {
        const created = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: plan.summary.slice(0, 24) || '新工作流' }),
        });
        const createdBody = (await created.json().catch(() => null)) as { workspace?: { id: string } } | null;
        const workspaceId = createdBody?.workspace?.id;
        if (workspaceId) {
          const saved = await fetch('/api/canvas', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-qiansi-workspace': workspaceId },
            body: JSON.stringify({ revision: 0, orchestratorId: 'orchestrator', nodes: laidOut, edges }),
          });
          if (saved.ok) {
            setCurrentWorkspace(workspaceId);
            switchWorkspace(workspaceId);
            return;
          }
        }
      } catch {
        // 新画布建不出来就退回覆盖当前画布，至少工作流不丢
      }
      setNodes(laidOut);
      setEdges(edges);
      setOrchestratorId('orchestrator');
      fitCanvas();
      setWorkflowOpen(false);
      setToast(`工作流已生成：${plan.summary}`);
    })();
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
      fitCanvas();

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
      if (aiPositions) fitCanvas();
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

  const handleModelChange = (nodeId: string, connectionId: string, modelId?: string) => {
    const connection = models.find((item) => item.id === connectionId);
    if (!connection) return;
    // A key serves a family: keep whichever model the user picked as long as
    // that key can actually call it.
    const catalog = catalogOf(connection);
    const model = modelId && catalog.includes(modelId) ? modelId : catalog[0] ?? connection.model;
    patchNode(nodeId, {
      connectionId,
      provider: connection.provider,
      model,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
    });
    push(
      nodeId,
      'assistant',
      `模型已切换为 ${connection.label} · ${model}。能力档案与 effort 方言随连接更新。`
    );
  };

  /**
   * The catalog from the key is the truth, not the ids typed into the editor.
   * One click moves every node onto its connection's cheapest capable model.
   * Written through the ops API so it is durable even if the modal closes
   * before the debounced save fires.
   */
  const applyPreferredModels = async (next: ModelDraft[]) => {
    setModels(next);
    const byConnection = new Map(next.map((item) => [item.id, item]));
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    let matched = 0;
    for (const node of nodesRef.current) {
      const connection = node.data.connectionId
        ? byConnection.get(node.data.connectionId)
        : undefined;
      if (!connection) continue;
      matched += 1;
      const model = preferredModel(catalogOf(connection));
      if (!model || model === node.data.model) continue;
      patches.push({
        id: node.id,
        data: {
          model,
          provider: connection.provider,
          protocol: connection.protocol,
          baseUrl: connection.baseUrl,
        },
      });
    }
    if (!patches.length) {
      setToast(
        `没有可替换的节点（检查 ${nodesRef.current.length} 个节点，${matched} 个匹配到连接，` +
          `目录：${next.map((item) => `${item.id}=${catalogOf(item).length}`).join(' ')}）`
      );
      return;
    }
    try {
      const response = await fetch('/api/canvas/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ops: patches.map((patch) => ({ op: 'update_node', id: patch.id, patch: patch.data })),
        }),
      });
      if (!response.ok) throw new Error('canvas ops failed');
      const data = (await response.json()) as { revision?: number };
      if (typeof data.revision === 'number') canvasRevision.current = data.revision;
      const byId = new Map(patches.map((patch) => [patch.id, patch.data]));
      setNodes((current) =>
        current.map((node) => {
          const patch = byId.get(node.id);
          return patch ? { ...node, data: { ...node.data, ...patch } } : node;
        })
      );
      setToast(`已把 ${patches.length} 个节点换成各连接的最划算模型`);
    } catch {
      setToast('替换失败：确认本地服务在运行');
    }
  };

  const handleModelsChange = (next: ModelDraft[]) => {
    setModels(next);
    try {
      // 只持久化连接定义；apiKey 留在内存（会话结束即丢），密钥真正的家在 vault。
      window.localStorage.setItem(
        'qiansi.models.v1',
        JSON.stringify(next.map((item) => ({ ...item, apiKey: '' })))
      );
    } catch {
      // 写不进去不影响本次会话
    }
    setNodes((current) =>
      current.map((node) => {
        const connectionId = node.data.connectionId;
        const connection = next.find((item) => item.id === connectionId);
        if (!connection) return node;
        const catalog = catalogOf(connection);
        const model = catalog.includes(node.data.model)
          ? node.data.model
          : catalog[0] ?? connection.model;
        return {
          ...node,
          data: {
            ...node.data,
            provider: connection.provider,
            model,
            protocol: connection.protocol,
            baseUrl: connection.baseUrl,
          },
        };
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
        model: connection
          ? preferredModel(catalogOf(connection)) || connection.model
          : preset?.model ?? 'openai-compatible',
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

  /**
   * One-click adaptation: promote the current session's model to orchestrator
   * and wire the standard topology (orchestrator → workers, libraries →
   * orchestrator) so the board is ready to run without manual dragging.
   */
  const adaptToSession = () => {
    const primary = models.find((item) => item.status === 'ok') ?? models[0];
    if (!primary) {
      setToast('没有可用的模型连接：先在「模型连接」里配置一个');
      return;
    }

    const current = nodesRef.current;
    const existing =
      current.find((node) => node.id === orchestratorId) ??
      current.find((node) => node.data?.kind === 'orchestrator');
    const targetId = existing?.id ?? 'session-orchestrator';
    const palette = '#f59e0b';

    if (existing) {
      setNodes((all) =>
        all.map((node) =>
          node.id === targetId
            ? {
                ...node,
                data: {
                  ...node.data,
                  name: node.data.name === '主控' ? `当前会话 · ${primary.label}` : node.data.name,
                  provider: primary.provider,
                  model: primary.model,
                  connectionId: primary.id,
                  protocol: primary.protocol,
                  baseUrl: primary.baseUrl,
                  status: 'idle',
                  metric: '已适配当前会话',
                },
              }
            : node
        )
      );
    } else {
      setNodes((all) => [
        ...all,
        {
          id: targetId,
          type: 'agent',
          position: { x: 60, y: 460 },
          data: {
            name: `当前会话 · ${primary.label}`,
            role: '当前会话的主控：拆解目标、分派与验收',
            provider: primary.provider,
            model: primary.model,
            effort: 'medium',
            status: 'idle',
            kind: 'orchestrator',
            accent: palette,
            metric: 'ready',
            connectionId: primary.id,
            protocol: primary.protocol,
            baseUrl: primary.baseUrl,
          },
        } as StudioNode,
      ]);
    }
    setOrchestratorId(targetId);

    const workers = current.filter(
      (node) =>
        node.id !== targetId &&
        (node.data.kind === 'agent' || node.data.kind === 'orchestrator') &&
        node.data.model &&
        node.data.model !== 'library'
    );
    const libraries = current.filter((node) => node.data.kind === 'library');

    const edgeStyle = { fill: '#8b98a8', fontSize: 9.5 } as const;
    const edgeBg = { fill: '#0e1318', fillOpacity: 0.92 } as const;
    setEdges((existingEdges) => {
      const next = [...existingEdges];
      const linked = (a: string, b: string) =>
        next.some(
          (edge) => (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a)
        );
      for (const worker of workers) {
        if (linked(targetId, worker.id)) continue;
        next.push({
          id: `adapt-${targetId}-${worker.id}`,
          source: targetId,
          target: worker.id,
          type: 'smoothstep',
          animated: true,
          label: '任务',
          data: { kind: 'assign' },
          style: { stroke: '#6366f1', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          labelStyle: edgeStyle,
          labelBgStyle: edgeBg,
        } as Edge);
      }
      for (const library of libraries) {
        if (linked(library.id, targetId)) continue;
        next.push({
          id: `adapt-${library.id}-${targetId}`,
          source: library.id,
          target: targetId,
          type: 'smoothstep',
          animated: true,
          label: '公共文件',
          data: { kind: 'context' },
          style: { stroke: '#38d9c2', strokeWidth: 1.5, dasharray: '6 4' },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          labelStyle: edgeStyle,
          labelBgStyle: edgeBg,
        } as Edge);
      }
      return next;
    });

    setToast(`已适配：主控 = ${primary.label}（${primary.model}）· 连接 ${workers.length} 个工作节点`);
    push(targetId, 'assistant', `已一键适配：我（${primary.label} · ${primary.model}）是当前会话的主控。点「运行编排」即可开始；也可以先拖入更多节点。`);
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
    // 必须通知服务端：只改界面等于让运行在后台继续烧额度。
    const activeRun = activeRunIdRef.current;
    if (activeRun) {
      void fetch('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: `stop-${Date.now()}`,
          type: 'run.stop',
          payload: { runId: activeRun },
        }),
      }).catch(() => undefined);
      activeRunIdRef.current = '';
    }
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
    activeRunIdRef.current = runId;
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

    on('search.used', (event) => {
      const payload = JSON.parse(event.data) as {
        event: { nodeId: string; taskId: string; query: string; hits: number };
      };
      patchNode(payload.event.nodeId, { metric: `联网检索 · ${payload.event.hits} 条` });
      push(
        payload.event.nodeId,
        'assistant',
        `联网检索「${payload.event.query}」：${payload.event.hits} 条结果已交给模型。`
      );
    });

    on('tool.called', (event) => {
      const payload = JSON.parse(event.data) as {
        event: {
          nodeId: string;
          taskId: string;
          tool: string;
          args: string;
          ok: boolean;
          ms: number;
          preview: string;
        };
      };
      const call = payload.event;
      if (!call.nodeId) return;
      patchNode(call.nodeId, { metric: `工具 ${call.tool} · ${call.ok ? '成功' : '失败'}` });
      push(
        call.nodeId,
        'assistant',
        `调用工具 ${call.tool}（${call.ms}ms）：${call.ok ? '成功' : '失败'}${
          call.preview ? ` · ${call.preview.slice(0, 160)}` : ''
        }`
      );
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
      // 进度条切到完成态：用真实结束时间算总耗时，并且不再走计时器。
      setRecentEndedAt(Date.now());
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
      // 失败时拉取归因与重试进度：运行条上必须看得见为什么失败、还能不能重试。
      if (payload.event.status !== 'done') {
        void fetch(`/api/runs/${runId}/result`)
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { failureSummary?: RunFailureInfo | null } | null) => {
            if (body?.failureSummary) setFailureInfo(body.failureSummary);
          })
          .catch(() => undefined);
        // 顺便把环境诊断拉下来：工作目录、模型 Key、可用的重跑方式。
        window.setTimeout(() => void loadDiagnosis(runId), 600);
      } else {
        setFailureInfo(null);
        setDiagnosis(null);
        // 跑完后服务端会把项目真的启动一次做用户视角验收；结果稍后到。
        for (const delay of [6000, 20000, 45000, 80000]) {
          window.setTimeout(() => void refreshUserView(), delay);
        }
      }
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

  /** 读一次失败运行的环境诊断：失败原因和「怎么重跑」都从这一个接口来。 */
  const loadDiagnosis = async (runId: string) => {
    setDiagnosisBusy(true);
    try {
      const response = await fetch(`/api/runs/${runId}/diagnosis`, {
        headers: { 'x-qiansi-workspace': currentWorkspace() },
      });
      if (!response.ok) return;
      const body = (await response.json()) as RunDiagnosis;
      if (body?.ok) setDiagnosis(body);
    } catch {
      // 诊断失败不影响失败总结本身
    } finally {
      setDiagnosisBusy(false);
    }
  };

  /**
   * 主动重跑：resume 断点续跑（只跑没产出的任务），fresh 按当前画布整轮重跑。
   * 已有运行在跑时服务端会排队，这里照常把结果说清楚。
   */
  const rerunRun = async (mode: 'resume' | 'fresh') => {
    const previous = diagnosis?.runId ?? runSummary?.runId;
    if (!previous) {
      setToast('找不到可重跑的运行');
      return;
    }
    setRerunBusy(true);
    try {
      const response = await fetch(`/api/runs/${previous}/rerun`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-qiansi-workspace': currentWorkspace(),
        },
        body: JSON.stringify({ mode }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; runId?: string | null; queued?: boolean; hint?: string; error?: string; missing?: string[] }
        | null;
      if (!response.ok || !data?.ok) {
        setToast(
          `重跑失败：${data?.error ?? `HTTP ${response.status}`}${
            data?.missing?.length ? `（缺 Key：${data.missing.join('、')}）` : ''
          }`
        );
        return;
      }
      if (!data.runId) {
        // 排队：当前运行结束后自动开跑，不清掉界面上的失败信息。
        setToast(data.hint ?? '已排队，等当前运行结束后自动开始');
        return;
      }
      setFailureInfo(null);
      setDiagnosis(null);
      setRunning(true);
      runTasksRef.current = {};
      setRunTasks({});
      setRunTokens(0);
      runEventCount.current = 0;
      runStartedAt.current = Date.now();
      setRecentEndedAt(0);
      subscribeToRun(data.runId);
    } catch {
      setToast('重跑请求失败');
    } finally {
      setRerunBusy(false);
    }
  };

  /** 修环境：启用一个被停用的厂商，然后刷新诊断。 */
  const enableModelSlot = async (slot: string) => {
    try {
      const policyResponse = await fetch('/api/model-policy');
      const policy = (await policyResponse.json().catch(() => null)) as
        | { disabledSlots?: string[] }
        | null;
      const disabledSlots = (policy?.disabledSlots ?? []).filter((item) => item !== slot);
      const saved = await fetch('/api/model-policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabledSlots }),
      });
      if (!saved.ok) {
        setToast('启用失败');
        return;
      }
      setToast(`已启用 ${slot}；重跑会使用它`);
      if (diagnosis) void loadDiagnosis(diagnosis.runId);
    } catch {
      setToast('启用请求失败');
    }
  };

  /** 修环境：把画布工作目录改到一个存在的目录。 */
  const fixRootDir = async (path: string) => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(currentWorkspace())}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootDir: path }),
      });
      if (!response.ok) {
        setToast('工作目录无效：目录不存在或写不进去');
        return;
      }
      setToast('工作目录已更新');
      if (diagnosis) void loadDiagnosis(diagnosis.runId);
    } catch {
      setToast('保存工作目录失败');
    }
  };

  /** 现在就跑一次用户视角验收：真实启动项目、截图、逐项检查。 */
  const runUserViewNow = async () => {
    setUserViewBusy(true);
    try {
      const response = await fetch('/api/user-view', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-qiansi-workspace': currentWorkspace(),
        },
        body: JSON.stringify({ runId: runSummary?.runId ?? diagnosis?.runId ?? undefined }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; report?: UserViewReport; error?: string; reason?: string }
        | null;
      if (!response.ok || !body?.report) {
        setToast(`用户视角验收失败：${body?.reason ?? body?.error ?? `HTTP ${response.status}`}`);
        return;
      }
      setUserView(body.report);
      setUserViewOpen(true);
      setToast(body.report.summary);
    } catch {
      setToast('用户视角验收请求失败');
    } finally {
      setUserViewBusy(false);
    }
  };

  /** 运行成功后服务端会自动验收：轮询最新结果，不打断用户。 */
  const refreshUserView = async () => {
    try {
      const response = await fetch(
        `/api/user-view/latest?ws=${encodeURIComponent(currentWorkspace())}`
      );
      if (!response.ok) return;
      const body = (await response.json()) as { report?: UserViewReport | null };
      if (body.report) {
        const report = body.report;
        setUserView((current) => (!current || report.at >= current.at ? report : current));
      }
    } catch {
      // 没验收结果不影响运行条
    }
  };

  /**
   * Push the board exactly as it is on screen. Saving is debounced by 800ms, so
   * without this a run started right after an edit would execute the previous
   * revision — or be refused as unrunnable when the saved copy is stale.
   */
  const flushCanvas = async (): Promise<'ok' | 'conflict' | 'error'> => {
    if (!canvasReady.current) return 'error';
    const nodesPayload = nodesRef.current
      .filter((node) => node.id !== '__final__')
      .map((node) => {
        const {
          onDelete: _onDelete,
          onMakeOrchestrator: _onMakeOrchestrator,
          onOpen: _onOpen,
          onOpenSession: _onOpenSession,
          ...data
        } = node.data as AgentNodeData & { onOpenSession?: unknown };
        return { ...node, data };
      });
    const edgesPayload = edgesRef.current
      .filter((edge) => edge.id !== '__final-edge')
      .map((edge) => ({
        ...edge,
        data: edge.data ? { ...(edge.data as Record<string, unknown>), onOpen: undefined } : edge.data,
      }));
    try {
      const response = await fetch('/api/canvas', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orchestratorId,
          nodes: nodesPayload,
          edges: edgesPayload,
          revision: canvasRevision.current,
        }),
      });
      const data = (await response.json().catch(() => null)) as { revision?: number } | null;
      if (response.status === 409) return 'conflict';
      if (response.ok && typeof data?.revision === 'number') {
        canvasRevision.current = data.revision;
        dirty.current = false;
        return 'ok';
      }
      return 'error';
    } catch {
      return 'error';
    }
  };

  /**
   * 画布顶栏的「重载」按钮：先把未保存的编辑落盘，再整页刷新。
   * 整页刷新会重新拉取界面代码与画布数据——版本更新或页面状态异常时，
   * 点这一下就是完全换血，不依赖任何外部刷新手段。
   */
  const reloadCanvas = async () => {
    await flushCanvas();
    window.location.reload();
  };

  const run = async (goalOverride?: string) => {
    if (running) return;
    setRunning(true);
    setChoice(null);
    resetRunState();
    runStartedAt.current = Date.now();
    setRecentEndedAt(0);
    recentOnlyRef.current = false;
    patchNode(orchestratorId, { status: 'running', metric: '规划中…' });
    push(orchestratorId, 'assistant', '已按当前画布提交运行。');
    const flushed = await flushCanvas();
    if (flushed === 'conflict') {
      setRunning(false);
      patchNode(orchestratorId, { status: 'idle', metric: '未运行' });
      push(
        orchestratorId,
        'assistant',
        '画布刚被外部修改（可能来自 agent），已同步到最新版本。请确认画布后再点一次运行。'
      );
      return;
    }
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
              moonshot: credentialFor('moonshot'),
              zhipu: credentialFor('bigmodel'),
              qwen: credentialFor('dashscope'),
              openai: credentialFor('api.openai.com'),
              relay: credentialFor('127.0.0.1'),
            },
            budget: {
              maxTotalTokens: settings.maxTokensPerRun,
              maxTokensPerMinute: settings.maxTokensPerMinute,
            },
            goal: goalOverride?.trim() || undefined,
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
      if (response.status === 422) {
        // the canvas itself is not runnable — say why instead of silently
        // falling back to a demo that looks like it worked
        let reasons: string[] = [];
        try {
          const parsed = (await response.json()) as { reasons?: string[] };
          reasons = Array.isArray(parsed.reasons) ? parsed.reasons : [];
        } catch {
          // keep the generic reason below
        }
        setRunning(false);
        patchNode(orchestratorId, { status: 'idle', metric: '未运行' });
        push(
          orchestratorId,
          'assistant',
          `画布还不能运行：\n${reasons.map((reason) => `· ${reason}`).join('\n') || '· 缺少可执行的节点或主控'}`
        );
        return;
      }
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { runId: string };
      subscribeToRun(data.runId);
    } catch {
      setRunning(false);
      push(orchestratorId, 'assistant', '真实运行启动失败（服务或凭据不可用），切换到本地演示。');
      await runLocalDemo();
    }
  };

  /**
   * 刷新或切换画布后从服务端恢复「本轮结果」：runSummary 只活在内存里，
   * 以前一刷新按钮就永久置灰，明明运行记录还在。
   */
  const historyHydratedRef = useRef(false);
  useEffect(() => {
    if (historyHydratedRef.current) return;
    historyHydratedRef.current = true;
    void (async () => {
      try {
        const listResponse = await fetch('/api/runs');
        if (!listResponse.ok) return;
        const list = (await listResponse.json()) as {
          items?: Array<{ runId: string; status: string; workspaceId?: string; startedAt: number }>;
        };
        const workspace = currentWorkspace() || 'main';
        const latest = (list.items ?? []).find((item) => (item.workspaceId ?? 'main') === workspace);
        if (!latest) return;
        const resultResponse = await fetch(`/api/runs/${latest.runId}/result`);
        if (!resultResponse.ok) return;
        const result = (await resultResponse.json()) as {
          status?: string;
          usage?: { total?: number };
          tasks?: Array<{ taskId?: string; id?: string; nodeId?: string; title?: string; status: string; output?: string }>;
          events?: number;
          failureSummary?: RunFailureInfo | null;
        };
        if (runningRef.current || runTasksRef.current && Object.keys(runTasksRef.current).length > 0) return;
        const tasks: Record<string, RunTaskView> = {};
        for (const task of result.tasks ?? []) {
          const taskId = task.taskId ?? (task as { id?: string }).id ?? '';
          if (!taskId) continue;
          tasks[taskId] = {
            taskId,
            nodeId: task.nodeId ?? '',
            title: task.title,
            status: (['done', 'failed'].includes(task.status) ? task.status : 'pending') as RunTaskView['status'],
            output: task.output,
          };
        }
        const values = Object.values(tasks);
        setRunSummary({
          runId: latest.runId,
          status: (latest.status === 'done' ? 'done' : latest.status === 'failed' ? 'failed' : 'aborted') as RunSummary['status'],
          total: values.length,
          passed: values.filter((task) => task.status === 'done').length,
          needsHuman: 0,
          events: result.events ?? 0,
          durationMs: 0,
          tokens: result.usage?.total ?? 0,
        });
        runTasksRef.current = tasks;
        setRunTasks(tasks);
        setFailureInfo(result.failureSummary ?? null);
        if (result.failureSummary) void loadDiagnosis(latest.runId);
      } catch {
        // 历史恢复失败不影响当前界面
      }
    })();
  }, []);

  /**
   * 打开面板或刷新后，把这张画布最近一次用户视角验收显示出来：
   * 服务端在运行结束后会自动补一次，刷新不该让证据消失。
   */
  useEffect(() => {
    void refreshUserView();
  }, []);

  /** 读取这张画布的团队名册：工具栏徽标与节点指派都靠它。 */
  useEffect(() => {
    void fetch('/api/team')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { ok?: boolean; team?: TeamDoc } | null) => {
        if (body?.team) setTeam(body.team);
      })
      .catch(() => undefined);
  }, []);

  const send = async (nodeId: string, text: string) => {
    push(nodeId, 'user', text);
    // Talking to the orchestrator is how a session starts: it plans, hands out
    // work and accepts the result — the same order a conversation follows.
    // 降级必须说出来：运行中发消息会变成普通对话，不说用户就以为接管坏了。
    const takeover = decideTakeover({
      autoOrchestrate: settings.autoOrchestrate,
      isOrchestrator: nodeId === orchestratorId,
      running,
    });
    if (takeover.action === 'run') {
      await run(text);
      return;
    }
    if (takeover.action === 'chat-downgraded') {
      push(
        nodeId,
        'assistant',
        '已开启自动编排，但上一轮运行还在进行中，这条消息先按普通对话回复；等它结束后再发一次，就会触发完整编排。'
      );
    }
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
          webSearch: node?.webSearch === true,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        text?: string;
        error?: string;
        searches?: Array<{ query: string; hits: number }>;
      };
      if (!response.ok || !data.ok) throw new Error(data.error ?? 'chat_failed');
      const searched = data.searches?.length
        ? `\n\n（联网检索：${data.searches.map((item) => `${item.query}（${item.hits} 条）`).join('；')}）`
        : '';
      push(nodeId, 'assistant', (data.text?.trim() || '（模型没有返回内容）') + searched);
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
            onOpenArtifact: node.data.output ? () => openArtifactFromNode(node) : undefined,
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
        onClearCanvas={() => setClearConfirmOpen(true)}
        onExport={() => window.open(`/api/canvas/export?ws=${encodeURIComponent(currentWorkspace())}`, '_blank')}
        onOpenWorkflow={() => setWorkflowOpen(true)}
        onAdapt={adaptToSession}
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
        onOpenKeys={() => setKeysOpen(true)}
        attentionCount={attentionCount}
        onOpenAttention={() => setAttentionOpen(true)}
        onOpenSelfOpt={() => setSelfOptOpen(true)}
        onOpenHandoff={() => setHandoffOpen(true)}
        onOpenTeam={() => setTeamOpen(true)}
        teamCount={team?.members.length ?? 0}
        onAutoLayout={() => void autoLayout()}
        layouting={layouting}
        brushMode={brushMode}
        onBrushMode={setBrushMode}
        onReload={() => void reloadCanvas()}
      />

      <div className="workspace-row">
        <WorkspaceSwitcher
          onCanvasStarted={(name) => setToast(`新画布「${name}」已开跑，点标签页看进度`)}
        />
      </div>

      <div className="workspace">
        <div className="canvas-wrap" ref={canvasWrapRef}>
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
          <RunProgress
            tasks={Object.values(runTasks)}
            running={running || externalRun}
            startedAt={runStartedAt.current}
            endedAt={recentEndedAt}
            tokens={runTokens}
            failure={failureInfo}
            diagnosis={diagnosis}
            diagnosisBusy={diagnosisBusy}
            rerunBusy={rerunBusy}
            userViewBusy={userViewBusy}
            userView={userView}
            onRetry={() => void rerunRun('resume')}
            onRerun={(mode) => void rerunRun(mode)}
            onDiagnose={() => {
              const id = diagnosis?.runId ?? runSummary?.runId;
              if (id) void loadDiagnosis(id);
            }}
            onEnableModel={(slot) => void enableModelSlot(slot)}
            onFixRootDir={(path) => void fixRootDir(path)}
            onUserView={() => void runUserViewNow()}
            onOpenUserView={() => setUserViewOpen(true)}
            onOpenReport={running || externalRun ? undefined : () => setReportOpen(true)}
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
            team={team?.members}
            onMemberChange={(memberId, memberName) => {
              if (selectedNode) patchNode(selectedNode.id, { memberId, memberName });
            }}
            onClose={() => setSelection(null)}
            onSend={(text) => {
              if (drawer.mode === 'node' && selectedNode) {
                send(selectedNode.id, text);
              } else {
                // 吞掉输入不回话，用户会以为整条链路都坏了。
                setToast('这是连线会话（只读）。点一个节点再发消息。');
              }
            }}
            onEffortChange={(effort) => {
              if (selectedNode) changeEffort(selectedNode.id, effort);
            }}
            onModelChange={(connectionId, model) => {
              if (selectedNode) handleModelChange(selectedNode.id, connectionId, model);
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
            models={models}
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
        onApplyPreferred={applyPreferredModels}
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

      <UserViewModal
        open={userViewOpen}
        report={userView}
        busy={userViewBusy}
        onClose={() => setUserViewOpen(false)}
        onRecheck={() => void runUserViewNow()}
      />

      <ApprovalsModal open={approvalsOpen} onClose={() => setApprovalsOpen(false)} />
      <AttentionModal open={attentionOpen} onClose={() => setAttentionOpen(false)} />
      <SelfOptModal open={selfOptOpen} onClose={() => setSelfOptOpen(false)} />
      <KeysModal open={keysOpen} onClose={() => setKeysOpen(false)} />
      <HandoffModal open={handoffOpen} onClose={() => setHandoffOpen(false)} defaultSource={settings.agent} />

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

      <ConfirmDialog
        open={clearConfirmOpen}
        title="清空画板？"
        detail="所有节点、连线、运行状态和对话记录会被移除；模型连接、设置和已上传的文件保留。"
        confirmLabel="清空"
        onConfirm={clearCanvas}
        onCancel={() => setClearConfirmOpen(false)}
      />

      <WorkflowModal
        open={workflowOpen}
        models={models}
        team={team?.members}
        playbook={team?.playbook}
        onClose={() => setWorkflowOpen(false)}
        onUploadFiles={uploadFilesForWorkflow}
        onApply={applyWorkflow}
      />

      <TeamModal
        open={teamOpen}
        models={models}
        onClose={() => setTeamOpen(false)}
        onSaved={(doc) => setTeam(doc)}
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
