import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageSquare, Plus, Save, Trash2, Users, X } from 'lucide-react';
import { catalogOf, type ModelDraft } from '../data/models';
import type { TeamAutonomy, TeamDoc, TeamMember } from '../types';

interface TeamModalProps {
  open: boolean;
  models: ModelDraft[];
  onClose: () => void;
  onSaved?: (team: TeamDoc) => void;
}

const AUTONOMY_OPTIONS: Array<{ value: TeamAutonomy; label: string; hint: string }> = [
  { value: 'investigate', label: '调查', hint: '只读与检索，产出结论' },
  { value: 'draft', label: '草稿', hint: '只读，产出修改提案' },
  { value: 'auto', label: '执行', hint: '可读写工作目录、跑命令' },
  { value: 'full', label: '全权', hint: '执行 + 画布操作' },
];

function emptyMember(): TeamMember {
  return {
    id: crypto.randomUUID(),
    name: '',
    job: '',
    model: '',
    autonomy: 'auto',
    memory: '',
    createdAt: Date.now(),
  };
}

/**
 * 团队：名册 + 手册。借鉴 Grok Bot 团队模式——一人一职、标准只写一次、
 * 自治档位约束工具、成员数量有上限且超了要说出来。
 */
export function TeamModal({ open, models, onClose, onSaved }: TeamModalProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [playbook, setPlaybook] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cap, setCap] = useState(12);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meetingTopic, setMeetingTopic] = useState('');
  const [meetingBusy, setMeetingBusy] = useState(false);
  const [meeting, setMeeting] = useState<Array<{ name: string; model: string; content: string }> | null>(
    null
  );

  const modelChoices = useMemo(
    () =>
      models.flatMap((connection) =>
        catalogOf(connection).map((model) => ({
          value: model,
          label: `${connection.label} · ${model}`,
          connectionId: connection.id,
          protocol: connection.protocol,
          baseUrl: connection.baseUrl,
          model,
        }))
      ),
    [models]
  );

  /**
   * 提醒按当前编辑中的内容实时算：保存过的提醒会过时，
   * 不能拿「还没有成员」一直挂在两个成员下面。
   */
  const displayWarnings = useMemo(() => {
    const list: string[] = warnings.filter((warning) => warning.includes('职责描述有重叠'));
    if (members.length > 8) {
      list.push(
        `团队有 ${members.length} 人。人越多，上下文、注意力和费用越多——先确认每个成员都有无法被现有成员兼任的职责。`
      );
    }
    if (members.length === 0) {
      list.push('还没有成员。团队模式要求一人一职；先在名册里加 2–3 个具体角色。');
    }
    if (members.length > 0 && !playbook.trim()) {
      list.push('团队手册是空的。把交付标准、禁止事项写进去，所有成员都会读到。');
    }
    if (playbook.length > 4000) {
      list.push('团队手册偏长。手册放必须遵守的标准；具体故事和一次性要求放到成员记忆里。');
    }
    return list;
  }, [members.length, playbook, warnings]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setMeeting(null);
    void fetch('/api/team')
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; team?: TeamDoc }
          | null;
        if (!response.ok || !body?.team) {
          setError('读取团队失败');
          return;
        }
        setMembers(body.team.members ?? []);
        setPlaybook(body.team.playbook ?? '');
        setWarnings(body.team.warnings ?? []);
        if (body.team.cap) setCap(body.team.cap);
      })
      .catch(() => setError('读取团队失败'))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const patchMember = (id: string, patch: Partial<TeamMember>) =>
    setMembers((current) => current.map((member) => (member.id === id ? { ...member, ...patch } : member)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/team', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ members, playbook }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; team?: TeamDoc; error?: string; hint?: string }
        | null;
      if (!response.ok || !body?.ok || !body.team) {
        setError(body?.hint ?? body?.error ?? `保存失败（HTTP ${response.status}）`);
        return;
      }
      setMembers(body.team.members ?? []);
      setWarnings(body.team.warnings ?? []);
      onSaved?.(body.team);
    } catch {
      setError('保存请求失败');
    } finally {
      setSaving(false);
    }
  };

  const holdMeeting = async () => {
    const topic = meetingTopic.trim();
    if (!topic) {
      setError('先写一个会议议题');
      return;
    }
    const speakers = members.filter((member) => member.name.trim() && member.job.trim()).slice(0, 5);
    if (speakers.length < 2) {
      setError('至少需要 2 个有名字和职责的成员才能开会');
      return;
    }
    if (modelChoices.length === 0) {
      setError('没有可用模型，先在「模型密钥」里配一个');
      return;
    }
    const participants = speakers.map((member, index) => {
      const choice =
        modelChoices.find((item) => item.model === member.model) ??
        modelChoices[index % modelChoices.length];
      return {
        id: member.id,
        name: member.name,
        model: choice.model,
        role: member.job,
        connectionId: choice.connectionId,
        protocol: choice.protocol,
        baseUrl: choice.baseUrl,
      };
    });
    setMeetingBusy(true);
    setError(null);
    setMeeting(null);
    try {
      const response = await fetch('/api/discuss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic, rounds: 1, participants }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            rounds?: Array<{ messages: Array<{ name: string; model: string; content: string }> }>;
            error?: string;
          }
        | null;
      if (!response.ok || !body?.ok) {
        setError(`开会失败：${body?.error ?? `HTTP ${response.status}`}`);
        return;
      }
      setMeeting((body.rounds ?? []).flatMap((round) => round.messages));
    } catch {
      setError('开会请求失败');
    } finally {
      setMeetingBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal team-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <Users size={14} /> 团队 · 名册与手册
            </div>
            <div className="modal-sub">
              一人一职；手册所有成员必读；自治档位决定能否动文件。名册会被自动编排优先使用。
            </div>
          </div>
          <button className="icon-tool" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="team-body">
          {loading ? (
            <div className="team-loading">
              <Loader2 size={14} className="spin" /> 正在读取团队…
            </div>
          ) : (
            <>
              <section className="team-section">
                <header>
                  <h4>团队手册</h4>
                  <span className="muted">写标准，不写故事；所有成员都会读到</span>
                </header>
                <textarea
                  className="team-playbook"
                  value={playbook}
                  onChange={(event) => setPlaybook(event.target.value)}
                  placeholder="例如：交付前必须给出可复核的证据；不确定的数字必须标注来源；不要编造 API 或引用。"
                  rows={4}
                />
              </section>

              <section className="team-section">
                <header>
                  <h4>
                    成员 <span className="muted">{members.length}/{cap}</span>
                  </h4>
                  <button
                    className="btn"
                    disabled={members.length >= cap}
                    onClick={() => setMembers((current) => [...current, emptyMember()])}
                  >
                    <Plus size={13} /> 加一个成员
                  </button>
                </header>

                {members.length === 0 && (
                  <div className="team-empty">
                    还没有成员。先加 2–3 个具体角色（如「事实核对」「写稿」「上线检查」），
                    不要加「通用助手」。
                  </div>
                )}

                {members.map((member) => (
                  <div className="team-member" key={member.id}>
                    <div className="team-member-row">
                      <input
                        value={member.name}
                        onChange={(event) => patchMember(member.id, { name: event.target.value })}
                        placeholder="称呼（如 小核）"
                        className="team-name"
                      />
                      <input
                        value={member.job}
                        onChange={(event) => patchMember(member.id, { job: event.target.value })}
                        placeholder="唯一职责：一件事（如 核实事实与来源）"
                        className="team-job"
                      />
                      <button
                        className="icon-tool"
                        onClick={() =>
                          setMembers((current) => current.filter((item) => item.id !== member.id))
                        }
                        title="移除成员"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div className="team-member-row">
                      <input
                        value={member.model ?? ''}
                        onChange={(event) => patchMember(member.id, { model: event.target.value })}
                        placeholder="默认模型（可空）"
                        list="team-model-options"
                        className="team-model"
                      />
                      <select
                        value={member.autonomy}
                        onChange={(event) =>
                          patchMember(member.id, { autonomy: event.target.value as TeamAutonomy })
                        }
                        title={AUTONOMY_OPTIONS.find((item) => item.value === member.autonomy)?.hint}
                      >
                        {AUTONOMY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label} · {option.hint}
                          </option>
                        ))}
                      </select>
                    </div>
                    <details className="team-memory">
                      <summary>团队记忆（只给这个成员看）</summary>
                      <textarea
                        value={member.memory}
                        onChange={(event) => patchMember(member.id, { memory: event.target.value })}
                        rows={3}
                        placeholder="偏好、约定、踩过的坑。写成可复用的经验，不写一次性的故事。"
                      />
                    </details>
                  </div>
                ))}
                <datalist id="team-model-options">
                  {modelChoices.map((choice) => (
                    <option key={choice.value} value={choice.value} label={choice.label} />
                  ))}
                </datalist>
              </section>

              {displayWarnings.length > 0 && (
                <div className="team-warnings">
                  {displayWarnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                </div>
              )}

              <section className="team-section">
                <header>
                  <h4>团队会议</h4>
                  <span className="muted">每人用自己的模型发言一次；要求他们明确分歧</span>
                </header>
                <div className="team-meeting-row">
                  <input
                    value={meetingTopic}
                    onChange={(event) => setMeetingTopic(event.target.value)}
                    placeholder="议题，例如：这个上线方案最大的风险是什么？"
                  />
                  <button className="btn" disabled={meetingBusy} onClick={() => void holdMeeting()}>
                    {meetingBusy ? <Loader2 size={13} className="spin" /> : <MessageSquare size={13} />}
                    开会
                  </button>
                </div>
                {meeting && (
                  <div className="team-meeting-transcript">
                    {meeting.map((message, index) => (
                      <div key={index}>
                        <b>{message.name}</b>
                        <span className="muted"> · {message.model}</span>
                        <p>{message.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {error && <div className="team-error">{error}</div>}
            </>
          )}
        </div>

        <div className="team-foot">
          <span className="muted">保存后再运行，标准与档位才会生效。</span>
          <button className="btn primary" onClick={() => void save()} disabled={saving || loading}>
            {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
            保存团队
          </button>
        </div>
      </div>
    </div>
  );
}
