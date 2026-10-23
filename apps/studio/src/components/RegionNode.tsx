import type { NodeProps } from '@xyflow/react';
import { ArrowLeft, ArrowRight, ArrowRightLeft, Lock, Trash2 } from 'lucide-react';
import type { AgentNodeData, RegionMode } from '../data/demoGraph';

const modeMeta: Record<
  RegionMode,
  { label: string; hint: string; icon: typeof ArrowRight; tone: string }
> = {
  open: {
    label: '双向',
    hint: '主工作流可以派活，区域也可以交付',
    icon: ArrowRightLeft,
    tone: 'open',
  },
  inbound: {
    label: '单向入',
    hint: '主工作流可以派活，区域产物不外流',
    icon: ArrowRight,
    tone: 'inbound',
  },
  outbound: {
    label: '单向出',
    hint: '区域可以交付，但主工作流不派活',
    icon: ArrowLeft,
    tone: 'outbound',
  },
  closed: {
    label: '封闭',
    hint: '与主工作流隔离，只能内部协作',
    icon: Lock,
    tone: 'closed',
  },
};

export function RegionNode({ data, selected }: NodeProps) {
  const node = data as unknown as AgentNodeData;
  const mode = node.regionMode ?? 'open';
  const meta = modeMeta[mode];
  const Icon = meta.icon;

  return (
    <div className={`region-node ${meta.tone} ${selected ? 'selected' : ''}`}>
      <div className="region-head">
        <span className="region-icon">
          <Icon size={12} />
        </span>
        <span className="region-name">{node.name}</span>
        <span className="region-mode">{meta.label}</span>
        <span className="region-hint">{meta.hint}</span>
        {node.onDelete && (
          <button
            className="node-delete nodrag"
            title="删除区域（不会删除区域内的节点）"
            onClick={(event) => {
              event.stopPropagation();
              node.onDelete?.();
            }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
