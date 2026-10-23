import type { Edge } from '@xyflow/react';
import type { StudioNode } from './demoGraph';

export interface LayoutPosition {
  x: number;
  y: number;
}

/**
 * Horizontal-first layered layout.
 *
 * The main chain is spread left-to-right by dependency depth (longest path,
 * with cycles ignored so review/retry wires cannot loop). Nodes that have no
 * wires at all are collected into a bottom row instead of being stacked in
 * column zero, which keeps the graph wide rather than tall.
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
  const stack = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (depth > 24 || stack.has(id)) return;
    const current = level.get(id);
    if (current !== undefined && current >= depth) return;
    level.set(id, depth);
    stack.add(id);
    for (const target of outgoing.get(id) ?? []) visit(target, depth + 1);
    stack.delete(id);
  };

  const roots = candidates.filter((node) => (incoming.get(node.id) ?? []).length === 0);
  const start =
    orchestratorId && ids.has(orchestratorId) ? orchestratorId : roots[0]?.id;
  if (start) visit(start, 0);
  for (const root of roots) visit(root.id, 0);
  for (const node of candidates) {
    if (!level.has(node.id)) visit(node.id, 0);
  }

  const isolated = candidates.filter(
    (node) =>
      (incoming.get(node.id) ?? []).length === 0 &&
      (outgoing.get(node.id) ?? []).length === 0
  );
  const isolatedIds = new Set(isolated.map((node) => node.id));

  const columns = new Map<number, StudioNode[]>();
  for (const node of candidates) {
    if (isolatedIds.has(node.id)) continue;
    const column = level.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }

  const positions: Record<string, LayoutPosition> = {};
  let tallest = 1;
  for (const [column, list] of columns) {
    list.sort((a, b) => (a.data.name ?? a.id).localeCompare(b.data.name ?? b.id));
    tallest = Math.max(tallest, list.length);
    list.forEach((node, index) => {
      positions[node.id] = {
        x: 100 + column * 400,
        y: 100 + index * 170,
      };
    });
  }

  isolated
    .sort((a, b) => (a.data.name ?? a.id).localeCompare(b.data.name ?? b.id))
    .forEach((node, index) => {
      positions[node.id] = {
        x: 100 + index * 320,
        y: 100 + tallest * 170 + 140,
      };
    });

  return positions;
}
