import { useEffect, useRef, useState } from 'react';
import { Clock, FileCog, History, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { currentWorkspace, setCurrentWorkspace, switchWorkspace } from '../workspace';

/**
 * 画布标签栏：一个工作流 = 一张画布 = 一个标签页。
 *
 * - 运行中的画布带绿点标记，随时点过去看进度；
 * - 关标签页是软删除：进「历史画布」，可恢复或彻底删除；
 * - 首次加载时把视图钉在本页自己的工作区上（localStorage 没有或已失效时
 *   采用服务端当前值并落盘），之后服务端的「当前画布」被改走也不影响本页。
 */

interface WorkspaceMeta {
  id: string;
  name: string;
  instructions?: string;
  canvasExists: boolean;
  archivedAt?: number;
  running?: number;
}

interface ArchivedMeta {
  id: string;
  name: string;
  archivedAt?: number;
}

const timeLabel = (ts?: number) => {
  if (!ts) return '';
  const date = new Date(ts);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours()
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export function WorkspaceSwitcher({ onCanvasStarted }: { onCanvasStarted?: (name: string) => void }) {
  const [items, setItems] = useState<WorkspaceMeta[]>([]);
  const [archived, setArchived] = useState<ArchivedMeta[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  /** 待关闭的标签：确认/取消都用它，绝不改正在看的 current。 */
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const knownIds = useRef<Set<string> | null>(null);

  const load = async (announce = false) => {
    try {
      const response = await fetch('/api/workspaces');
      const data = (await response.json()) as {
        items?: WorkspaceMeta[];
        archived?: ArchivedMeta[];
        current?: string;
      };
      const list = data.items ?? [];
      setItems(list);
      setArchived(data.archived ?? []);
      const stored = currentWorkspace();
      const known = list.some((item) => item.id === stored);
      if ((!stored || !known) && data.current) {
        setCurrentWorkspace(data.current);
        setCurrent(data.current);
        if (stored !== data.current) switchWorkspace(data.current);
        return;
      }
      setCurrent(stored || data.current || list[0]?.id || '');
      if (announce) {
        const fresh = list.filter((item) => !knownIds.current?.has(item.id));
        const started = fresh.filter((item) => (item.running ?? 0) > 0);
        if (started.length > 0 && onCanvasStarted) {
          onCanvasStarted(started[0].name);
        }
      }
      knownIds.current = new Set(list.map((item) => item.id));
    } catch {
      // 服务端还没起来：保持空列表，下一次轮询再试
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 4000);
    return () => window.clearInterval(timer);
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

  const archiveCurrent = async () => {
    const target = pendingClose ?? current;
    if (!target) return;
    setBusy(true);
    setConfirmArchive(false);
    try {
      const response = await fetch(`/api/workspaces/${target}/archive`, { method: 'POST' });
      const data = (await response.json()) as { ok?: boolean; current?: string; error?: string };
      if (!data.ok) {
        setArchiveError(
          data.error === 'last_active' ? '至少保留一个画布：关掉它之前先新建一张。' : data.error ?? '关闭失败'
        );
        return;
      }
      setArchiveError('');
      // 关掉正在看的画布才需要跳走；关后台标签原地不动。
      if (target === currentWorkspace()) {
        const next = data.current ?? items.find((item) => item.id !== target)?.id ?? '';
        setCurrentWorkspace(next);
        switchWorkspace(next);
      } else {
        void load();
      }
    } finally {
      setBusy(false);
      setPendingClose(null);
    }
  };

  const restoreOne = async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/workspaces/${id}/restore`, { method: 'POST' });
      const data = (await response.json()) as { ok?: boolean };
      if (data.ok) {
        setHistoryOpen(false);
        switchWorkspace(id);
      }
    } finally {
      setBusy(false);
    }
  };

  const purgeOne = async (id: string) => {
    setBusy(true);
    setPurging(null);
    try {
      const response = await fetch(`/api/workspaces/${id}`, { method: 'DELETE' });
      const data = (await response.json()) as { ok?: boolean };
      if (data.ok) {
        setArchived((list) => list.filter((item) => item.id !== id));
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

  const closeDisabled = items.length <= 1;

  if (items.length === 0 && archived.length === 0) {
    return (
      <div className="workspace-switcher">
        <div className="workspace-tabs">
          <button className="icon-tool workspace-new" onClick={() => void createAndSwitch()} disabled={busy} title="新建空白画布">
            <Plus size={14} />
          </button>
          <span className="workspace-empty-hint">没有活跃画布</span>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-switcher">
      <div className="workspace-tabs">
        {items.map((item) => (
          <div
            key={item.id}
            className={`workspace-tab ${item.id === current ? 'active' : ''}`}
            title={item.running ? `运行中（${item.running} 个任务）· 点击查看进度` : item.name}
            onClick={() => {
              if (item.id !== current) switchWorkspace(item.id);
            }}
          >
            {(item.running ?? 0) > 0 && <span className="workspace-tab-running" />}
            <span className="workspace-tab-name">{item.name}</span>
            <button
              className="workspace-tab-close"
              title={closeDisabled ? "至少保留一个画布" : "关闭标签页（画布进历史，可恢复）"}
              disabled={closeDisabled || busy}
              onClick={(event) => {
                event.stopPropagation();
                setPendingClose(item.id);
                setConfirmArchive(true);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="icon-tool workspace-new" onClick={() => void createAndSwitch()} disabled={busy} title="新建空白画布">
          <Plus size={14} />
        </button>
        <div className="workspace-history-anchor">
          <button
            className={`icon-tool ${historyOpen ? 'active' : ''}`}
            onClick={() => setHistoryOpen((open) => !open)}
            title="历史画布：关闭过的画布在这里，可恢复或彻底删除"
          >
            <History size={14} />
          </button>
          {historyOpen && (
            <div className="workspace-history" onClick={(event) => event.stopPropagation()}>
              <div className="workspace-history-title">
                <Clock size={12} /> 历史画布（{archived.length}）
              </div>
              {archived.length === 0 && <div className="workspace-history-empty">没有关闭过的画布。</div>}
              {archived.map((item) => (
                <div key={item.id} className="workspace-history-item">
                  <div className="workspace-history-meta">
                    <b>{item.name}</b>
                    <span>关闭于 {timeLabel(item.archivedAt)}</span>
                  </div>
                  <div className="workspace-history-actions">
                    <button className="keys-mini" disabled={busy} onClick={() => void restoreOne(item.id)}>
                      <RotateCcw size={11} /> 恢复
                    </button>
                    <button
                      className="keys-mini danger"
                      disabled={busy}
                      onClick={() => setConfirmPurge(item.id)}
                    >
                      <Trash2 size={11} /> 永久删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          className={`icon-tool ${editorOpen ? 'active' : ''}`}
          onClick={() => setEditorOpen((open) => !open)}
          title="工作区公共指令：注入本画布每个 worker 的常驻规范"
        >
          <FileCog size={14} />
        </button>
      </div>
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

      {archiveError && <div className="keys-error">{archiveError}</div>}
      <ConfirmDialog
        open={confirmArchive}
        title={`关闭画布「${items.find((item) => item.id === (pendingClose ?? current))?.name ?? ''}」？`}
        detail="标签页会移除，画布进「历史画布」：之后可以恢复，也可以在历史里彻底删除。"
        confirmLabel="关闭并进历史"
        onConfirm={() => void archiveCurrent()}
        onCancel={() => setConfirmArchive(false)}
      />
      <ConfirmDialog
        open={Boolean(confirmPurge)}
        title={`永久删除「${archived.find((item) => item.id === confirmPurge)?.name ?? ''}」？`}
        detail="画布文件、节点与连线会被删掉，不可恢复。运行记录仍在全局历史里。"
        confirmLabel="永久删除"
        onConfirm={() => confirmPurge && void purgeOne(confirmPurge)}
        onCancel={() => setConfirmPurge(null)}
      />
    </div>
  );
}
