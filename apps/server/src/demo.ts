import type {
  CapabilityProfile,
  ChatAdapter,
  NormalizedChatRequest,
  NormalizedStreamEvent,
  Plan,
} from '@qiansi/engine';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Demo adapter used by the server until real provider keys are configured.
 * It streams a canned specialist answer so the full run/snapshot/SSE loop can
 * be exercised without spending tokens.
 */
export class DemoAdapter implements ChatAdapter {
  async *stream(request: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
    const lower = system.toLowerCase();

    const text = lower.includes('research') || system.includes('研究')
      ? '已完成检索与交叉核实：6 条事实、2 个争议点，来源已标注。'
      : lower.includes('write') || system.includes('写')
        ? '初稿完成：3 节结构、约 900 字，已按验收标准自检。'
        : lower.includes('review') || system.includes('审')
          ? '验收完成：2 处事实需要补来源，其余通过；建议返修第 2 段。'
          : '子任务完成，产出已写入运行账本。';

    for (let index = 0; index < text.length; index += 8) {
      yield { type: 'text-delta', text: text.slice(index, index + 8) };
      await delay(60);
    }
    yield { type: 'usage', input: 120, output: 80 };
    yield { type: 'done', reason: 'stop' };
  }
}

function demoProfile(id: string): CapabilityProfile {
  return {
    id,
    label: id,
    provider: 'Demo',
    protocol: 'openai-chat',
    baseUrl: 'demo://',
    model: id,
    contextWindow: 128000,
    maxOutput: 8192,
    modalities: { tools: true, json: true },
    effort: { dialect: 'none', canDisable: true },
    strengths: {},
    domesticReachable: true,
  };
}

export const demoProfiles: CapabilityProfile[] = [
  demoProfile('demo-researcher'),
  demoProfile('demo-writer'),
  demoProfile('demo-reviewer'),
];

export const demoPlan: Plan = {
  goal: '演示：调研 → 写作 → 验收',
  rationale: '服务端演示计划；P1 接入真实 provider 后替换。',
  subtasks: [
    {
      id: 'T1',
      title: '研究员',
      description: '检索并核实 6 条事实。',
      assignedNodeId: 'researcher',
      profileId: 'demo-researcher',
      effort: 'medium',
      acceptanceCriteria: '至少 5 条带来源的事实',
      machineCheckable: false,
      dependsOn: [],
      status: 'pending',
      attempts: 0,
    },
    {
      id: 'T2',
      title: '写手',
      description: '基于 T1 产出写 900 字初稿。',
      assignedNodeId: 'writer',
      profileId: 'demo-writer',
      effort: 'medium',
      acceptanceCriteria: '3 节结构、保留来源标记',
      machineCheckable: false,
      dependsOn: ['T1'],
      status: 'pending',
      attempts: 0,
    },
    {
      id: 'T3',
      title: '审校',
      description: '按验收标准核查 T2。',
      assignedNodeId: 'reviewer',
      profileId: 'demo-reviewer',
      effort: 'high',
      acceptanceCriteria: '逐条核查并给出返修建议',
      machineCheckable: false,
      dependsOn: ['T2'],
      status: 'pending',
      attempts: 0,
    },
  ],
};
