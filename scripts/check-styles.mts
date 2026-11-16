/**
 * 风格系统的自检：定义完整性、中英文推断、提示词拼装。
 *
 *   npx tsx scripts/check-styles.ts
 */
import {
  CONVERSATION_STYLES,
  discussionPrompt,
  isConversationStyle,
  styleById,
  stylePrompt,
  suggestStyle,
} from '@qiansi/engine';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

console.log('定义完整性');
check('九种风格', CONVERSATION_STYLES.length === 9, String(CONVERSATION_STYLES.length));
for (const style of CONVERSATION_STYLES) {
  const complete = Boolean(
    style.directive.trim() && style.handoff.trim() && style.discussion.trim() && style.scenario.trim()
  );
  check(`${style.id} 三段齐全`, complete);
  check(`${style.id} 有中文标签`, /[一-龥]/.test(style.label), style.label);
  check(`${style.id} 有中英文关键词`, style.tags.some((tag) => /[一-龥]/.test(tag)) && style.tags.some((tag) => /[a-z]/i.test(tag)), style.tags.join(','));
}

console.log('中文推断');
const zhCases: Array<[string, string]> = [
  ['安全评审，找出风险', 'debate'],
  ['新概念教学助手', 'scaffold'],
  ['方案选型对比', 'converge'],
  ['创意头脑风暴', 'brainstorm'],
  ['落地实施计划', 'consultant'],
  ['资料检索员', 'expert'],
  ['情绪安慰', 'empathy'],
  ['面试演练', 'roleplay'],
  ['思路复盘讨论', 'peer'],
];
for (const [text, expected] of zhCases) {
  const got = suggestStyle(text);
  check(`「${text}」→ ${expected}`, got === expected, got);
}

console.log('英文推断（过去一律落到 expert）');
const enCases: Array<[string, string]> = [
  ['Code Reviewer', 'debate'],
  ['Risk Audit', 'debate'],
  ['Brainstorm partner', 'brainstorm'],
  ['Roadmap Planner', 'consultant'],
  ['Research assistant', 'expert'],
  ['Interview coach', 'roleplay'],
  ['Community Support', 'empathy'],
  ['Concept Tutor', 'scaffold'],
  ['Tradeoff comparison', 'converge'],
  ['Thinking partner', 'peer'],
];
for (const [text, expected] of enCases) {
  const got = suggestStyle(text);
  check(`「${text}」→ ${expected}`, got === expected, got);
}
check('大小写不敏感', suggestStyle('CODE REVIEWER') === 'debate', suggestStyle('CODE REVIEWER'));

console.log('兜底与守卫');
check('没有关键词时兜底 expert', suggestStyle('节点 A') === 'expert', suggestStyle('节点 A'));
check('未知 id 不通过守卫', !isConversationStyle('nope'));
check('已知 id 通过守卫', isConversationStyle('debate'));
check('未知 id 回落到 expert', styleById('nope').id === 'expert', styleById('nope').id);

console.log('提示词拼装');
const debate = styleById('debate');
const worker = stylePrompt(debate);
check('工作提示词含 directive', worker.includes(debate.directive));
check('工作提示词含交接规则', worker.includes(debate.handoff));
const talk = discussionPrompt(debate);
check('讨论提示词含 discussion', talk.includes(debate.discussion));
check('讨论提示词不混入工作指令', !talk.includes(debate.directive));

console.log('画布节点 → 计划任务（节点上的 style 字段真的生效）');
const { buildPlanFromCanvas } = await import('../apps/server/src/plan-from-canvas.js');
const document = {
  version: 1,
  revision: 1,
  savedAt: 0,
  orchestratorId: 'lead',
  nodes: [
    { id: 'lead', type: 'agent', data: { kind: 'agent', name: '主控', model: 'deepseek-flash' } },
    { id: 'a', type: 'agent', data: { kind: 'agent', name: '评审', model: 'deepseek-flash', style: 'scaffold' } },
    { id: 'b', type: 'agent', data: { kind: 'agent', name: 'Code Reviewer', model: 'deepseek-flash' } },
    { id: 'c', type: 'agent', data: { kind: 'agent', name: '节点 C', model: 'deepseek-flash', style: 'bogus' } },
  ],
  edges: [
    { id: 'e1', source: 'lead', target: 'a' },
    { id: 'e2', source: 'lead', target: 'b' },
    { id: 'e3', source: 'lead', target: 'c' },
  ],
};
const built = buildPlanFromCanvas(document as never, '目标');
const styleOf = (nodeId: string) =>
  built?.plan.subtasks.find((task) => task.assignedNodeId === nodeId)?.style;
check('显式指定优先于关键词推断', styleOf('a') === 'scaffold', String(styleOf('a')));
check('未指定时按英文名推断', styleOf('b') === 'debate', String(styleOf('b')));
check('非法值回落推断而不是报错', styleOf('c') === 'expert', String(styleOf('c')));

console.log(failed === 0 ? '\nSTYLES OK' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
