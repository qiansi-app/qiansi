import { useEffect, useRef, useState } from 'react';
import { Eye, GitBranch, Play, RotateCcw, Sparkles, Square, X } from 'lucide-react';

/**
 * 自我优化面板：选模式和程度 → 看预算预测 → 跑 → 看阶段与问题 → 在版本之间切换。
 * 后端是 SelfOptEngine：体检、对标、复盘、执行、校验、快照六段。
 */

interface ModeSpec {
  id: string;
  label: string;
  blurb: string;
  does: string[];
  avoids: string[];
  search: boolean;
}

interface LevelSpec {
  id: string;
  label: string;
  blurb: string;
  writes: boolean;
  commits: boolean;
  iterates: boolean;
}

interface Stage {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail?: string;
  tokens?: number;
}

interface Finding {
  id: string;
  title: string;
  kind: string;
  severity: string;
  status: 'proposed' | 'applied' | 'skipped' | 'failed';
  note?: string;
  commit?: string;
}

interface Forecast {
  low: number;
  expected: number;
  high: number;
  rounds: number;
  basis: string;
  overBudget: boolean;
  calibratedFrom: number;
}

interface Session {
  id: string;
  mode: string;
  level: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  round: number;
  usedTokens: number;
  budget: { maxTokens: number; maxRounds: number };
  stages: Stage[];
  findings: Finding[];
  versions: string[];
  forecast?: Forecast;
  error?: string;
  log: string[];
}

interface Version {
  id: string;
  short: string;
  title: string;
  mode: string;
  level: string;
  files: string[];
  tokens: number;
  createdAt: number;
}

interface Meta {
  rootDir?: string;
  branch?: string;
  clean?: boolean;
  dirty?: string[];
  modes: ModeSpec[];
  levels: LevelSpec[];
  defaultBudget: { tokens: number; rounds: number };
  safety: string[];
}

interface VersionsPayload {
  ok: boolean;
  branch?: string;
  clean?: boolean;
  active?: string | null;
  versions: Version[];
  error?: string;
}

interface SelfOptModalProps {
  open: boolean;
  onClose: () => void;
}

