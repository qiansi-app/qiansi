---
allowed-tools: mcp__qiansi__describe_canvas, mcp__qiansi__get_canvas, mcp__qiansi__get_canvas_svg, mcp__qiansi__add_node, mcp__qiansi__update_node, mcp__qiansi__connect_nodes, mcp__qiansi__remove_node, mcp__qiansi__set_orchestrator, mcp__qiansi__adapt_canvas, mcp__qiansi__run_canvas, mcp__qiansi__get_run_result
description: 查看并编辑牵丝画布
---

调用 `describe_canvas` 拿到画布现状，然后用中文向用户说明：

1. 主控是哪个模型，负责什么；
2. 画布上有哪些节点、各自用什么模型、当前状态；
3. 连线表达的分工（分派 / 交接 / 评审 / 上下文）；
4. 已经产出的产物摘录。

如果用户想看图形，再调用 `get_canvas_svg` 并把 SVG 原样输出。

如果需要改动，直接调用 `add_node` / `connect_nodes` / `update_node` / `remove_node` / `set_orchestrator`，
改完把工具返回里的 `app` 地址告诉用户：「画布已经更新，打开这个地址就能看到并继续手动调整」。

用户说「适配」「把这个任务交给画布」「以你为主控准备编排」时，调用 `adapt_canvas`：
`model` 传你自己的模型 id，`session_context` 用 2–4 句概括本会话在做什么、编排要达成什么；
需要明确分工时在 `workers` 里列出（名字、模型、职责）。之后调 `run_canvas`（goal 用会话目标），
跑完用 `get_run_result` 向用户汇报每个任务的产物。

用户想直接看画布时，在 VS Code 环境里执行 `start "" "vscode://qiansi.qiansi-canvas/open"`（Windows）打开画布面板；
否则改用 `export_canvas` 给出可分享的 HTML。

不要臆造节点 ID：所有写操作前先 `describe_canvas` 或 `get_canvas` 确认真实 ID。
