import type { CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  Clock,
  Crown,
  Loader2,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import type { AgentNodeData, EffortLevel, NodeStatus } from '../data/demoGraph';

const statusText: Record<NodeStatus, string> = {
  idle: '待命',
  queued: '排队',
  running: '工作中',
  reviewing: '验收中',
  done: '待验收',
  failed: '失败',
  blocked: '等待你',
};

const statusIcon = (status: NodeStatus) => {
  const size = 11;
  switch (status) {
    case 'queued':
      return <Clock size={size} />;
    case 'running':
      return <Loader2 size={size} className="spin" />;
    case 'reviewing':
      return <PauseCircle size={size} />;
    case 'done':
      return <CheckCircle2 size={size} />;
    case 'failed':
      return <XCircle size={size} />;
    case 'blocked':
      return <AlertTriangle size={size} />;
    default:
      return <Circle size={size} />;
  }
};

const effortRank: Record<EffortLevel, number> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 3,
};

export function AgentNode({ data, selected }: NodeProps) {
  const node = data as unknown as AgentNodeData;
  const style = { '--accent': node.accent } as CSSProperties;
  const isOrchestrator = node.kind === 'orchestrator';
  const rank = effortRank[node.effort] ?? 2;

  return (
    <div
      className={[
        'agent-node',
        selected ? 'selected' : '',
        isOrchestrator ? 'orchestrator' : '',
        node.status === 'running' ? 'is-running' : '',
      ].join(' ')}
      style={style}
    >
      <Handle type="target" position={Position.Left} className="port" title="任务 / 产物 / 语境" />

      <div className="node-head">
        <span className="provider-mark" />
        <span className="node-name">{node.name}</span>
        {isOrchestrator && <Crown size={13} className="crown" />}
        {node.taskId && <span className="task-badge">{node.taskId}</span>}
        <span className={`status-dot ${node.status}`} title={statusText[node.status]} />
        {node.onDelete && (
          <button
            className="node-delete nodrag"
            title="删除节点"
            onClick={(event) => {
              event.stopPropagation();
              node.onDelete?.();
            }}
          >
            <XCircle size={11} />
          </button>
        )}
        <span className="node-menu" title="更多">
          ⋯
        </span>
      </div>

      <div className="node-status-row">
        <span className={`status-chip ${node.status}`}>
          {statusIcon(node.status)}
          {statusText[node.status]}
        </span>
        <span className="model-inline">{node.model}</span>
        <span
          className="effort-bars"
          title={`effort: ${node.effort} · 来源: ${node.effortSource ?? '默认'}`}
        >
          {[1, 2, 3].map((index) => (
            <i key={index} className={index <= rank ? 'on' : ''} />
          ))}
        </span>
        <span className="retry">{node.retry ?? '0/3'}</span>
      </div>

      <div className="node-task">{node.task ?? node.role}</div>
      <div className="node-artifact">{node.artifact ?? '暂无产物'}</div>

      <div className="node-metrics">
        <span>{node.metrics ?? '—'}</span>
        <span className="node-action">{node.status === 'running' ? '停止' : '重跑'}</span>
      </div>

      <Handle type="source" position={Position.Right} className="port" title="产物 / 任务 / 验收" />
    </div>
  );
}
