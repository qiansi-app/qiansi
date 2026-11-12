import { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2, X } from 'lucide-react';

/**
 * Keys & quota, laid out the way CC Switch taught people to expect: every
 * subscription is a row with a meter, and the one you want used is the one
 * marked active. Secrets go straight into the vault — the server never sends
 * them back.
 */

interface KeyView {
  id: string;
  label: string;
  vaultRef: string;
  enabled: boolean;
  billing: 'subscription' | 'metered';
  quota: { period: 'day' | 'month'; limitTokens: number } | null;
  spentTokens: number;
  spentCny: number;
  limitTokens: number | null;
  percent: number | null;
  state: 'unlimited' | 'ok' | 'warn' | 'exhausted';
  active: boolean;
  lastUsedAt?: number;
}

interface SlotView {
  slot: string;
  label: string;
  activeKeyId: string;
  keys: KeyView[];
  headroomTokens: number;
  state: 'ok' | 'warn' | 'exhausted' | 'unconfigured';
  periodResetsAt: number | null;
  prices?: { in: number; out: number };
  /** 整个厂商被停用：评审团、接续编排与运行都不会再用它。 */
  disabled?: boolean;
}

interface KeysModalProps {
  open: boolean;
  onClose: () => void;
}

const BILLING_LABEL: Record<string, string> = { subscription: '订阅', metered: '按量' };

const STRATEGIES: Array<{ id: 'performance' | 'subscription' | 'cost'; label: string; hint: string }> = [
  { id: 'performance', label: '性能优先', hint: '先用最强模型，不计计费类型' },
  { id: 'subscription', label: '订阅优先', hint: '先用已付费订阅的 Key，同类里挑更强的' },
  { id: 'cost', label: '成本优先', hint: '按每百万 token 的边际花费从低到高' },
];

const STATE_LABEL: Record<string, string> = {
  ok: '正常',
  warn: '接近上限',
  exhausted: '已用尽',
  unconfigured: '未配置',
  unlimited: '不限',
};

