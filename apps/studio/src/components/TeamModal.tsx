import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
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

const TOOL_GROUPS: Array<{
  id: string;
  label: string;
  tools: string[];
  readOnly: boolean;
}> = [
  { id: 'read', label: '读文件', tools: ['read_file', 'list_dir'], readOnly: true },
  { id: 'write', label: '写文件', tools: ['write_file'], readOnly: false },
  { id: 'shell', label: '终端', tools: ['run_command'], readOnly: false },
  {
    id: 'canvas',
    label: '画布',
    tools: ['describe_canvas', 'get_canvas', 'list_workspaces', 'list_runs', 'get_run_result'],
    readOnly: true,
  },
  { id: 'web', label: '联网', tools: ['web_search'], readOnly: true },
];

const ALL_TOOLS = TOOL_GROUPS.flatMap((group) => group.tools);
const READ_ONLY_TOOLS = new Set(
  TOOL_GROUPS.filter((group) => group.readOnly).flatMap((group) => group.tools)
);

interface MeetingProposal {
  memberId: string;
  memberName: string;
  tool: string;
  toolLabel: string;
  reason: string;
}

interface MeetingSpeakerState {
  id: string;
  name: string;
  job: string;
  model: string;
  status: 'waiting' | 'speaking' | 'done' | 'failed';
  content?: string;
  error?: string;
  ms?: number;
}

type MeetingStatus = 'idle' | 'running' | 'done' | 'error';

function emptyMember(): TeamMember {
  return {
    id: crypto.randomUUID(),
    name: '',
    job: '',
    model: '',
    autonomy: 'auto',
    tools: [...ALL_TOOLS],
    memory: '',
    createdAt: Date.now(),
  };
}

function memberKey(member: TeamMember): string {
  return JSON.stringify({
    name: member.name,
    job: member.job,
    model: member.model ?? '',
    autonomy: member.autonomy,
    tools: member.tools ?? [],
    memory: member.memory,
  });
}

function snapshot(members: TeamMember[], playbook: string): string {
  return JSON.stringify({ members: members.map(memberKey), playbook });
}

interface CatalogGroup {
  label: string;
  options: string[];
  disabled?: boolean;
}

function avatarOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return /[一-龥]/.test(trimmed) ? trimmed.slice(-1) : trimmed.slice(0, 1).toUpperCase();
}

/**
 * 团队：名册 + 能力 + 手册 + 会议。
 * 一人一职；能力（工具白名单）在运行时真正生效；会议逐个推送成员发言，
 * 成员缺少工具时提出申请，由用户决定是否批准。
 */