const k = (value: number) => `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;

const timeLabel = (ts: number) => {
  const date = new Date(ts);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours()
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待',
  running: '中',
  done: '完',
  skipped: '略',
  failed: '错',
};

export function SelfOptModal({ open, onClose }: SelfOptModalProps) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [versions, setVersions] = useState<VersionsPayload | null>(null);
  const [mode, setMode] = useState('repair');
  const [level, setLevel] = useState('L1');
  const [budget, setBudget] = useState(120_000);
  const [maxRounds, setMaxRounds] = useState(3);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [watch, setWatch] = useState<{ id: string; stat: string; diff: string } | null>(null);
  const [toast, setToast] = useState('');
  const pollRef = useRef<number | null>(null);

  const loadStatus = async () => {
    try {
      const response = await fetch('/api/selfopt/status');
      const body = (await response.json()) as { ok?: boolean; session?: Session | null; meta?: Meta };
      if (body.meta) setMeta(body.meta);
      setSession(body.session ?? null);
      return body.session ?? null;
    } catch {
      setError('连不上本地服务');
      return null;
    }
  };

  const loadVersions = async () => {
    try {
      const response = await fetch('/api/selfopt/versions');
      const body = (await response.json()) as VersionsPayload;
      setVersions(body);
    } catch {
      // 版本区加载失败不影响主流程
    }
  };

  const loadForecast = async (nextMode = mode, nextLevel = level, nextBudget = budget) => {
    try {
      const response = await fetch(
        `/api/selfopt/forecast?mode=${nextMode}&level=${nextLevel}&budget=${Math.max(1000, nextBudget)}`
      );
      const body = (await response.json()) as { ok?: boolean; forecast?: Forecast };
      setForecast(body.forecast ?? null);
    } catch {
      setForecast(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    void loadVersions();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!meta) return;
    setBudget((current) => (current > 0 ? current : meta.defaultBudget.tokens));
    setMaxRounds((current) => (current > 0 ? current : meta.defaultBudget.rounds));
    void loadForecast(mode, level, meta.defaultBudget.tokens);
  }, [meta]);

  useEffect(() => {
    if (!open) return;
    void loadForecast(mode, level, budget);
  }, [mode, level, budget]);

  useEffect(() => {
    if (!open) return;
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    if (session?.status !== 'running') return;
    pollRef.current = window.setInterval(async () => {
      const next = await loadStatus();
      if (next && next.status !== 'running') {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        void loadVersions();
      }
    }, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, session?.status]);

  const start = async () => {
    setBusy(true);
    setError('');
    setToast('');
    try {
      const response = await fetch('/api/selfopt/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, level, maxTokens: budget, maxRounds }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; session?: Session; error?: string }
        | null;
      if (!response.ok || !body?.ok) {
        const reason = body?.error ?? `HTTP ${response.status}`;
        setError(
          reason === 'worktree_dirty'
            ? '工作区有未提交改动：请先提交或 stash，再让牵丝改代码。'
            : reason === 'selfopt_in_progress'
              ? '已有一轮自我优化在跑，先等它结束或停止它。'
              : reason === 'not_a_git_repo'
                ? '当前目录不是 git 仓库，自我优化无法留版本。'
                : reason
        );
        return;
      }
      setSession(body.session ?? null);
    } catch {
      setError('启动请求失败');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      const response = await fetch('/api/selfopt/stop', { method: 'POST' });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (body?.ok) setToast('已请求停止，当前步骤结束后停下');
    } catch {
      setError('停止请求失败');
    }
  };

  const viewDiff = async (version: Version) => {
    try {
      const response = await fetch(`/api/selfopt/versions/${encodeURIComponent(version.id)}/diff`);
      const body = (await response.json()) as { ok?: boolean; stat?: string; diff?: string };
      if (!body.ok) {
        setError('拿不到这个版本的差异');
        return;
      }
      setWatch({ id: version.id, stat: body.stat ?? '', diff: body.diff ?? '' });
    } catch {
      setError('差异请求失败');
    }
  };

  const switchTo = async (version: Version) => {
    try {
      const response = await fetch(`/api/selfopt/versions/${encodeURIComponent(version.id)}/switch`, {
        method: 'POST',
      });
      const body = (await response.json()) as { ok?: boolean; branch?: string; error?: string };
      if (!body.ok) {
        setError(body.error === 'worktree_dirty' ? '工作区有未提交改动，先提交或 stash 再切换。' : body.error ?? '切换失败');
        return;
      }
      setToast(`已切到 ${body.branch}`);
      void loadVersions();
    } catch {
      setError('切换请求失败');
    }
  };

  const restore = async () => {
    try {
      const response = await fetch('/api/selfopt/restore', { method: 'POST' });
      const body = (await response.json()) as { ok?: boolean; branch?: string; error?: string };
      if (!body.ok) {
        setError(body.error === 'worktree_dirty' ? '工作区有未提交改动，先提交或 stash。' : body.error ?? '恢复失败');
        return;
      }
      setToast(`已回到 ${body.branch}`);
      void loadVersions();
    } catch {
      setError('恢复请求失败');
    }
  };

  if (!open) return null;

  const modes = meta?.modes ?? [];
  const levels = meta?.levels ?? [];
  const running = session?.status === 'running';
  const levelSpec = levels.find((item) => item.id === level);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal report-modal selfopt-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <Sparkles size={15} /> 自我优化
            </div>
            <div className="modal-sub">
              {meta?.rootDir ? `${meta.rootDir} · ${meta.branch ?? ''}` : '让牵丝自己体检、对标、复盘、改自己'}
              {meta && meta.clean === false ? ' · 工作区有未提交改动' : ''}
            </div>
          </div>
          <button className="icon-tool" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        {error && <div className="keys-error">{error}</div>}
        {toast && <div className="attention-hint">{toast}</div>}

        <div className="selfopt-row">
          <div className="selfopt-label">模式</div>
          <div className="selfopt-grid">
            {modes.map((item) => (
              <button
                key={item.id}
                className={`selfopt-card ${mode === item.id ? 'active' : ''}`}
                onClick={() => setMode(item.id)}
                title={`${item.does.join('；')}\n不做：${item.avoids.join('；')}`}
                disabled={running}
              >
                <b>{item.label}</b>
                <span>{item.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="selfopt-row">
          <div className="selfopt-label">程度</div>
          <div className="selfopt-grid">
            {levels.map((item) => (
              <button
                key={item.id}
                className={`selfopt-card ${level === item.id ? 'active' : ''}`}
                onClick={() => setLevel(item.id)}
                title={item.blurb}
                disabled={running}
              >
                <b>
                  {item.id} {item.label}
                </b>
                <span>{item.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="selfopt-row">
          <div className="selfopt-label">预算</div>
          <div className="selfopt-controls">
            <label>
              上限 tokens
              <input
                className="selfopt-input"
                type="number"
                min={5000}
                step={5000}
                value={budget}
                disabled={running}
                onChange={(event) => setBudget(Number(event.target.value) || 0)}
              />
            </label>
            <label>
              最大轮数
              <input
                className="selfopt-input"
                type="number"
                min={1}
                max={8}
                value={maxRounds}
                disabled={running || !levelSpec?.iterates}
                onChange={(event) => setMaxRounds(Number(event.target.value) || 1)}
              />
            </label>
          </div>
        </div>

        {forecast && (
          <div className={`selfopt-forecast ${forecast.overBudget ? 'over' : ''}`}>
            预计 <b>{k(forecast.low)}</b> – <b>{k(forecast.high)}</b> tokens（中位 {k(forecast.expected)}，
            {forecast.rounds} 轮）
            <span className="attention-hint">
              {' '}
              · {forecast.basis}
              {forecast.calibratedFrom > 0 ? ` · 已按 ${forecast.calibratedFrom} 条历史校准` : ''}
            </span>
            {forecast.overBudget ? <div className="attention-hint">预测超出预算上限，持续档会提前收尾。</div> : null}
          </div>
        )}

        {session && (
          <>
            <div className="selfopt-stages">
              {session.stages.map((stage) => (
                <div
                  key={stage.id}
                  className={`selfopt-stage ${stage.status}`}
                  title={stage.detail ?? stage.label}
                >
                  {stage.label}
                  <em>{STATUS_LABEL[stage.status] ?? stage.status}</em>
                </div>
              ))}
              <div className="selfopt-stage">
                用量<em>{k(session.usedTokens)}</em>
              </div>
            </div>

            {session.findings.length > 0 && (
              <div className="attention-list">
                {session.findings.map((finding) => (
                  <div key={finding.id} className="attention-item">
                    <b>
                      [{finding.severity}/{finding.kind}] {finding.title}
                    </b>
                    <span>
                      {finding.status === 'applied'
                        ? `已提交 ${finding.commit ?? ''}`
                        : finding.status === 'failed'
                          ? `失败：${finding.note ?? ''}`
                          : finding.status === 'skipped'
                            ? `跳过：${finding.note ?? ''}`
                            : '待处理'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {session.error && <div className="keys-error">{session.error}</div>}

            {session.log.length > 0 && (
              <details className="selfopt-log">
                <summary>过程日志（{session.log.length} 条）</summary>
                <pre>{session.log.slice(-40).join('\n')}</pre>
              </details>
            )}
          </>
        )}

        {versions && versions.versions.length > 0 && (
          <div className="selfopt-versions">
            <div className="selfopt-label">
              <GitBranch size={13} /> 版本（{versions.versions.length}）· 当前分支 {versions.branch}
              {versions.clean === false ? ' · 有未提交改动' : ''}
            </div>
            {versions.versions.map((version) => (
              <div key={version.id} className="selfopt-version">
                <div>
                  <b>{version.title}</b>
                  <span>
                    {version.short} · {version.mode}/{version.level} · {version.files.length} 个文件 ·{' '}
                    {k(version.tokens)} tokens · {timeLabel(version.createdAt)}
                  </span>
                </div>
                <div className="selfopt-version-actions">
                  <button className="keys-mini" onClick={() => void viewDiff(version)}>
                    <Eye size={12} /> 查看
                  </button>
                  <button className="keys-mini" onClick={() => void switchTo(version)}>
                    切换
                  </button>
                </div>
              </div>
            ))}
            <button className="keys-mini" onClick={() => void restore()}>
              <RotateCcw size={12} /> 回到原分支
            </button>
          </div>
        )}

        {watch && (
          <div className="selfopt-diff">
            <div className="selfopt-label">
              {watch.stat.split('\n')[0]}
              <button className="keys-mini" onClick={() => setWatch(null)}>
                收起
              </button>
            </div>
            <pre>{watch.diff}</pre>
          </div>
        )}

        <div className="modal-foot">
          <span className="modal-foot-hint">
            {levelSpec?.writes
              ? '会改代码、跑检查、逐条提交；任何一步失败都会回滚这一条。'
              : '只出报告，不改代码。'}
          </span>
          {running ? (
            <button className="btn" onClick={() => void stop()}>
              <Square size={14} /> 停止
            </button>
          ) : (
            <button className="btn primary" disabled={busy || !meta} onClick={() => void start()}>
              <Play size={14} /> {busy ? '发起中…' : '开始'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
