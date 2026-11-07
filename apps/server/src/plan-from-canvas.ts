import { isConversationStyle, suggestStyle, type CapabilityProfile, type Effort, type Plan, type Subtask } from '@qiansi/engine';
import type { CanvasDocument, CanvasNode } from './canvas.js';
import { filesForTask, type CanvasFileText } from './canvas-files.js';
import { profileForModel, resolveModelRoute, type KeySlot } from './model-catalog.js';

const MAX_SUBTASKS = 8;

const DEFAULT_ACCEPTANCE =
  '紧扣任务目标，给出可直接使用的完整答案；不确定的地方明确标注，不编造来源或数字。';

const NON_WORKER_KINDS = new Set(['region', 'library', 'file', 'artifact']);

function asEffort(value: unknown): Effort {
  return value === 'low' || value === 'high' || value === 'max' || value === 'off'
    ? value
    : 'medium';
}

function workerNodes(document: CanvasDocument): CanvasNode[] {
  return document.nodes.filter((node) => {
    const data = node.data ?? {};
    if (NON_WORKER_KINDS.has(String(data.kind ?? ''))) return false;
    const model = String(data.model ?? '').trim();
    return Boolean(model) && model !== 'library' && model !== 'file';
  });
}

/**
 * The node only declares the model; the catalog decides which key slot serves
 * it. A node's provider string is a tie-breaker for unknown ids, never the
 * source of truth — one key calls a whole family of models.
 */
function routeOf(node: CanvasNode): { slot: KeySlot; route: ReturnType<typeof resolveModelRoute> } {
  const data = node.data ?? {};
  const route = resolveModelRoute(String(data.model ?? ''), String(data.provider ?? ''));
  return { slot: route.slot, route };
}

function diagnoseReasons(document: CanvasDocument): string[] {
  const workers = workerNodes(document);
  const reasons: string[] = [];
  if (workers.length === 0) {
    reasons.push('画布上还没有带模型的节点');
  } else if (workers.length === 1) {
    reasons.push('至少需要两个带模型的节点：一个主控 + 至少一个执行');
  } else if (
    !document.orchestratorId ||
    !workers.some((node) => node.id === document.orchestratorId)
  ) {
    reasons.push('还没有设置主控模型（右键节点 → 设为主控）');
  }
  return reasons;
}

/**
 * Explains why a canvas cannot run, in words a user can act on. Kept separate
 * from buildPlanFromCanvas so the HTTP layer can return the reasons instead of
 * silently falling back to a built-in demo.
 */
export function diagnoseCanvas(document: CanvasDocument): {
  runnable: boolean;
  reasons: string[];
} {
  const reasons = diagnoseReasons(document);
  return { runnable: reasons.length === 0, reasons };
}

/**
 * Turns the canvas into something the engine can actually run: every worker
 * node becomes a capability profile, and the wires out of the orchestrator
 * become subtasks.
 *
 * Returns null when the canvas is not runnable, so the caller can refuse the
 * run (or, for demos only, fall back) instead of pretending the drawing ran.
 */
export function buildPlanFromCanvas(
  document: CanvasDocument,
  goal: string,
  options: { files?: CanvasFileText[] } = {}
): {
  plan: Plan;
  profiles: CapabilityProfile[];
  slotByProfile: Map<string, KeySlot>;
} | null {
  if (diagnoseReasons(document).length > 0) return null;

  const workers = workerNodes(document);
  const byId = new Map(workers.map((node) => [node.id, node]));
  const orchestratorId =
    document.orchestratorId && byId.has(document.orchestratorId)
      ? document.orchestratorId
      : null;
  // diagnoseCanvas() reports "no orchestrator" as its own reason; returning null
  // here keeps the two in agreement, so the 422 actually fires instead of a
  // plan quietly treating every model node as a worker.
  if (!orchestratorId) return null;

  const ordered = [
    orchestratorId,
    ...workers.filter((node) => node.id !== orchestratorId).map((node) => node.id),
  ];
  const targets = ordered
    .filter((id) => id !== orchestratorId)
    .slice(0, MAX_SUBTASKS);
  if (!targets.length) return null;

  const laneId = new Map<string, string>();
  targets.forEach((nodeId, index) => laneId.set(nodeId, `C${index + 1}`));
  const laneIndex = new Map<string, number>();
  targets.forEach((nodeId, index) => laneIndex.set(nodeId, index));

  const runGoal = goal.trim() || '按画布上的分工完成这次任务';

  const subtasks: Subtask[] = targets.map((nodeId, index) => {
    const node = byId.get(nodeId)!;
    const data = node.data ?? {};
    const lane = laneId.get(nodeId)!;
    const here = laneIndex.get(nodeId)!;
    // Only depend on lanes that come earlier in the order we produced them, so
    // a back-edge in the drawing can never create a cycle in the scheduler.
    const dependsOn = [
      ...new Set(
        document.edges
          .filter(
            (edge) =>
              edge.target === nodeId &&
              laneId.has(edge.source) &&
              (laneIndex.get(edge.source) ?? 0) < here
          )
          .map((edge) => laneId.get(edge.source)!)
      ),
    ];

    return {
      id: lane,
      title: String(data.name ?? data.role ?? nodeId),
      description: [
        data.role ? `你的角色：${String(data.role)}` : '',
        `总目标：${runGoal}`,
        filesForTask(options.files ?? [], index, targets.length),
        '只输出最终答案，不要展示思考过程。',
      ]
        .filter(Boolean)
        .join('\n'),
      assignedNodeId: nodeId,
      profileId: `canvas-${nodeId}`,
      effort: asEffort(data.effort),
      acceptanceCriteria: DEFAULT_ACCEPTANCE,
      style: isConversationStyle(data.style)
        ? data.style
        : suggestStyle(`${String(data.name ?? "")} ${String(data.role ?? "")}`),
      machineCheckable: false,
      dependsOn,
      status: 'pending',
      attempts: 0,
    };
  });

  const profiles = targets.map((nodeId) => ({
    // Keep the plan-scoped id: subtasks reference profiles by canvas node, and
    // the run assigns each profile its key by that same id.
    ...profileForModel(
      String(byId.get(nodeId)!.data?.model ?? ''),
      String(byId.get(nodeId)!.data?.name ?? '')
    ),
    id: `canvas-${nodeId}`,
  }));
  const slotByProfile = new Map(
    targets.map((nodeId) => [`canvas-${nodeId}`, routeOf(byId.get(nodeId)!).slot])
  );

  return {
    profiles,
    slotByProfile,
    plan: {
      goal: runGoal,
      rationale: `由画布生成：${subtasks.length} 个执行节点，主控 ${orchestratorId ?? '（未设置，按顺序推进）'}。`,
      subtasks,
    },
  };
}
