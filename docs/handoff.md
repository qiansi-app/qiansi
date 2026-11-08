# 接续 Agent 会话

2026-11-08。一个模块：**一键读取当前 agent 对话的上下文与项目内容，接着干**，并可选自动编排工作流。

## 它做什么

1. **读会话**：`~/.claude/projects/<编码目录>/<session>.jsonl`（Claude Code）或 `~/.codex/sessions/**`（Codex），取最近修改的那个，只从**文件尾部读 512KB**（会话常达几十 MB），解析出用户最近的要求、agent 最近的结论、用过的工具、是否出现过错误。
2. **读项目**：git 分支与是否有未提交改动、`git ls-files` 前 60 条、package.json 的包名与脚本、README 前 2400 字。
3. **脱敏**：整份资料包在落盘前统一过 `redactSecrets`——会话里贴过 key 是常态。
4. **挂到画布**：写成一份 ≤ 数十 KB 的 Markdown，落到 `~/.qiansi/files/`，并挂到一个名为「接续上下文」的公共资料库节点（已存在则更新，不重复建）。
5. **自动编排（可选）**：把会话里最近一条要求交给 `/api/workflow`，让主控模型拆解成 3–5 个节点并连线；先试画布自己的主控，调不通时自动退到目录里可用的模型。
6. **立即运行（可选）**：编排成功后可马上起一次 live 运行（走单运行互斥）。

## 入口

- **界面**：画布工具栏「更多 → 接续 Agent 会话」，可选来源（自动 / Claude Code / Codex）、项目目录、是否自动编排、是否立即运行；返回后显示读到的是哪条会话、多少条记录、多久以前、资料包大小、新增了哪些节点。
- **MCP**：`handoff_from_agent`（参数同上）。DSH / Claude Code / Codex 里的 agent 可以直接调用。
- **HTTP**：`POST /api/handoff`。

## 实测记录

| 项 | 结果 |
|---|---|
| 抽取（真实会话） | 找到 `e--agentweave` 下 47 条记录的 Claude Code 会话，资料包 7.9KB |
| 无自动编排 | 只写资料库节点，画布节点数不变 ✅ |
| 自动编排 | 新增 4 个节点、12 条连线，画布 6 → 10 ✅ |
| MCP 工具 | 21 个工具中含 `handoff_from_agent`，调用返回 session/bytes ✅ |
| 界面 | 「更多」菜单出现「接续 Agent 会话」，面板含来源/目录/两个开关/按钮 ✅（截图 `qiansi-dogfood/handoff-modal.png`） |

## 过程中修掉的两个真 bug

1. **自动编排“静默失败”**：`/api/workflow` 返回的是 `{ workflow: { nodes, edges } }`，我按顶层 `nodes` 读，永远拿到空数组，却只留下一句模糊提示。现在解析正确，且失败原因会写进返回的 `notes`（HTTP 状态或异常消息）。
2. **主控不可用就整段放弃**：编排沿用画布主控，主控走的中转断了就 502。现在先试画布主控，失败自动退到目录里可用的模型。

## 已知限制

- Codex 会话结构未完整核实，解析是尽力而为（解析不到就给空，并提示「未找到可读的会话记录」）。
- 会话只读尾部：一次超长工作最前面的决策不在资料包里。
- 自动编排复用 `/api/workflow`，会消耗一次主控模型的调用。
- 读取范围只覆盖 Claude Code 与 Codex 两家；其他 agent 需要新增适配。

## 文件

- 读取与合成：`apps/server/src/handoff.ts`
- 接口：`apps/server/src/index.ts`（`POST /api/handoff`）
- 界面：`apps/studio/src/components/HandoffModal.tsx`
- MCP：`packages/mcp/server.mjs`（`handoff_from_agent`）
