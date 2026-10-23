import { AlertTriangle, CheckCircle2, Copy, Download, ListPlus, X, XCircle } from 'lucide-react';
import type { RunSummary, RunTaskView } from '../types';

interface RunReportProps {
  open: boolean;
  summary: RunSummary | null;
  tasks: Record<string, RunTaskView>;
  onClose: () => void;
  onMaterializeTask?: (taskId: string) => void;
  onMaterializeArtifact?: (taskId: string) => void;
}

function acceptanceLabel(task: RunTaskView): { text: string; tone: 'ok' | 'warn' | 'fail' | 'muted' } {
  if (!task.acceptance) return { text: '未判定', tone: 'muted' };
  if (task.acceptance.needsHuman) return { text: '需人工确认', tone: 'warn' };
  if (task.acceptance.pass) return { text: '通过', tone: 'ok' };
  return { text: '未通过', tone: 'fail' };
}

export function RunReport({
  open,
  summary,
  tasks,
  onClose,
  onMaterializeTask,
  onMaterializeArtifact,
}: RunReportProps) {
  if (!open) return null;

  const list = Object.values(tasks);
  const payload = { summary, tasks: list };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      // clipboard can be blocked; the download button still works
    }
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `qiansi-run-${summary?.runId ?? 'report'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal report-modal"
        role="dialog"
        aria-modal="true"
        aria-label="运行结果"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">运行结果</div>
            <div className="modal-sub">
              {summary
                ? `${summary.status} · ${summary.passed}/${summary.total} 通过 · ${summary.needsHuman} 需人工确认 · ${summary.events} 事件${
                    summary.tokens ? ` · ${summary.tokens.toLocaleString()} tok` : ''
                  } · ${(summary.durationMs / 1000).toFixed(1)}s`
                : '还没有运行结果'}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="mini-btn" onClick={copy} disabled={!summary}>
              <Copy size={12} /> 复制 JSON
            </button>
            <button className="mini-btn" onClick={download} disabled={!summary}>
              <Download size={12} /> 下载
            </button>
            <button className="btn ghost" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="report-body">
          {list.length === 0 && (
            <div className="empty">还没有运行结果。点击「运行编排」跑一次。</div>
          )}

          {list.map((task) => {
            const label = acceptanceLabel(task);
            return (
              <div key={task.taskId} className="report-task">
                <div className="report-task-head">
                  <span className={`task-status ${task.status}`}>
                    {task.status === 'done' && <CheckCircle2 size={11} />}
                    {task.status === 'failed' && <XCircle size={11} />}
                    {task.status === 'running' && <AlertTriangle size={11} />}
                    {task.status}
                  </span>
                  <strong>{task.title ?? task.taskId}</strong>
                  <span className="report-task-id">
                    {task.taskId} · {task.nodeId}
                    {task.effort ? ` · ${task.effort}` : ''}
                  </span>
                  <span className={`acceptance-badge ${label.tone}`}>{label.text}</span>
                  {task.acceptance && (
                    <span className="report-score">score {task.acceptance.score.toFixed(2)}</span>
                  )}
                  {onMaterializeTask && (
                    <button
                      className="mini-btn report-action"
                      onClick={() => onMaterializeTask(task.taskId)}
                      title="把任务放到画布上"
                    >
                      <ListPlus size={11} /> 任务
                    </button>
                  )}
                  {onMaterializeArtifact && task.output && (
                    <button
                      className="mini-btn report-action"
                      onClick={() => onMaterializeArtifact(task.taskId)}
                      title="把产物放到画布上"
                    >
                      <ListPlus size={11} /> 产物
                    </button>
                  )}
                </div>

                {task.acceptance && task.acceptance.reasons.length > 0 && (
                  <div className="report-reasons">{task.acceptance.reasons.join('；')}</div>
                )}

                <pre className="report-output">{task.output ?? '（无输出）'}</pre>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
