import { useEffect, useState } from 'react';
import { AlertTriangle, CircleStop, Eye, ShieldAlert, X } from 'lucide-react';

/**
 * 「需要人工」统一收件箱（借鉴 DSH：面板先列需要人的事，健康不占空间）。
 * 四类信号：待审批、评委标记需人工、失败的运行、被中断的运行。
 */

interface AttentionItem {
  runId?: string;
  goal?: string;
  taskId?: string;
  reasons?: string[];
  action?: string;
  risk?: string;
  costEstimate?: number;
  createdAt?: number;
  at?: number;
  tasks?: string[];
  id?: string;
}

interface Attention {
  total: number;
  approvals: AttentionItem[];
  judgeReviews: AttentionItem[];
  failedRuns: AttentionItem[];
  interrupted: AttentionItem[];
}

interface AttentionModalProps {
  open: boolean;
  onClose: () => void;
}

const timeAgo = (ts?: number) =>
  ts ? `${Math.max(1, Math.round((Date.now() - ts) / 60000))} 分钟前` : '';

export function AttentionModal({ open, onClose }: AttentionModalProps) {
  const [data, setData] = useState<Attention | null>(null);
  const [error, setError] = useState('');
  const [resuming, setResuming] = useState<string | null>(null);

  const resume = async (runId?: string) => {
    if (!runId) return;
    setResuming(runId);
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: `ui-resume-${runId}-${Date.now()}`,
          type: 'run.start',
          payload: { mode: 'live', resumeOf: runId, autoResume: true },
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) {
        setError(body?.error ?? `续跑失败：HTTP ${response.status}`);
      } else {
        onClose();
      }
    } catch {
      setError('续跑请求失败');
    } finally {
      setResuming(null);
    }
  };

  const load = async () => {
    try {
      const response = await fetch('/api/attention');
      const body = (await response.json()) as Partial<Attention> & { ok?: boolean };
      setData({ total: body.total ?? 0, approvals: body.approvals ?? [], judgeReviews: body.judgeReviews ?? [], failedRuns: body.failedRuns ?? [], interrupted: body.interrupted ?? [] });
      setError('');
    } catch {
      setError('连不上本地服务');
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  const empty = data && data.total === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal report-modal attention-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">需要人工</div>
            <div className="modal-sub">只列需要你处理的事；没有待处理时这里就是空的。</div>
          </div>
          <button className="icon-tool" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        {error && <div className="keys-error">{error}</div>}
        {empty && <div className="attention-empty">✓ 没有待处理的事项。</div>}

        <div className="attention-list">
          {data && data.approvals.length > 0 && (
            <section>
              <h4>
                <ShieldAlert size={13} /> 待审批（{data.approvals.length}）
              </h4>
              {data.approvals.map((item) => (
                <div key={item.id} className="attention-item">
                  <b>{item.action}</b>
                  <span>风险 {item.risk} · 预估 ¥{item.costEstimate} · {timeAgo(item.createdAt)}</span>
                </div>
              ))}
              <div className="attention-hint">在「更多 → 审批」里处理。</div>
            </section>
          )}

          {data && data.judgeReviews.length > 0 && (
            <section>
              <h4>
                <Eye size={13} /> 评委标记需人工确认（{data.judgeReviews.length}）
              </h4>
              {data.judgeReviews.map((item, index) => (
                <div key={`${item.runId}-${item.taskId}-${index}`} className="attention-item">
                  <b>{item.goal?.slice(0, 40) || item.runId?.slice(0, 8)}</b>
                  <span>任务 {item.taskId} · {item.reasons?.join('；').slice(0, 80)} · {timeAgo(item.at)}</span>
                </div>
              ))}
            </section>
          )}

          {data && data.failedRuns.length > 0 && (
            <section>
              <h4>
                <AlertTriangle size={13} /> 失败的运行（{data.failedRuns.length}）
              </h4>
              {data.failedRuns.map((item) => (
                <div key={item.runId} className="attention-item">
                  <b>{item.goal?.slice(0, 40) || item.runId?.slice(0, 8)}</b>
                  <span>{item.tasks?.length ?? 0} 个任务 · {timeAgo(item.at)}</span>
                  <button
                    className="keys-mini"
                    disabled={resuming === item.runId}
                    onClick={() => void resume(item.runId)}
                    title="只跑未完成的任务，已完成的产出作为上游"
                  >
                    {resuming === item.runId ? '发起中…' : '续跑'}
                  </button>
                </div>
              ))}
            </section>
          )}

          {data && data.interrupted.length > 0 && (
            <section>
              <h4>
                <CircleStop size={13} /> 被中断的运行（{data.interrupted.length}）
              </h4>
              {data.interrupted.map((item) => (
                <div key={item.runId} className="attention-item">
                  <b>{item.goal?.slice(0, 40) || item.runId?.slice(0, 8)}</b>
                  <span>{timeAgo(item.at)} · 服务重启所致</span>
                  <button
                    className="keys-mini"
                    disabled={resuming === item.runId}
                    onClick={() => void resume(item.runId)}
                    title="只跑未完成的任务，已完成的产出作为上游"
                  >
                    {resuming === item.runId ? '发起中…' : '续跑'}
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
