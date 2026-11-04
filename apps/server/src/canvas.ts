import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CanvasNodeData {
  kind?: string;
  name?: string;
  role?: string;
  provider?: string;
  model?: string;
  effort?: string;
  status?: string;
  accent?: string;
  metric?: string;
  connectionId?: string;
  taskId?: string;
  output?: string;
  hidden?: boolean;
  regionMode?: string;
  [key: string]: unknown;
}

export interface CanvasNode {
  id: string;
  type?: string;
  position?: { x?: number; y?: number };
  data?: CanvasNodeData;
  parentId?: string;
  width?: number;
  height?: number;
  style?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  data?: { kind?: string; artifact?: { taskId?: string; output?: string } };
  [key: string]: unknown;
}

export interface CanvasDocument {
  version: number;
  revision: number;
  savedAt: number;
  orchestratorId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type CanvasOp =
  | { op: 'add_node'; node: CanvasNode }
  | { op: 'remove_node'; id: string }
  | { op: 'update_node'; id: string; patch: Partial<CanvasNodeData> }
  | { op: 'move_node'; id: string; x: number; y: number }
  | { op: 'add_edge'; edge: Partial<CanvasEdge> & { source: string; target: string } }
  | { op: 'remove_edge'; id: string }
  | { op: 'set_orchestrator'; id: string }
  | { op: 'clear' };

export class CanvasConflict extends Error {
  readonly serverRevision: number;
  readonly serverDocument: CanvasDocument;

