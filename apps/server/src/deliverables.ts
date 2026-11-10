import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '@qiansi/engine';

/**
 * 真实的成果：每次运行把每个任务的完整产出写成 .md 文件，落在本工作区的
 * deliverables 目录里。弹窗里的全文是「看过就没了」，文件才是能拿走、能进
 * 仓库、能发给人的交付物。
 *
 * 目录：~/.qiansi/deliverables/<workspaceId>/<runId>/<taskId>-<title>.md
 */

export interface Deliverable {
  taskId: string;
  title: string;
  file: string;
  bytes: number;
}

function safeName(value: string): string {
  return value.replace(/[^\w.\-一-龥]/g, '_').slice(0, 40) || 'task';
}

export function saveRunDeliverables(input: {
  stateDir: string;
  workspaceId: string;
  runId: string;
  goal: string;
  plan: Plan | undefined;
  outputs: Record<string, string>;
}): Deliverable[] {
  const dir = join(input.stateDir, 'deliverables', input.workspaceId, input.runId);
  mkdirSync(dir, { recursive: true });

  // 一份索引，说明这轮运行是什么、有哪些成果。
  const indexLines = [
    `# 运行成果 · ${input.runId}`,
    '',
    `- 目标：${input.goal}`,
    `- 时间：${new Date().toISOString()}`,
    `- 工作区：${input.workspaceId}`,
    '',
  ];
  const saved: Deliverable[] = [];

  for (const task of input.plan?.subtasks ?? []) {
    const output = input.outputs[task.id];
    if (typeof output !== 'string' || output.trim().length === 0) continue;
    const name = `${task.id}-${safeName(task.title)}.md`;
    const file = join(dir, name);
    const body = [
      `# ${task.title}（${task.id}）`,
      '',
      `- 所属运行：${input.runId}`,
      `- 目标：${input.goal}`,
      `- 验收标准：${task.acceptanceCriteria}`,
      '',
      '---',
      '',
      output.trim(),
      '',
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    saved.push({ taskId: task.id, title: task.title, file, bytes: Buffer.byteLength(body, 'utf8') });
    indexLines.push(`- [${task.title}（${task.id}）](./${name}) — ${saved[saved.length - 1]!.bytes} 字节`);
  }

  writeFileSync(join(dir, 'INDEX.md'), indexLines.join('\n'), 'utf8');
  return saved;
}

/** 在工作区的成果目录里按 taskId 找最新的那个文件。 */
export function findDeliverable(
  stateDir: string,
  workspaceId: string,
  taskId: string
): { file: string; name: string } | null {
  const root = join(stateDir, 'deliverables', workspaceId);
  if (!existsSync(root)) return null;
  let best: { file: string; name: string; mtime: number } | null = null;
  for (const runDir of readdirSync(root)) {
    const dir = join(root, runDir);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.startsWith(`${taskId}-`) && name !== `${taskId}.md`) continue;
      const full = join(dir, name);
      const mtime = existsSync(full) ? statSync(full).mtimeMs : 0;
      if (!best || mtime > best.mtime) best = { file: full, name, mtime };
    }
  }
  return best ? { file: best.file, name: best.name } : null;
}
