import { useState } from 'react';
import {
  Boxes,
  Crown,
  Globe,
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
import { catalogOf, type ModelDraft } from '../data/models';
import { CONVERSATION_STYLES, isConversationStyle, styleById, suggestStyle } from '@qiansi/engine';
import type { ChatMessage, TeamMember } from '../types';

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
  /** 团队名册：把节点指派给某个成员。 */
  team?: TeamMember[];
  onMemberChange?: (memberId: string, memberName: string) => void;
  onClose: () => void;
  onSend: (text: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onModelChange: (connectionId: string, model: string) => void;
  onOpenModels: () => void;
  onIdentityChange?: (patch: {
    name?: string;
    role?: string;
    style?: string;
    webSearch?: boolean;
  }) => void;
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
  team,
  onMemberChange,
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

  /**
   * The node's stored connection can drift from its model (nodes predate the
   * catalog, or an agent wrote one). Match by model when the pair does not
   * exist, so the picker never shows a different model than the node has.
   */
  const resolvedModelValue = (() => {
    if (!node) return '';
    const connectionId = node.connectionId ?? '';
    const model = node.model ?? '';
    const exact = models.some(
      (connection) => connection.id === connectionId && catalogOf(connection).includes(model)
    );
    if (exact) return `${connectionId}::${model}`;
    const owner = models.find((connection) => catalogOf(connection).includes(model));
    return owner ? `${owner.id}::${model}` : '';
  })();

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
                <button
                  className={`mini-btn ${node.webSearch ? 'on' : ''}`}
                  onClick={() => onIdentityChange?.({ webSearch: !node.webSearch })}
                  title="服务端联网搜索：模型调用 web_search，结果由 Qiansi 服务端抓取"
                >
                  <Globe size={12} /> {node.webSearch ? '联网' : '离线'}
                </button>
              )}
              {node && (
                <select
                  className="select"
                  value={
                    isConversationStyle(node.style)
                      ? String(node.style)
                      : suggestStyle(`${node.name} ${node.role}`)
                  }
                  onChange={(event) => onIdentityChange?.({ style: event.target.value })}
                  title={`对话风格：${styleById(
                    isConversationStyle(node.style)
                      ? String(node.style)
                      : suggestStyle(`${node.name} ${node.role}`)
                  ).scenario}`}
                >
                  {!isConversationStyle(node.style) && (
                    <option value={suggestStyle(`${node.name} ${node.role}`)}>
                      {styleById(suggestStyle(`${node.name} ${node.role}`)).label}（按角色推荐）
                    </option>
                  )}
                  {CONVERSATION_STYLES.map((style) => (
                    <option key={style.id} value={style.id}>
                      {style.label}
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
          {team && team.length > 0 && onMemberChange && (
            <div className="field" style={{ marginBottom: 10 }}>
              <label>团队成员（一人一职）</label>
              <select
                className="select"
                value={node.memberId ?? ''}
                onChange={(event) => {
                  const member = team.find((item) => item.id === event.target.value);
                  onMemberChange(member?.id ?? '', member?.name ?? '');
                }}
              >
                <option value="">不指派（自由执行）</option>
                {team.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} · {member.job}
                  </option>
                ))}
              </select>
              <div className="field-hint">
                指派后，这个节点的提示词会带上该成员的职责、自治档位与团队记忆；调查/草稿档位只能读，不能写文件或跑命令。
              </div>
            </div>
          )}
          {onMakeOrchestrator && (
            <button className="btn ghost orchestrator-action" onClick={onMakeOrchestrator}>
              <Crown size={13} /> 设为主控模型
            </button>
          )}
          <div className="log-row">
            <time>模型</time>
            <div>
              <select
                className="select"
                value={resolvedModelValue}
                onChange={(event) => {
                  const [connectionId, model] = event.target.value.split('::');
                  if (connectionId && model) onModelChange(connectionId, model);
                }}
              >
                {!resolvedModelValue && (
                  <option value="" disabled>
                    {node.model ? `${node.model}（未匹配到连接）` : '选择模型…'}
                  </option>
                )}
                {models.map((connection) => (
                  <optgroup key={connection.id} label={connection.label}>
                    {catalogOf(connection).map((modelId) => (
                      <option
                        key={`${connection.id}::${modelId}`}
                        value={`${connection.id}::${modelId}`}
                      >
                        {modelId}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button className="mini-btn" style={{ marginTop: 6 }} onClick={onOpenModels}>
                <Boxes size={12} /> 管理连接与模型目录
              </button>
            </div>
          </div>
          <div className="log-row">
            <time>角色</time>
            <div>{node.role}</div>
          </div>
          <div className="log-row">
            <time>provider</time>
            <div>{node.provider}</div>
          </div>
          <div className="log-row">
            <time>联网</time>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={node.webSearch === true}
                  onChange={(event) => onIdentityChange?.({ webSearch: event.target.checked })}
                />
                <span>
                  {node.webSearch ? '已开启' : '已关闭'} · 服务端 web_search 工具
                </span>
              </label>
              <div style={{ marginTop: 4, color: 'var(--muted-2)' }}>
                开启后，运行和对话时模型可自行发起最多 2 轮搜索；搜索由服务端执行，
                模型不需要自带联网能力。默认关闭，因为它会访问外部网络。
              </div>
            </div>
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
