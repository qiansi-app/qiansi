import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolboxOptions } from '@qiansi/engine';

/**
 * 团队：一组成员 + 一本手册。
 *
 * 借鉴 Grok Bot 团队的四条原则：
 * - 一人一职：成员不是「通用助手」，名字下面只有一件事；
 * - 团队手册广播：标准只写一次，所有成员都读，个人笔记只放自己的经验；
 * - 自治档位：调查 / 草稿 / 执行 / 全权，档位决定能不能动文件、跑命令；
 * - 少养人：成员上限 12，超过 8 个就提示先问「现有成员能不能兼任」。
 *
 * 存储位置：~/.qiansi/workspaces/<id>/team.json（每张画布一个团队）。
 */

export type Autonomy = 'investigate' | 'draft' | 'auto' | 'full';

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  investigate: '调查',
  draft: '草稿',
  auto: '执行',
  full: '全权',
};

export const AUTONOMY_DESCRIPTION: Record<Autonomy, string> = {
  investigate: '只读与检索，产出调查结论；不得写文件、跑命令。',
  draft: '只读与检索，产出修改提案或草稿；不要直接改动。',
  auto: '可以读写工作目录、执行命令；危险命令会被拒绝。',
  full: '与执行相同，并且允许对整张画布与运行做操作。',
};

export interface TeamMember {
  id: string;
  /** 称呼：讨论、分工、报告里都用它。 */
  name: string;
  /** 唯一职责，一句话。 */
  job: string;
  /** 默认模型（可空：按节点或画布决定）。 */
  model?: string;
  autonomy: Autonomy;
  /** 这个成员的长期记忆：偏好、约定、踩过的坑。 */
  memory: string;
  createdAt: number;
}

export interface TeamDoc {
  version: 1;
  playbook: string;
  members: TeamMember[];
  updatedAt: number;
}

export const TEAM_MEMBER_CAP = 12;
/** 超过这个数量只提醒，不阻止：团队变大后注意力才是成本。 */
export const TEAM_SOFT_LIMIT = 8;

const EMPTY: TeamDoc = { version: 1, playbook: '', members: [], updatedAt: 0 };

function asAutonomy(value: unknown): Autonomy {
  return value === 'investigate' || value === 'draft' || value === 'full' ? value : 'auto';
}

export class TeamStore {
  constructor(private readonly workspaceDir: string) {}

  private file(): string {
    return join(this.workspaceDir, 'team.json');
  }

  read(): TeamDoc {
    try {
      if (!existsSync(this.file())) return { ...EMPTY, members: [] };
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as Partial<TeamDoc>;
      const members = (Array.isArray(parsed.members) ? parsed.members : [])
        .filter((member): member is TeamMember => Boolean(member && member.id && member.name))
        .slice(0, TEAM_MEMBER_CAP);
      return {
        version: 1,
        playbook: String(parsed.playbook ?? ''),
        members,
        updatedAt: Number(parsed.updatedAt ?? 0),
      };
    } catch {
      return { ...EMPTY, members: [] };
    }
  }

  write(doc: TeamDoc): void {
    mkdirSync(this.workspaceDir, { recursive: true });
    writeFileSync(
      this.file(),
      JSON.stringify({ ...doc, version: 1, updatedAt: Date.now() }, null, 1),
      { encoding: 'utf8', mode: 0o600 }
    );
  }
}

export interface TeamValidation {
  ok: boolean;
  doc?: TeamDoc;
  error?: string;
  hint?: string;
  warnings?: string[];
}

const NAME_MAX = 24;
const JOB_MAX = 120;
const MEMORY_MAX = 2000;
const PLAYBOOK_MAX = 8000;
const MODEL_MAX = 80;

