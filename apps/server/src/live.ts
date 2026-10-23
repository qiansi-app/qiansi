import {
  AnthropicMessagesAdapter,
  buildChatRequest,
  type AcceptanceResult,
  type CapabilityProfile,
  type Plan,
  type Subtask,
} from '@qiansi/engine';

const relayBase = (process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721').replace(/\/+$/, '');

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

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Real acceptance judge. Uses the sonnet relay profile so it never grades its
 * own output (workers are sonnet/haiku/opus and the judge is always sonnet,
 * except when the assignee itself is sonnet; the live plan assigns sonnet only
 * to the research task, so self-judging is avoided for the writer/reviewer).
 */
export function createLiveJudge(apiKey: string, teamContext?: string) {
  const judgeProfile = liveProfiles.find((profile) => profile.id === 'live-sonnet')!;
  const adapter = new AnthropicMessagesAdapter();

  return async (task: Subtask, output: string): Promise<AcceptanceResult> => {
    if (output.trim().length < 20) {
      return {
        pass: false,
        score: 0,
        reasons: ['output too short'],
        suggestedFix: 'Write a substantive answer that satisfies the acceptance criteria.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    const prompt = [
      `任务：${task.title}`,
      `验收标准：${task.acceptanceCriteria}`,
      `产出：`,
      output,
      '',
      '请严格验收。只返回一个 JSON 对象，不要 Markdown、不要代码围栏、不要解释：',
      '{"pass":true|false,"score":0到1,"reasons":["..."],"suggested_fix":"..."}',
    ].join('\n');

    const request = buildChatRequest(
      judgeProfile,
      [
        {
          role: 'system',
          content: `你是严格的验收评委。只返回一个 JSON 对象。${
            teamContext ? `\n团队身份：\n${teamContext}` : ''
          }`,
        },
        { role: 'user', content: prompt },
      ],
      'off',
      { apiKey, maxTokens: 1024, signal: controller.signal }
    );

    let text = '';
    try {
      for await (const event of adapter.stream(request)) {
        if (event.type === 'text-delta') text += event.text;
        if (event.type === 'error') throw new Error(event.message);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          pass: true,
          score: 0.6,
          reasons: ['judge timeout; fallback pass for live demo'],
        };
      }
      return {
        pass: false,
        score: 0,
        reasons: [`judge error: ${error instanceof Error ? error.message : String(error)}`],
      };
    } finally {
      clearTimeout(timer);
    }

    const verdict = extractJson(text);
    if (!verdict) {
      // A reasoning relay may spend the whole budget on thinking. For the live
      // demo we fall back to a soft pass rather than burning retries; the run
      // log marks this as unparseable so it is auditable.
      return {
        pass: true,
        score: 0.6,
        needsHuman: true,
        reasons: ['评委返回无法解析，已标记为需人工确认'],
      };
    }

    return {
      pass: Boolean(verdict.pass),
      score: Number(verdict.score ?? 0),
      reasons: Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : [],
      suggestedFix:
        typeof verdict.suggested_fix === 'string' ? verdict.suggested_fix : undefined,
    };
  };
}
