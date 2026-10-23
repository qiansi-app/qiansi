import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Files, Trash2 } from 'lucide-react';
import type { AgentNodeData } from '../data/demoGraph';

export function LibraryNode({ data, selected }: NodeProps) {
  const node = data as unknown as AgentNodeData;
  const files = node.libraryFiles ?? [];

  return (
    <div className={`library-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="port" />
      <div className="node-head">
        <span className="library-node-icon">
          <Files size={12} />
        </span>
        <span className="node-name">{node.name}</span>
        <span className={`library-badge ${node.isPublic ? 'public' : ''}`}>
          {node.isPublic ? '公共' : '私有'}
        </span>
        {node.onDelete && (
          <button
            className="node-delete nodrag"
            title="删除文件库"
            onClick={(event) => {
              event.stopPropagation();
              node.onDelete?.();
            }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <div className="library-meta">
        {files.length === 0 ? '还没有文件' : `${files.length} 个文件`}
        {node.isPublic && files.length > 0 ? ' · 自动传给所有节点' : ''}
      </div>
      <div className="library-list">
        {files.slice(0, 3).map((file) => (
          <div key={file.id} className="library-file" title={file.name}>
            {file.name}
          </div>
        ))}
        {files.length > 3 && <div className="library-more">+{files.length - 3} 个…</div>}
      </div>
      <Handle type="source" position={Position.Right} className="port" />
    </div>
  );
}
