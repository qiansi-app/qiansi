import { useState } from 'react';
import { Loader2, MessagesSquare, Send, X } from 'lucide-react';

export interface DiscussionParticipant {
  id: string;
  name: string;
  model: string;
  connectionId?: string;
  protocol?: string;
  baseUrl?: string;
}

interface DiscussionMessage {
  name: string;
  model: string;
  content: string;
}

interface DiscussionRound {
  round: number;
  messages: DiscussionMessage[];
}

interface DiscussionModalProps {
  open: boolean;
  participants: DiscussionParticipant[];
  context?: string;
  onClose: () => void;
  onCreateArtifact?: (title: string, output: string) => void;
}

export function DiscussionModal({
  open,
  participants,
  context,
  onClose,
  onCreateArtifact,
}: DiscussionModalProps) {
  const [topic, setTopic] = useState('');
  const [rounds, setRounds] = useState(2);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<DiscussionRound[]>([]);
  const [note, setNote] = useState<string | null>(null);

  if (!open) return null;

  const start = async () => {
    const text = topic.trim();
    if (!text || running) return;
    setRunning(true);
    setError(null);
    setNote(null);
    setTranscript([]);
    try {
      const response = await fetch('/api/discuss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: text, rounds, participants, context }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as {
        rounds?: DiscussionRound[];
        effectiveRounds?: number;
      };
      setTranscript(data.rounds ?? []);
      if (data.effectiveRounds && data.effectiveRounds < rounds) {
        setNote(`为保证响应时长，本次自动执行 ${data.effectiveRounds} 轮。`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '讨论失败');
    } finally {
      setRunning(false);
    }
  };

  const save = () => {
    const output = transcript
      .flatMap((round) =>
        round.messages.map((item) => `[第 ${round.round} 轮] ${item.name}：${item.content}`)
      )
      .join('\n\n');
    onCreateArtifact?.(`讨论 · ${topic.trim()}`, output);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="discussion-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>
              <MessagesSquare size={16} /> AI 讨论
            </h2>
            <p>{participants.length} 个模型参与 · 每轮依次发言，后发言者能看到前面的观点</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="discussion-participants">
          {participants.map((item) => (
            <span key={item.id} className="discussion-chip">
              {item.name}
              <small>{item.model}</small>
            </span>
          ))}
        </div>

        <div className="discussion-controls">
          <input
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="讨论主题，例如：这篇初稿的核心论点是否成立？"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void start();
            }}
          />
          <label>
            轮数
            <select value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <button className="btn primary" onClick={() => void start()} disabled={running || !topic.trim()}>
            {running ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            {running ? '讨论中…' : '开始讨论'}
          </button>
        </div>

        {error && <div className="discussion-error">{error}</div>}
        {note && <div className="discussion-note">{note}</div>}

        <div className="discussion-transcript">
          {transcript.length === 0 && !running && (
            <div className="discussion-empty">
              选择 2 个以上模型后发起讨论。每个模型会看到主题与前面所有发言，适合做交叉审阅、方案对比或事实核对。
            </div>
          )}
          {transcript.map((round) => (
            <section key={round.round} className="discussion-round">
              <div className="discussion-round-title">第 {round.round} 轮</div>
              {round.messages.map((item, index) => (
                <div key={`${round.round}-${index}`} className="discussion-message">
                  <div className="discussion-author">
                    {item.name}
                    <small>{item.model}</small>
                  </div>
                  <div className="discussion-content">{item.content}</div>
                </div>
              ))}
            </section>
          ))}
          {running && (
            <div className="discussion-running">
              <Loader2 size={14} className="spin" /> 正在依次调用模型…
            </div>
          )}
        </div>

        {transcript.length > 0 && (
          <footer className="modal-foot">
            <button className="btn ghost" onClick={save}>
              存为产物模块
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
