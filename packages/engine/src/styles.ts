/**
 * 对话风格：同一件事，说法不同，结果差很多。
 *
 * 风格不是装饰。它同时决定三件事——
 *   1. 这个节点怎么干活（directive）；
 *   2. 它的产物交给下游时保留什么、丢掉什么（handoff）；
 *   3. 多 AI 讨论时它怎么接别人的话（discussion）。
 *
 * 场景表来自产品定义：学概念用脚手架、找点子用头脑风暴、验风案用辩论、
 * 做选择用收敛、理思路用同行、要落地用顾问、查资料用专家直答、情绪低落
 * 用共情、演练用角色扮演。
 */

export type ConversationStyle =
  | 'scaffold'
  | 'brainstorm'
  | 'debate'
  | 'converge'
  | 'peer'
  | 'consultant'
  | 'expert'
  | 'empathy'
  | 'roleplay';

export interface ConversationStyleDef {
  id: ConversationStyle;
  label: string;
  scenario: string;
  /** 工作指令：这个节点该怎么组织自己的输出。 */
  directive: string;
  /** 交接规则：上游产物交给下游时怎么改写。 */
  handoff: string;
  /** 讨论规则：多 AI 讨论时怎么接话。 */
  discussion: string;
  /** 角色/任务名里出现这些词时自动推荐。 */
  tags: string[];
}

export const CONVERSATION_STYLES: ConversationStyleDef[] = [
  {
    id: 'scaffold',
    label: '引导型 / 脚手架式',
    scenario: '学新知识、理解概念',
    directive:
      '用脚手架方式带着读者走：先确认已经知道什么，再把新概念拆成两三层，每层给一个具体例子，最后留一个问题检验理解。不要一次抛出全部结论。',
    handoff: '把上游结论拆成三段：已确认的事实、仍待验证的假设、下一步要做的动作。',
    discussion: '你不直接给答案，而是先复述别人观点中你认同的部分，再提一个能把讨论推进一层的问题；必要时给一个最小例子。',
    tags: ['教学', '讲解', '解释', '入门', '入门者', '学'],
  },
  {
    id: 'brainstorm',
    label: '头脑风暴式',
    scenario: '需要新点子',
    directive:
      '先大量发散，再收敛提示。至少给出 8 个不同的点子，允许粗糙；每个点子后面用一行标注「赌注／成本／大概多难验证」。不要在发散阶段自我否定。',
    handoff: '保留全部点子，按主题聚类，不要删减；把上游已排除的点子单独列一节并写明排除理由。',
    discussion: '优先接别人的点子往上加或做变体，不要重复已经说过的；可以提出与前面发言者完全不同的方向。',
    tags: ['创意', '点子', '头脑风暴', '构思', '灵感', '发散'],
  },
  {
    id: 'debate',
    label: '辩论 / 魔鬼代言人',
    scenario: '方案有风险要验证',
    directive:
      '你负责唱反调。先复述方案主张，再给出三条以上最强的反对论证（每条附一个具体反例或失败场景），然后列出该主张在什么条件下才成立。不要为了平衡而稀释反对意见。',
    handoff: '对上游的每一条结论，都加一句「最可能被推翻的地方」；保留风险清单与触发条件。',
    discussion: '挑前面发言中最脆弱的一条结论反驳，给出理由和反例；被反驳时只承认有证据的部分。',
    tags: ['审校', '审核', '风险', '评审', '反驳', '检查', '复核'],
  },
  {
    id: 'converge',
    label: '收敛决策式',
    scenario: '做选择题',
    directive:
      '把问题收敛成一个决定。列出 2-4 个候选与 3-5 条判据，给出对照表，然后明确推荐一个，说明被放弃的选项为什么放弃，最后写一条「如果推荐错了，最早会在哪里看出来」。',
    handoff: '把上游内容压缩成决策表：选项 / 判据打分 / 结论 / 放弃理由；只保留影响决策的信息。',
    discussion: '每轮结束前把分歧收敛成「已达成一致 / 仍有分歧 / 需要什么证据才能定」，并给出你的倾向。',
    tags: ['决策', '选择', '取舍', '对比', '选型', '优先级'],
  },
  {
    id: 'peer',
    label: '同行讨论式',
    scenario: '找人聊清思路',
    directive:
      '像一个了解背景的同行在和你一起想：先说出你听懂的版本，再补充你注意到的细节，允许说「我不确定」，可以不给出结论。重点是让思路变清楚，而不是给标准答案。',
    handoff: '保留讨论中的分歧点和未定项，不要强行统一；标出哪些结论是共识、哪些只是一位参与者的看法。',
    discussion: '接着别人具体说的内容往下聊，可以补充、可以修正、也可以说「这点我也没想清楚」；避免总结陈词。',
    tags: ['讨论', '聊聊', '复盘', '梳理', '想法', '思路'],
  },
  {
    id: 'consultant',
    label: '顾问式',
    scenario: '要一个能落地的方案',
    directive:
      '先写清目标与约束（时间、人力、预算、不能动的东西），再给一个可落地的方案：分步骤、每步的产出与负责人/依赖、验收标准、风险与兜底。方案要能在真实条件下执行，不要停在原则层面。',
    handoff: '把上游整理成四段：现状 / 约束 / 方案步骤 / 验收标准；把不可执行的建议直接删掉。',
    discussion: '每次发言都要落到「谁在什么时候做什么、怎么算做到了」；对没有验收标准的建议提出质疑。',
    tags: ['顾问', '落地', '实施', '交付', '计划', '执行', '方案'],
  },
  {
    id: 'expert',
    label: '专家直答 / 精简式',
    scenario: '日常查资料、写东西',
    directive:
      '直接给结论，不要铺垫。先一句话回答，再列要点（最好不超过五条），必要时给来源或依据。不写「首先、其次」这类过场话。',
    handoff: '只传结论与关键依据，删掉推理过程和客套话；保留必要的数字与出处。',
    discussion: '一句话表明立场，然后最多三条依据；不复述主题，不评价别人的表达方式。',
    tags: ['研究员', '资料', '检索', '事实', '查', '写手', '摘要', '总结'],
  },
  {
    id: 'empathy',
    label: '倾听共情式',
    scenario: '情绪低落时',
    directive:
      '先接住情绪：用一两句话准确复述对方的处境与感受（不要夸张，也不要评判），再问一个开放但具体的问题。除非对方明确要建议，否则不要给解决方案，更不要说「你应该」。',
    handoff: '保留对方的原话与情绪线索；转述时不要加解释性判断，不要被下游当作事实依据。',
    discussion: '先回应情绪，再谈内容；遇到分歧时不争胜负，指出双方各自在意的点。',
    tags: ['安慰', '情绪', '倾诉', '共情', '低落', '倾听'],
  },
  {
    id: 'roleplay',
    label: '角色扮演式',
    scenario: '面试、谈判演练',
    directive:
      '按指定角色说话：先用一行写清你扮演谁、立场与目的，然后完全以该角色的口吻回应（面试官就追问，谈判对手就施压）。保持角色，不跳出解释；结束时另起一段给三点评点。',
    handoff: '保留角色设定、关键台词与对方的反应；把点评与角色发言分开标注，避免下游误读为事实。',
    discussion: '以你的角色身份与其他人对话，可用角色立场制造真实压力；每轮结尾可标注「角色外的一句话」。',
    tags: ['演练', '模拟', '面试', '谈判', '角色', '扮演'],
  },
];

