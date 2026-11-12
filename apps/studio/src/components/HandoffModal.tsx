import { useEffect, useRef, useState } from 'react';
import { Link2, Loader2, X } from 'lucide-react';
import { switchWorkspace } from '../workspace';

/**
 * 接续外部 agent 的会话：把最近一段真实对话与项目事实提取成资料包挂到画布，
 * 可选自动编排后续工作流、可选立即运行。
 */

interface HandoffResult {
  ok?: boolean;
  error?: string;
  session?: {
    source: string;
    sessionId: string;
    file: string;
    records: number;
    ageMinutes: number;
    tools: string[];
  } | null;
  project?: { cwd: string; branch: string; files: number } | null;
  pack?: { bytes: number; name: string };
  arranged?: { nodes: number; edges: number };
  archived?: boolean;
  runId?: string | null;
  runError?: string | null;
  workspaceId?: string;
  workspaceName?: string;
  notes?: string[];
}

interface HandoffModalProps {
  open: boolean;
  onClose: () => void;
  /** 设置里「附着的主流 Agent」：决定默认读哪个来源的会话。 */
  defaultSource?: 'claude-code' | 'codex' | 'cursor' | 'none';
}

export function HandoffModal({ open, onClose, defaultSource }: HandoffModalProps) {
  const [source, setSource] = useState<'auto' | 'claude-code' | 'codex'>(() => {
    if (defaultSource === 'claude-code' || defaultSource === 'codex') return defaultSource;
    return 'auto';
  });
  const [cwd, setCwd] = useState('');
  const [autoArrange, setAutoArrange] = useState(true);
  const [autoRun, setAutoRun] = useState(true);
  // 任务原文：留空则从会话里取最后一条真实需求。
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HandoffResult | null>(null);
  const [error, setError] = useState('');
  /** 运行已启动时自动跳到新画布：接管 = 直接看着它跑，而不是留在旧画布。 */
  const jumped = useRef(false);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError('');
    jumped.current = false;
  }, [open]);

  useEffect(() => {
    if (!result?.runId || !result.workspaceId || jumped.current) return;
    jumped.current = true;
    const timer = window.setTimeout(() => {
      switchWorkspace(result.workspaceId as string);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [result]);

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source,
          cwd: cwd.trim() || undefined,
          task: task.trim() || undefined,
          autoArrange,
          autoRun,
        }),
      });
      const data = (await response.json().catch(() => null)) as HandoffResult | null;
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? `HTTP ${response.status}`);
        setResult(data);
      } else {
        setResult(data);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal handoff-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">接续 Agent 会话</div>
            <div className="modal-sub">
              读取最近一段真实对话与项目内容，合成资料包挂到画布；可选自动编排、立即运行。
            </div>
          </div>
          <button className="icon-tool" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="handoff-form">
          <label>
            来源
            <select value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
              <option value="auto">自动（优先 Claude Code）</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            项目目录
            <input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="留空则用服务端当前目录"
            />
          </label>
          <label>
            任务原文
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              rows={3}
              placeholder="留空则取会话里最后一条真实需求；也可以直接写清楚要牵丝做什么"
            />
          </label>
          <label className="handoff-check">
            <input
              type="checkbox"
              checked={autoArrange}
              onChange={(event) => {
                const checked = event.target.checked;
                setAutoArrange(checked);
                // 不编排就没有可运行的节点：立即运行必须跟着关掉，避免静默跳过。
                if (!checked) setAutoRun(false);
              }}
            />
            自动编排工作流（让主控拆解并连线）
          </label>
          <label className="handoff-check">
            <input
              type="checkbox"
              checked={autoRun}
              disabled={!autoArrange}
              title={autoArrange ? undefined : '需要先勾选自动编排，画布才有可运行的节点'}
              onChange={(event) => setAutoRun(event.target.checked)}
            />
            写入后立即运行（会消耗模型额度）
          </label>
          <button className="btn primary" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <Link2 size={13} />}
            {busy ? '读取中…' : '读取并接续'}
          </button>
        </div>

        {error && <div className="keys-error">{error}</div>}

        {result?.session && (
          <div className="handoff-result">
            <div>
              <b>{result.session.source}</b> · {result.session.sessionId.slice(0, 8)} ·{' '}
              {result.session.ageMinutes} 分钟前 · 解析 {result.session.records} 条记录
            </div>
            <div className="handoff-meta">{result.session.file}</div>
            {result.session.tools.length > 0 && (
              <div className="handoff-meta">工具：{result.session.tools.slice(0, 8).join('、')}</div>
            )}
            {result.project && (
              <div className="handoff-meta">
                {result.project.cwd} · {result.project.branch || '非 git'} · {result.project.files} 个文件
              </div>
            )}
            {result.pack && (
              <div className="handoff-meta">
                资料包 {Math.round(result.pack.bytes / 1024)}KB · {result.pack.name}
              </div>
            )}
            {result.arranged && result.arranged.nodes > 0 && (
              <div className="handoff-meta">
                自动编排：新增 {result.arranged.nodes} 个节点、{result.arranged.edges} 条连线
              </div>
            )}
            {result.archived ? (
              <div className="handoff-meta warn">
                自动编排没有产出，资料已保存到「{result.workspaceName ?? '历史画布'}」，可在历史画布里恢复后手动补节点。
              </div>
            ) : (
              result.workspaceName && (
                <div className="handoff-meta">
                  已写入新画布「{result.workspaceName}」
                  {result.workspaceId && (
                    <button
                      className="keys-mini"
                      style={{ marginLeft: 8 }}
                      onClick={() => result.workspaceId && switchWorkspace(result.workspaceId)}
                    >
                      去新画布看进度
                    </button>
                  )}
                </div>
              )
            )}
            {result.runId && (
              <div className="handoff-meta">
                已启动运行：{result.runId.slice(0, 8)} · 正在跳转到新画布看进度…
              </div>
            )}
            {(result.notes ?? []).map((note) => (
              <div key={note} className="handoff-meta warn">
                {note}
              </div>
            ))}
          </div>
        )}
        {!result?.session && result?.ok && (
          <div className="handoff-result">
            没有找到可读的会话记录，只写入了项目上下文。
            {(result.notes ?? []).map((note) => (
              <div key={note} className="handoff-meta warn">
                {note}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
