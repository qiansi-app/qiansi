import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { redactSecrets } from '@qiansi/engine';
import type { ToolboxOptions, ToolSpec } from '@qiansi/engine';

/**
 * 节点工具：让画布上的工作节点真正读写文件、执行命令、查询画布与联网。
 *
 * 边界：
 * - 文件与命令都限制在工作目录（handoff 时是会话所在项目）之内；
 * - 命令有危险动作黑名单、超时与输出上限，全部写审计；
 * - 返回给模型的文本统一过 redactSecrets，防止把密钥带进提示词与日志。
 */

export interface NodeToolboxDeps {
  rootDir: string;
  workspaceId: string;
  runId?: string;
  canvas: () => unknown;
  workspaces: () => Array<{ id: string; name: string; archivedAt?: number }>;
  runs: () => Array<{ runId: string; status: string; goal: string; workspaceId?: string }>;
  runResult: (runId: string) => unknown;
  search?: (query: string, maxResults: number) => Promise<Array<{ title: string; url: string; snippet?: string }>>;
  audit: (entry: { action: string; target?: string; detail?: Record<string, unknown> }) => void;
}

const MAX_READ = 120_000;
const MAX_WRITE = 400_000;
const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

/** 明显会毁掉机器或仓库的命令：直接拒绝，并写进工具结果让模型换做法。 */
const DANGEROUS = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\breg\s+delete\b/i,
  /\bbcdedit\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\s+--force\b/i,
  /\brm\s+-rf\s+[\/\\]\s*$/i,
  /\b(del|rd|rmdir)\s+\/[sq].*[a-z]:\\?\s*$/i,
  /\bremove-item\b[^\n]*-recurse[^\n]*[a-z]:\\?\s*$/i,
];

function clip(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n…（输出已截断，共 ${text.length} 字符）` : text;
}

function inside(root: string, rawPath: string): string {
  const target = resolve(root, String(rawPath || '.'));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越出工作目录：${rawPath}`);
  }
  return target;
}

function schema(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { name, description, parameters };
}

