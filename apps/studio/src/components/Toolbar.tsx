import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Boxes,
  Brush,
  FileText,
  FolderOpen,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
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

function MenuItem({
  icon: Icon,
  label,
  hint,
  badge,
  disabled,
  onClick,
}: {
  icon: typeof Plus;
  label: string;
  hint?: string;
  badge?: number;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="toolbar-menu-item" onClick={onClick} disabled={disabled}>
      <Icon size={14} />
      <span className="toolbar-menu-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {badge && badge > 0 ? <span className="menu-badge">{badge}</span> : null}
    </button>
  );
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const menuAction = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

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

      <div className="toolbar-actions">
        <button className="icon-tool" onClick={onAddNode} title="添加模型节点" aria-label="添加模型节点">
          <Plus size={16} />
        </button>

        <button
          className="icon-tool"
          onClick={onAutoLayout}
          disabled={layouting}
          title="自动排版：主控模型排列节点与连线"
          aria-label="自动排版"
        >
          {layouting ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
        </button>

        <div className={`brush-control ${brushMode ? 'active' : ''}`}>
          <button
            className="icon-tool"
            onClick={() => onBrushMode(brushMode ? null : 'open')}
            title="画笔：拖拽划出分项目区域"
            aria-label="画笔"
          >
            <Brush size={16} />
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

        <button className="icon-tool" onClick={onUpload} title="上传文件" aria-label="上传文件">
          <Paperclip size={16} />
        </button>

        <button
          className="icon-tool"
          onClick={onDiscuss}
          disabled={discussionCount < 2}
          title="选中 2 个以上模型后发起 AI 讨论"
          aria-label="AI 讨论"
        >
          <MessagesSquare size={16} />
          {discussionCount > 0 && <span className="tool-badge">{discussionCount}</span>}
        </button>

        <span className="toolbar-divider" />

        <div className="toolbar-more" ref={menuRef}>
          <button
            className={`icon-tool ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen((open) => !open)}
            title="更多功能"
            aria-label="更多功能"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={17} />
            {(approvalCount > 0 || externalCount > 0) && <span className="tool-dot" />}
          </button>

          {menuOpen && (
            <div className="toolbar-menu" role="menu">
              <div className="toolbar-menu-section">画布</div>
              <MenuItem
                icon={FolderOpen}
                label="文件库"
                hint="批量文件与文件夹"
                onClick={menuAction(onAddLibrary)}
              />

              <div className="toolbar-menu-section">面板</div>
              <MenuItem
                icon={Boxes}
                label="模型连接"
                hint="Key、协议与工具权限"
                onClick={menuAction(onOpenModels)}
              />
              <MenuItem
                icon={FileText}
                label="本轮结果"
                hint="分任务产出与验收"
                disabled={!hasReport}
                onClick={menuAction(onOpenReport)}
              />
              <MenuItem
                icon={ShieldAlert}
                label="审批"
                badge={approvalCount}
                onClick={menuAction(onOpenApprovals)}
              />
              <MenuItem
                icon={Bot}
                label="外部 Agent"
                hint="调用记录与分账"
                badge={externalCount}
                onClick={menuAction(onOpenExternal)}
              />

              <div className="toolbar-menu-section">系统</div>
              <MenuItem icon={RotateCcw} label="重置画布" onClick={menuAction(onReset)} />
              <MenuItem icon={Settings} label="设置" onClick={menuAction(onOpenSettings)} />
            </div>
          )}
        </div>

        {running ? (
          <button className="btn" onClick={onStop}>
            <Square size={13} /> 停止
          </button>
        ) : (
          <button className="btn primary" onClick={onRun}>
            <Play size={14} /> 运行编排
          </button>
        )}
      </div>
    </header>
  );
}