/** 严格的输入校验：坏数据在写入前拒绝，别让它变成运行时的怪行为。 */
export function normalizeTeamInput(input: unknown): TeamValidation {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawMembers = Array.isArray(raw.members) ? raw.members.slice(0, TEAM_MEMBER_CAP + 1) : [];
  if (rawMembers.length > TEAM_MEMBER_CAP) {
    return {
      ok: false,
      error: 'too_many_members',
      hint: `成员上限 ${TEAM_MEMBER_CAP} 人。先问一句「现有成员能不能兼任这件事」，再决定是否新增。`,
    };
  }
  const members: TeamMember[] = [];
  const names = new Set<string>();
  const jobs: Array<{ name: string; normalized: string }> = [];
  const warnings: string[] = [];
  for (const item of rawMembers) {
    const member = (item ?? {}) as Record<string, unknown>;
    const name = String(member.name ?? '').trim().slice(0, NAME_MAX);
    const job = String(member.job ?? '').trim().slice(0, JOB_MAX);
    if (!name) return { ok: false, error: 'member_name_required', hint: '每个成员都要有称呼。' };
    const key = name.toLowerCase();
    if (names.has(key)) {
      return { ok: false, error: 'duplicate_member_name', hint: `成员称呼不能重复：${name}。` };
    }
    names.add(key);
    if (!job) {
      return {
        ok: false,
        error: 'member_job_required',
        hint: `${name} 还没有职责。一人一职：写清楚他唯一负责的那件事。`,
      };
    }
    const normalizedJob = job.replace(/[\s，。,.、；;：:]/g, '');
    if (jobs.some((existing) => existing.normalized === normalizedJob)) {
      return {
        ok: false,
        error: 'member_job_overlap',
        hint: `${name} 的职责与 ${jobs.find((existing) => existing.normalized === normalizedJob)?.name} 完全相同。合并成一个成员，或换一个方向。`,
      };
    }
    const overlapping = jobs.find(
      (existing) =>
        existing.normalized.includes(normalizedJob) || normalizedJob.includes(existing.normalized)
    );
    if (overlapping) {
      warnings.push(`「${name}」与「${overlapping.name}」的职责描述有重叠，确认他们真的各管一段。`);
    }
    jobs.push({ name, normalized: normalizedJob });
    members.push({
      id: String(member.id ?? '').trim() || randomUUID(),
      name,
      job,
      model: String(member.model ?? '').trim().slice(0, MODEL_MAX) || undefined,
      autonomy: asAutonomy(member.autonomy),
      memory: String(member.memory ?? '').slice(0, MEMORY_MAX),
      createdAt: Number(member.createdAt ?? Date.now()) || Date.now(),
    });
  }
  const playbook = String(raw.playbook ?? '').slice(0, PLAYBOOK_MAX);
  return {
    ok: true,
    doc: { version: 1, playbook, members, updatedAt: Date.now() },
    warnings,
  };
}

/** 给用户看的提醒：不阻止保存，但要说出来。 */
export function teamWarnings(doc: TeamDoc): string[] {
  const warnings: string[] = [];
  if (doc.members.length > TEAM_SOFT_LIMIT) {
    warnings.push(
      `团队有 ${doc.members.length} 人。人越多，上下文、注意力和费用越多——先确认每个成员都有无法被现有成员兼任的职责。`
    );
  }
  if (doc.members.length === 0) {
    warnings.push('还没有成员。团队模式要求一人一职；先在名册里加 2–3 个具体角色。');
  }
  if (doc.members.length > 0 && !doc.playbook.trim()) {
    warnings.push('团队手册是空的。把交付标准、禁止事项写进去，所有成员都会读到。');
  }
  if (doc.playbook.length > 4000) {
    warnings.push('团队手册偏长。手册放必须遵守的标准；具体故事和一次性要求放到成员记忆里。');
  }
  return warnings;
}

/** 注入任务提示的成员身份块：名字、唯一职责、档位、记忆。 */
export function memberPrompt(member: TeamMember): string {
  return [
    `团队成员：${member.name}`,
    `唯一职责：${member.job}`,
    `自治档位：${AUTONOMY_LABEL[member.autonomy]}——${AUTONOMY_DESCRIPTION[member.autonomy]}`,
    member.memory.trim() ? `你的团队记忆（以前的经验与约定）：\n${member.memory.trim().slice(0, 1500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 只读档位允许的工具：读文件、看目录、查画布、联网检索。 */
export const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'describe_canvas',
  'get_canvas',
  'list_workspaces',
  'list_runs',
  'get_run_result',
  'web_search',
]);

/**
 * 按自治档位收紧工具箱：调查/草稿只拿到只读工具，并且执行层再拒绝一次——
 * 模型即使硬要写文件，也不会真的动到磁盘。提示词约束和代码约束各一层。
 */
export function restrictToolbox(
  toolbox: ToolboxOptions | undefined,
  autonomy: Autonomy
): ToolboxOptions | undefined {
  if (!toolbox) return undefined;
  if (autonomy === 'auto' || autonomy === 'full') return toolbox;
  return {
    ...toolbox,
    tools: toolbox.tools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name)),
    execute: async (call) => {
      if (!READ_ONLY_TOOL_NAMES.has(call.name)) {
        return {
          content: `档位「${AUTONOMY_LABEL[autonomy]}」不允许调用 ${call.name}：请给出结论或修改提案，不要直接改动。`,
          isError: true,
        };
      }
      return toolbox.execute(call);
    },
  };
}
