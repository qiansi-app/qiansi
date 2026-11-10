import { useEffect, useState } from 'react';
import { Copy, Download, ListPlus, X } from 'lucide-react';
import type { RunTaskView } from '../types';

interface ArtifactModalProps {
  open: boolean;
  task?: RunTaskView;
  onClose: () => void;
  onMaterialize?: (taskId: string) => void;
}

export function ArtifactModal({ open, task, onClose, onMaterialize }: ArtifactModalProps) {
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 保存为真实文件：服务端把该任务的完整产出写到工作区的 deliverables 目录。
  // 有真实文件，成果才能拿走、进仓库、发给别人——而不是只活在弹窗里。
  useEffect(() => {
    setSavedPath(null);
    setError(null);
  }, [task?.taskId]);

  const saveAsFile = async () => {
    if (!task?.taskId) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/deliverables/${task.taskId}`, { method: 'POST' });
      const data = (await response.json().catch(() => null)) as {
        file?: string;
        error?: string;
      } | null;
      if (!response.ok || !data?.file) {
        setError(data?.error ?? `HTTP ${response.status}`);
      } else {
        setSavedPath(data.file);
        setError(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!open || !task) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(task.output ?? '');
    } catch {
      // 剪贴板不可用时静默失败
    }
  };

  const tone = task.acceptance?.needsHuman
    ? 'warn'
    : task.acceptance?.pass
      ? 'ok'
      : 'fail';
  const label = task.acceptance?.needsHuman
    ? '需人工确认'
    : task.acceptance?.pass
      ? '通过'
      : '未通过';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal report-modal" onClick={(event) => event.stopPropagation()}>
        <div className="report-head">
          <div>
            <div className="report-title">
              {task.title} · 产物
            </div>
            <div className="report-meta">
              {task.taskId} · {task.nodeId}
              {task.effort ? ` · effort=${task.effort}` : ''}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className={`acceptance-badge ${tone}`}>{label}</span>
            {task.acceptance && (
              <span className="report-score">score {task.acceptance.score.toFixed(2)}</span>
            )}
            <button className="mini-btn" onClick={copy}>
              <Copy size={12} /> 复制
            </button>
            <button className="mini-btn" onClick={() => void saveAsFile()} disabled={saving}>
              <Download size={12} /> {saving ? '保存中…' : '存为文件'}
            </button>
            {onMaterialize && (
              <button className="mini-btn" onClick={() => onMaterialize(task.taskId)}>
                <ListPlus size={12} /> 拉出为模块
              </button>
            )}
            <button className="btn ghost" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="report-body">
          {savedPath && (
            <div className="report-saved">
              已保存为真实文件：<code>{savedPath}</code>
            </div>
          )}
          {error && <div className="report-saved error">{error}</div>}
          {task.acceptance && task.acceptance.reasons.length > 0 && (
            <div className="report-reasons">{task.acceptance.reasons.join('；')}</div>
          )}
          <pre className="report-output">{task.output ?? '（无输出）'}</pre>
        </div>
      </div>
    </div>
  );
}
