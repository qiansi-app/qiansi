import { useState } from 'react';
import {
  Bell,
  Bot,
  Check,
  MessageSquare,
  Palette,
  Power,
  Send,
  Settings2,
  X,
} from 'lucide-react';
import type { AppSettings } from '../data/settings';

type Tab = 'general' | 'appearance' | 'agent' | 'feedback';

interface SettingsModalProps {
  open: boolean;
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

export function SettingsModal({ open, settings, onChange, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>('general');
  const [feedback, setFeedback] = useState('');
  const [contact, setContact] = useState('');
  const [feedbackState, setFeedbackState] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle');

  if (!open) return null;

  const set = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });

  const submitFeedback = async () => {
    const message = feedback.trim();
    if (!message) return;
    setFeedbackState('sending');
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, contact: contact.trim() }),
      });
      if (!response.ok) throw new Error('feedback failed');
      setFeedbackState('ok');
      setFeedback('');
    } catch {
      setFeedbackState('error');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div className="drawer-avatar" style={{ ['--accent' as string]: '#6ea8fe' }}>
            <Settings2 size={16} />
          </div>
          <div>
            <div className="modal-title">设置</div>
            <div className="modal-sub">通知 · 外观 · Agent 接入 · 反馈</div>
          </div>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            <button className={`settings-nav-item ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>
              <Bell size={14} /> 通用
            </button>
            <button className={`settings-nav-item ${tab === 'appearance' ? 'active' : ''}`} onClick={() => setTab('appearance')}>
              <Palette size={14} /> 外观
            </button>
            <button className={`settings-nav-item ${tab === 'agent' ? 'active' : ''}`} onClick={() => setTab('agent')}>
              <Bot size={14} /> Agent
            </button>
            <button className={`settings-nav-item ${tab === 'feedback' ? 'active' : ''}`} onClick={() => setTab('feedback')}>
              <MessageSquare size={14} /> 反馈
            </button>
          </nav>

          <div className="settings-pane">
            {tab === 'general' && (
              <>
                <div className="setting-row">
                  <div>
                    <div className="setting-title">
                      <Bell size={13} /> 运行完成通知
                    </div>
                    <div className="setting-desc">
                      总任务结束时显示桌面通知。首次开启会请求浏览器通知权限。
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={settings.notifications}
                    onChange={(event) => set({ notifications: event.target.checked })}
                  />
                </div>

                <div className="setting-row">
                  <div>
                    <div className="setting-title">
                      <Power size={13} /> 开机自启
                    </div>
                    <div className="setting-desc">
                      桌面版会注册开机启动；本地 Web 模式仅保存偏好。
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={settings.autostart}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      set({ autostart: enabled });
                      const api = window as unknown as {
                        qiansi?: {
                          setAutostart?: (value: boolean) => Promise<unknown>;
                        };
                        agentweave?: {
                          setAutostart?: (value: boolean) => Promise<unknown>;
                        };
                      };
                      const bridge = api.qiansi ?? api.agentweave;
                      void bridge?.setAutostart?.(enabled);
                    }}
                  />
                </div>

                <div className="setting-row">
                  <div>
                    <div className="setting-title">
                      <Power size={13} /> 预算上限
                    </div>
                    <div className="setting-desc">
                      防止模型死循环浪费 token。超过上限会中止当前运行并提示。
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flex: '0 0 260px' }}>
                    <label style={{ flex: 1, fontSize: 10, color: 'var(--muted)' }}>
                      每次运行
                      <input
                        type="number"
                        min={1000}
                        step={1000}
                        value={settings.maxTokensPerRun}
                        onChange={(event) =>
                          set({ maxTokensPerRun: Math.max(0, Number(event.target.value) || 0) })
                        }
                        style={{
                          width: '100%',
                          height: 30,
                          marginTop: 4,
                          borderRadius: 7,
                          border: '1px solid var(--border)',
                          background: '#0d1217',
                          color: 'var(--text)',
                          padding: '0 8px',
                        }}
                      />
                    </label>
                    <label style={{ flex: 1, fontSize: 10, color: 'var(--muted)' }}>
                      每分钟
                      <input
                        type="number"
                        min={500}
                        step={500}
                        value={settings.maxTokensPerMinute}
                        onChange={(event) =>
                          set({
                            maxTokensPerMinute: Math.max(0, Number(event.target.value) || 0),
                          })
                        }
                        style={{
                          width: '100%',
                          height: 30,
                          marginTop: 4,
                          borderRadius: 7,
                          border: '1px solid var(--border)',
                          background: '#0d1217',
                          color: 'var(--text)',
                          padding: '0 8px',
                        }}
                      />
                    </label>
                  </div>
                </div>
              </>
            )}

            {tab === 'appearance' && (
              <>
                <div className="field">
                  <label>主题</label>
                  <select
                    value={settings.theme}
                    onChange={(event) => set({ theme: event.target.value as AppSettings['theme'] })}
                  >
                    <option value="dark">深色（默认）</option>
                    <option value="light">浅色</option>
                  </select>
                </div>
                <div className="field">
                  <label>节点密度</label>
                  <select
                    value={settings.density}
                    onChange={(event) => set({ density: event.target.value as AppSettings['density'] })}
                  >
                    <option value="comfortable">舒适</option>
                    <option value="compact">紧凑</option>
                  </select>
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-title">画布显示任务模块</div>
                    <div className="setting-desc">
                      运行后可以把子任务拉到画布上；关闭后这些任务模块会隐藏，但不会被删除。
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={settings.showTasks}
                    onChange={(event) => set({ showTasks: event.target.checked })}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-title">流程线上显示产物</div>
                    <div className="setting-desc">
                      把每个任务的次级产物与最终产物显示在连线上，点击即可追溯问题出现在哪一步。
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={settings.showArtifacts}
                    onChange={(event) => set({ showArtifacts: event.target.checked })}
                  />
                </div>
                <div className="field-hint">主题与密度即时生效，保存在本机浏览器。</div>
              </>
            )}

            {tab === 'agent' && (
              <>
                <div className="field">
                  <label>附着的主流 Agent</label>
                  <select
                    value={settings.agent}
                    onChange={(event) => set({ agent: event.target.value as AppSettings['agent'] })}
                  >
                    <option value="claude-code">Claude Code（推荐，支持 MCP）</option>
                    <option value="codex">Codex</option>
                    <option value="cursor">Cursor</option>
                    <option value="none">暂不接入</option>
                  </select>
                </div>
                <div className="field-hint">
                  这里保存偏好。MCP server 与模型网关在下一阶段接入后，这个选择决定画布作为谁的下属模型池。
                </div>
              </>
            )}

            {tab === 'feedback' && (
              <>
                <div className="field">
                  <label>问题或建议</label>
                  <textarea
                    className="feedback-input"
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                    placeholder="描述发生了什么、你期望什么、如何复现…"
                  />
                </div>
                <div className="field">
                  <label>联系方式（可选）</label>
                  <input
                    value={contact}
                    onChange={(event) => setContact(event.target.value)}
                    placeholder="邮箱 / GitHub / 其他"
                  />
                </div>
                <div className="probe-row">
                  <button
                    className="btn primary"
                    onClick={submitFeedback}
                    disabled={!feedback.trim() || feedbackState === 'sending'}
                  >
                    <Send size={13} /> {feedbackState === 'sending' ? '提交中…' : '提交反馈'}
                  </button>
                  {feedbackState === 'ok' && (
                    <span className="probe-result ok">
                      <Check size={12} /> 已记录到本地反馈日志
                    </span>
                  )}
                  {feedbackState === 'error' && (
                    <span className="probe-result fail">提交失败，请确认本地服务已启动</span>
                  )}
                </div>
                <div className="field-hint">
                  当前反馈写入本机 `~/.qiansi/feedback.jsonl`，不上传第三方。接入 GitHub Issues 后会替换为在线提交。
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
