import { useEffect, useState } from 'react';
import { FileCog, LayoutGrid, Plus } from 'lucide-react';
import { currentWorkspace, switchWorkspace } from '../workspace';

/**
 * 工作区切换器：一张画布 = 一个会话/项目。
 *
 * 切换是整页重载——画布、运行进度、SSE 订阅一起换，避免半新半旧的状态。
 * 「公共指令」= 注入本工作区每个 worker 系统提示的常驻规范
 * （借鉴 DSH 的 team sections：披露语、评审规范这类要全员遵守的文本）。
 */

interface WorkspaceMeta {
  id: string;
  name: string;
  instructions?: string;
  canvasExists: boolean;
}

export function WorkspaceSwitcher() {
  const [items, setItems] = useState<WorkspaceMeta[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const response = await fetch('/api/workspaces');
      const data = (await response.json()) as { items?: WorkspaceMeta[]; current?: string };
      setItems(data.items ?? []);
      const stored = currentWorkspace();
      setCurrent(stored || data.current || data.items?.[0]?.id || '');
    } catch {
      // 服务端还没起来：保持空列表，下一次交互再试
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!editorOpen) return;
    const active = items.find((item) => item.id === current);
    setInstructions(active?.instructions ?? '');
    setSaved(false);
  }, [editorOpen, items, current]);

  const active = items.find((item) => item.id === current);

  const createAndSwitch = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      const data = (await response.json()) as { workspace?: { id: string } };
      if (data.workspace?.id) switchWorkspace(data.workspace.id);
    } finally {
      setBusy(false);
    }
  };

  const saveInstructions = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/workspaces/${current}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instructions }),
      });
      if (response.ok) {
        setSaved(true);
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="workspace-switcher">
      <LayoutGrid size={14} className="workspace-switcher-icon" />
      <select
        value={current}
        title="工作区：每张画布对应一个会话或项目"
        onChange={(event) => {
          if (event.target.value !== current) switchWorkspace(event.target.value);
        }}
      >
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.canvasExists ? '' : '（空）'}
          </option>
        ))}
      </select>
      <button
        className="icon-tool workspace-new"
        onClick={() => void createAndSwitch()}
        disabled={busy}
        title="新建空白画布"
      >
        <Plus size={14} />
      </button>
      <button
        className={`icon-tool ${editorOpen ? 'active' : ''}`}
        onClick={() => setEditorOpen((open) => !open)}
        title="工作区公共指令：注入本画布每个 worker 的常驻规范"
      >
        <FileCog size={14} />
      </button>
      {active && !active.canvasExists && <span className="workspace-empty-hint">空白画布</span>}

      {editorOpen && (
        <div className="workspace-instructions" onClick={(event) => event.stopPropagation()}>
          <div className="workspace-instructions-title">
            「{active?.name}」的公共指令
            <small>注入本画布每个 worker 的系统提示，例如输出规范、术语表、红线要求</small>
          </div>
          <textarea
            value={instructions}
            placeholder="例如：输出一律用中文；引用数字必须标注来源；不要编造不确定的事实……"
            onChange={(event) => {
              setInstructions(event.target.value);
              setSaved(false);
            }}
            rows={5}
          />
          <div className="workspace-instructions-actions">
            <button className="btn primary" onClick={() => void saveInstructions()} disabled={busy}>
              保存
            </button>
            {saved && <span className="workspace-saved">已保存，下次运行生效</span>}
          </div>
        </div>
      )}
    </div>
  );
}
