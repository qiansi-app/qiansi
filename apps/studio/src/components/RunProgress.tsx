import { useEffect, useState } from 'react';
import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import type { RunTaskView } from '../types';

interface RunProgressProps {
  tasks: RunTaskView[];
  running: boolean;
  startedAt: number;
  tokens: number;
  onOpenReport?: () => void;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 100) / 10);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

const STATUS_LABEL: Record<RunTaskView['status'], string> = {
  pending: '待执行',
  running: '进行中',
  done: '已完成',
  failed: '失败',
};

/**
 * The board tells you what each node is doing, but not how far the run has got.
 * This strip answers that in one glance: 3/6 done, who is working now, how long
 * it has taken and what it has cost.
 */
export function RunProgress({ tasks, running, startedAt, tokens, onOpenReport }: RunProgressProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running || !startedAt) return;
    setElapsed(Date.now() - startedAt);
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  const list = Object.values(tasks);
  if (!list.length) return null;

  const total = list.length;
  const done = list.filter((task) => task.status === 'done').length;
  const failed = list.filter((task) => task.status === 'failed').length;
  const active = list.find((task) => task.status === 'running');
  const settled = done + failed;
  const percent = total ? Math.round((settled / total) * 100) : 0;

  const headline = running
    ? active
      ? `正在跑「${active.title ?? active.taskId}」`
      : '规划中…'
    : failed
      ? `${done}/${total} 完成，${failed} 个失败`
      : // An interrupted run leaves tasks pending; calling that "全部完成" lied.
        list.some((task) => task.status === 'pending' || task.status === 'running')
        ? `${done}/${total} · 运行已中断`
        : `${done}/${total} 全部完成`;

  return (
    <div className={`run-progress ${running ? 'running' : 'settled'}`}>
      <div className="run-progress-main">
        <span className="run-progress-state">
          {running ? <Loader2 size={13} className="spin" /> : failed ? <X size={13} /> : <Check size={13} />}
          {headline}
        </span>

        <span className="run-progress-dots" aria-label={`${settled}/${total} 完成`}>
          {list.map((task) => (
            <i
              key={task.taskId}
              className={`run-dot ${task.status}`}
              title={`${task.title ?? task.taskId} · ${STATUS_LABEL[task.status]}`}
            />
          ))}
        </span>

        <span className="run-progress-meta">
          <b>{done}/{total}</b>
          <span className="run-progress-sep">·</span>
          {formatElapsed(elapsed)}
          {tokens > 0 && (
            <>
              <span className="run-progress-sep">·</span>
              {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok
            </>
          )}
        </span>

        {onOpenReport && (
          <button className="run-progress-open" onClick={onOpenReport} title="查看本轮结果">
            <ChevronRight size={14} />
          </button>
        )}
      </div>

      <div className="run-progress-track">
        <div className="run-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
