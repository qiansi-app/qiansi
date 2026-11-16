/**
 * 纠错回路自检：失败之后，第二次尝试的提示词里必须带上一轮失败原因。
 *
 *   npx tsx scripts/check-correction.ts
 */
import type {
  AcceptanceResult,
  CapabilityProfile,
  ChatAdapter,
  NormalizedChatRequest,
  NormalizedStreamEvent,
  RunEvent,
  Subtask,
} from '@qiansi/engine';
import { buildCorrectionBrief, Orchestrator } from '@qiansi/engine';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const profile: CapabilityProfile = {
  id: 'fake',
  label: 'Fake',
  provider: 'fake',
  protocol: 'openai-chat',
  baseUrl: 'http://127.0.0.1:1',
  model: 'fake-1',
  contextWindow: 32000,
  maxOutput: 2048,
  modalities: { text: true },
  effort: { dialect: 'effort', values: ['low', 'high'], canDisable: true },
};

const subtask: Subtask = {
  id: 't1',
  title: '写报告',
  description: '写一份两段式报告',
  assignedNodeId: 'n1',
  profileId: 'fake',
  effort: 'high',
  acceptanceCriteria: '包含结论段',
  machineCheckable: false,
  dependsOn: [],
  status: 'pending',
  attempts: 0,
};

console.log('buildCorrectionBrief');
const brief = buildCorrectionBrief(
  {
    pass: false,
    score: 0.3,
    reasons: ['缺少结论段', '没有引用来源'],
    suggestedFix: '补一段结论并标注来源',
  },
  {
    tools: [
      { name: 'write_file', ok: false, args: '{"path":"out/a.md"}', content: 'EACCES: permission denied' },
      { name: 'read_file', ok: true, args: '{"path":"out/a.md"}', content: '# hi' },
    ],
  },
  0
);
check('带上失败原因', brief.text.includes('缺少结论段'), brief.text);
check('带上建议改法', brief.text.includes('补一段结论并标注来源'));
check('带上失败的工具调用与返回', brief.text.includes('write_file') && brief.text.includes('EACCES'));
check('不把成功的调用算成失败', !brief.text.includes('read_file {'), brief.text);
check('toolErrors 只收失败项', brief.toolErrors.length === 1 && brief.toolErrors[0].includes('EACCES'), JSON.stringify(brief.toolErrors));

console.log('编排器把纠错带进第二次尝试');
const requests: NormalizedChatRequest[] = [];
const adapter: ChatAdapter = {
  async *stream(request: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
    requests.push(request);
    yield { type: 'text-delta', text: `answer #${requests.length}` };
    yield { type: 'usage', input: 10, output: 5 };
    yield { type: 'done', reason: 'stop' };
  },
};
let judgeCalls = 0;
const verdicts: AcceptanceResult[] = [
  { pass: false, score: 0.3, reasons: ['缺少结论段'], suggestedFix: '补一段结论' },
  { pass: true, score: 0.9, reasons: [] },
];
const events: RunEvent[] = [];
const hooks = { before: 0, after: 0 };
const orchestrator = new Orchestrator({
  profiles: [profile],
  adapters: { 'openai-chat': adapter },
  maxRetries: 1,
  taskTimeoutMs: 5000,
  maxOutputTokens: 512,
  runId: 'run-correction',
  accept: async () => verdicts[Math.min(judgeCalls++, verdicts.length - 1)],
  beforeTask: () => {
    hooks.before += 1;
  },
  afterTask: () => {
    hooks.after += 1;
    return [{ path: 'out/report.md', bytes: 12, mtime: Date.now(), kind: 'text', source: 'write_file' }];
  },
});
orchestrator.on((event) => events.push(event));

const plan = { goal: '写报告', subtasks: [structuredClone(subtask)] };
const result = await orchestrator.run(plan);

check('运行完成', result.status === 'done', result.status);
check('调用了两次模型', requests.length === 2, String(requests.length));

const systemOf = (index: number) =>
  String((requests[index]?.messages ?? []).find((message) => message.role === 'system')?.content ?? '');
check('第一次提示词不含纠错段', !systemOf(0).includes('Previous attempt failed acceptance'));
check('第二次提示词含纠错段', systemOf(1).includes('Previous attempt failed acceptance'), systemOf(1).slice(0, 200));
check('第二次提示词含未通过原因', systemOf(1).includes('缺少结论段'));
check('第二次提示词含建议改法', systemOf(1).includes('补一段结论'));

const revised = events.find((event) => event.type === 'task.revised');
check('发出 task.revised', Boolean(revised));
if (revised && revised.type === 'task.revised') {
  check('revised 带 attempt', revised.attempt === 0, String(revised.attempt));
  check('revised 带原因列表', (revised.reasons ?? []).includes('缺少结论段'));
  check('revised 带建议改法', revised.fix === '补一段结论');
}

const completed = events.find((event) => event.type === 'task.completed');
if (completed && completed.type === 'task.completed') {
  check('完成事件带产物', (completed.files ?? []).length === 1, JSON.stringify(completed.files));
  check('artifacts 字段同步', (completed.artifacts ?? [])[0] === 'out/report.md');
  check('尝试日志两条', (completed.attemptLog ?? []).length === 2, JSON.stringify(completed.attemptLog));
  check('尝试日志记下失败原因', (completed.attemptLog?.[0]?.reasons ?? []).includes('缺少结论段'));
} else {
  check('发出 task.completed', false);
  check('尝试日志两条', false);
  check('尝试日志记下失败原因', false);
}
check('beforeTask / afterTask 各调用一次', hooks.before === 1 && hooks.after === 1, JSON.stringify(hooks));

console.log(failed === 0 ? '\nCORRECTION OK' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