export function buildNodeToolbox(deps: NodeToolboxDeps): ToolboxOptions {
  const root = resolve(deps.rootDir);
  const tools: ToolSpec[] = [
    schema(
      'read_file',
      '读取工作目录内的文本文件。相对路径相对工作目录。返回文件内容（超长会截断）。修改文件前先用它读原内容。',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作目录' },
          offset: { type: 'integer', minimum: 1, description: '从第几行开始（默认 1）' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: '最多读多少行' },
        },
        required: ['path'],
        additionalProperties: false,
      }
    ),
    schema(
      'write_file',
      '在工作目录内写入文本文件（覆盖或用 append 追加）。会自动创建父目录。只做最小必要修改。',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作目录' },
          content: { type: 'string', description: '要写入的完整文本' },
          append: { type: 'boolean', description: 'true 时追加到文件末尾' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }
    ),
    schema(
      'list_dir',
      '列出工作目录内某个目录的文件与子目录（名称、类型、大小）。',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，默认工作目录根' },
          limit: { type: 'integer', minimum: 1, maximum: 400, description: '最多列出多少项，默认 200' },
        },
        additionalProperties: false,
      }
    ),
    schema(
      'run_command',
      '在工作目录内执行一条 shell 命令并返回 stdout/stderr 与退出码。适合运行测试、类型检查、git 查询。危险命令（格式化、关机、git reset --hard 等）会被拒绝。',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: MAX_TIMEOUT,
            description: '超时毫秒数，默认 30000',
          },
        },
        required: ['command'],
        additionalProperties: false,
      }
    ),
    schema('describe_canvas', '用文本描述当前画布：节点、类型、模型、状态与连线数量。', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    schema('get_canvas', '返回当前画布的完整 JSON（超长会截断）。', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    schema('list_workspaces', '列出所有画布（含归档），含 id、名称与是否归档。', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    schema('list_runs', '列出最近的运行记录：runId、状态、目标与所属画布。', {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    }),
    schema('get_run_result', '按 runId 取一次运行的快照与每个任务的产出。', {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
      additionalProperties: false,
    }),
  ];
  if (deps.search) {
    tools.push(
      schema(
        'web_search',
        '联网检索并返回标题、URL 与摘要。用于核实当前事实、价格、发布与统计；只引用返回的 URL，不得编造来源。',
        {
          type: 'object',
          properties: {
            query: { type: 'string' },
            max_results: { type: 'integer', minimum: 1, maximum: 10 },
          },
          required: ['query'],
          additionalProperties: false,
        }
      )
    );
  }

  const execute = async (call: { name: string; arguments: string }) => {
    const args = (() => {
      try {
        return JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const started = Date.now();

    try {
      switch (call.name) {
        case 'read_file': {
          const target = inside(root, String(args.path ?? ''));
          if (!existsSync(target)) throw new Error(`文件不存在：${args.path}`);
          const info = statSync(target);
          if (info.isDirectory()) throw new Error(`这是目录，请用 list_dir：${args.path}`);
          if (info.size > 2 * 1024 * 1024) throw new Error(`文件过大（${info.size} 字节），请改用 run_command 分段读取`);
          const raw = readFileSync(target, 'utf8');
          const lines = raw.split(/\r?\n/);
          const offset = Math.max(1, Number(args.offset ?? 1) || 1);
          const limit = Math.min(2000, Math.max(1, Number(args.limit ?? 2000) || 2000));
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const body = slice.map((line, index) => `${offset + index}\t${line}`).join('\n');
          return { content: clip(redactSecrets(body, []), MAX_READ) };
        }
        case 'write_file': {
          const target = inside(root, String(args.path ?? ''));
          const content = String(args.content ?? '');
          if (content.length > MAX_WRITE) throw new Error(`内容过大（${content.length} 字符），上限 ${MAX_WRITE}`);
          mkdirSync(dirname(target), { recursive: true });
          if (args.append === true) {
            writeFileSync(target, content, { encoding: 'utf8', flag: 'a' });
          } else {
            writeFileSync(target, content, 'utf8');
          }
          return {
            content: `已${args.append === true ? '追加' : '写入'} ${relative(root, target) || target}（${content.length} 字符）`,
          };
        }
        case 'list_dir': {
          const target = inside(root, String(args.path ?? '.'));
          if (!existsSync(target)) throw new Error(`目录不存在：${args.path}`);
          const entries = readdirSync(target, { withFileTypes: true })
            .slice(0, Math.min(400, Number(args.limit ?? 200) || 200))
            .map((entry) => {
              const full = join(target, entry.name);
              let size = '';
              try {
                size = entry.isDirectory() ? 'dir' : `${statSync(full).size}B`;
              } catch {
                size = '?';
              }
              return `${entry.isDirectory() ? '[d]' : '[f]'} ${entry.name} ${size}`;
            });
          return { content: clip(entries.join('\n') || '（空目录）', 8000) };
        }
        case 'run_command': {
          const command = String(args.command ?? '').trim();
          if (!command) throw new Error('command 为空');
          const danger = DANGEROUS.find((rule) => rule.test(command));
          if (danger) throw new Error(`命令被安全策略拒绝：${command.slice(0, 120)}`);
          const timeout = Math.min(
            MAX_TIMEOUT,
            Math.max(1000, Number(args.timeout_ms ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT)
          );
          const result = await runShell(command, root, timeout);
          deps.audit({
            action: 'node.tool',
            target: deps.runId ?? deps.workspaceId,
            detail: {
              tool: 'run_command',
              command: command.slice(0, 300),
              code: result.code,
              ms: Date.now() - started,
            },
          });
          const text = [
            `exit=${result.code}${result.timedOut ? '（超时被终止）' : ''}`,
            result.stdout ? `stdout:\n${result.stdout}` : '',
            result.stderr ? `stderr:\n${result.stderr}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          return { content: clip(redactSecrets(text, []), MAX_OUTPUT), isError: result.code !== 0 };
        }
        case 'describe_canvas': {
          const doc = deps.canvas() as {
            nodes?: Array<{ id?: string; type?: string; data?: Record<string, unknown> }>;
            edges?: unknown[];
            orchestratorId?: string;
          };
          const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
          const lines = [
            `节点 ${nodes.length} 个 · 连线 ${Array.isArray(doc?.edges) ? doc.edges.length : 0} 条` +
              (doc?.orchestratorId ? ` · 主控 ${doc.orchestratorId}` : ''),
          ];
          for (const node of nodes.slice(0, 60)) {
            const data = node.data ?? {};
            lines.push(
              `- ${data.name ?? node.id}（${node.type ?? '?'}）模型 ${data.model ?? '-'} · 状态 ${data.status ?? '-'}`
            );
          }
          return { content: clip(lines.join('\n'), 12_000) };
        }
        case 'get_canvas':
          return { content: clip(JSON.stringify(deps.canvas(), null, 1), 20_000) };
        case 'list_workspaces': {
          const lines = deps.workspaces().map(
            (item) => `${item.id}\t${item.name}${item.archivedAt ? '（已归档）' : ''}`
          );
          return { content: clip(lines.join('\n') || '（没有画布）', 8000) };
        }
        case 'list_runs': {
          const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10) || 10));
          const lines = deps.runs().slice(0, limit).map(
            (run) => `${run.runId}\t${run.status}\t${run.workspaceId ?? '-'}\t${String(run.goal).slice(0, 60)}`
          );
          return { content: clip(lines.join('\n') || '（没有运行）', 8000) };
        }
        case 'get_run_result': {
          const id = String(args.run_id ?? '').trim();
          if (!id) throw new Error('run_id 为空');
          return { content: clip(JSON.stringify(deps.runResult(id), null, 1), 20_000) };
        }
        case 'web_search': {
          if (!deps.search) throw new Error('联网检索不可用');
          const query = String(args.query ?? '').trim();
          if (!query) throw new Error('query 为空');
          const max = Math.min(10, Math.max(1, Number(args.max_results ?? 6) || 6));
          const hits = await deps.search(query, max);
          const lines = [`检索「${query}」：${hits.length} 条`];
          hits.forEach((hit, index) => {
            lines.push(`${index + 1}. ${hit.title}`);
            lines.push(`   ${hit.url}`);
            if (hit.snippet) lines.push(`   ${hit.snippet.slice(0, 200)}`);
          });
          return { content: clip(redactSecrets(lines.join('\n'), []), 8000) };
        }
        default:
          return { content: `未知工具：${call.name}`, isError: true };
      }
    } finally {
      if (call.name !== 'run_command') {
        deps.audit({
          action: 'node.tool',
          target: deps.runId ?? deps.workspaceId,
          detail: { tool: call.name, args: JSON.stringify(args).slice(0, 200), ms: Date.now() - started },
        });
      }
    }
  };

  return {
    tools,
    execute,
    maxRounds: 6,
  };
}

interface ShellOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能已经退出
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
