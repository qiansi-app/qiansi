import { discussionPrompt, isConversationStyle, styleById } from '@qiansi/engine';
import { TEAM_TOOL_LABELS, TEAM_TOOL_NAMES } from './team.js';

/**
 * 团队会议：每个成员按顺序发言，服务端逐个把「开始 / 发言完成 / 失败」
 * 推给界面，用户能明确看到谁在说话、谁已经说完。
 *
 * 成员如果缺少工具，可以在发言末尾写一行工具申请；这里把它解析成
 * 结构化提案，交给用户决定是否批准。批准由界面写回团队名册。
 */

export interface MeetingSpeaker {
  id: string;
  name: string;
  job: string;
  model: string;
}

export interface MeetingProposal {
  memberId: string;
  memberName: string;
  tool: string;
  toolLabel: string;
  reason: string;
}

export interface MeetingMessage {
  memberId: string;
  name: string;
  model: string;
  content: string;
  ms: number;
}

export type MeetingEvent =
  | {
      type: 'meeting.started';
      topic: string;
      style: { id: string; label: string };
      members: Array<{ id: string; name: string; job: string; model: string }>;
    }
  | { type: 'member.started'; memberId: string; name: string; at: number }
  | {
      type: 'member.finished';
      memberId: string;
      name: string;
      model: string;
      content: string;
      ms: number;
      proposals: MeetingProposal[];
    }
  | { type: 'member.failed'; memberId: string; name: string; error: string; ms: number }
  | {
      type: 'meeting.finished';
      proposals: MeetingProposal[];
      messages: MeetingMessage[];
    };

const TOOL_REQUEST_LINE = /(?:TOOL_REQUEST|工具申请)\s*[:：]\s*(.+)$/i;

export function parseToolRequests(content: string, speaker: MeetingSpeaker): MeetingProposal[] {
  const proposals: MeetingProposal[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(TOOL_REQUEST_LINE);
    if (!match) continue;
    const body = String(match[1] ?? '').trim();
    // 允许「list_dir、run_command | 理由」这样一行申请多个工具。
    const [toolsPart, ...reasonParts] = body.split(/[|｜]/);
    const reason =
      reasonParts.join('|').trim().replace(/[。；;]+$/, '').slice(0, 120) ||
      '这个成员认为需要它来完成职责';
    for (const raw of String(toolsPart ?? '').split(/[、,，\s]+/)) {
      const tool = raw.trim().toLowerCase();
      if (!TEAM_TOOL_NAMES.has(tool) || seen.has(tool)) continue;
      seen.add(tool);
      proposals.push({
        memberId: speaker.id,
        memberName: speaker.name,
        tool,
        toolLabel: TEAM_TOOL_LABELS[tool] ?? tool,
        reason,
      });
    }
  }
  return proposals;
}

function stripToolRequests(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !TOOL_REQUEST_LINE.test(line))
    .join('\n')
    .trim();
}

function meetingSystemPrompt(speaker: MeetingSpeaker, styleId: string): string {
  const style = styleById(isConversationStyle(styleId) ? styleId : 'peer');
  return [
    '你正在参加一场多 AI 团队会议。直接给出观点（200 字以内），引用或反驳前面发言者的具体内容；不要复述主题，不要使用客套话。',
    `你在团队里的唯一职责：${speaker.job}。从职责出发发言；与其他成员的判断冲突时明确指出分歧，不要为了和气而附和。`,
    '如果你高效完成职责确实缺少某个工具，在最后单独一行写：',
    'TOOL_REQUEST: <工具名> | <20 字以内理由>',
    `可用工具名（只能选这些）：${[...TEAM_TOOL_NAMES].join('、')}。`,
    '没有需要就不要写这一行，也不要为了凑数申请。',
    discussionPrompt(style),
  ].join('\n');
}

export interface RunMeetingInput {
  topic: string;
  context?: string;
  styleId?: string;
  speakers: MeetingSpeaker[];
  speak: (speaker: MeetingSpeaker, system: string, user: string) => Promise<string>;
  emit: (event: MeetingEvent) => Promise<void> | void;
}

export async function runStreamingMeeting(input: RunMeetingInput): Promise<{
  messages: MeetingMessage[];
  proposals: MeetingProposal[];
}> {
  const style = styleById(isConversationStyle(input.styleId ?? 'peer') ? (input.styleId ?? 'peer') : 'peer');
  const speakers = input.speakers.slice(0, 5);
  const messages: MeetingMessage[] = [];
  const proposals: MeetingProposal[] = [];

  await input.emit({
    type: 'meeting.started',
    topic: input.topic,
    style: { id: style.id, label: style.label },
    members: speakers.map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      job: speaker.job,
      model: speaker.model,
    })),
  });

  for (const speaker of speakers) {
    const startedAt = Date.now();
    await input.emit({ type: 'member.started', memberId: speaker.id, name: speaker.name, at: startedAt });
    const prior = messages.length
      ? messages.map((message) => `[${message.name} · ${message.model}]\n${message.content}`).join('\n\n')
      : '（还没有人发言）';
    const user = [
      `会议议题：${input.topic}`,
      input.context ? `背景材料：\n${input.context}` : '',
      `已有发言：\n${prior}`,
      `现在轮到你（${speaker.name}，模型 ${speaker.model}）发言。`,
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      const raw = await input.speak(speaker, meetingSystemPrompt(speaker, style.id), user);
      const ms = Date.now() - startedAt;
      const found = parseToolRequests(raw, speaker);
      const content = stripToolRequests(raw) || '（没有返回内容）';
      messages.push({ memberId: speaker.id, name: speaker.name, model: speaker.model, content, ms });
      for (const proposal of found) {
        if (!proposals.some((item) => item.memberId === proposal.memberId && item.tool === proposal.tool)) {
          proposals.push(proposal);
        }
      }
      await input.emit({
        type: 'member.finished',
        memberId: speaker.id,
        name: speaker.name,
        model: speaker.model,
        content,
        ms,
        proposals: found,
      });
    } catch (error) {
      const ms = Date.now() - startedAt;
      await input.emit({
        type: 'member.failed',
        memberId: speaker.id,
        name: speaker.name,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        ms,
      });
    }
  }

  await input.emit({ type: 'meeting.finished', proposals, messages });
  return { messages, proposals };
}
