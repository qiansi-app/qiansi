import { useEffect, useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';

interface Approval {
  id: string;
  action: string;
  risk: string;
  costEstimate: number;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  resolvedAt?: number;
  note?: string;
}

interface ApprovalsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ApprovalsModal({ open, onClose }: ApprovalsModalProps) {
  const [items, setItems] = useState<Approval[]>([]);

  const load = async () => {
    try {
      const response = await fetch('/api/approvals');
      const data = (await response.json()) as { items?: Approval[] };
      setItems(data.items ?? []);
    } catch {
      setItems([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  const resolve = async (id: string, decision: 'approved' | 'denied') => {
    try {
      await fetch(`/api/approvals/${id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch {
      // keep the list; the next poll retries
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal report-modal"
        role="dialog"
        aria-modal="true"
        aria-label="待审批"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">待审批动作</div>
            <div className="modal-sub">
              下属模型通过 MCP 请求执行危险动作时，会出现在这里。
            </div>
          </div>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="report-body">
          {items.length === 0 && (
            <div className="empty">
              没有待审批动作。主控 agent 通过 MCP 调用 `request_approval` 时会在这里询问你。
            </div>
          )}

          {items.map((item) => (
            <div key={item.id} className="report-task approval-item">
              <div className="report-task-head">
                <ShieldAlert size={14} />
                <strong>{item.action}</strong>
                <span className={`acceptance-badge ${item.status === 'approved' ? 'ok' : item.status === 'denied' ? 'fail' : 'warn'}`}>
                  {item.status === 'pending' ? '等待你' : item.status === 'approved' ? '已批准' : '已拒绝'}
                </span>
                <span className="report-score">
                  {item.risk} · ¥{item.costEstimate.toFixed(2)} ·{' '}
                  {new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
              </div>

              {item.status === 'pending' && (
                <div className="probe-row" style={{ marginTop: 8 }}>
                  <button className="btn primary" onClick={() => void resolve(item.id, 'approved')}>
                    <Check size={13} /> 批准
                  </button>
                  <button className="btn" onClick={() => void resolve(item.id, 'denied')}>
                    <X size={13} /> 拒绝
                  </button>
                </div>
              )}

              {item.note && <div className="field-hint">{item.note}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