  constructor(serverDocument: CanvasDocument) {
    super('canvas_conflict');
    this.name = 'CanvasConflict';
    this.serverRevision = serverDocument.revision;
    this.serverDocument = serverDocument;
  }
}

const MAX_NODES = 300;
const MAX_EDGES = 600;
const MAX_PAYLOAD = 5 * 1024 * 1024;

function emptyDocument(): CanvasDocument {
  return {
    version: 1,
    revision: 0,
    savedAt: 0,
    orchestratorId: '',
    nodes: [],
    edges: [],
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Normalises whatever is on disk into a document the rest of the app can trust.
 * A corrupt file becomes an empty canvas rather than an error, because a broken
 * canvas must never block the app from starting.
 */
function normalize(raw: unknown): CanvasDocument {
  if (!raw || typeof raw !== 'object') return emptyDocument();
  const source = raw as Record<string, unknown>;
  const nodes = Array.isArray(source.nodes) ? (source.nodes as CanvasNode[]) : [];
  const edges = Array.isArray(source.edges) ? (source.edges as CanvasEdge[]) : [];
  return {
    version: Number(source.version) || 1,
    revision: Number(source.revision) || 0,
    savedAt: Number(source.savedAt) || 0,
    orchestratorId: asString(source.orchestratorId),
    nodes: nodes.filter((node) => node && typeof node === 'object' && typeof node.id === 'string'),
    edges: edges.filter(
      (edge) =>
        edge &&
        typeof edge === 'object' &&
        typeof edge.id === 'string' &&
        typeof edge.source === 'string' &&
        typeof edge.target === 'string'
    ),
  };
}

export class CanvasStore {
  private readonly file: string;
  /** Highest revision ever committed; survives file loss or corruption. */
  private readonly revisionFile: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, 'canvas.json');
    this.revisionFile = join(stateDir, 'canvas.revision');
    mkdirSync(stateDir, { recursive: true });
  }

  private readFloor(): number {
    try {
      const value = Number(readFileSync(this.revisionFile, 'utf8').trim());
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  private bumpFloor(revision: number): void {
    try {
      writeFileSync(this.revisionFile, String(revision), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // a missing floor only costs strict monotonicity, never data
    }
  }

  read(): CanvasDocument {
    if (!existsSync(this.file)) return emptyDocument();
    let document: CanvasDocument;
    try {
      document = normalize(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return emptyDocument();
    }
    // A truncated or replaced file must not look older than it is, or every
    // client's optimistic lock silently resets.
    const floor = this.readFloor();
    if (document.revision < floor) document.revision = floor;
    return document;
  }

  /**
   * Full write. `baseRevision` turns this into a compare-and-swap so two writers
   * (the studio and an agent) cannot silently overwrite each other.
   */
  write(input: {
    orchestratorId?: string;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    baseRevision?: number;
  }): CanvasDocument {
    const current = this.read();
    if (
      typeof input.baseRevision === 'number' &&
      current.revision > 0 &&
      input.baseRevision !== current.revision
    ) {
      throw new CanvasConflict(current);
    }
    const next: CanvasDocument = {
      version: 1,
      revision: current.revision + 1,
      savedAt: Date.now(),
      orchestratorId: input.orchestratorId ?? current.orchestratorId,
      nodes: input.nodes.slice(0, MAX_NODES),
      edges: input.edges.slice(0, MAX_EDGES),
    };
    this.persist(next);
    return next;
  }

  /** Applies operator-level edits. Each op is independent; failures are collected. */
  apply(ops: CanvasOp[]): { document: CanvasDocument; applied: number; errors: string[] } {
    const document = this.read();
    const errors: string[] = [];
    let applied = 0;

    for (const [index, raw] of ops.entries()) {
      const op = raw as CanvasOp & { op?: string };
      try {
        switch (op?.op) {
          case 'add_node': {
            const node = (op as { node?: CanvasNode }).node;
            if (!node || typeof node.id !== 'string' || !node.id) {
              throw new Error('node.id is required');
            }
            if (document.nodes.some((item) => item.id === node.id)) {
              throw new Error(`node ${node.id} already exists`);
            }
            if (document.nodes.length >= MAX_NODES) throw new Error('node limit reached');
            document.nodes.push(node);
            break;
          }
          case 'remove_node': {
            const id = (op as { id?: string }).id;
            if (!id) throw new Error('id is required');
            const before = document.nodes.length;
            document.nodes = document.nodes.filter((item) => item.id !== id);
            if (document.nodes.length === before) throw new Error(`node ${id} not found`);
            document.edges = document.edges.filter(
              (edge) => edge.source !== id && edge.target !== id
            );
            if (document.orchestratorId === id) document.orchestratorId = '';
            break;
          }
          case 'update_node': {
            const { id, patch } = op as { id?: string; patch?: Partial<CanvasNodeData> };
            if (!id || !patch || typeof patch !== 'object') {
              throw new Error('id and patch are required');
            }
            const node = document.nodes.find((item) => item.id === id);
            if (!node) throw new Error(`node ${id} not found`);
            node.data = { ...(node.data ?? {}), ...patch };
            break;
          }
          case 'move_node': {
            const { id, x, y } = op as { id?: string; x?: number; y?: number };
            if (!id || !Number.isFinite(x) || !Number.isFinite(y)) {
              throw new Error('id, x and y are required');
            }
            const node = document.nodes.find((item) => item.id === id);
            if (!node) throw new Error(`node ${id} not found`);
            node.position = { x: Number(x), y: Number(y) };
            break;
          }
          case 'add_edge': {
            const edge = (op as { edge?: Partial<CanvasEdge> }).edge;
            if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
              throw new Error('edge.source and edge.target are required');
            }
            const known = new Set(document.nodes.map((item) => item.id));
            if (!known.has(edge.source) || !known.has(edge.target)) {
              throw new Error('edge endpoints must be existing nodes');
            }
            if (document.edges.length >= MAX_EDGES) throw new Error('edge limit reached');
            document.edges.push({
              ...edge,
              id: edge.id || `edge-${document.edges.length + 1}-${Date.now().toString(36)}`,
              source: edge.source,
              target: edge.target,
            });
            break;
          }
          case 'remove_edge': {
            const id = (op as { id?: string }).id;
            if (!id) throw new Error('id is required');
            const before = document.edges.length;
            document.edges = document.edges.filter((edge) => edge.id !== id);
            if (document.edges.length === before) throw new Error(`edge ${id} not found`);
            break;
          }
          case 'set_orchestrator': {
            const id = (op as { id?: string }).id;
            if (!id) throw new Error('id is required');
            if (!document.nodes.some((node) => node.id === id)) {
              throw new Error(`node ${id} not found`);
            }
            document.orchestratorId = id;
            break;
          }
          case 'clear': {
            document.nodes = [];
            document.edges = [];
            document.orchestratorId = '';
            break;
          }
          default:
            throw new Error(
              `unknown op "${String((op as { op?: string } | undefined)?.op ?? 'unknown')}"`
            );
        }
        applied += 1;
      } catch (error) {
        errors.push(`op[${index}] ${op?.op ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (applied === 0) {
      return { document, applied: 0, errors };
    }

    const next: CanvasDocument = {
      ...document,
      version: 1,
      revision: document.revision + 1,
      savedAt: Date.now(),
    };
    this.persist(next);
    return { document: next, applied, errors };
  }

  private persist(document: CanvasDocument): void {
    const payload = JSON.stringify(document);
    if (payload.length > MAX_PAYLOAD) throw new Error('canvas_too_large');
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
    this.bumpFloor(document.revision);
  }
}

/**
 * A run started by an agent has no window to draw into, so the server writes
 * each task's output back onto its node. Without this the board looks untouched
 * after the agent reports "跑完了".
 */
export function writeRunArtifacts(
  store: CanvasStore,
  plan: { subtasks: Array<{ id: string; assignedNodeId?: string }> },
  outputs: Record<string, string>,
  failed: boolean
): number {
  const ops: CanvasOp[] = [];
  for (const task of plan.subtasks ?? []) {
    if (!task.assignedNodeId) continue;
    const output = outputs?.[task.id];
    const hasOutput = typeof output === 'string' && output.trim().length > 0;
    // A successful task keeps its own result even when a later one failed; only
    // tasks that produced nothing get marked failed.
    if (!hasOutput && !failed) continue;
    ops.push({
      op: 'update_node',
      id: task.assignedNodeId,
      patch: hasOutput
        ? {
            output,
            // the card face shows a short excerpt; the full text stays in output
            artifact: output.trim().slice(0, 120),
            status: 'done',
            taskId: task.id,
          }
        : { status: 'failed', taskId: task.id },
    });
  }
  if (!ops.length) return 0;
  try {
    return store.apply(ops).applied;
  } catch {
    return 0;
  }
}

const EDGE_KIND_LABEL: Record<string, string> = {
  assign: '分派',
  handoff: '交接',
  review: '评审',
  context: '上下文',
};

function nodeLabel(node: CanvasNode): string {
  const data = node.data ?? {};
  return asString(data.name) || asString(data.role) || node.id;
}

/**
 * Compact text view of the canvas for an agent prompt. Deliberately terse:
 * every token here is spent on every turn that injects it.
 */
export function canvasSummary(document: CanvasDocument): string {
  const regionNodes = document.nodes.filter((node) => node.data?.kind === 'region');
  const projectNodes = document.nodes.filter((node) => node.data?.kind !== 'region');
  const orchestrator = document.nodes.find((node) => node.id === document.orchestratorId);

  const lines: string[] = [];
  lines.push(
    `牵丝画布：${projectNodes.length} 个节点、${document.edges.length} 条连线、${regionNodes.length} 个项目区域。已保存版本 r${document.revision}。`
  );
  lines.push(
    orchestrator
      ? `主控模型：${nodeLabel(orchestrator)}${orchestrator.data?.model ? `（${orchestrator.data.model}）` : ''}`
      : '主控模型：未设置'
  );

  if (projectNodes.length) {
    lines.push('');
    lines.push('节点：');
    for (const node of projectNodes.slice(0, 60)) {
      const data = node.data ?? {};
      const bits: string[] = [];
      if (data.kind) bits.push(data.kind);
      if (data.model) bits.push(`模型 ${data.model}`);
      if (data.effort) bits.push(`effort ${data.effort}`);
      if (data.role) bits.push(data.role);
      if (data.status) bits.push(`状态 ${data.status}`);
      const parent = node.parentId
        ? regionNodes.find((region) => region.id === node.parentId)
        : undefined;
      if (parent) bits.push(`属于「${nodeLabel(parent)}」`);
      lines.push(`- ${node.id}｜${nodeLabel(node)}${bits.length ? ` — ${bits.join(' / ')}` : ''}`);
      const output = asString(data.output).trim();
      if (output) {
        const excerpt = output.replace(/\s+/g, ' ').slice(0, 140);
        lines.push(`  产物：${excerpt}${output.length > 140 ? '…' : ''}`);
      }
    }
    if (projectNodes.length > 60) {
      lines.push(`- …另有 ${projectNodes.length - 60} 个节点未列出`);
    }
  }

  if (document.edges.length) {
    lines.push('');
    lines.push('连线：');
    const byId = new Map(document.nodes.map((node) => [node.id, node]));
    for (const edge of document.edges.slice(0, 60)) {
      const from = byId.get(edge.source);
      const to = byId.get(edge.target);
      const kind = edge.data?.kind ?? 'assign';
      const label = edge.label ? `「${edge.label}」` : '';
      lines.push(
        `- ${from ? nodeLabel(from) : edge.source} → ${to ? nodeLabel(to) : edge.target} [${EDGE_KIND_LABEL[kind] ?? kind}]${label}`
      );
    }
    if (document.edges.length > 60) {
      lines.push(`- …另有 ${document.edges.length - 60} 条连线未列出`);
    }
  }

  if (regionNodes.length) {
    lines.push('');
    lines.push('项目区域：');
    for (const region of regionNodes) {
      const mode = region.data?.regionMode ?? region.data?.kind;
      const gate = mode === 'two-way' ? '双向开放' : mode === 'one-way' ? '单向接入主工作流' : '未接线';
      lines.push(`- ${nodeLabel(region)}（${gate}）`);
    }
  }

  return lines.join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const KIND_FILL: Record<string, string> = {
  model: '#1b2b44',
  task: '#16342c',
  artifact: '#3a2a17',
  region: '#131a24',
  external: '#2a1d38',
};

const EDGE_STROKE: Record<string, string> = {
  assign: '#6ea8fe',
  handoff: '#4ade80',
  review: '#fbbf24',
  context: '#22d3ee',
};

/**
 * Renders the canvas as a standalone SVG. Claude Code and Codex both inline
 * SVG resources into the transcript, which is how the canvas "shows up" in the
 * agent conversation without any rendering work on their side.
 */
export function canvasSvg(document: CanvasDocument): string {
  const nodes = document.nodes;
  const edges = document.edges;
  const nodeWidth = 220;
  const nodeHeight = 78;

  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const node of nodes) {
    const isRegion = node.data?.kind === 'region';
    const w = Number(node.width) || (isRegion ? 520 : nodeWidth);
    const h = Number(node.height) || (isRegion ? 360 : nodeHeight);
    positions.set(node.id, {
      x: Number(node.position?.x) || 0,
      y: Number(node.position?.y) || 0,
      w,
      h,
    });
  }

  let minX = 0;
  let minY = 0;
  let maxX = 900;
  let maxY = 600;
  if (positions.size) {
    minX = Infinity;
    minY = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
    for (const box of positions.values()) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
  }
  const pad = 48;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const width = Math.max(320, Math.min(4000, maxX - minX));
  const height = Math.max(240, Math.min(3000, maxY - minY));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="${Math.round(minX)} ${Math.round(minY)} ${Math.round(width)} ${Math.round(height)}" font-family="'Segoe UI','Microsoft YaHei',system-ui,sans-serif">`
  );
  parts.push(
    `<defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1e2836" stroke-width="1"/></pattern>` +
      `<marker id="arrow-assign" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="${EDGE_STROKE.assign}"/></marker>` +
      `<marker id="arrow-handoff" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="${EDGE_STROKE.handoff}"/></marker>` +
      `<marker id="arrow-review" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="${EDGE_STROKE.review}"/></marker>` +
      `<marker id="arrow-context" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="${EDGE_STROKE.context}"/></marker></defs>`
  );
  parts.push(`<rect x="${Math.round(minX)}" y="${Math.round(minY)}" width="${Math.round(width)}" height="${Math.round(height)}" fill="#0b1622"/>`);
  parts.push(`<rect x="${Math.round(minX)}" y="${Math.round(minY)}" width="${Math.round(width)}" height="${Math.round(height)}" fill="url(#grid)" opacity="0.6"/>`);

  // Regions first so they sit behind everything else.
  const ordered = [...nodes].sort((a, b) => {
    const aRegion = a.data?.kind === 'region' ? 0 : 1;
    const bRegion = b.data?.kind === 'region' ? 0 : 1;
    return aRegion - bRegion;
  });

  for (const edge of edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) continue;
    const kind = edge.data?.kind ?? 'assign';
    const stroke = EDGE_STROKE[kind] ?? EDGE_STROKE.assign;
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const curve = Math.max(40, Math.abs(x2 - x1) / 2);
    parts.push(
      `<path d="M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="2" stroke-opacity="0.85" marker-end="url(#arrow-${kind in EDGE_STROKE ? kind : 'assign'})"/>`
    );
    if (edge.label) {
      parts.push(
        `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" fill="${stroke}" font-size="11" text-anchor="middle">${escapeXml(edge.label.slice(0, 24))}</text>`
      );
    }
  }

  for (const node of ordered) {
    const box = positions.get(node.id);
    if (!box) continue;
    const data = node.data ?? {};
    const isRegion = data.kind === 'region';
    const accent = asString(data.accent) || EDGE_STROKE.assign;
    const fill = KIND_FILL[asString(data.kind)] ?? '#16202e';
    const dash = isRegion ? ' stroke-dasharray="8 6" stroke-opacity="0.8"' : '';
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${isRegion ? 18 : 14}" fill="${fill}" fill-opacity="${isRegion ? 0.45 : 1}" stroke="${accent}" stroke-width="${node.id === document.orchestratorId ? 2.5 : 1.2}"${dash}/>`
    );
    if (node.id === document.orchestratorId) {
      parts.push(
        `<text x="${box.x + 12}" y="${box.y + 20}" fill="${accent}" font-size="10" letter-spacing="1">主控</text>`
      );
    }
    const title = nodeLabel(node).slice(0, 18);
    parts.push(
      `<text x="${box.x + 14}" y="${box.y + (isRegion ? 40 : 32)}" fill="#e6edf6" font-size="${isRegion ? 15 : 14}" font-weight="600">${escapeXml(title)}</text>`
    );
    const subtitleBits: string[] = [];
    if (data.model) subtitleBits.push(asString(data.model));
    if (data.effort) subtitleBits.push(`effort ${data.effort}`);
    if (data.role && !data.name) subtitleBits.push(asString(data.role));
    if (subtitleBits.length) {
      parts.push(
        `<text x="${box.x + 14}" y="${box.y + (isRegion ? 62 : 52)}" fill="#93a4bb" font-size="11">${escapeXml(subtitleBits.join(' · ').slice(0, 34))}</text>`
      );
    }
    const output = asString(data.output).trim();
    if (output && !isRegion) {
      const excerpt = output.replace(/\s+/g, ' ').slice(0, 26);
      parts.push(
        `<text x="${box.x + 14}" y="${box.y + box.h - 12}" fill="#7c8ba1" font-size="10">${escapeXml(excerpt)}</text>`
      );
    }
  }

  if (!nodes.length) {
    parts.push(
      `<text x="${Math.round(minX + width / 2)}" y="${Math.round(minY + height / 2)}" fill="#5b6b80" font-size="14" text-anchor="middle">画布还是空的</text>`
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}
