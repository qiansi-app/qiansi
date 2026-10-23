# 路线图

> 原则：每个里程碑都必须有一个可运行、可演示的产物；引擎先于 UI；宁可砍功能，不砍验收闭环与 effort 校准。

## P0 — 骨架与可交互画布（当前，已完成）

- npm workspaces：`apps/studio` + `packages/engine`
- 引擎：统一类型、能力档案、effort 方言翻译、编排状态机、OpenAI-compatible + Anthropic 流式适配器
- Studio：React Flow 画布、4 个演示节点、类型化连线、点击节点对话抽屉、运行模拟、选择卡
- 文档：蓝图、调研笔记、画布规格、ADR 0001/0002
- 验收：`npm run typecheck` 与 `npm run build` 通过；浏览器可打开

## P1 — 真实闭环（进行中）

已完成：本地 Hono 服务（bootstrap/cookie、真实连接探测、幂等命令、SSE + `Last-Event-ID`、快照、`run.stop`）、CLI `probe`、Vite `/api` 代理；真实 provider 运行已跑通（本机 Claude 中转，3 个子任务 + 真实评委，约 40 秒，1742 个事件）；上下游产物现在会注入下游 prompt。

- `apps/server`：Hono + SSE；命令 POST、`snapshot(runId)`、事件流；Origin 白名单 + 启动 token（✅ 已完成）
- `packages/cli`：`probe <connection.json>`（✅ 已完成）；`run <plan.json>`（待做）
- 真实 provider 运行：本机 Claude 中转（Anthropic 协议）已跑通；DeepSeek 直连 + MiniMax 文本待接入（部分完成）
- 机器检查器（JSON schema / regex / file-exists）+ 严格评委契约 + 禁止自评（⏳；当前是 LLM 评委 + 软通过兜底）
- 本地持久化：SQLite（better-sqlite3 或 node:sqlite 回退）（⏳）
- 验收：不碰 UI，仅用 CLI 完成一次真实多模型运行并产出 `run.json` + artifacts（⏳）

## P1.5 — 可用性补强（已完成）

- 运行结果面板：按任务展示产出、验收分数/理由、需人工确认标记；复制/下载 JSON。
- 总任务完成提示：画布 toast + 浏览器桌面通知（设置可开关）。
- 重置：一键重置所有节点状态、流式消息与运行结果，支持连续多轮。
- 设置：通知、开机自启（本地 Web 仅保存偏好）、主题（深/浅）、节点密度、附着 Agent。
- 反馈：设置内提交，写入 `~/.qiansi/feedback.jsonl`。
- 验收真实化：评委返回可解析 JSON 时展示逐条理由；不可解析时标记“需人工确认”，不再伪装成通过。

## P2 — 校准与选择卡

- 计划期 rubric：每子任务 `{model, effort, reason, acceptance, machineCheckable}`
- `effortSource` 追溯 + `EffortDecisionLog`
- 失败阶梯：effort+1 → 模型升档 → 选择卡；无 effort 旋钮的模型直接升档
- 首连一致性探测 `{streaming, tools, json, vision, effortParam, reasoningField}`
- 调度器健康：EWMA、冷却、全冷却选择卡
- 四类选择卡 + 偏好权重
- 验收：连续 20 次运行中，至少 5 次自动升 effort 成功，日志可回放

## P3 — 画布进阶

- 撤销/重做、连线策略面板、拖拽改派完整契约
- 分组/子图、便签、reroute、自动布局、命令面板
- 节点成本微型条、Profile 编辑、运行历史与导出
- 验收：50+ 节点仍流畅；改派/撤销/策略均有测试

已完成（2026-10-22）：

- 主控模型可切换，名册与评委 prompt 标记 `[主控]`
- 自动排版：主控模型出坐标，失败回退本地分层
- 多模型 AI 讨论，结果可存为产物模块
- 任务/产物可拉到画布，独立模块展示，可按模块或全局隐藏
- 文件上传为模块并手动连线作为分项目上下文
- 画笔划出项目区域，双向/单向入/单向出/封闭四种方向门禁
- 节点删除统一确认与样式

## P4 — 发布

- 命名已定：牵丝 / Qiansi（见 [发布流程](release.md)）；GitHub 用 `qiansi-app` / `qiansi-labs`，域名优先 `qiansi.dev` / `qiansi.app`，npm 包名 `qiansi` 可用
- 中英双语文档、GIF、两个示例图（研究简报 / 内容生产）
- CI：类型检查、版本一致性检查、NSIS + 便携版、SHA256、标签驱动草稿 Release 已完成；适配器 fixture 测试、引擎状态机测试待做
- 打包：改名与版本资源写入完成（exe 显示 Qiansi 0.1.0）；动态端口、托盘、单实例、`asarUnpack` 已完成；本机安全软件拦截 NSIS，改由 CI 产出；代码签名待证书
- Agent 接入：OpenAI 兼容网关 + MCP（list_models / call_model / get_usage / request_approval）+ 审批面板已完成
- token 治理：运行预算、网关每分钟上限、熔断、按 agent/session 分账已完成（分账目前存内存，重启归零）
- 运行历史：`~/.qiansi/runs/<id>.json` + `/api/runs` 已完成
- 产物追溯：次级产物显示在连线上、最终产物节点、显示开关、点击查看验收，已完成
- 身份反馈：节点名称/角色可编辑，连同模型/effort 作为团队名册注入主控与评委 prompt，已完成
- 外部调用可视化：按 session 聚合「外部 Agent」节点、模型连线与产物卡片；`/api/activity` 实时广播、`/api/external` 补历史；`/api/usage.external` 按 agent/session 分账，已完成
- 验收：陌生人按 README 在 10 分钟内跑通示例

## 明确不做

RAG/知识库、100+ 集成、触发器/webhook、多用户/RBAC、模板市场、云托管、移动端、学习型路由器、插件 SDK、命令执行型验收（无沙箱前）。

## 砍功能顺序

如果进度落后，按此顺序砍：边级对话 → 计划预览 → 第二语言 → 第二个示例图。**永远不砍验收闭环与 effort 校准。**
