import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileText, Trash2 } from 'lucide-react';
import type { AgentNodeData } from '../data/demoGraph';

function sizeLabel(bytes?: number): string {
  if (!bytes) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileNode({ data, selected }: NodeProps) {
  const node = data as unknown as AgentNodeData;

  return (
    <div className={`file-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="port" />
      <div className="node-head">
        <span className="file-node-icon">
          <FileText size={12} />
        </span>
        <span className="node-name">{node.name}</span>
        <span className="file-node-size">{sizeLabel(node.fileSize)}</span>
        {node.onDelete && (
          <button
            className="node-delete nodrag"
            title="删除文件模块"
            onClick={(event) => {
              event.stopPropagation();
              node.onDelete?.();
            }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <div className="file-node-text">
        {node.filePreview?.trim() || '已上传，可连到任意模型或任务节点作为上下文。'}
      </div>
      <Handle type="source" position={Position.Right} className="port" />
    </div>
  );
}
