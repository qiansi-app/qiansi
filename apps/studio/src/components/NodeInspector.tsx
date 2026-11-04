import { Copy, EyeOff, Eye, FilePlus, FolderOpen, Globe, GitBranch, Trash2, X } from 'lucide-react';
import type { AgentNodeData, RegionMode, StudioNode } from '../data/demoGraph';
import { catalogOf, type ModelDraft } from '../data/models';

const kindLabel: Record<string, string> = {
  task: '任务模块',
  artifact: '产物模块',
  file: '文件模块',
  library: '文件库',
  region: '项目区域',
  agent: '模型节点',
  orchestrator: '主控节点',
  external: '外部 Agent',
};

const regionModes: Array<{ value: RegionMode; label: string; hint: string }> = [
  { value: 'open', label: '双向', hint: '主工作流可派活，区域也可交付' },
  { value: 'inbound', label: '单向入', hint: '只接收主工作流任务' },
  { value: 'outbound', label: '单向出', hint: '只向主工作流交付' },
  { value: 'closed', label: '封闭', hint: '与主工作流隔离' },
];

interface NodeInspectorProps {
  node: StudioNode;
  /** Configured keys; each key exposes its whole callable-model catalog. */
  models?: ModelDraft[];
  onPatch: (patch: Partial<AgentNodeData>) => void;
  onDelete: () => void;
  onDetach?: () => void;
  onCopy?: () => void;
  onPinToWire?: () => void;
  onAddFiles?: () => void;
  onAddFolder?: () => void;
  onClose: () => void;
}

export function NodeInspector({
  node,
  models,
  onPatch,
  onDelete,
  onDetach,
  onCopy,
  onPinToWire,
  onAddFiles,
  onAddFolder,
  onClose,
}: NodeInspectorProps) {
  const data = node.data;
  const kind = data.kind;

  const modelChoices = (models ?? []).flatMap((connection) =>
    catalogOf(connection).map((model) => ({
      value: `${connection.id}::${model}`,
      label: `${connection.label} · ${model}`,
      connection,
      model,
    }))
  );
  const currentNodeValue = `${data.connectionId ?? ''}::${data.model ?? ''}`;
  const knownSelection = modelChoices.some((choice) => choice.value === currentNodeValue);

  return (
    <aside className="node-inspector">
      <header className="inspector-head">
        <div>
          <h3>{data.name}</h3>
          <p>{kindLabel[kind] ?? kind}</p>
        </div>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <X size={15} />
        </button>
      </header>

      <div className="inspector-section">
        <div className="inspector-label">名称</div>
        <input
          className="inspector-input"
          value={data.name}
          onChange={(event) => onPatch({ name: event.target.value })}
        />
      </div>

      {kind === 'region' && (
        <div className="inspector-section">
          <div className="inspector-label">与主工作流的方向</div>
          <div className="region-mode-list">
            {regionModes.map((item) => (
              <button
                key={item.value}
                className={`region-mode-option ${data.regionMode === item.value ? 'active' : ''}`}
                onClick={() => onPatch({ regionMode: item.value })}
              >
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      {(kind === 'agent' || kind === 'orchestrator') && modelChoices.length > 0 && (
        <div className="inspector-section">
          <div className="inspector-label">模型（按 key 的可调用目录选择）</div>
          <select
            className="inspector-input"
            value={knownSelection ? currentNodeValue : '__custom__'}
            onChange={(event) => {
              const choice = modelChoices.find((item) => item.value === event.target.value);
              if (!choice) return;
              onPatch({
                connectionId: choice.connection.id,
                provider: choice.connection.provider,
                protocol: choice.connection.protocol,
                baseUrl: choice.connection.baseUrl,
                model: choice.model,
              });
            }}
          >
            {!knownSelection && (
              <option value="__custom__">
                {data.model ? `${data.model}（自定义）` : '未设置'}
              </option>
            )}
            {modelChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <div className="inspector-meta">
            运行时按模型 id 路由到对应的 key；同一把 key 的所有模型都在列表里。
          </div>
        </div>
      )}

      {(kind === 'task' || kind === 'artifact') && (
        <div className="inspector-section">
          <div className="inspector-label">产物</div>
          <div className="inspector-output">{data.output || '暂无内容'}</div>
          {data.acceptance && (
            <div className="inspector-meta">
              验收 {data.acceptance.score?.toFixed(2) ?? '—'}
              {data.acceptance.needsHuman ? ' · 需人工确认' : ''}
            </div>
          )}
        </div>
      )}

      {kind === 'file' && (
        <div className="inspector-section">
          <div className="inspector-label">文件</div>
          <div className="inspector-meta">
            {data.fileName ?? data.name} · {data.fileSize ?? 0} bytes
          </div>
          <div className="inspector-output">{data.filePreview || '二进制文件，无文本预览'}</div>
        </div>
      )}

      {kind === 'library' && (
        <div className="inspector-section">
          <div className="inspector-label">文件（{(data.libraryFiles ?? []).length}）</div>
          <div className="library-inspector-list">
            {(data.libraryFiles ?? []).slice(0, 8).map((file) => (
              <div key={file.id} className="library-inspector-file" title={file.name}>
                {file.name}
              </div>
            ))}
            {(data.libraryFiles ?? []).length === 0 && (
              <div className="inspector-meta">还没有文件</div>
            )}
          </div>
          {onAddFiles && (
            <button className="btn ghost inspector-action" onClick={onAddFiles}>
              <FilePlus size={14} /> 添加文件（可多选）
            </button>
          )}
          {onAddFolder && (
            <button className="btn ghost inspector-action" onClick={onAddFolder}>
              <FolderOpen size={14} /> 添加整个文件夹
            </button>
          )}
          <button
            className={`btn ghost inspector-action ${data.isPublic ? 'public-on' : ''}`}
            onClick={() => onPatch({ isPublic: !data.isPublic })}
          >
            <Globe size={14} /> {data.isPublic ? '公共文件库（已开启）' : '设为公共文件库'}
          </button>
          <div className="inspector-meta">
            公共文件库会自动连到所有模型节点，内容作为对话与讨论的上下文。
          </div>
        </div>
      )}

      <div className="inspector-section">
        {onCopy && (
          <button className="btn ghost inspector-action" onClick={onCopy}>
            <Copy size={14} /> 复制模块
          </button>
        )}
        {kind === 'artifact' && onPinToWire && (
          <button className="btn ghost inspector-action" onClick={onPinToWire}>
            <GitBranch size={14} /> 放回流程线
          </button>
        )}
        {node.parentId && onDetach && (
          <button className="btn ghost inspector-action" onClick={onDetach}>
            移出区域
          </button>
        )}
        <button
          className="btn ghost inspector-action"
          onClick={() => onPatch({ hidden: !data.hidden })}
        >
          {data.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          {data.hidden ? '显示此模块' : '隐藏此模块'}
        </button>
        <button className="btn ghost inspector-action danger-text" onClick={onDelete}>
          <Trash2 size={14} /> 删除
        </button>
      </div>
    </aside>
  );
}
