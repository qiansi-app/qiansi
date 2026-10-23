import { Handle, Position, type NodeProps } from '@xyflow/react';

interface ExternalNodeData extends Record<string, unknown> {
  agent: string;
  sessionId: string;
  callCount: number;
  purpose: string;
  model: string;
  output: string;
  tokens: number;
  onOpenSession?: (sessionId: string) => void;
}

export function ExternalNode({ data }: NodeProps) {
  const node = data as unknown as ExternalNodeData;

  return (
    <div
      className="external-node"
      onClick={(event) => {
        event.stopPropagation();
        node.onOpenSession?.(node.sessionId);
      }}
    >
      <div className="external-node-head">
        <span className="external-dot" /> 外部 Agent
        <span className="external-node-count">{node.callCount} calls</span>
      </div>
      <div className="external-node-agent">{node.agent}</div>
      <div className="external-node-purpose">{node.purpose}</div>
      <div className="external-node-model">
        {node.model} · {node.tokens} tok
      </div>
      <div className="external-node-output">
        {node.output.replace(/\s+/g, ' ').slice(0, 110)}
      </div>
      <Handle type="source" position={Position.Right} className="port" />
    </div>
  );
}
