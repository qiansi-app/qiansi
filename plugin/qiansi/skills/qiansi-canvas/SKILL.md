---
name: qiansi-canvas
description: 读写牵丝（Qiansi）多 AI 协作画布。当用户提到画布、工作流、编排、模型分工、子任务、产物、连线、主控模型时使用；也用于把一段讨论落成画布上的节点与连线。
---

# 牵丝画布

牵丝是一个本地优先的多 AI 协作画布。用户在上面摆节点（模型 / 任务 / 产物 / 文件库 / 项目区域），用连线表达分工，让主控模型安排工作。

画布就是 `~/.qiansi/canvas.json`，通过本地服务 `http://127.0.0.1:8787` 暴露成 API，MCP 工具（前缀 `mcp__qiansi__`）是唯一的读写入口。

## 什么时候用

- 用户问「画布现在什么样」「主控是谁」「这步产出在哪」→ `describe_canvas`（最省 token，先试它）。
- 用户想把讨论变成流程 → `add_node` + `connect_nodes`。
- 用户要改分工、换主控、删掉某个环节 → `set_orchestrator` / `update_node` / `remove_node`。
- 用户想看图像 → 用下面的「唤起可视化画布」；拿不到 VS Code 时再 `get_canvas_svg`，把 SVG 原样给出。
- 用户说「跑一遍」→ `run_canvas`，跑完用 `get_run_result` 汇报。
- 用户说「适配」「以你为主控」「把这个会话交给画布」→ `adapt_canvas`（见下）。

## 一键适配（当前会话 → 主控）

`adapt_canvas` 是"准备编排"的一步到位入口。只有你自己知道当前会话的上下文，所以由你把两样东西传进去：

- `model`：你自己的模型 id（比如 `claude-opus-4-8[1M]`）；
- `session_context`：2–4 句概括本会话在做什么、这次编排要达成什么。

工具会：把主控节点**就地**换成你的模型（不新增第二个主控）、把会话摘要写进主控角色、按需创建并列出 `workers`、连好「主控 → 工作节点（assign）」与「文件库 → 主控（context）」的标准拓扑。

适配之后：`run_canvas`（goal 用会话目标）→ `get_run_result` 汇报。

## 唤起可视化画布

牵丝在 VS Code 里有画布面板扩展（完整可拖拽界面，与 MCP 写入实时同步）。用户想"看到"画布时，直接打开它而不是贴 SVG：

```powershell
# Windows（PowerShell / cmd）
start "" "vscode://qiansi.qiansi-canvas/open"
```

```bash
# macOS / Linux
open "vscode://qiansi.qiansi-canvas/open" 2>/dev/null || xdg-open "vscode://qiansi.qiansi-canvas/open"
```

执行后告诉用户「画布面板已在 VS Code 右侧打开」。拿不到 shell 或非 VS Code 环境时，退而求其次：用 `export_canvas` 给出 HTML 链接。

## 画布语义

节点 `data.kind`：

| kind | 含义 |
|---|---|
| `model`（画布类型 `agent`） | 一个可被调用的 AI，带 provider / model / effort |
| `task` | 一个子任务，运行时会挂产物 |
| `artifact` | 一次讨论或一个阶段的产物 |
| `library` | 文件库，作为共享上下文喂给相连的节点 |
| `file` | 上传的文件 |
| `region` | 项目区域（虚线框），把一组节点圈成子项目 |

连线 `data.kind`：

| kind | 含义 |
|---|---|
| `assign` | 分派：把工作交给下游 |
| `handoff` | 交接：把上一环的结果传下去 |
| `review` | 评审：验收、挑错、退回 |
| `context` | 上下文：共享资料，不产生任务 |

主控（orchestrator）是画布上被标记的那个节点，负责拆解目标、分派、验收。运行前必须先有主控。

## 写操作的规矩

1. **先读后写**：任何 `update_node` / `remove_node` / `connect_nodes` 之前，先用 `describe_canvas` 拿到真实 ID。不要猜 ID。
2. **一条边一个语义**：不要用 `assign` 表示「顺便也评审一下」。
3. **加节点要带角色**：`role` 写清楚这个节点干什么，否则用户看不懂。
4. **改完要给地址**：工具返回里的 `app` 字段就是用户该去看的地方（桌面版直接打开应用即 8787）。
5. **失败照实说**：工具返回 `ok: false` 时把 `errors` 原样转述，不要假装成功。

## 常见套路

把一次讨论落成流程：

1. `add_node` 建节点（kind `model` 或 `task`，带 `role`）。
2. `connect_nodes` 连接：主控 → 各节点用 `assign`，节点之间用 `handoff`，验收环节用 `review`。
3. `describe_canvas` 复核一遍，向用户复述最终结构。

把产物记录到画布：`update_node` 传 `{ patch: { output: "..." } }`，产物会显示在连线上。

## 限制

- 画布上的节点 ID 唯一；重复 ID 会被拒绝并返回错误。
- 画布上限 300 个节点 / 600 条连线。
- 用户同时在画布里拖动时以版本号先到者为准；冲突时工具会返回当前服务端内容，按它重新改。
- `run_canvas` 的 live 模式需要用户先在牵丝里配好模型密钥；没配就先用 `mode: "demo"` 空跑验证结构。
