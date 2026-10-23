import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
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
  const tone = artifact?.acceptance?.needsHuman
    ? 'warn'
    : artifact?.acceptance?.pass
      ? 'ok'
      : 'fail';

  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} />
      {artifact && (
        <EdgeLabelRenderer>
          <button
            className={`artifact-chip ${tone}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            onClick={(event) => {
              event.stopPropagation();
              data?.onOpen?.(artifact.taskId);
            }}
            title="点击查看这一级产物与验收"
          >
            <span className="artifact-chip-id">{artifact.taskId}</span>
            <span className="artifact-chip-text">
              {artifact.output.replace(/\s+/g, ' ').slice(0, 42)}
            </span>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
