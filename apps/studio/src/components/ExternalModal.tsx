import { useEffect, useMemo, useState } from 'react';
import { Bot, X } from 'lucide-react';
import type { ExternalCallEvent } from '../types';

interface AgentUsage {
  tokens: number;
  calls: number;
}

interface ExternalModalProps {
  open: boolean;
  calls: ExternalCallEvent[];
  focusSessionId?: string | null;
  onClose: () => void;
  onOpenArtifact: (taskId: string) => void;
}

export function ExternalModal({
  open,
  calls,
  focusSessionId,
  onClose,
  onOpenArtifact,
}: ExternalModalProps) {
  const [byAgent, setByAgent] = useState<Record<string, AgentUsage>>({});

  useEffect(() => {
    if (!open) return;
    fetch('/api/usage')
      .then((response) => response.json())
      .then((data: { external?: { byAgent?: Record<string, AgentUsage> } }) => {
        setByAgent(data.external?.byAgent ?? {});
      })
      .catch(() => setByAgent({}));
  }, [open]);

  const sessions = useMemo(() => {
    const map = new Map<
      string,
      {
        sessionId: string;
        agent: string;
        calls: ExternalCallEvent[];
        tokens: number;
        latestAt: number;
      }
    >();

    for (const call of calls) {
      const existing = map.get(call.sessionId) ?? {
        sessionId: call.sessionId,
        agent: call.agent,
        calls: [],
        tokens: 0,
        latestAt: 0,
      };
      existing.calls.push(call);
      existing.tokens += call.usage?.total ?? 0;
      existing.latestAt = Math.max(existing.latestAt, call.at);
      map.set(call.sessionId, existing);
    }

    return [...map.values()]
      .filter((session) => !focusSessionId || session.sessionId === focusSessionId)
      .sort((a, b) => b.latestAt - a.latestAt);
  }, [calls, focusSessionId]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal report-modal"
        role="dialog"
        aria-modal="true"
        aria-label="外部调用"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">外部 Agent 调用</div>
            <div className="modal-sub">
              按 agent 分账，按 session 聚合；点击产物可查看该次输出。
            </div>
          </div>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="report-body">
          <div className="agent-usage-table">
            {Object.entries(byAgent).length === 0 && <span className="field-hint">暂无外部用量</span>}
            {Object.entries(byAgent).map(([agent, usage]) => (
              <div key={agent} className="agent-usage-row">
                <span>
                  <Bot size={12} /> {agent}
                </span>
                <span>{usage.calls} calls</span>
                <strong>{usage.tokens.toLocaleString()} tok</strong>
              </div>
            ))}
          </div>

          {sessions.length === 0 && (
            <div className="empty">
              还没有外部调用。Claude Code 通过 MCP 或任何 OpenAI 兼容客户端调用 `/v1` 后，会出现在这里。
            </div>
          )}

          {sessions.map((session) => (
            <div key={session.sessionId} className="report-task">
              <div className="report-task-head">
                <Bot size={13} />
                <strong>{session.agent}</strong>
                <span className="report-task-id">{session.sessionId.slice(0, 8)}</span>
                <span className="report-score">
                  {session.calls.length} calls · {session.tokens.toLocaleString()} tok
                </span>
              </div>

              {session.calls.map((call) => (
                <div
                  key={call.runId}
                  className="log-row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpenArtifact(call.taskId)}
                >
                  <time>{new Date(call.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                  <div>
                    <strong style={{ color: '#d5dee9' }}>{call.purpose}</strong>
                    <div style={{ marginTop: 3 }}>
                      {call.model} · {call.usage?.total ?? 0} tok ·{' '}
                      {call.output.replace(/\s+/g, ' ').slice(0, 70)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
