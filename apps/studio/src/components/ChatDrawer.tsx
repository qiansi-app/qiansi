import { useState } from 'react';
import {
  Boxes,
  Crown,
  ListChecks,
  MessageSquare,
  RotateCcw,
  ScrollText,
  Send,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type { AgentNodeData, EffortLevel } from '../data/demoGraph';
import type { ModelDraft } from '../data/models';
import type { ChatMessage } from '../types';

type Tab = 'chat' | 'tasks' | 'logs' | 'profile';

interface ChatDrawerProps {
  mode: 'node' | 'edge';
  title: string;
  subtitle: string;
  accent: string;
  messages: ChatMessage[];
  node?: AgentNodeData;
  edge?: {
    label?: string;
    kind?: string;
    source: string;
    target: string;
  };
  models: ModelDraft[];
  onClose: () => void;
  onSend: (text: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onModelChange: (connectionId: string) => void;
  onOpenModels: () => void;
  onIdentityChange?: (patch: { name?: string; role?: string }) => void;
  onMakeOrchestrator?: () => void;
  onRerun: () => void;
  onDelete?: () => void;
}

const effortOptions: EffortLevel[] = ['off', 'low', 'medium', 'high', 'max'];

const statusLabel: Record<string, string> = {
  idle: '待命',
  queued: '排队',
  running: '执行中',
  reviewing: '验收中',
  done: '完成',
  failed: '失败',
  blocked: '等待决定',
};

export function ChatDrawer({
  mode,
  title,
  subtitle,
  accent,
  messages,
  node,
  edge,
  models,
  onClose,
  onSend,
  onEffortChange,
  onModelChange,
  onOpenModels,
  onIdentityChange,
  onMakeOrchestrator,
  onRerun,
  onDelete,
}: ChatDrawerProps) {
  const [tab, setTab] = useState<Tab>(mode === 'edge' ? 'logs' : 'chat');
  const [draft, setDraft] = useState('');

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <aside className="drawer" style={{ ['--accent' as string]: accent }}>
      <div className="drawer-head">
        <div className="drawer-avatar">
          <MessageSquare size={16} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="drawer-title">{title}</div>
          <div className="drawer-sub">{subtitle}</div>
        </div>
        <button className="btn ghost drawer-close" onClick={onClose} title="关闭">
          <X size={15} />
        </button>
        {onDelete && (
          <button
            className="btn ghost"
            onClick={onDelete}
            title="删除节点"
            style={{ color: 'var(--red)' }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <nav className="tabs">
        {mode === 'node' && (
          <>
            <button
              className={`tab ${tab === 'chat' ? 'active' : ''}`}
              onClick={() => setTab('chat')}
            >
              <MessageSquare size={12} /> 对话
            </button>
            <button
              className={`tab ${tab === 'tasks' ? 'active' : ''}`}
              onClick={() => setTab('tasks')}
            >
              <ListChecks size={12} /> 任务
            </button>
          </>
        )}
        <button className={`tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          <ScrollText size={12} /> 日志
        </button>
        {mode === 'node' && (
          <button
            className={`tab ${tab === 'profile' ? 'active' : ''}`}
            onClick={() => setTab('profile')}
          >
            <SlidersHorizontal size={12} /> 能力
          </button>
        )}
      </nav>

      {tab === 'chat' && (
        <>
          <div className="drawer-body">
            {messages.length === 0 ? (
              <div className="empty">
                这是与「{title}」的持久会话。
                <br />
                P1 接入真实 provider 后，消息会流式返回。
              </div>
            ) : (
              <div className="messages">
                {messages.map((message) => (
                  <div key={message.id} className={`msg ${message.role}`}>
                    <div className="msg-meta">{message.role === 'user' ? '你' : title}</div>
                    {message.content}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={`给「${title}」发消息…  Enter 发送，Shift+Enter 换行`}
            />
            <div className="composer-actions">
              {node && (
                <select
                  className="select"
                  value={node.effort}
                  onChange={(event) => onEffortChange(event.target.value as EffortLevel)}
                  title="思考程度"
                >
                  {effortOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      effort: {effort}
                    </option>
                  ))}
                </select>
              )}
              {node && (
                <button className="mini-btn" onClick={onRerun} title="重跑当前节点的任务">
                  <RotateCcw size={12} /> 重跑
                </button>
              )}
              <span className="spacer" />
              <button className="btn primary" onClick={send} disabled={!draft.trim()}>
                <Send size={13} /> 发送
              </button>
            </div>
          </div>
        </>
      )}

      {tab === 'tasks' && node && (
        <div className="drawer-body">
          <div className="log-row">
            <time>当前</time>
            <div>
              <strong style={{ color: '#d5dee9' }}>{node.role}</strong>
              <div style={{ marginTop: 3 }}>
                状态：{statusLabel[node.status]} · effort：{node.effort}
              </div>
              <div style={{ marginTop: 3 }}>验收：结果非空且满足任务声明；失败先升 effort，再升模型档位。</div>
            </div>
          </div>
          <div className="log-row">
            <time>待命</time>
            <div>等待主控派发子任务。可在对话抽屉里手动改派或重跑。</div>
          </div>
          <div className="log-row">
            <time>提示</time>
            <div>拖拽任务卡片到另一个节点即可改派（v1 交互，当前为占位）。</div>
          </div>
        </div>
      )}

      {tab === 'logs' && (
        <div className="drawer-body">
          {edge ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <span className="edge-badge">
                  {edge.label ?? edge.kind} · {edge.source} → {edge.target}
                </span>
              </div>
              <div className="log-row">
                <time>12:01:04</time>
                <div>主控沿此连线派发子任务，effort=medium，任务已排队。</div>
              </div>
              <div className="log-row">
                <time>12:01:06</time>
                <div>下游接单，开始流式生成；上游输入已冻结。</div>
              </div>
              <div className="log-row">
                <time>12:01:14</time>
                <div>产出返回，进入验收；机器检查通过，主控评分 0.86。</div>
              </div>
              <div className="log-row">
                <time>12:01:15</time>
                <div>占用 1.2k tokens · 8.4s，已写入运行账本。</div>
              </div>
            </>
          ) : (
            <>
              <div className="log-row">
                <time>12:01:03</time>
                <div>节点创建：provider / model 绑定，能力档案已加载。</div>
              </div>
              <div className="log-row">
                <time>12:01:04</time>
                <div>主控派发任务，effort 由计划期 rubric 决定。</div>
              </div>
              <div className="log-row">
                <time>12:01:12</time>
                <div>流式输出开始；token 与延迟实时记账。</div>
              </div>
              <div className="log-row">
                <time>12:01:14</time>
                <div>验收通过；产出物已内容寻址存档。</div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'profile' && node && (
        <div className="drawer-body">
          <div className="field" style={{ marginTop: 12, marginBottom: 10 }}>
            <label>节点名称</label>
            <input
              value={node.name}
              onChange={(event) => onIdentityChange?.({ name: event.target.value })}
            />
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>角色</label>
            <input
              value={node.role}
              onChange={(event) => onIdentityChange?.({ role: event.target.value })}
            />
          </div>
          <div className="field-hint">
            节点身份会作为团队名册，在下一轮运行时反馈给主控模型与评委。
          </div>
          {onMakeOrchestrator && (
            <button className="btn ghost orchestrator-action" onClick={onMakeOrchestrator}>
              <Crown size={13} /> 设为主控模型
            </button>
          )}
          <div className="log-row">
            <time>连接</time>
            <div>
              <select
                className="select"
                value={node.connectionId ?? ''}
                onChange={(event) => onModelChange(event.target.value)}
              >
                <option value="" disabled>
                  选择模型连接…
                </option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.model}
                  </option>
                ))}
              </select>
              <button className="mini-btn" style={{ marginTop: 6 }} onClick={onOpenModels}>
                <Boxes size={12} /> 管理连接
              </button>
            </div>
          </div>
          <div className="log-row">
            <time>角色</time>
            <div>{node.role}</div>
          </div>
          <div className="log-row">
            <time>模型</time>
            <div>{node.provider} · {node.model}</div>
          </div>
          <div className="log-row">
            <time>effort</time>
            <div>
              <select
                className="select"
                value={node.effort}
                onChange={(event) => onEffortChange(event.target.value as EffortLevel)}
              >
                {effortOptions.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="log-row">
            <time>能力</time>
            <div>
              文本 / 工具调用 / JSON。真实能力档案由首连探测填充；无 effort 旋钮的模型会显示「effort ignored」并直接升模型档位。
            </div>
          </div>
          <div className="log-row">
            <time>健康</time>
            <div>EWMA 成功率与延迟、冷却时间（v1 由调度器维护）。</div>
          </div>
        </div>
      )}
    </aside>
  );
}
