import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useNodes,
  type EdgeProps,
} from '@xyflow/react';

export interface WireEdgeData extends Record<string, unknown> {
  kind?: string;
}

/**
 * Every edge that is not carrying an artifact still needs a label — 任务、
 * 交接、验收、公共文件. React Flow's default label is one line of 9.5px text on a
 * translucent box, which reads as "no design at all" next to the artifact cards.
 *
 * Here each kind gets its own glyph and colour, the pill is offset off the wire
 * (same normal trick as the cards, at a smaller distance since it is small),
 * and a dot keeps the pill tied to the line.
 */

interface KindStyle {
  label: string;
  glyph: string;
  color: string;
  background: string;
  border: string;
}

const KINDS: Record<string, KindStyle> = {
  assign: {
    label: '任务',
    glyph: '→',
    color: '#a5b4fc',
    background: 'rgba(99, 102, 241, 0.16)',
    border: 'rgba(99, 102, 241, 0.55)',
  },
  handoff: {
    label: '交接',
    glyph: '⇢',
    color: '#6ee7b7',
    background: 'rgba(16, 185, 129, 0.16)',
    border: 'rgba(16, 185, 129, 0.5)',
  },
  review: {
    label: '验收',
    glyph: '✓',
    color: '#fcd34d',
    background: 'rgba(245, 158, 11, 0.16)',
    border: 'rgba(245, 158, 11, 0.5)',
  },
  context: {
    label: '公共文件',
    glyph: '❐',
    color: '#5eead4',
    background: 'rgba(56, 217, 194, 0.14)',
    border: 'rgba(56, 217, 194, 0.45)',
  },
};

function styleFor(kind: string): KindStyle {
  return KINDS[kind] ?? KINDS.assign!;
}

export function WireEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 12,
  });

  const data = props.data as WireEdgeData | undefined;
  const kind = String(data?.kind ?? 'assign');
  const style = styleFor(kind);
  const text = typeof props.label === 'string' && props.label ? props.label : style.label;

  // Same normal as the artifact card, but a small distance: the pill is ~20px
  // tall, so 18px clears the stroke without drifting away from its wire.
  const dx = props.targetX - props.sourceX;
  const dy = props.targetY - props.sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;

  // A label beside the wire can still land on a node. Estimate its box (CJK
  // glyphs are ~10px at this font size) and pick the first candidate that is
  // clear of every node, trying both sides and a few distances.
  const estimatedWidth = Math.min(
    180,
    [...text].reduce((sum, char) => sum + (/[一-龥]/.test(char) ? 10 : 6), 0) + 44
  );
  const halfW = estimatedWidth / 2 + 8;
  const halfH = 13;
  const nodes = useNodes();

  /**
   * How much of the pill would sit on a node. When a wire runs *under* a node,
   * every candidate near its anchor collides — then "first clear" never
   * triggers and the label stays on the node. Scoring the overlap and taking
   * the minimum degrades to the least-bad spot instead.
   */
  const overlapArea = (x: number, y: number): number =>
    nodes.reduce((sum, node) => {
      if (node.hidden) return sum;
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      if (!width || !height) return sum;
      const ox = Math.min(x + halfW, node.position.x + width) - Math.max(x - halfW, node.position.x);
      const oy = Math.min(y + halfH, node.position.y + height) - Math.max(y - halfH, node.position.y);
      return ox > 0 && oy > 0 ? sum + ox * oy : sum;
    }, 0);

  const tx = dx / length;
  const ty = dy / length;
  const candidates: Array<{ x: number; y: number }> = [];
  for (const s of [1, -1] as const) {
    for (const gap of [18, 34, 52, 76, 104]) {
      candidates.push({ x: labelX + nx * s * gap, y: labelY + ny * s * gap });
    }
    for (const slide of [-40, -80, -120, -160, -210, -260, 40, 80, 120, 160, 210, 260]) {
      candidates.push({
        x: labelX + nx * s * 18 + tx * slide,
        y: labelY + ny * s * 18 + ty * slide,
      });
    }
  }
  let picked = candidates[0]!;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const area = overlapArea(candidate.x, candidate.y);
    if (area < best) {
      best = area;
      picked = candidate;
    }
    if (area === 0) break;
  }
  const pillX = picked.x;
  const pillY = picked.y;

  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} />
      <EdgeLabelRenderer>
        <svg
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 1,
            height: 1,
            overflow: 'visible',
            pointerEvents: 'none',
          }}
        >
          <line
            x1={labelX}
            y1={labelY}
            x2={pillX}
            y2={pillY}
            className={`wire-tether ${kind}`}
          />
          <circle cx={labelX} cy={labelY} r={2} className={`wire-anchor ${kind}`} />
        </svg>
        <span
          data-debug={`ov${Math.round(best)}`}
          className={`wire-pill ${kind}`}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${pillX}px, ${pillY}px)`,
            color: style.color,
            background: style.background,
            borderColor: style.border,
          }}
        >
          <span className="wire-pill-glyph" aria-hidden="true">
            {style.glyph}
          </span>
          {text}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
