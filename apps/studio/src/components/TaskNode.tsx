import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CheckCircle2, ListChecks, Trash2, XCircle } from 'lucide-react';
import type { AgentNodeData } from '../data/demoGraph';

export function TaskNode({ data, selected }: NodeProps) {
  const node = data as unknown as AgentNodeData;
  const pass = node.acceptance?.pass;
  const tone = node.acceptance?.needsHuman ? 'warn' : pass ? 'ok' : 'fail';

  return (
    <div className={`task-node ${selected ? 'selected' : ''} ${tone}`}>
      <Handle type="target" position={Position.Left} className="port" />
      <div className="node-head">
        <span className="task-node-icon">
          <ListChecks size={12} />
        </span>
        <span className="node-name">{node.name}</span>
        {node.taskId && <span className="task-badge">{node.taskId}</span>}
        {node.acceptance &&
          (pass ? <CheckCircle2 size={12} className="ok" /> : <XCircle size={12} className="fail" />)}
        {node.onDelete && (
          <button
            className="node-delete nodrag"
            title="删除任务模块"
            onClick={(event) => {
              event.stopPropagation();
              node.onDelete?.();
            }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <div className="task-node-meta">
        <span>{node.model ?? '未分配模型'}</span>
        <span>{node.status === 'done' ? '已完成' : node.status}</span>
      </div>
      <div className="task-node-text">{(node.output ?? '等待产出…').replace(/\s+/g, ' ').slice(0, 160)}</div>
      {node.acceptance?.score !== undefined && (
        <div className="task-node-foot">
          验收 {node.acceptance.score.toFixed(2)}
          {node.acceptance.needsHuman ? ' · 需人工确认' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="port" />
    </div>
  );
}
