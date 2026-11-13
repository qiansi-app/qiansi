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
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { AgentNode } from './AgentNode';
import { ArtifactEdge } from './ArtifactEdge';
import { WireEdge } from './WireEdge';
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
const edgeTypes = { artifact: ArtifactEdge, wire: WireEdge };

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

const EDGE_LEGEND = [
  { kind: 'assign', label: '分派', color: '#6366f1' },
  { kind: 'handoff', label: '交接', color: '#10b981' },
  { kind: 'review', label: '审校', color: '#f59e0b' },
  { kind: 'context', label: '上下文', color: '#38d9c2' },
];

function readLegendOpen(): boolean {
  try {
    return window.localStorage.getItem('qiansi.legend.open') !== '0';
  } catch {
    return true;
  }
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
  // Every edge without an artifact gets the designed pill label; the artifact
  // type keeps its own card component.
  const renderedEdges = useMemo(
    () => edges.map((edge) => (edge.type === 'artifact' ? edge : { ...edge, type: 'wire' })),
    [edges]
  );

  const [legendOpen, setLegendOpen] = useState(readLegendOpen);
  const toggleLegend = () => {
    setLegendOpen((open) => {
      try {
        window.localStorage.setItem('qiansi.legend.open', open ? '0' : '1');
      } catch {
        // 记不住折叠状态不影响使用
      }
      return !open;
    });
  };

  const handleNodeClick: NodeMouseHandler<StudioNode> = (_event, node) => {
    onNodeClick(node.id);
  };
  const handleEdgeClick: EdgeMouseHandler<Edge> = (_event, edge) => {
    onEdgeClick(edge.id);
  };

  return (
    <ReactFlow<StudioNode, Edge>
      nodes={nodes}
      edges={renderedEdges}
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
        style={{ background: '#0e1318', border: '1px solid #1b222b', borderRadius: 10, width: 168, height: 112 }}
      />
      <Controls showInteractive={false} position="bottom-right" />
      <Panel position="bottom-left">
        <div className={`canvas-legend ${legendOpen ? 'open' : 'collapsed'}`}>
          <button
            type="button"
            className="legend-toggle"
            onClick={toggleLegend}
            aria-expanded={legendOpen}
            title={legendOpen ? '收起图例' : '展开图例与操作提示'}
          >
            {legendOpen ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
            图例
          </button>
          {legendOpen && (
            <>
              <span className="legend-items">
                {EDGE_LEGEND.map((item) => (
                  <span className="legend-item" key={item.kind}>
                    <i className="legend-line" style={{ background: item.color }} />
                    {item.label}
                  </span>
                ))}
              </span>
              <span className="legend-hint">
                Ctrl/⌘ 或 Shift 多选模型发起讨论 · 拖拽端口连线 · 画笔划出分项目区域
              </span>
            </>
          )}
        </div>
      </Panel>
    </ReactFlow>
  );
}
