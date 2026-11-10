import { useEffect, useState } from 'react';
import { FileCog, LayoutGrid, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { currentWorkspace, setCurrentWorkspace, switchWorkspace } from '../workspace';

/**
 * 工作区切换器：一张画布 = 一个会话/项目。
 *
 * 切换是整页重载——画布、运行进度、SSE 订阅一起换，避免半新半旧的状态。
 * 「公共指令」= 注入本工作区每个 worker 系统提示的常驻规范
 * （借鉴 DSH 的 team sections：披露语、评审规范这类要全员遵守的文本）。
 *
 * 首次加载时把视图钉在本页自己的工作区上：localStorage 里没有（或指向已删除
 * 的画布）时采用服务端当前值并落盘。此后本页始终显式带上工作区头——
 * 服务端的「当前画布」被脚本或 agent 改走时，这个面板不再跟着变。
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
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = async () => {
    try {
      const response = await fetch('/api/workspaces');
      const data = (await response.json()) as { items?: WorkspaceMeta[]; current?: string };
      const list = data.items ?? [];
      setItems(list);
      const stored = currentWorkspace();
      const known = list.some((item) => item.id === stored);
      // 钉住视图：没有选过、或选的画布已被删掉时，采用服务端当前值并记住。
      // 之后再有人改服务端的「当前画布」，这个面板也不动——它有自己的头。
      if ((!stored || !known) && data.current) {
        setCurrentWorkspace(data.current);
        setCurrent(data.current);
        if (stored !== data.current) switchWorkspace(data.current);
        return;
      }
      setCurrent(stored || data.current || list[0]?.id || '');
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

  const deleteCurrent = async () => {
    if (!current) return;
    setBusy(true);
    setConfirmDelete(false);
    try {
      const response = await fetch(`/api/workspaces/${current}`, { method: 'DELETE' });
      const data = (await response.json()) as { ok?: boolean; current?: string; error?: string };
      if (data.ok) {
        // 服务端已把「当前」切到剩下的第一个；跟随它。
        const next = data.current ?? items.find((item) => item.id !== current)?.id ?? '';
        if (next && next !== current) {
          setCurrentWorkspace(next);
        } else {
          setCurrentWorkspace('');
        }
        switchWorkspace(next || '');
      }
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
        className="icon-tool workspace-delete"
        onClick={() => setConfirmDelete(true)}
        disabled={busy || items.length <= 1}
        title={
          items.length <= 1
            ? '至少保留一张画布'
            : `删除「${active?.name ?? '当前画布'}」及其节点、消息与运行记录`
        }
      >
        <Trash2 size={14} />
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

      <ConfirmDialog
        open={confirmDelete}
        title={`删除画布「${active?.name ?? ''}」？`}
        detail="节点、连线、消息与这个画布上的运行记录会一并删除，模型连接与密钥不受影响。"
        confirmLabel="删除画布"
        onConfirm={() => void deleteCurrent()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