function formatTokens(value: number): string {
  if (value < 0) return '不限';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function KeysModal({ open, onClose }: KeysModalProps) {
  const [slots, setSlots] = useState<SlotView[]>([]);
  const [strategy, setStrategy] = useState<'performance' | 'subscription' | 'cost'>('subscription');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: '', secret: '', limit: '', period: 'month' as 'day' | 'month' });
  const [editing, setEditing] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState({ limit: '', period: 'month' as 'day' | 'month' });

  const load = async () => {
    try {
      const response = await fetch('/api/keys');
      const data = (await response.json()) as {
        slots?: SlotView[];
        strategy?: 'performance' | 'subscription' | 'cost';
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setSlots(data.slots ?? []);
      if (data.strategy) setStrategy(data.strategy);
      setError('');
    } catch {
      setError('连不上本地服务');
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  const call = async (path: string, init?: RequestInit) => {
    setBusy(true);
    try {
      const response = await fetch(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      const data = (await response.json().catch(() => null)) as { slots?: SlotView[]; error?: string } | null;
      if (!response.ok) {
        setError(data?.error ?? `HTTP ${response.status}`);
        return false;
      }
      if (data?.slots) setSlots(data.slots);
      setError('');
      return true;
    } catch {
      setError('请求失败');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addKey = async (slot: string) => {
    const quota =
      Number(draft.limit) > 0
        ? { period: draft.period, limitTokens: Number(draft.limit) }
        : undefined;
    const ok = await call('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ slot, label: draft.label, secret: draft.secret, quota }),
    });
    if (ok) {
      setAdding(null);
      setDraft({ label: '', secret: '', limit: '', period: 'month' });
    }
  };

  const saveQuota = async (slot: string, keyId: string) => {
    const limit = Number(quotaDraft.limit);
    const ok = await call(`/api/keys/${slot}/${keyId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quota: limit > 0 ? { period: quotaDraft.period, limitTokens: limit } : null,
      }),
    });
    if (ok) setEditing(null);
  };

  /** 整个厂商停用/启用：欠费或被停用的 key 不该再被评审团和接续编排选中。 */
  const toggleSlot = async (slot: SlotView) => {
    const current = await fetch('/api/model-policy')
      .then((response) => response.json() as Promise<{ disabledSlots?: string[] }>)
      .catch(() => null);
    const list = new Set(current?.disabledSlots ?? []);
    if (slot.disabled) list.delete(slot.slot);
    else list.add(slot.slot);
    const ok = await call('/api/model-policy', {
      method: 'PUT',
      body: JSON.stringify({ disabledSlots: [...list] }),
    });
    if (ok) await load();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal report-modal keys-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">密钥与额度</div>
            <div className="modal-sub">
              每个订阅一行：用量按本地记账估算，用尽自动切到下一个可用 Key；运行前会绕开没有额度的模型家族。
            </div>
          </div>
          <div className="modal-actions">
            <button className="icon-tool" onClick={() => void load()} disabled={busy} title="刷新">
              <RefreshCw size={15} className={busy ? 'spin' : undefined} />
            </button>
            <button className="icon-tool" onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </div>
        </div>

        {error && <div className="keys-error">{error}</div>}

        <div className="keys-strategy">
          <span className="keys-strategy-label">工作流路由</span>
          {STRATEGIES.map((item) => (
            <button
              key={item.id}
              className={`keys-strategy-chip ${strategy === item.id ? 'active' : ''}`}
              title={item.hint}
              onClick={() => {
                setStrategy(item.id);
                void call('/api/keys/strategy', {
                  method: 'PUT',
                  body: JSON.stringify({ strategy: item.id }),
                });
              }}
            >
              {item.label}
            </button>
          ))}
          <span className="keys-strategy-hint">
            {STRATEGIES.find((item) => item.id === strategy)?.hint}
          </span>
        </div>

        <div className="keys-list">
          {slots.map((slot) => (
            <section key={slot.slot} className={`keys-slot ${slot.state}`}>
              <header>
                <span className="keys-slot-name">
                  <KeyRound size={14} /> {slot.label}
                </span>
                <span className={`keys-chip ${slot.state}`}>
                  {STATE_LABEL[slot.state] ?? slot.state}
                  {slot.headroomTokens >= 0 ? ` · 余 ${formatTokens(slot.headroomTokens)}` : ''}
                </span>
                {slot.disabled && <span className="keys-badge muted">已停用</span>}
                <button
                  className="keys-mini"
                  title="停用后，评审团、接续编排与运行都不会再选这家模型"
                  onClick={() => void toggleSlot(slot)}
                >
                  {slot.disabled ? '启用' : '停用'}
                </button>
                <button className="keys-mini" onClick={() => setAdding(adding === slot.slot ? null : slot.slot)}>
                  <Plus size={12} /> 添加 Key
                </button>
              </header>

              {slot.keys.length === 0 && <div className="keys-empty">还没有可用 Key。</div>}

              {slot.keys.map((key) => (
                <div key={key.id} className={`keys-row ${key.active ? 'active' : ''} ${key.state}`}>
                  <div className="keys-row-main">
                    <div className="keys-row-title">
                      <b>{key.label}</b>
                      {key.active && <span className="keys-badge">当前</span>}
                      <span className={`keys-badge billing ${key.billing}`}>
                        {BILLING_LABEL[key.billing]}
                      </span>
                      {!key.enabled && <span className="keys-badge muted">已停用</span>}
                      <code>{key.vaultRef}</code>
                    </div>
                    <div className="keys-meter">
                      <div
                        className={`keys-meter-fill ${key.state}`}
                        style={{ width: `${key.percent ?? 100}%` }}
                      />
                    </div>
                    <div className="keys-row-meta">
                      {key.quota
                        ? `${formatTokens(key.spentTokens)} / ${formatTokens(key.quota.limitTokens)} · ${
                            key.quota.period === 'day' ? '每日' : '每月'
                          }重置`
                        : `已用 ${formatTokens(key.spentTokens)} · 未设额度`}
                      {key.spentCny > 0 ? ` · 约 ¥${key.spentCny.toFixed(2)}` : ''}
                    </div>
                  </div>

                  <div className="keys-row-actions">
                    {editing === `${slot.slot}/${key.id}` ? (
                      <div className="keys-quota-edit">
                        <select
                          value={quotaDraft.period}
                          onChange={(event) =>
                            setQuotaDraft({ ...quotaDraft, period: event.target.value as 'day' | 'month' })
                          }
                        >
                          <option value="month">每月</option>
                          <option value="day">每日</option>
                        </select>
                        <input
                          type="number"
                          min={0}
                          placeholder="token 上限"
                          value={quotaDraft.limit}
                          onChange={(event) => setQuotaDraft({ ...quotaDraft, limit: event.target.value })}
                        />
                        <button className="keys-mini" onClick={() => void saveQuota(slot.slot, key.id)}>
                          保存
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          className="keys-mini"
                          onClick={() => {
                            setEditing(`${slot.slot}/${key.id}`);
                            setQuotaDraft({
                              limit: key.quota ? String(key.quota.limitTokens) : '',
                              period: key.quota?.period ?? 'month',
                            });
                          }}
                        >
                          额度
                        </button>
                        <button
                          className="keys-mini"
                          title="切换计费类型：订阅（已付费）或按量（每次调用计费）"
                          onClick={() =>
                            void call(`/api/keys/${slot.slot}/${key.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({
                                billing: key.billing === 'subscription' ? 'metered' : 'subscription',
                              }),
                            })
                          }
                        >
                          {key.billing === 'subscription' ? '改按量' : '标为订阅'}
                        </button>
                        {!key.active && (
                          <button
                            className="keys-mini"
                            onClick={() => void call(`/api/keys/${slot.slot}/${key.id}/activate`, { method: 'POST' })}
                          >
                            应用
                          </button>
                        )}
                        <button
                          className="keys-mini"
                          onClick={() =>
                            void call(`/api/keys/${slot.slot}/${key.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ enabled: !key.enabled }),
                            })
                          }
                        >
                          {key.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          className="keys-mini danger"
                          onClick={() => void call(`/api/keys/${slot.slot}/${key.id}`, { method: 'DELETE' })}
                          title="删除这个 Key"
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}

              {adding === slot.slot && (
                <div className="keys-add">
                  <input
                    placeholder="标签，例如：备用账号"
                    value={draft.label}
                    onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  />
                  <input
                    placeholder="API Key（只写入本地保险库，不回显）"
                    type="password"
                    value={draft.secret}
                    onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                  />
                  <div className="keys-add-quota">
                    <select
                      value={draft.period}
                      onChange={(event) => setDraft({ ...draft, period: event.target.value as 'day' | 'month' })}
                    >
                      <option value="month">每月</option>
                      <option value="day">每日</option>
                    </select>
                    <input
                      type="number"
                      min={0}
                      placeholder="token 上限（留空=不限）"
                      value={draft.limit}
                      onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
                    />
                    <button className="btn primary" onClick={() => void addKey(slot.slot)} disabled={!draft.secret || busy}>
                      添加
                    </button>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
