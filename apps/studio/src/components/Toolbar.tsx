import {
  Bot,
  Boxes,
  Brush,
  FileText,
  FolderOpen,
  Loader2,
  MessagesSquare,
  Network,
  Paperclip,
  Play,
  Plus,
  RotateCcw,
  Settings,
  ShieldAlert,
  Square,
  Wand2,
} from 'lucide-react';
import type { RegionMode } from '../data/demoGraph';

interface ToolbarProps {
  running: boolean;
  nodeCount: number;
  edgeCount: number;
  tokens: number;
  hasReport: boolean;
  onRun: () => void;
  onStop: () => void;
  onAddNode: () => void;
  onOpenModels: () => void;
  onOpenSettings: () => void;
  onOpenReport: () => void;
  onReset: () => void;
  approvalCount: number;
  onOpenApprovals: () => void;
  externalCount: number;
  onOpenExternal: () => void;
  discussionCount: number;
  onDiscuss: () => void;
  onUpload: () => void;
  onAddLibrary: () => void;
  onAutoLayout: () => void;
  layouting: boolean;
  brushMode: RegionMode | null;
  onBrushMode: (mode: RegionMode | null) => void;
}

export function Toolbar({
  running,
  nodeCount,
  edgeCount,
  tokens,
  hasReport,
  onRun,
  onStop,
  onAddNode,
  onOpenModels,
  onOpenSettings,
  onOpenReport,
  onReset,
  approvalCount,
  onOpenApprovals,
  externalCount,
  onOpenExternal,
  discussionCount,
  onDiscuss,
  onUpload,
  onAddLibrary,
  onAutoLayout,
  layouting,
  brushMode,
  onBrushMode,
}: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="brand">
        <div className="brand-mark">
          <Network size={17} strokeWidth={2.2} />
        </div>
        <div>
          <div className="brand-name">牵丝</div>
          <div className="brand-sub">Qiansi · 多 AI 协作画布</div>
        </div>
      </div>

      <div className="toolbar-stat">
        <strong>{nodeCount}</strong> 节点
      </div>
      <div className="toolbar-stat">
        <strong>{edgeCount}</strong> 连线
      </div>
      {tokens > 0 && (
        <div className="toolbar-stat">
          <strong>{tokens.toLocaleString()}</strong> tok
        </div>
      )}

      <div className="toolbar-spacer" />

      <button className="btn ghost" onClick={onOpenModels} title="模型连接、Key 测试与工具权限">
        <Boxes size={14} /> 模型
      </button>

      <button className="btn ghost" onClick={onOpenReport} disabled={!hasReport} title="查看本轮运行的分任务结果">
        <FileText size={14} /> 结果
      </button>

      <button className="btn ghost" onClick={onOpenApprovals} title="待审批动作">
        <ShieldAlert size={14} /> 审批{approvalCount > 0 ? ` ${approvalCount}` : ''}
      </button>

      <button className="btn ghost" onClick={onOpenExternal} title="外部 Agent 调用与分账">
        <Bot size={14} /> 外部{externalCount > 0 ? ` ${externalCount}` : ''}
      </button>

      <button
        className="btn ghost"
        onClick={onAutoLayout}
        disabled={layouting}
        title="让主控模型重新排列节点与连线"
      >
        {layouting ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
        {layouting ? '排版中' : '排版'}
      </button>

      <button
        className="btn ghost"
        onClick={onDiscuss}
        disabled={discussionCount < 2}
        title="选中 2 个以上模型后发起 AI 讨论"
      >
        <MessagesSquare size={14} /> 讨论{discussionCount > 0 ? ` ${discussionCount}` : ''}
      </button>

      <button className="btn ghost" onClick={onUpload} title="上传文件并连到模型或任务">
        <Paperclip size={14} /> 文件
      </button>

      <button className="btn ghost" onClick={onAddLibrary} title="建立一个文件库，可批量传文件或整个文件夹">
        <FolderOpen size={14} /> 文件库
      </button>

      <div className={`brush-control ${brushMode ? 'active' : ''}`}>
        <button
          className="btn ghost"
          onClick={() => onBrushMode(brushMode ? null : 'open')}
          title="在画布上拖拽划出项目区域"
        >
          <Brush size={14} /> 画笔
        </button>
        {brushMode && (
          <select
            value={brushMode}
            onChange={(event) => onBrushMode(event.target.value as RegionMode)}
            title="区域与主工作流的方向"
          >
            <option value="open">双向</option>
            <option value="inbound">单向入</option>
            <option value="outbound">单向出</option>
            <option value="closed">封闭</option>
          </select>
        )}
      </div>

      <button className="btn ghost" onClick={onReset} title="重置所有节点状态与运行结果">
        <RotateCcw size={14} /> 重置
      </button>

      <button className="btn ghost" onClick={onOpenSettings} title="通知、外观、Agent 接入与反馈">
        <Settings size={14} /> 设置
      </button>

      <button className="btn ghost" onClick={onAddNode} title="添加一个模型节点">
        <Plus size={14} /> 添加模型
      </button>

      {running ? (
        <button className="btn" onClick={onStop}>
          <Square size={13} /> 停止
        </button>
      ) : (
        <button className="btn primary" onClick={onRun}>
          <Play size={14} /> 运行编排
        </button>
      )}
    </header>
  );
}
