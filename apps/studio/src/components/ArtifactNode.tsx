import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import type { RunTaskView } from '../types';

interface ArtifactNodeData extends Record<string, unknown> {
  taskId: string;
  name?: string;
  output: string;
  acceptance?: RunTaskView['acceptance'];
  onOpen?: (taskId: string) => void;
  onDelete?: () => void;
}

export function ArtifactNode({ data, selected }: NodeProps) {
  const node = data as unknown as ArtifactNodeData;
  const tone = node.acceptance?.needsHuman
    ? 'warn'
    : node.acceptance?.pass
      ? 'ok'
      : 'fail';

  return (
    <div
      className={`artifact-node ${tone} ${selected ? 'selected' : ''}`}
      onClick={() => {
        node.onOpen?.(node.taskId);
      }}
    >
      <Handle type="target" position={Position.Left} className="port" />
      <div className="artifact-node-head">
        {node.name || '最终产物'}
        {node.onDelete && (
          <button
            className="node-delete nodrag"
            title="删除产物模块"
            onClick={(event) => {
              event.stopPropagation();
              node.onDelete?.();
            }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <div className="artifact-node-text">{node.output.replace(/\s+/g, ' ').slice(0, 220)}</div>
      <div className="artifact-node-foot">{node.onOpen ? '点击查看验收' : '讨论产物'}</div>
    </div>
  );
}
