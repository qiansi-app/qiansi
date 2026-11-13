import { useEffect, useRef, useState } from 'react';
import { Eye, GitBranch, Play, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { switchWorkspace } from '../workspace';

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
  files?: string[];
  proposedBy?: string;
  reviews?: Array<{ by: string; verdict: 'confirm' | 'revise' | 'refute'; note?: string }>;
  checks?: Array<{ cmd: string; ok: boolean; detail?: string }>;
  review?: { ok: boolean; by?: string; note?: string };
  diffStat?: string;
  diff?: string;
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
  rootDir?: string;
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
  canvasWorkspaceId?: string | null;
  panel?: string[];
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
  /** 有 key 的模型候选：评审团从这里取。 */
  roster?: string[];
}

interface VersionsPayload {
  ok: boolean;
  branch?: string;
  clean?: boolean;
  active?: string | null;
  versions: Version[];
  error?: string;
}

interface SessionSummary {
  id: string;
  mode: string;
  level: string;
  status: string;
  tokens: number;
  findings: number;
  applied: number;
  failed: number;
  versions: number;
  error?: string;
  hasReport?: boolean;
  startedAt: number;
  finishedAt?: number;
}

interface LandingItem {
  id: string;
  title: string;
  short: string;
  files: string[];
  createdAt: number;
  exists: boolean;
  landed: boolean;
  subject?: string;
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
  /** 被优化的项目目录：留空 = 牵丝自己；其它项目填绝对路径。 */
  const [rootDir, setRootDir] = useState('');
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [watch, setWatch] = useState<{ id: string; stat: string; diff: string } | null>(null);
  const [toast, setToast] = useState('');
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [report, setReport] = useState<{ id: string; text: string } | null>(null);
  const [landing, setLanding] = useState<{ branch: string; head: string; items: LandingItem[] } | null>(null);
  /** 展开证据（校验/复核/diff）的那条问题。 */
  const [evidence, setEvidence] = useState<string | null>(null);
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

  /** 历史/报告/核验/版本都要落在「被优化的那个仓库」上，不能默认成牵丝自己。 */
  const scopeRoot = () => (rootDir.trim() || session?.rootDir || '').trim();
  const scopeQuery = () => {
    const scope = scopeRoot();
    return scope ? `?rootDir=${encodeURIComponent(scope)}` : '';
  };

  const loadVersions = async () => {
    try {
      const response = await fetch(`/api/selfopt/versions${scopeQuery()}`);
      const body = (await response.json()) as VersionsPayload;
      setVersions(body);
    } catch {
      // 版本区加载失败不影响主流程
    }
  };

  const loadHistory = async () => {
    try {
      const scope = scopeRoot();
      const response = await fetch(
        `/api/selfopt/sessions${scope ? `?rootDir=${encodeURIComponent(scope)}` : ''}`
      );
      const body = (await response.json()) as { ok?: boolean; sessions?: SessionSummary[] };
      setHistory(body.sessions ?? []);
    } catch {
      // 历史加载失败不影响当前轮
    }
  };

  /** 每条优化做过什么、验过什么、有没有提交，都在报告里。 */
  const showReport = async (id: string) => {
    try {
      const scope = scopeRoot();
      const response = await fetch(
        `/api/selfopt/sessions/${encodeURIComponent(id)}/report${scope ? `?rootDir=${encodeURIComponent(scope)}` : ''}`
      );
      const body = (await response.json()) as { ok?: boolean; report?: string; error?: string };
      if (!body.ok || !body.report) {
        setError(body.error === 'report_not_found' ? '这轮还没有生成报告（可能是旧版本跑的）。' : body.error ?? '报告读取失败');
        return;
      }
      setError('');
      setReport({ id, text: body.report });
    } catch {
      setError('报告读取失败');
    }
  };