const STYLE_MAP = new Map<string, ConversationStyleDef>(
  CONVERSATION_STYLES.map((style) => [style.id, style])
);

export function styleById(id: string | undefined | null): ConversationStyleDef {
  return STYLE_MAP.get(String(id ?? '')) ?? STYLE_MAP.get('expert')!;
}

export function isConversationStyle(value: unknown): value is ConversationStyle {
  return typeof value === 'string' && STYLE_MAP.has(value);
}

/**
 * Picks a style from a node's name/role. The order is the tie-breaker: a role
 * like「安全评审，给出落地建议」should read as a review (debate), not as a plan
 * (consultant), so the more specific intents are checked first. The user can
 * always override, and a guess is visible in the node's inspector.
 */
const SUGGEST_ORDER: ConversationStyle[] = [
  'roleplay',
  'empathy',
  'debate',
  'converge',
  'consultant',
  'scaffold',
  'brainstorm',
  'peer',
  'expert',
];

export function suggestStyle(text: string): ConversationStyle {
  const value = String(text ?? '');
  for (const id of SUGGEST_ORDER) {
    const style = STYLE_MAP.get(id)!;
    if (style.tags.some((tag) => value.includes(tag))) return style.id;
  }
  return 'expert';
}

/** The block an orchestrator adds to a worker's system prompt. */
export function stylePrompt(style: ConversationStyleDef): string {
  return [
    `对话风格：${style.label}（适用：${style.scenario}）`,
    style.directive,
    `交接规则：${style.handoff}`,
  ].join('\n');
}

/** The block a discussion round adds to each participant's system prompt. */
export function discussionPrompt(style: ConversationStyleDef): string {
  return [
    `讨论风格：${style.label}（适用：${style.scenario}）`,
    style.discussion,
  ].join('\n');
}
