import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Edge,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import { AgentNode } from './AgentNode';
import { ArtifactEdge } from './ArtifactEdge';
import { ArtifactNode } from './ArtifactNode';
import { ExternalNode } from './ExternalNode';
import { FileNode } from './FileNode';
import { LibraryNode } from './LibraryNode';
import { RegionNode } from './RegionNode';
import { TaskNode } from './TaskNode';
import type { AgentNodeData, StudioNode } from '../data/demoGraph';

const nodeTypes = {
  agent: AgentNode,
  artifact: ArtifactNode,
  external: ExternalNode,
  task: TaskNode,
  file: FileNode,
  library: LibraryNode,
  region: RegionNode,
};
const edgeTypes = { artifact: ArtifactEdge };

interface CanvasProps {
  nodes: StudioNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<StudioNode>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: OnConnect;
  onNodeClick: (id: string) => void;
  onEdgeClick: (id: string) => void;
  onNodesDelete: (ids: string[]) => void;
  onSelectionChange?: (ids: string[]) => void;
  onInit?: (instance: ReactFlowInstance<StudioNode, Edge>) => void;
  onNodeDragStop?: (node: StudioNode) => void;
}

export function Canvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onEdgeClick,
  onNodesDelete,
  onSelectionChange,
  onInit,
  onNodeDragStop,
}: CanvasProps) {
  const handleNodeClick: NodeMouseHandler<StudioNode> = (_event, node) => {
    onNodeClick(node.id);
  };
  const handleEdgeClick: EdgeMouseHandler<Edge> = (_event, edge) => {
    onEdgeClick(edge.id);
  };

  return (
    <ReactFlow<StudioNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={handleNodeClick}
      onEdgeClick={handleEdgeClick}
      onNodesDelete={(deleted) => onNodesDelete(deleted.map((node) => node.id))}
      onSelectionChange={({ nodes: selected }) =>
        onSelectionChange?.(selected.map((node) => node.id))
      }
      onInit={onInit}
      onNodeDragStop={(_event, node) => onNodeDragStop?.(node)}
      multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
      deleteKeyCode={null}
      fitView
      fitViewOptions={{ padding: 0.24 }}
      minZoom={0.2}
      maxZoom={1.8}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ animated: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#232a33" />
      <MiniMap
        pannable
        zoomable
        nodeStrokeWidth={2}
        nodeColor={(node) => (node.data as AgentNodeData).accent ?? '#4d6bfe'}
        maskColor="rgba(5, 7, 10, 0.74)"
        style={{ background: '#0e1318', border: '1px solid #1b222b', borderRadius: 10 }}
      />
      <Controls showInteractive={false} position="bottom-right" />
      <Panel position="bottom-left">
        <div className="canvas-legend">
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#6ea8fe' }} /> assign
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#38d9c9' }} /> handoff
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#e0a458' }} /> review
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#5f6b7a' }} /> context
          </span>
        </div>
      </Panel>
    </ReactFlow>
  );
}