  /** 只信 git：版本记录里的提交是否仍在当前分支上。 */
  const checkLanding = async () => {
    try {
      const scope = scopeRoot();
      const response = await fetch(
        `/api/selfopt/landing${scope ? `?rootDir=${encodeURIComponent(scope)}` : ''}`
      );
      const body = (await response.json()) as {
        ok?: boolean;
        branch?: string;
        head?: string;
        items?: LandingItem[];
        error?: string;
      };
      if (!body.ok) {
        setError(body.error ?? '落地核验失败');
        return;
      }
      setError('');
      setLanding({ branch: body.branch ?? '', head: body.head ?? '', items: body.items ?? [] });
    } catch {
      setError('落地核验失败');
    }
  };

  const loadForecast = async (nextMode = mode, nextLevel = level, nextBudget = budget) => {    try {
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
    if (session?.status === 'running') return;
    // 换了被优化的仓库：版本、历史、落地都跟着换，不能继续显示上一个仓库的。
    void loadVersions();
    void loadHistory();
  }, [open, rootDir, session?.rootDir]);

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
        void loadHistory();
      }
    }, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, session?.status]);

  const start = async (overrides?: { mode?: string; level?: string; budget?: number; rootDir?: string }) => {
    const useMode = overrides?.mode ?? mode;
    const useLevel = overrides?.level ?? level;
    const useBudget = overrides?.budget ?? budget;
    const useRootDir = overrides?.rootDir ?? rootDir;
    setBusy(true);
    setError('');
    setToast('');
    setReport(null);
    setLanding(null);
    try {
      const response = await fetch('/api/selfopt/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: useMode,
          level: useLevel,
          maxTokens: useBudget,
          maxRounds,
          rootDir: useRootDir.trim() || undefined,
        }),
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
      const response = await fetch(
        `/api/selfopt/versions/${encodeURIComponent(version.id)}/diff${scopeQuery()}`
      );
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
      const response = await fetch(
        `/api/selfopt/versions/${encodeURIComponent(version.id)}/switch${scopeQuery()}`,
        { method: 'POST' }
      );
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
      const response = await fetch(`/api/selfopt/restore${scopeQuery()}`, { method: 'POST' });
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

        {meta?.roster && meta.roster.length > 0 && (
          <div className="selfopt-forecast">
            评审团：
            <b>
              {meta.roster.slice(0, 5).join(' · ')}
              {meta.roster.length > 5 ? ` 等 ${meta.roster.length} 个模型` : ''}
            </b>
            <span className="attention-hint">
              {' '}
              · 各自独立复盘 → 互相质询（确认/修正/驳回）→ 综合合稿；只有一个模型时自动退回单模型
            </span>
          </div>
        )}

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
          <div className="selfopt-label">项目</div>
          <div className="selfopt-controls">
            <label style={{ flex: 1 }}>
              被优化的仓库（留空 = 牵丝自己）
              <input
                className="selfopt-input"
                style={{ width: '100%' }}
                value={rootDir}
                disabled={running}
                onChange={(event) => setRootDir(event.target.value)}
                placeholder="例如 E:/some-project（必须是 git 仓库）"
              />
            </label>
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

            {session.status === 'failed' && (
              <div className="selfopt-failure">
                <b>本轮没有落地任何改动</b>
                <span>{session.error ?? session.stages.find((stage) => stage.status === 'failed')?.detail ?? '未知错误'}</span>
                <button
                  className="keys-mini"
                  onClick={() =>
                    void start({
                      mode: session.mode,
                      level: session.level,
                      budget: session.budget.maxTokens,
                      rootDir: session.rootDir ?? rootDir,
                    })
                  }
                >
                  按同样设置重试
                </button>
              </div>
            )}

            {session.findings.length > 0 && (
              <div className="attention-list">
                {session.findings.map((finding) => {
                  const open = evidence === finding.id;
                  return (
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
                      {(finding.checks?.length ?? 0) > 0 && (
                        <span className="attention-hint">
                          校验：
                          {finding.checks!
                            .map((check) => `${check.cmd} ${check.ok ? '✓' : '✗'}`)
                            .join(' · ')}
                          {finding.review ? ` · 复核${finding.review.ok ? '通过' : '驳回'}` : ''}
                          {finding.commit ? ` · 提交 ${finding.commit}` : ''}
                        </span>
                      )}
                      {(finding.proposedBy || (finding.reviews?.length ?? 0) > 0) && (
                        <span className="attention-hint">
                          {finding.proposedBy ? `提出：${finding.proposedBy}` : ''}
                          {(finding.reviews?.length ?? 0) > 0
                            ? `${finding.proposedBy ? ' · ' : ''}互审：${finding.reviews!
                                .filter((review) => review.verdict === 'confirm').length} 确认 / ${finding.reviews!
                                .filter((review) => review.verdict === 'revise').length} 修正 / ${finding.reviews!
                                .filter((review) => review.verdict === 'refute').length} 驳回`
                            : ''}
                        </span>
                      )}
                      {(finding.diffStat || finding.diff) && (
                        <>
                          <button
                            className="keys-mini"
                            onClick={() => setEvidence(open ? null : finding.id)}
                          >
                            {open ? '收起证据' : '查看证据'}
                          </button>
                          {open && (
                            <div className="selfopt-evidence">
                              {finding.diffStat && <pre>{finding.diffStat}</pre>}
                              {finding.diff && <pre>{finding.diff}</pre>}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {session.error && <div className="keys-error">{session.error}</div>}

            {session.canvasWorkspaceId && (
              <div className="selfopt-forecast">
                体检与问题已同步到画布
                <button
                  className="keys-mini"
                  style={{ marginLeft: 8 }}
                  onClick={() => session.canvasWorkspaceId && switchWorkspace(session.canvasWorkspaceId)}
                >
                  去画布看问题
                </button>
              </div>
            )}

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

        {history.length > 0 && (
          <div className="selfopt-history">
            <div className="selfopt-label">历史优化（{history.length}）· 点「报告」看每轮改了什么</div>
            {history.slice(0, 8).map((item) => (
              <div key={item.id} className={`selfopt-history-item ${item.status}`}>
                <div>
                  <b>
                    {timeLabel(item.startedAt)} · {item.mode}/{item.level} · {item.status}
                  </b>
                  <span>
                    {item.findings} 条问题 · 落地 {item.applied} · 提交 {item.versions} · {k(item.tokens)} tokens
                    {item.error ? ` · ${item.error.slice(0, 48)}` : ''}
                  </span>
                </div>
                <button
                  className="keys-mini"
                  onClick={() => void showReport(item.id)}
                  disabled={!item.hasReport}
                  title={item.hasReport ? '查看这轮的报告：改了什么、验过什么、提交在哪' : '这轮没有报告'}
                >
                  报告
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="selfopt-landing">
          <button className="keys-mini" onClick={() => void checkLanding()} title="逐条检查优化提交是否仍在当前分支上">
            <GitBranch size={12} /> 核验落地（git）
          </button>
          {landing && (
            <div className="selfopt-landing-list">
              <div className="attention-hint">
                分支 {landing.branch} @ {landing.head} · {landing.items.filter((item) => item.landed).length}/
                {landing.items.length} 条优化仍在当前分支
              </div>
              {landing.items.map((item) => (
                <div key={item.id} className={`selfopt-landing-item ${item.landed ? 'ok' : 'missing'}`}>
                  <span>
                    {item.landed ? '✓' : '✗'} {item.short} · {item.title}
                  </span>
                  <em>{item.landed ? '已落地' : item.exists ? '不在当前分支' : '提交不存在'}</em>
                </div>
              ))}
            </div>
          )}
        </div>

        {report && (
          <div className="selfopt-report">
            <div className="selfopt-label">
              优化报告 · {report.id}
              <button className="keys-mini" onClick={() => setReport(null)}>
                收起
              </button>
            </div>
            <pre>{report.text}</pre>
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
