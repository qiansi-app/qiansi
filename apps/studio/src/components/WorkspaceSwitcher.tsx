import { useEffect, useState } from 'react';
import { LayoutGrid, Plus } from 'lucide-react';
import { currentWorkspace, switchWorkspace } from '../workspace';

/**
 * 工作区切换器：一张画布 = 一个会话/项目。
 *
 * 切换是整页重载——画布、运行进度、SSE 订阅一起换，避免半新半旧的状态。
 */

interface WorkspaceMeta {
  id: string;
  name: string;
  canvasExists: boolean;
}

export function WorkspaceSwitcher() {
  const [items, setItems] = useState<WorkspaceMeta[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/workspaces');
        const data = (await response.json()) as { items?: WorkspaceMeta[]; current?: string };
        setItems(data.items ?? []);
        const stored = currentWorkspace();
        setCurrent(stored || data.current || data.items?.[0]?.id || '');
      } catch {
        // 服务端还没起来：保持空列表，下一次交互再试
      }
    })();
  }, []);

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
      {active && !active.canvasExists && <span className="workspace-empty-hint">空白画布</span>}
    </div>
  );
}
