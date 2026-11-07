import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useNodes,
  type EdgeProps,
} from '@xyflow/react';
import type { RunTaskView } from '../types';

export interface ArtifactEdgeData extends Record<string, unknown> {
  artifact?: {
    taskId: string;
    title?: string;
    output: string;
    acceptance?: RunTaskView['acceptance'];
  };
  onOpen?: (taskId: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  assign: '任务',
  handoff: '交接',
  review: '验收',
  context: '上下文',
};

/** Fixed card size in canvas units — the offset math needs it before render. */
const CARD_WIDTH = 208;
const CARD_HEIGHT = 84;

/**
 * The card sits beside the wire, not on it: offset along the normal of the
 * source→target line, with the side chosen per edge so parallel edges do not
 * stack. A short tether plus a dot keeps the link visible.
 *
 * The offset must clear the card's own half-extent along the normal, otherwise
 * a tall card on a vertical normal still covers the anchor — measured at 82px
 * tall with a 40px gap, it overlapped by one pixel.
 *
 * Everything here is in canvas units. EdgeLabelRenderer scales with the
 * viewport, so mixing screen pixels into the offset would make the gap shrink
 * or grow with zoom.
 */
function sideFor(id: string): 1 | -1 {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return hash % 2 === 0 ? 1 : -1;
}

export function ArtifactEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 12,
  });

  const data = props.data as ArtifactEdgeData | undefined;
  const artifact = data?.artifact;
  const kind = String((props.data as { kind?: unknown } | undefined)?.kind ?? 'assign');

  const tone = artifact?.acceptance?.needsHuman
    ? 'warn'
    : artifact?.acceptance?.pass === false
      ? 'fail'
      : artifact?.acceptance?.pass
        ? 'ok'
        : 'plain';
  const badge = tone === 'warn' ? '需人工' : tone === 'fail' ? '未通过' : tone === 'ok' ? '通过' : '产物';
  const glyph = tone === 'warn' ? '!' : tone === 'fail' ? '✕' : tone === 'ok' ? '✓' : '·';

  // Normal of the straight source→target line. For a horizontal flow this is
  // vertical, which is exactly where a label should go.
  const dx = props.targetX - props.sourceX;
  const dy = props.targetY - props.sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  // Short wires get a wider gap so the card clears both node bodies; the gap
  // always clears the card's half-extent along this normal.
  const halfExtent =
    Math.abs(ny) >= Math.abs(nx) ? CARD_HEIGHT / 2 : CARD_WIDTH / 2;
  const baseGap = Math.max(length < 220 ? 52 : 40, halfExtent + 14);
  const side = sideFor(props.id);

  // A card beside the wire can still land on a node in a dense graph. Try both
  // sides and a few distances, then a couple of slides along the wire, and take
  // the first placement that is clear; fall back to the first candidate.
  const nodes = useNodes();
  const cardHalfW = CARD_WIDTH / 2 + 6;
  const cardHalfH = CARD_HEIGHT / 2 + 6;
  const hitsNode = (x: number, y: number): boolean =>
    nodes.some((node) => {
      if (node.hidden) return false;
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      if (!width || !height) return false;
      const left = node.position.x;
      const top = node.position.y;
      return (
        x + cardHalfW > left &&
        x - cardHalfW < left + width &&
        y + cardHalfH > top &&
        y - cardHalfH < top + height
      );
    });

  const tx = dx / length;
  const ty = dy / length;
  const candidates: Array<{ x: number; y: number }> = [];
  for (const s of [side, -side] as const) {
    for (const extra of [0, 34, 70]) {
      candidates.push({
        x: labelX + nx * s * (baseGap + extra),
        y: labelY + ny * s * (baseGap + extra),
      });
    }
  }
  for (const slide of [-70, 70, -130, 130]) {
    for (const s of [side, -side] as const) {
      candidates.push({
        x: labelX + nx * s * baseGap + tx * slide,
        y: labelY + ny * s * baseGap + ty * slide,
      });
    }
  }
  const picked = candidates.find((candidate) => !hitsNode(candidate.x, candidate.y)) ?? candidates[0]!;
  const cardX = picked.x;
  const cardY = picked.y;

  const score = artifact?.acceptance?.score;
  const title = artifact?.title || KIND_LABEL[kind] || '产物';

  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} />
      {artifact && (
        <EdgeLabelRenderer>
          <svg
            className="artifact-tether-svg"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              overflow: 'visible',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          >
            <line
              x1={labelX}
              y1={labelY}
              x2={cardX}
              y2={cardY}
              className={`artifact-tether ${tone}`}
            />
            <circle cx={labelX} cy={labelY} r={2.5} className={`artifact-anchor ${tone}`} />
          </svg>

          <button
            className={`artifact-card ${tone}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${cardX}px, ${cardY}px)`,
              width: CARD_WIDTH,
              minHeight: CARD_HEIGHT,
              pointerEvents: 'all',
            }}
            aria-label={`打开 ${artifact.taskId} 的产物与验收结果`}
            onClick={(event) => {
              event.stopPropagation();
              data?.onOpen?.(artifact.taskId);
            }}
            title={artifact.output.replace(/\s+/g, ' ').slice(0, 120)}
          >
            <span className="artifact-card-icon" aria-hidden="true">
              {glyph}
            </span>
            <span className="artifact-card-body">
              <span className="artifact-card-top">
                <span className="artifact-card-kind">{KIND_LABEL[kind] ?? '产物'}</span>
                <span className="artifact-card-id">{artifact.taskId}</span>
                <span className={`artifact-card-badge ${tone}`}>{badge}</span>
              </span>
              <span className="artifact-card-title">{title}</span>
              <span className="artifact-card-text">
                {artifact.output.replace(/\s+/g, ' ').slice(0, 60)}
              </span>
            </span>
            {typeof score === 'number' && (
              <span className="artifact-card-score">{Math.round(score * 100)}</span>
            )}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
