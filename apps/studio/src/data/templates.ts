export interface WorkflowTemplate {
  id: string;
  title: string;
  hint: string;
  /** Pre-filled goal. Ends with a colon so the user just appends their topic. */
  goal: string;
}

/**
 * Most people stare at an empty canvas. These are the five shapes that come up
 * again and again; each one fills the goal box so the main model has something
 * concrete to plan against.
 */
export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'research',
    title: '调研报告',
    hint: '检索 → 成文 → 核对',
    goal:
      '围绕下面这个主题写一份 1500 字调研报告：先多源检索并标出不确定的地方，再成文，最后逐条核对引用与数字。主题是：\n',
  },
  {
    id: 'longform',
    title: '长文写作',
    hint: '初稿 → 挑薄弱处 → 改稿',
    goal:
      '把下面这个主题写成一篇 2000 字的公众号长文，结构清晰、有具体例子；写完先由审校挑出论证最薄弱的三处，再改一版。主题是：\n',
  },
  {
    id: 'codereview',
    title: '代码评审',
    hint: '找缺陷 → 排序 → 最小改动',
    goal:
      '评审我接下来提供的代码：先列出潜在缺陷、边界条件与安全隐患，再按严重度排序，给出最小改动建议。代码是：\n',
  },
  {
    id: 'competitor',
    title: '竞品分析',
    hint: '对比 → 找缺口 → 差异化',
    goal:
      '就下面这个领域做竞品分析：列出 3–5 个竞品，对比定位、能力、定价与缺口，最后给出我方差异化建议。领域是：\n',
  },
  {
    id: 'script',
    title: '短视频脚本',
    hint: '三选一 → 口播稿 → 控时长',
    goal:
      '写一个 60 秒短视频脚本：先给三个候选切入角度，选最有张力的一版写成口播稿和分镜，再压缩到 60 秒念得完。题材是：\n',
  },
];
