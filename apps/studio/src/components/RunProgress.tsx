import { useEffect, useState } from 'react';
import { Check, ChevronRight, Loader2, RotateCcw, X } from 'lucide-react';
import type { RunFailureInfo, RunTaskView } from '../types';

interface RunProgressProps {
  tasks: RunTaskView[];
  running: boolean;
  startedAt: number;
  /** 补显完成态时的真实结束时间；缺省按当前时刻，避免定格在 0.0s。 */
  endedAt?: number;
  tokens: number;
  /** 失败归因与重试进度：展示原因，并提供重试入口。 */
  failure?: RunFailureInfo | null;
  onRetry?: () => void;
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
export function RunProgress({ tasks, running, startedAt, endedAt, tokens, failure, onRetry, onOpenReport }: RunProgressProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running || !startedAt) return;
    setElapsed(Date.now() - startedAt);
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  // 不是在跑：直接用真实耗时（结束时间 − 开始时间），不再走计时器。
  const settledElapsed = running ? 0 : startedAt ? (endedAt || Date.now()) - startedAt : 0;
  const shownElapsed = running ? elapsed : settledElapsed;

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
          {formatElapsed(shownElapsed)}
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

      {!running && failure && (
        <div className="run-progress-failure">
          <div className="run-progress-failure-text">
            <b>失败：{failure.headline}</b>
            <span className="run-progress-sep">·</span>
            <span>第 {failure.attempt}/{failure.maxAttempts} 次</span>
            {failure.retryScheduled && <span className="run-progress-badge">已排队自动重试</span>}
            <div className="run-progress-failure-reasons" title={failure.reasons.join('\n')}>
              {failure.reasons.slice(0, 3).join('；')}
            </div>
          </div>
          {onRetry && !failure.retryScheduled && (
            <button className="run-progress-retry" onClick={onRetry} title="从断点续跑：只重跑没有产出的任务">
              <RotateCcw size={12} /> 重试
            </button>
          )}
        </div>
      )}
    </div>
  );
}
