import { useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  Eye,
  Loader2,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { RunDiagnosis, RunFailureInfo, RunTaskView, UserViewReport } from '../types';

interface RunProgressProps {
  tasks: RunTaskView[];
  running: boolean;
  startedAt: number;
  /** 补显完成态时的真实结束时间；缺省按当前时刻，避免定格在 0.0s。 */
  endedAt?: number;
  tokens: number;
  /** 失败归因与重试进度：展示原因，并提供重试入口。 */
  failure?: RunFailureInfo | null;
  /** 环境诊断：工作目录、模型、建议与重跑方式。 */
  diagnosis?: RunDiagnosis | null;
  diagnosisBusy?: boolean;
  rerunBusy?: boolean;
  userViewBusy?: boolean;
  userView?: UserViewReport | null;
  onRetry?: () => void;
  onRerun?: (mode: 'resume' | 'fresh') => void;
  onDiagnose?: () => void;
  onEnableModel?: (slot: string) => void;
  onFixRootDir?: (path: string) => void;
  onUserView?: () => void;
  onOpenUserView?: () => void;
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
 * it has taken and what it has cost. When a run fails it also becomes the
 * diagnosis centre: why it failed, which part of the environment is broken,
 * and the buttons that fix and re-run it.
 */
export function RunProgress({
  tasks,
  running,
  startedAt,
  endedAt,
  tokens,
  failure,
  diagnosis,
  diagnosisBusy,
  rerunBusy,
  userViewBusy,
  userView,
  onRetry,
  onRerun,
  onDiagnose,
  onEnableModel,
  onFixRootDir,
  onUserView,
  onOpenUserView,
  onOpenReport,
}: RunProgressProps) {
  const [elapsed, setElapsed] = useState(0);
  const [diagOpen, setDiagOpen] = useState(false);
  const [rootInput, setRootInput] = useState('');

  useEffect(() => {
    if (!running || !startedAt) return;
    setElapsed(Date.now() - startedAt);
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  // 新一轮开始或失败清空时，收起旧诊断，不让它继续挂着上一轮的建议。
  useEffect(() => {
    if (!failure) setDiagOpen(false);
  }, [failure]);

  // 不是在跑：直接用真实耗时（结束时间 − 开始时间），不再走计时器。
  const settledElapsed = running ? 0 : startedAt ? (endedAt || Date.now()) - startedAt : 0;
  const shownElapsed = running ? elapsed : settledElapsed;

  const list = Object.values(tasks);
  if (!list.length) {
    // 没有运行记录、但有用户视角验收结果：留一条窄条，证据不随刷新消失。
    if (!userView) return null;
    const label =
      userView.verdict === 'pass' ? '通过' : userView.verdict === 'fail' ? '未通过' : '无法验收';
    return (
      <div className="run-progress settled compact">
        <div className="run-progress-main">
          <span className="run-progress-state">
            <Eye size={13} /> 用户视角验收 · {label}
          </span>
          <span className="run-progress-meta">
            {new Date(userView.at).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
          <button
            className={`run-progress-uv ${userView.verdict}`}
            onClick={() => (onOpenUserView ? onOpenUserView() : onUserView?.())}
            title={userView.summary}
          >
            查看
          </button>
        </div>
      </div>
    );
  }

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

  const verdictLabel =
    userView?.verdict === 'pass' ? '通过' : userView?.verdict === 'fail' ? '未通过' : '无法验收';
  const rootDir = diagnosis?.environment.rootDir;
  const canRerun = Boolean(onRerun || onRetry);

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

        {!running && (
          <button
            className={`run-progress-uv ${userView?.verdict ?? 'none'}`}
            onClick={() => (userView ? onOpenUserView?.() : onUserView?.())}
            disabled={userViewBusy}
            title={
              userView
                ? `用户视角验收：${userView.summary}`
                : '把项目跑起来，用浏览器截图并按用户视角检查'
            }
          >
            {userViewBusy ? <Loader2 size={12} className="spin" /> : <Eye size={12} />}
            {userViewBusy ? '验收中…' : userView ? `用户视角：${verdictLabel}` : '用户视角验收'}
          </button>
        )}

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
            <span>
              {failure.attempt <= failure.maxAttempts
                ? `第 ${failure.attempt}/${failure.maxAttempts} 次`
                : `第 ${failure.attempt} 次（自动上限 ${failure.maxAttempts}）`}
            </span>
            {failure.retryScheduled && <span className="run-progress-badge">已排队自动重试</span>}
            <div className="run-progress-failure-reasons" title={failure.reasons.join('\n')}>
              {failure.reasons.slice(0, 3).join('；')}
            </div>
          </div>
          <div className="run-progress-failure-actions">
            {onDiagnose && (
              <button
                className={`run-progress-retry ${diagOpen ? 'active' : ''}`}
                onClick={() => {
                  setDiagOpen((open) => !open);
                  if (!diagnosis) onDiagnose();
                }}
                title="环境自检：工作目录、模型 Key、可用的重跑方式"
              >
                <ShieldAlert size={12} /> 诊断
              </button>
            )}
            {onRetry && !failure.retryScheduled && (
              <button className="run-progress-retry" onClick={onRetry} title="从断点续跑：只重跑没有产出的任务">
                <RotateCcw size={12} /> 重试
              </button>
            )}
          </div>
        </div>
      )}

      {!running && failure && diagOpen && (
        <div className="run-diagnosis" role="dialog" aria-label="失败环境诊断">
          {diagnosisBusy && !diagnosis && (
            <div className="run-diagnosis-loading">
              <Loader2 size={13} className="spin" /> 正在检查环境…
            </div>
          )}
          {diagnosis && (
            <>
              <div className="run-diagnosis-grid">
                <section>
                  <h4>环境自检</h4>
                  <ul className="run-diagnosis-facts">
                    <li>
                      <span className={rootDir && rootDir.exists ? 'ok' : 'bad'}>
                        {rootDir ? (rootDir.exists ? '✓' : '✗') : '·'}
                      </span>
                      工作目录：
                      <code title={rootDir?.path}>
                        {rootDir ? rootDir.path : '未设置'}
                        {rootDir?.source === 'server' ? '（服务端目录）' : ''}
                      </code>
                    </li>
                    {diagnosis.environment.models.map((model) => (
                      <li key={model.nodeId}>
                        <span className={model.ready ? 'ok' : 'bad'}>{model.ready ? '✓' : '✗'}</span>
                        {model.name}：
                        <code>{model.model}</code>
                        <span className={model.ready ? 'muted' : 'bad'}> {model.note}</span>
                        {model.disabled && onEnableModel && (
                          <button
                            className="run-diagnosis-link"
                            onClick={() => onEnableModel(model.slot)}
                          >
                            启用
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {rootDir && !rootDir.exists && onFixRootDir && (
                    <div className="run-diagnosis-fix">
                      <input
                        value={rootInput}
                        onChange={(event) => setRootInput(event.target.value)}
                        placeholder="填入一个存在的项目目录，例如 E:\\my-app"
                      />
                      <button
                        disabled={!rootInput.trim()}
                        onClick={() => onFixRootDir(rootInput.trim())}
                      >
                        保存目录
                      </button>
                    </div>
                  )}
                </section>

                <section>
                  <h4>任务状态</h4>
                  <ul className="run-diagnosis-tasks">
                    {diagnosis.tasks.map((task) => (
                      <li key={task.id} className={task.status}>
                        <span className={`run-diagnosis-dot ${task.status}`} />
                        <b>{task.title}</b>
                        <span className="muted">
                          {task.status === 'done' ? '已完成' : task.status === 'failed' ? '失败' : '待执行'}
                        </span>
                        {task.error && <span className="run-diagnosis-error">{task.error.slice(0, 160)}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              {diagnosis.environment.hints.length > 0 && (
                <div className="run-diagnosis-hints">
                  {diagnosis.environment.hints.map((hint, index) => (
                    <p key={index}>{hint}</p>
                  ))}
                </div>
              )}

              <div className="run-diagnosis-actions">
                <button
                  className="primary"
                  disabled={
                    rerunBusy ||
                    !diagnosis.actions.resume.available ||
                    failure.retryScheduled
                  }
                  title={
                    failure.retryScheduled
                      ? '已排队自动重试，等它跑完再手动重跑'
                      : diagnosis.actions.resume.reason ??
                        `只重跑没有产出的 ${diagnosis.actions.resume.pending} 个任务，已完成的产出保留`
                  }
                  onClick={() => onRerun?.('resume')}
                >
                  <RotateCcw size={12} /> 继续重跑
                </button>
                <button
                  disabled={rerunBusy || !diagnosis.actions.fresh.available}
                  title={diagnosis.actions.fresh.reason ?? '按当前画布重新规划并跑完整轮'}
                  onClick={() => onRerun?.('fresh')}
                >
                  整轮重跑
                </button>
                {onUserView && (
                  <button
                    disabled={userViewBusy || !diagnosis.actions.userView.available}
                    title={diagnosis.actions.userView.reason ?? '启动项目并截图检查'}
                    onClick={onUserView}
                  >
                    <Eye size={12} /> {userViewBusy ? '验收中…' : '用户视角验收'}
                  </button>
                )}
                {rerunBusy && <span className="muted">正在发起重跑…</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
