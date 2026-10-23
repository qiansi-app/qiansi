import type { Edge } from '@xyflow/react';
import type { StudioNode } from './demoGraph';

export interface LayoutPosition {
  x: number;
  y: number;
}

/**
 * Deterministic layered layout used when the orchestrator model is unavailable
 * or returns unusable coordinates. Pure geometry: no provider calls.
 */
export function layeredLayout(
  nodes: StudioNode[],
  edges: Edge[],
  orchestratorId: string | null
): Record<string, LayoutPosition> {
  const candidates = nodes.filter(
    (node) => node.type !== 'region' && !node.parentId && !node.data.hidden
  );
  const ids = new Set(candidates.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  const roots = candidates.filter((node) => (incoming.get(node.id) ?? []).length === 0);
  const start = orchestratorId && ids.has(orchestratorId) ? orchestratorId : roots[0]?.id;
  if (start) {
    level.set(start, 0);
    queue.push(start);
  }
  for (const root of roots) {
    if (!level.has(root.id)) {
      level.set(root.id, 0);
      queue.push(root.id);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const next = (level.get(current) ?? 0) + 1;
    for (const target of outgoing.get(current) ?? []) {
      // Workflows can contain review/retry edges that point backwards; only
      // assign a level on first visit so cycles cannot escalate forever.
      if (!level.has(target)) {
        level.set(target, next);
        queue.push(target);
      }
    }
  }
  for (const node of candidates) {
    if (!level.has(node.id)) level.set(node.id, 0);
  }

  const columns = new Map<number, StudioNode[]>();
  for (const node of candidates) {
    const column = level.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }

  const positions: Record<string, LayoutPosition> = {};
  const columnHeight = [...columns.values()].reduce(
    (max, list) => Math.max(max, list.length),
    1
  );
  for (const [column, list] of columns) {
    list.sort((a, b) => (a.data.name ?? a.id).localeCompare(b.data.name ?? b.id));
    list.forEach((node, index) => {
      const offset = (list.length - columnHeight) / 2;
      positions[node.id] = {
        x: 80 + column * 360,
        y: 80 + (index + offset) * 200,
      };
    });
  }
  return positions;
}
