import type { CapabilityProfile, Plan } from '@qiansi/engine';
import { createRoutedJudge } from './acceptance.js';

export const relayBase = (process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721').replace(/\/+$/, '');

function relayProfile(
  id: string,
  model: string,
  strengths: Record<string, number>
): CapabilityProfile {
  return {
    id,
    label: id,
    provider: 'Anthropic relay',
    protocol: 'anthropic-messages',
    baseUrl: relayBase,
    model,
    contextWindow: 1000000,
    maxOutput: 2048,
    modalities: { tools: true, json: true, vision: true },
    // The relay's upstream models think by default; sending a thinking budget
    // is not portable, so the live demo keeps effort as metadata only.
    effort: { dialect: 'none', canDisable: true },
    strengths,
    domesticReachable: true,
  };
}

export const liveProfiles: CapabilityProfile[] = [
  relayProfile('live-opus', 'claude-opus-4-8[1M]', { reasoning: 0.95, writing: 0.9, code: 0.9 }),
  relayProfile('live-sonnet', 'claude-sonnet-4-6[1M]', { reasoning: 0.9, writing: 0.9, code: 0.9 }),
  relayProfile('live-haiku', 'claude-haiku-4-5', { reasoning: 0.7, writing: 0.8, code: 0.75 }),
  {
    id: 'live-deepseek',
    label: 'DeepSeek Chat',
    provider: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    contextWindow: 128000,
    maxOutput: 4096,
    modalities: { tools: true, json: true },
    effort: { dialect: 'none', canDisable: true },
    strengths: { writing: 0.8, extraction: 0.8, reasoning: 0.75 },
    domesticReachable: true,
  },
  {
    id: 'live-minimax',
    label: 'MiniMax M3.1',
    provider: 'MiniMax',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M3.1-Flash-Preview',
    contextWindow: 200000,
    maxOutput: 4096,
    modalities: { tools: true, json: true, vision: true, imageGen: true, videoGen: true, tts: true },
    effort: {
      dialect: 'minimax-output-effort',
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
      canDisable: true,
    },
    strengths: { writing: 0.85, multimodal: 0.95, reasoning: 0.75 },
    domesticReachable: true,
  },
];

export const livePlan: Plan = {
  goal: '写一段 300 字科普：多 AI 分工为什么比单模型更稳',
  rationale: '服务端真实运行：调研 → 写作 → 审校；每个任务由独立评委验收。',
  subtasks: [
    {
      id: 'L1',
      title: '资料员',
      description:
        '用 5 个短语列出「多个 AI 分工协作」的要点，每点不超过 20 字；标注不确定处，不要编造来源。只输出最终答案，不要展示思考过程。',
      assignedNodeId: 'researcher',
      profileId: 'live-deepseek',
      effort: 'low',
      acceptanceCriteria: '至少 5 条短语，且明确标注不确定处',
      machineCheckable: false,
      dependsOn: [],
      status: 'pending',
      attempts: 0,
    },
    {
      id: 'L2',
      title: '写手',
      description:
        '基于 L1 的要点，写一段约 120 字的中文科普。保留不确定性标注，不新增未核实事实。只输出最终答案，不要展示思考过程。',
      assignedNodeId: 'writer',
      profileId: 'live-minimax',
      effort: 'low',
      acceptanceCriteria: '约 120 字中文，包含不确定性标注，不新增未核实事实',
      machineCheckable: false,
      dependsOn: ['L1'],
      status: 'pending',
      attempts: 0,
    },
    {
      id: 'L3',
      title: '审校',
      description: '审校 L2，用两句话给出通过/返修结论和至少 2 条具体理由。只输出最终答案，不要展示思考过程。',
      assignedNodeId: 'reviewer',
      profileId: 'live-deepseek',
      effort: 'low',
      acceptanceCriteria: '给出明确结论，并至少有 2 条具体理由',
      machineCheckable: false,
      dependsOn: ['L2'],
      status: 'pending',
      attempts: 0,
    },
  ],
};

/**
 * Real acceptance judge. Uses the sonnet relay profile so it never grades its
 * own output (workers are sonnet/haiku/opus and the judge is always sonnet,
 * except when the assignee itself is sonnet; the live plan assigns sonnet only
 * to the research task, so self-judging is avoided for the writer/reviewer).
 *
 * Kept as a single-stage judge for callers that have no router model; the
 * server uses createRoutedJudge from ./acceptance.js, which adds the cheap gate
 * in front of this one.
 */
export function createLiveJudge(apiKey: string, teamContext?: string) {
  const judgeProfile = liveProfiles.find((profile) => profile.id === 'live-sonnet')!;
  return createRoutedJudge({
    full: { profile: judgeProfile, apiKey },
    teamContext,
  });
}
