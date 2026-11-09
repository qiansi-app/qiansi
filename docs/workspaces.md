# 工作区：一张画布对一个会话/项目

2026-11-09。之前只有一份 `~/.qiansi/canvas.json`，不同项目的流程会堆在同一张图上。现在每个工作区有自己的目录与运行历史。

## 布局

```
~/.qiansi/workspaces.json            索引：当前工作区、名字、顺序
~/.qiansi/workspaces/<id>/canvas.json
~/.qiansi/workspaces/<id>/canvas.revision
```

首次启动会把旧的 `canvas.json` / `canvas.revision` 移进 `workspaces/main/`，命名「主画布」——旧数据不丢。

## 使用

- **界面**：顶栏「节点 / 连线」左边的下拉，切换工作区；右侧 `＋` 新建空白画布。切换是整页重载，画布、运行进度、订阅一起换，不会半新半旧。
- **接口**：所有 `/api/*` 请求带 `x-qiansi-workspace: <id>`（或 `?ws=`）；未知 id 回落到当前工作区。
- **MCP**：`list_workspaces` 查列表，`use_workspace` 切换（`create: true` 直接新建）。之后的画布与运行工具都作用于该工作区。
- **运行归属**：启动时记录 `runWorkspace`，产物回写写回同一张画布；`/api/runs` 与 `/api/runs/active` 都按工作区过滤。

## 验收（实测）

| 断言 | 结果 |
|---|---|
| 迁移出主画布 | ✅ items=[main]，canvasExists=true |
| 两个工作区各写一个节点 | ✅ 互不影响（A 的节点 / B 的节点） |
| 主画布未被测试污染 | ✅ 仍是原来那 5 个节点 |
| 删除测试工作区 | ✅ 只剩 main |
| 界面上有切换器 | ✅ 下拉里列出「主画布」 |
| 未知 id 行为 | 回落到当前工作区（只读安全） |

## 已知边界

- 同一工作区被两个窗口同时编辑时，仍以 `revision` 乐观锁 + 409 合并为准（不是实时协作）。
- 写请求带未知工作区 id 目前也会回落；要更严格可以改成 400（验收清单里的 I-04）。
- SSE `/api/runs/:id/events` 按 runId 订阅，尚未按工作区过滤（runId 本身已全局唯一，没有串台风险）。