export function TeamModal({ open, models, onClose, onSaved }: TeamModalProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [playbook, setPlaybook] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cap, setCap] = useState(12);
  const [serverGroups, setServerGroups] = useState<CatalogGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [meetingTopic, setMeetingTopic] = useState('');
  const [meetingStatus, setMeetingStatus] = useState<MeetingStatus>('idle');
  const [speakers, setSpeakers] = useState<MeetingSpeakerState[]>([]);
  const [proposals, setProposals] = useState<MeetingProposal[]>([]);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const proposalsRef = useRef<HTMLDivElement | null>(null);

  // 新的工具申请出现在会议区底部：自动滚过去，别让用户以为会议没结果。
  useEffect(() => {
    if (proposals.length > 0) {
      proposalsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [proposals.length]);

  const modelGroups = useMemo(() => {
    const groups: CatalogGroup[] = [];
    const seen = new Set<string>();
    for (const slot of serverGroups) {
      const options = slot.options.filter((model) => !seen.has(model));
      for (const model of options) seen.add(model);
      if (options.length > 0) {
        groups.push({
          label: slot.disabled ? `${slot.label}（已停用）` : slot.label,
          options,
          disabled: slot.disabled,
        });
      }
    }
    for (const connection of models) {
      const options = catalogOf(connection).filter((model) => !seen.has(model));
      for (const model of options) seen.add(model);
      if (options.length > 0) groups.push({ label: connection.label, options });
    }
    return groups;
  }, [models, serverGroups]);
  const knownModels = useMemo(
    () => new Set(modelGroups.flatMap((group) => group.options)),
    [modelGroups]
  );

  const dirty = Boolean(savedSnapshot) && snapshot(members, playbook) !== savedSnapshot;

  const validation = useMemo(() => {
    const errors: string[] = [];
    const names = new Map<string, number>();
    const jobs = new Map<string, number>();
    members.forEach((member, index) => {
      const name = member.name.trim();
      const job = member.job.trim();
      if (!name) errors.push(`第 ${index + 1} 位成员还没有称呼`);
      else if (names.has(name.toLowerCase())) errors.push(`称呼重复：${name}`);
      else names.set(name.toLowerCase(), index);
      if (!job) errors.push(`${name || `第 ${index + 1} 位成员`} 还没有职责`);
      else {
        const normalized = job.replace(/[\s，。,.、；;：:]/g, '');
        if (jobs.has(normalized)) errors.push(`${name} 的职责与第 ${jobs.get(normalized)! + 1} 位成员完全相同`);
        else jobs.set(normalized, index);
      }
    });
    return errors;
  }, [members]);

  const displayWarnings = useMemo(() => {
    const list: string[] = warnings.filter((warning) => warning.includes('职责描述有重叠'));
    if (members.length > 8) list.push(`团队有 ${members.length} 人。人越多，上下文、注意力和费用越多——先确认每个成员都有无法被现有成员兼任的职责。`);
    if (members.length === 0) list.push('还没有成员。团队模式要求一人一职；先在名册里加 2–3 个具体角色。');
    if (members.length > 0 && !playbook.trim()) list.push('团队手册是空的。把交付标准、禁止事项写进去，所有成员都会读到。');
    if (playbook.length > 4000) list.push('团队手册偏长。手册放必须遵守的标准；具体故事和一次性要求放到成员记忆里。');
    if (members.some((member) => (member.tools ?? []).length === 0)) list.push('有成员没有开通任何工具：只能纯文本交付。需要文件/终端/联网时在会议里申请，或在这里打开。');
    return list;
  }, [members, playbook, warnings]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setConfirmClose(false);
    setMeetingStatus('idle');
    setSpeakers([]);
    setProposals([]);
    setApplied(new Set());
    void Promise.all([
      fetch('/api/team').then(async (response) => ({
        ok: response.ok,
        body: (await response.json().catch(() => null)) as
          | { ok?: boolean; team?: TeamDoc }
          | null,
      })),
      fetch('/api/keys')
        .then((response) => (response.ok ? response.json().catch(() => null) : null))
        .catch(() => null),
    ])
      .then(([teamResponse, keys]) => {
        if (!teamResponse.ok || !teamResponse.body?.team) {
          setError('读取团队失败');
          return;
        }
        const normalized = (teamResponse.body.team.members ?? []).map((member) => ({
          ...member,
          tools: member.tools ?? [...ALL_TOOLS],
        }));
        const text = teamResponse.body.team.playbook ?? '';
        setMembers(normalized);
        setPlaybook(text);
        setWarnings(teamResponse.body.team.warnings ?? []);
        if (teamResponse.body.team.cap) setCap(teamResponse.body.team.cap);
        setSavedSnapshot(snapshot(normalized, text));
        // 模型目录以服务端密钥为准：本地的 ModelDraft 列表可能不含所有可调用模型。
        const slots = Array.isArray((keys as any)?.slots) ? (keys as any).slots : [];
        setServerGroups(
          slots
            .filter((slot: any) => Array.isArray(slot?.models) && slot.models.length > 0)
            .map((slot: any) => ({
              label: String(slot.label ?? slot.slot ?? '模型'),
              options: slot.models.map((model: unknown) => String(model)),
              disabled: slot.disabled === true,
            }))
        );
      })
      .catch(() => setError('读取团队失败'))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const patchMember = (id: string, patch: Partial<TeamMember>) =>
    setMembers((current) =>
      current.map((member) => {
        if (member.id !== id) return member;
        const next = { ...member, ...patch };
        if (patch.autonomy === 'investigate' || patch.autonomy === 'draft') {
          next.tools = (next.tools ?? [...ALL_TOOLS]).filter((tool) => READ_ONLY_TOOLS.has(tool));
        }
        return next;
      })
    );

  const toggleGroup = (member: TeamMember, group: (typeof TOOL_GROUPS)[number]) => {
    if (
      (member.autonomy === 'investigate' || member.autonomy === 'draft') &&
      !group.readOnly
    ) {
      setError(`「${AUTONOMY_OPTIONS.find((option) => option.value === member.autonomy)?.label}」档位不能开通${group.label}`);
      return;
    }
    const tools = new Set(member.tools ?? []);
    const allActive = group.tools.every((tool) => tools.has(tool));
    for (const tool of group.tools) {
      if (allActive) tools.delete(tool);
      else tools.add(tool);
    }
    patchMember(member.id, { tools: [...tools] });
  };

  const persist = async (nextMembers: TeamMember[], nextPlaybook: string): Promise<TeamDoc | null> => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/team', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ members: nextMembers, playbook: nextPlaybook }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; team?: TeamDoc; error?: string; hint?: string }
        | null;
      if (!response.ok || !body?.ok || !body.team) {
        setError(body?.hint ?? body?.error ?? `保存失败（HTTP ${response.status}）`);
        return null;
      }
      const normalized = (body.team.members ?? []).map((member) => ({
        ...member,
        tools: member.tools ?? [],
      }));
      setMembers(normalized);
      setWarnings(body.team.warnings ?? []);
      setSavedSnapshot(snapshot(normalized, body.team.playbook ?? ''));
      onSaved?.(body.team);
      return body.team;
    } catch {
      setError('保存请求失败');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (validation.length > 0) {
      setError(validation[0]!);
      return;
    }
    await persist(members, playbook);
  };

  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onClose();
  };

  const approveProposal = async (proposal: MeetingProposal) => {
    const member = members.find((item) => item.id === proposal.memberId);
    if (!member) return;
    if ((member.tools ?? []).includes(proposal.tool)) {
      setApplied((current) => new Set(current).add(`${proposal.memberId}:${proposal.tool}`));
      return;
    }
    const next = members.map((item) =>
      item.id === member.id
        ? { ...item, tools: [...new Set([...(item.tools ?? []), proposal.tool])] }
        : item
    );
    setMembers(next);
    const saved = await persist(next, playbook);
    if (saved) {
      setApplied((current) => new Set(current).add(`${proposal.memberId}:${proposal.tool}`));
    }
  };

  const dispatchMeeting = (name: string, data: string) => {
    let event: Record<string, any>;
    try {
      event = JSON.parse(data) as Record<string, any>;
    } catch {
      return;
    }
    if (name === 'meeting.started') {
      setSpeakers(
        (event.members ?? []).map((member: any) => ({
          id: String(member.id),
          name: String(member.name),
          job: String(member.job ?? ''),
          model: String(member.model ?? ''),
          status: 'waiting',
        }))
      );
    } else if (name === 'member.started') {
      setSpeakers((current) =>
        current.map((speaker) =>
          speaker.id === event.memberId ? { ...speaker, status: 'speaking' } : speaker
        )
      );
    } else if (name === 'member.finished') {
      setSpeakers((current) =>
        current.map((speaker) =>
          speaker.id === event.memberId
            ? { ...speaker, status: 'done', content: String(event.content ?? ''), ms: Number(event.ms ?? 0) }
            : speaker
        )
      );
      if (Array.isArray(event.proposals) && event.proposals.length > 0) {
        setProposals((current) => {
          const merged = [...current];
          for (const proposal of event.proposals as MeetingProposal[]) {
            if (!merged.some((item) => item.memberId === proposal.memberId && item.tool === proposal.tool)) {
              merged.push(proposal);
            }
          }
          return merged;
        });
      }
    } else if (name === 'member.failed') {
      setSpeakers((current) =>
        current.map((speaker) =>
          speaker.id === event.memberId
            ? { ...speaker, status: 'failed', error: String(event.error ?? '发言失败') }
            : speaker
        )
      );
    } else if (name === 'meeting.finished') {
      setProposals(Array.isArray(event.proposals) ? (event.proposals as MeetingProposal[]) : []);
      setMeetingStatus('done');
    }
  };

  const holdMeeting = async () => {
    const topic = meetingTopic.trim();
    if (!topic) {
      setError('先写一个会议议题');
      return;
    }
    if (dirty) {
      setError('有未保存的修改：先保存团队再开会，会议用的是服务端名册');
      return;
    }
    const eligible = members.filter((member) => member.name.trim() && member.job.trim());
    if (eligible.length < 2) {
      setError('至少需要两个有名字和职责的成员才能开会');
      return;
    }
    setMeetingStatus('running');
    setSpeakers([]);
    setProposals([]);
    setApplied(new Set());
    setError(null);
    try {
      const response = await fetch('/api/team/meeting', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic }),
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string; hint?: string }
          | null;
        setMeetingStatus('error');
        setError(body?.hint ?? `开会失败：${body?.error ?? `HTTP ${response.status}`}`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          let name = '';
          const data: string[] = [];
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (name && data.length) dispatchMeeting(name, data.join('\n'));
        }
      }
      setMeetingStatus((current) => (current === 'error' ? current : 'done'));
    } catch {
      setMeetingStatus('error');
      setError('会议流中断');
    }
  };

  const meetingBusy = meetingStatus === 'running';

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div className="modal team-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <Users size={14} /> 团队 · 名册、能力与手册
            </div>
            <div className="modal-sub">
              一人一职；能力决定能不能读文件、跑命令、联网；手册所有成员必读。编排会优先按职责派活。
            </div>
          </div>
          <button className="icon-tool" onClick={requestClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="team-body">
          {confirmClose && (
            <div className="team-close-confirm">
              <AlertTriangle size={14} /> 有未保存的修改。
              <button className="btn" onClick={() => setConfirmClose(false)}>继续编辑</button>
              <button className="btn ghost" onClick={onClose}>放弃修改</button>
            </div>
          )}

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
                    {dirty && <span className="team-dirty">未保存</span>}
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
                    还没有成员。先加 2–3 个具体角色（如「事实核对」「写稿」「上线检查」），不要加「通用助手」。
                  </div>
                )}

                {members.map((member) => {
                  const tools = new Set(member.tools ?? []);
                  const readOnlyRung = member.autonomy === 'investigate' || member.autonomy === 'draft';
                  return (
                    <div className="team-member" key={member.id}>
                      <div className="team-member-head">
                        <span className="team-avatar">{avatarOf(member.name)}</span>
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
                          onClick={() => setMembers((current) => current.filter((item) => item.id !== member.id))}
                          title="移除成员"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div className="team-member-meta">
                        <label>
                          模型
                          <select
                            value={member.model ?? ''}
                            onChange={(event) => patchMember(member.id, { model: event.target.value })}
                          >
                            <option value="">按节点/画布决定</option>
                            {member.model && !knownModels.has(member.model) && (
                              <option value={member.model}>{member.model}（未在目录中）</option>
                            )}
                            {modelGroups.map((group) => (
                              <optgroup key={group.label} label={group.label}>
                                {group.options.map((model) => (
                                  <option key={`${group.label}-${model}`} value={model}>
                                    {model}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </label>
                        <label>
                          档位
                          <select
                            value={member.autonomy}
                            onChange={(event) =>
                              patchMember(member.id, { autonomy: event.target.value as TeamAutonomy })
                            }
                            title={AUTONOMY_OPTIONS.find((option) => option.value === member.autonomy)?.hint}
                          >
                            {AUTONOMY_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label} · {option.hint}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="team-tools">
                        <span className="team-tools-label">
                          <Wrench size={12} /> 能力
                        </span>
                        {TOOL_GROUPS.map((group) => {
                          const activeCount = group.tools.filter((tool) => tools.has(tool)).length;
                          const active = activeCount > 0;
                          const partial = activeCount > 0 && activeCount < group.tools.length;
                          const blocked = readOnlyRung && !group.readOnly;
                          return (
                            <button
                              key={group.id}
                              className={`team-tool-chip ${active ? 'on' : ''} ${partial ? 'partial' : ''}`}
                              disabled={blocked}
                              title={
                                blocked
                                  ? '调查/草稿档位只能使用只读工具'
                                  : partial
                                    ? '部分开通：点击补齐这组工具'
                                    : active
                                      ? '点击关闭这组工具'
                                      : '点击开通这组工具'
                              }
                              onClick={() => toggleGroup(member, group)}
                            >
                              {active ? <Check size={10} /> : null}
                              {group.label}
                            </button>
                          );
                        })}
                        <span className="team-tools-hint">
                          {(member.tools ?? []).length === 0
                            ? '没有工具：只能纯文本交付'
                            : readOnlyRung
                              ? `${(member.tools ?? []).length} 项工具 · 只读档位`
                              : `${(member.tools ?? []).length} 项工具`}
                        </span>
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
                  );
                })}

                {validation.length > 0 && (
                  <ul className="team-validation">
                    {validation.slice(0, 4).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </section>

              {displayWarnings.length > 0 && (
                <div className="team-warnings">
                  {displayWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              )}

              <section className="team-section team-meeting">
                <header>
                  <h4>
                    团队会议
                    {speakers.length > 0 && (
                      <span className="team-meeting-progress">
                        {speakers.filter((speaker) => speaker.status === 'done').length}/{speakers.length} 已发言
                      </span>
                    )}
                  </h4>
                  <span className="muted">逐个发言：能看到谁在说、谁已说完；缺工具可以提出申请</span>
                </header>
                <div className="team-meeting-row">
                  <input
                    value={meetingTopic}
                    onChange={(event) => setMeetingTopic(event.target.value)}
                    placeholder="议题，例如：这个上线方案最大的风险是什么？"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !meetingBusy) void holdMeeting();
                    }}
                  />
                  <button
                    className="btn"
                    disabled={meetingBusy || dirty || members.filter((member) => member.name.trim() && member.job.trim()).length < 2}
                    title={dirty ? '先保存团队再开会' : '每个成员用自己的模型发言一次'}
                    onClick={() => void holdMeeting()}
                  >
                    {meetingBusy ? <Loader2 size={13} className="spin" /> : <MessageSquare size={13} />}
                    {meetingBusy ? '开会中…' : '开会'}
                  </button>
                </div>
                {dirty && <div className="team-meeting-hint">名册有未保存修改：保存后才能用最新名册开会。</div>}

                {speakers.length > 0 && (
                  <div className="team-speakers">
                    {speakers.map((speaker) => (
                      <div className={`team-speaker ${speaker.status}`} key={speaker.id}>
                        <div className="team-speaker-head">
                          <span className="team-avatar">{avatarOf(speaker.name)}</span>
                          <div>
                            <b>{speaker.name}</b>
                            <span className="muted"> · {speaker.job}</span>
                            <div className="team-speaker-model">{speaker.model}</div>
                          </div>
                          <span className={`team-speaker-status ${speaker.status}`}>
                            {speaker.status === 'waiting' && <><Clock size={11} /> 等待</>}
                            {speaker.status === 'speaking' && <><Loader2 size={11} className="spin" /> 发言中</>}
                            {speaker.status === 'done' && <><Check size={11} /> 已发言</>}
                            {speaker.status === 'failed' && <><X size={11} /> 失败</>}
                          </span>
                        </div>
                        {speaker.content && <p className="team-speaker-content">{speaker.content}</p>}
                        {speaker.error && <p className="team-speaker-error">{speaker.error}</p>}
                      </div>
                    ))}
                  </div>
                )}

                {proposals.length > 0 && (
                  <div className="team-proposals" ref={proposalsRef}>
                    <h4>
                      <Wrench size={12} /> 工具申请（由你决定）
                    </h4>
                    {proposals.map((proposal) => {
                      const key = `${proposal.memberId}:${proposal.tool}`;
                      const done = applied.has(key);
                      return (
                        <div className="team-proposal" key={key}>
                          <div>
                            <b>{proposal.memberName}</b> 申请开通「{proposal.toolLabel}」：
                            <span className="muted"> {proposal.reason}</span>
                          </div>
                          {done ? (
                            <span className="team-proposal-done"><Check size={12} /> 已加入能力</span>
                          ) : (
                            <div className="team-proposal-actions">
                              <button className="btn primary" onClick={() => void approveProposal(proposal)}>
                                批准并添加
                              </button>
                              <button
                                className="btn ghost"
                                onClick={() => setProposals((current) => current.filter((item) => item !== proposal))}
                              >
                                忽略
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {error && <div className="team-error">{error}</div>}
            </>
          )}
        </div>

        <div className="team-foot">
          <span className="muted">
            {dirty ? '有未保存修改；保存后再运行，标准与能力才会生效。' : members.length > 0 ? '已保存。' : '保存后再运行。'}
          </span>
          <button
            className="btn primary"
            onClick={() => void save()}
            disabled={saving || loading || !dirty || validation.length > 0}
          >
            {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
            {saving ? '保存中…' : dirty ? '保存团队' : '已保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
