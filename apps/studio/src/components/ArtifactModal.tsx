import { Copy, ListPlus, X } from 'lucide-react';
import type { RunTaskView } from '../types';

interface ArtifactModalProps {
  open: boolean;
  task?: RunTaskView;
  onClose: () => void;
  onMaterialize?: (taskId: string) => void;
}

export function ArtifactModal({ open, task, onClose, onMaterialize }: ArtifactModalProps) {
  if (!open || !task) return null;

  const tone = task.acceptance?.needsHuman
    ? 'warn'
    : task.acceptance?.pass
      ? 'ok'
      : 'fail';
  const label = task.acceptance?.needsHuman
    ? '需人工确认'
    : task.acceptance?.pass
      ? '通过'
      : '未判定';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            taskId: task.taskId,
            title: task.title,
            nodeId: task.nodeId,
            output: task.output,
            acceptance: task.acceptance,
          },
          null,
          2
        )
      );
    } catch {
      // clipboard can be blocked; the text is still visible
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal report-modal"
        role="dialog"
        aria-modal="true"
        aria-label="产物"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">
              {task.title ?? task.taskId} · 产物
            </div>
            <div className="modal-sub">
              {task.taskId} · {task.nodeId}
              {task.effort ? ` · effort=${task.effort}` : ''}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <span className={`acceptance-badge ${tone}`}>{label}</span>
            {task.acceptance && (
              <span className="report-score">score {task.acceptance.score.toFixed(2)}</span>
            )}
            <button className="mini-btn" onClick={copy}>
              <Copy size={12} /> 复制
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
          {task.acceptance && task.acceptance.reasons.length > 0 && (
            <div className="report-reasons">{task.acceptance.reasons.join('；')}</div>
          )}
          <pre className="report-output">{task.output ?? '（无输出）'}</pre>
        </div>
      </div>
    </div>
  );
}
