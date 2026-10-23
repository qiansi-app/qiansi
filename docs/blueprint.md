# Qiansi 蓝图 v0.2

> 状态：基于 2026-10-21 的五份调研（竞品、路由/思考程度、画布技术、Provider 适配、UI 提示词源）+ 3 套竞争性架构 + 3 位评委。已采纳 **浏览器 Studio + 无头 CLI + Hono/SSE**，见 [架构决策 0001](decisions/0001-architecture.md)。
> P1 已完成：本地 Hono 服务（bootstrap/cookie、真实连接探测、幂等命令、SSE、快照、`run.stop`）、CLI `probe`、Vite 代理；真实 provider 运行已跑通（3 任务 + 真实评委，约 40 秒），并修复了依赖产物向下游注入的编排缺陷。
> **发布名已定：牵丝 / Qiansi**。早期的代号 AgentWeave 及备选名查重记录保留在 [命名决策 0002](decisions/0002-naming.md)。

## 1. 一句话

一个本地优先、开源的多 AI 协作画布：把每个 API 模型作为节点放上画布，指定一个主模型当指挥；它负责拆解任务、按能力分派、验收、打回修改，你随时点节点或连线与单个 AI 对话并手动改派。

## 2. 市场空白（为什么值得做）

现有画布产品（Langflow、Flowise、Dify、n8n、Bisheng、Sim、ComfyUI）的节点都是**步骤**：prompt、LLM 调用、条件、工具。模型只是节点配置里的一个下拉框。AutoGen Studio 有团队调度但节点是 agent 规格，CrewAI 有 manager 但可视化在收费云。由此留下五个空白：

1. **模型即节点**：每个接入的 API 模型是一等实体，带活的能力档案，而不是配置字段。
2. **主模型拥有验收权**：一个被明确指定的 orchestrator，公开拥有 拆解 → 分派 → 验收 → 有界返修 的闭环。AutoGen 的调度是群聊涌现，不是有验收权的经理。
3. **逐任务思考程度校准**：同一模型在不同子任务上使用不同推理强度。目前没有产品化实现；研究侧（RouteLLM、Ares 等）尚未落到画布产品。
4. **点节点直聊 + 手动改派**：与某个具体模型的持久 1:1 会话，并能在会话里重新协商任务归属。现有产品要么只能跑单个组件，要么只能和整个团队聊天。
5. **选择卡式人机协同**：不是二元批准/拒绝，而是把真实取舍（成本 vs 质量、超预算、低置信度）做成多选项交给用户。

明确不做的三件事（避免单人开发陷入焦油坑）：Provider 大卖场、RAG/知识库流水线、集成/触发器平台与多人协作。

## 3. 核心概念

### 3.1 节点 = Agent 槽位，不是裸模型

用户的心智是「模型上画布」，但分工通常按角色发生。解法是 **Agent Slot**：

```
AgentSlot = 角色(role) + 模型(profileId) + 思考程度(effort) + 能力约束 + 运行状态
```

- 一个槽位默认绑定一个模型；同一模型可以被多个槽位复用（例如 DeepSeek 同时做「资料员」和「审稿人」）。
- 画布上显示的是槽位；模型是它的属性。这样既满足「模型即节点」的直觉，又让连线有明确的分工语义。
- orchestrator 也是一个槽位，带 `kind: "orchestrator"` 标记（皇冠），全图唯一（v1 限制）。

### 3.2 连线的语义（typed wires）

不要用一根万能箭头。v1 定义四种边，颜色和标签不同：

| 类型 | 含义 | 方向 |
|---|---|---|
| `assign` | 上游把子任务派给下游 | 上游 → 下游 |
| `handoff` | 上游产出物作为下游输入 | 上游 → 下游 |
| `review` | 下游验收/审查上游产出 | 下游 → 上游（语义上） |
| `context` | 共享上下文/记忆，不触发执行 | 双向虚线 |

点击任意连线打开该边的会话/日志（v1 先做只读日志；v2 支持边级对话）。

### 3.3 任务图

```ts
interface Subtask {
  id: string
  title: string
  description: string
  assignedNodeId: string
  effort: 'off' | 'low' | 'medium' | 'high' | 'max'
  acceptanceCriteria: string
  machineCheckable: boolean
  dependsOn: string[]
  status: 'pending' | 'ready' | 'running' | 'reviewing' | 'done' | 'failed' | 'blocked'
  attempts: number
  artifacts: string[]
}
```

`dependsOn` 决定就绪顺序；任务图是画布运行的唯一真相，画布只是它的视图。

### 3.4 选择卡（Choice Card）

只在真正需要人拍板时出现，固定四类：

1. 成本/质量接近平局（两个方案的预估成本差 < 20%，质量评分差 < 0.5）
2. 预算将超（预估 token/费用 > 用户设定阈值的 80%）
3. 验收置信度低（orchestrator 自评 < 0.6，且无机器可查标准）
4. 连续返修仍失败（达到重试上限）

每张卡带 2–4 个选项、各自代价与后果；用户的选择会写回偏好权重，后续同类情况自动采用。

### 3.5 能力档案（Capability Profile）

每个模型一行、可版本化的 JSON。字段见 `config/capabilities.seed.json` 与 `packages/engine/src/types.ts`。关键点：

- `effort.dialect` 描述该模型接受哪种思考程度参数（见 §6 表）。
- `strengths` 是 0–1 的手工种子 + 运行结果更新。
- `measured` 记录 EWMA 延迟、成功率、冷却时间，供路由和熔断使用。
- 未知字段不猜：未映射的 effort 值降级为模型默认值，绝不原样发送导致 400。

## 4. 系统架构

```
┌───────────────────────────── apps/studio (React + React Flow) ─────────────────────────────┐
│  Canvas 节点/连线视图        ChatDrawer 单节点会话        ChoiceCard 选择卡        Run 控制条  │
└───────────────▲──────────────────────────────▲───────────────────────────────▲─────────────┘
                │ graph JSON / commands        │ events (SSE/WS)               │
┌───────────────┴──────────────────────────────┴───────────────────────────────┴─────────────┐
│ packages/engine (纯 TypeScript，无 DOM、无 React)                                            │
│  Orchestrator 状态机 · 任务图 · 验收器 · 成本账本 · 事件日志 · 能力档案 · 路由/effort 校准      │
└───────────────▲──────────────────────────────▲───────────────────────────────▲─────────────┘
                │ NormalizedChatRequest        │ NormalizedStreamEvent         │
┌───────────────┴──────────────────────────────┴───────────────────────────────┴─────────────┐
│ Provider adapters: openai-chat | anthropic-messages | MiniMax 多模态子适配器（image/video/tts）│
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

三条硬规则：

1. **引擎不依赖 UI**：可以只用 Node 脚本跑完一次编排，测试不启动浏览器。
2. **画布不持有业务真相**：节点位置、缩放是视图状态；任务、消息、验收结果是引擎状态。
3. **事件驱动**：引擎发事件，UI 订阅；所有事件写入 run log（v1 用 JSONL，v2 用 SQLite），既用于回放，也用于后续 effort 校准的数据集。

v0.2 决策：Studio 通过本地 **Hono** 服务通信——命令走 POST，运行事件走 **SSE**（`Last-Event-ID` 可续传），重连先读 `snapshot(runId)` 再接收约 50ms 批量事件，避免重放数千条日志。`packages/cli` 在 M1 先于 UI 跑通闭环（FakeModel 离线测试）。见 [0001](decisions/0001-architecture.md)。

## 5. 编排循环

### 5.1 状态机

```
IDLE
 └─ user.start(goal) → PLANNING
PLANNING
 └─ orchestrator 产出 Plan { subtasks[], edges[], rationale }
     ├─ 低置信/高成本 → CHOICE_PENDING（选择卡）
     └─ 直接进入 DISPATCHING
DISPATCHING
 └─ 取所有 ready 任务 → 并行 EXECUTING（受并发上限约束）
EXECUTING
 └─ 适配器流式返回 → REVIEWING
REVIEWING
 ├─ machineCheckable 先跑机器检查（测试/JSON schema/字数/链接）
 ├─ 通过 → DONE
 └─ 失败 → REVISING
REVISING
 ├─ attempts < 2 → effort 升一档 → 重新 EXECUTING
 ├─ attempts == 2 → 模型升一档（同角色换更强 profile）→ 重新 EXECUTING
 └─ 仍失败 → CHOICE_PENDING（重试/换模型/改验收标准/终止）
CHOICE_PENDING
 └─ 用户选择 → 回到对应状态；选择写入偏好
DONE / ABORTED
```

### 5.2 验收器

优先级：**机器检查 > 独立 reviewer 节点 > orchestrator 评分**；主控绝不给自己执行的任务打分。

- **机器检查失败 → 强制返修**，无论 LLM 评委怎么说；**机器检查通过 → 直接接受**，不再调用评委（省 token）。
- 机器检查由任务声明：`test`、`json_schema`、`regex`、`max_words`、`url_reachable`。`command-exit` 检查器推迟到有沙箱与超时之后。
- orchestrator 评分用固定 rubric，输出 `{pass, score, failures:[{criterionId, evidence}], suggested_fix}`；每个失败必须引用 criterion id；无法解析视为失败；评委 effort 固定 medium，禁止递归评审。
- 当 orchestrator 就是执行者时，验收路由到指定 reviewer 节点或人类选择卡，绝不通过提示词要求“公正”。
- 验收结果必须落盘（`acceptance.json`），是后续争议和校准的证据。

### 5.3 思考程度校准 v1（不训练）

1. **计划期一次批量 rubric**：主模型在产出 Plan 时，为每个子任务输出 `{subtask_id, model_id, effort, reason, acceptance_criteria, machine_checkable}`。不逐消息调用分类器，避免第二次 LLM 调用的误差与成本。
2. **确定性门**：先按 token 数/上下文长度做硬路由（超长上下文 → 长上下文模型）；任务类型直接来自计划的结构化拆解。
3. **验收循环即校准器**：失败时先升 effort，再升模型档位，最多 2 次；把 `(任务特征, effort, 重试次数, 结果, token)` 写入日志。
4. **离线拟合**：累计几百次运行后，用 2–3 个特征拟合 logistic 阈值；不引入在线训练系统。
5. **只对真平局出选择卡**：避免每步都打扰用户。

## 6. Provider 适配层

### 6.1 只需要两个协议适配器

- `openai-chat`：覆盖 DeepSeek、Kimi、Qwen、GLM、MiniMax 文本、OpenAI，以及任何 OpenAI-compatible 网关（one-api/new-api）。
- `anthropic-messages`：覆盖 Claude 与本地 Anthropic-format 中转。
- 多模态走能力子适配器：`ImageCapable`、`VideoCapable`（异步任务轮询）、`TtsCapable`。MiniMax 的图片/视频/语音端点不是 chat 形状，必须单独实现。

统一类型：

```ts
interface NormalizedChatRequest {
  model: string
  messages: NormalizedMessage[]
  tools?: ToolSpec[]
  effort: 'off' | 'low' | 'medium' | 'high' | 'max'
  budgetTokens?: number
  signal?: AbortSignal
}
type NormalizedStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'toolcall-delta'; id: string; name?: string; argsDelta?: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'done'; reason: 'stop' | 'length' | 'tool_calls' | 'aborted' }
```

适配器是「注入 fetch 的纯翻译层」，可用录制的 SSE fixture 离线单测。

### 6.2 思考程度方言表

| Provider | 参数形态 | 取值 | 备注 |
|---|---|---|---|
| OpenAI | `reasoning_effort` | none/minimal/low/medium/high | 部分模型拒绝该参数，发送前查档案 |
| DeepSeek | `reasoning_effort`（chat） | 低/中/高（以文档为准） | reasoner 与 chat 是模型切换；`reasoning_content` 返回 |
| Kimi | 默认思考，`chat_template_kwargs.thinking=false` 关闭 | on/off | K2-thinking 默认开 |
| Qwen | `enable_thinking` + `thinking_budget` | 128–32768 | 部分 thinking 变体强制开启 |
| GLM | `thinking.type` | enabled/disabled | 文档确认后落表 |
| Claude | `thinking.budget_tokens` | >1024 且 < max_tokens | max_tokens 必填；thinking 块需回传签名 |
| MiniMax | `output_config.effort`（Anthropic-format） | low/medium/high/xhigh/max | 国内版 base 为 api.minimaxi.com |

发送规则：`capabilities.seed.json` 里的 `effort.dialect` 决定翻译方式；值不在白名单时**降级为默认**并记录警告，不原样发送。

### 6.3 密钥与国内网络

- 密钥只存 OS 密钥链（Electron `safeStorage` / Windows DPAPI）或环境变量；配置文件只存引用。UI 永远掩码显示。
- baseUrl 按 provider 可配，禁止硬编码；国内/国际域名与 Key 不通用（MiniMax、Moonshot 都有两套）。
- 所有请求支持 per-provider 超时、SSE 心跳与 `Retry-After` 退避。
- v1 允许把 one-api/new-api 当作普通 `openai-chat` 通道接入，但不做成硬依赖。

## 7. 画布规格 v0

> 完整交互规格已由画布深挖工作流产出，见 [canvas-spec.md](canvas-spec.md)（节点解剖、契约边、九状态机、连线策略、放行卡、拖拽改派、快捷键）。本节是实现基线。

### 7.1 节点解剖

```
┌───────────────────────────────────────────┐
│ ● 资料员            [high]   ⋮            │  ← 状态点 + 角色 + effort 徽章 + 菜单
│ DeepSeek · deepseek-reasoner              │  ← 模型行
│ ─────────────────────────────────────────  │
│ 正在核对第 3 条来源…                       │  ← 单行进度回声（不放大段流）
│ ○ in    assign →              review ○    │  ← 类型化端口
└───────────────────────────────────────────┘
```

- orchestrator 节点：金色/琥珀色描边 + 皇冠图标；全图唯一。
- provider 用左侧 3px 色条区分（DeepSeek 蓝、MiniMax 橙、Claude 陶土、Kimi 紫、Qwen 绿）。
- 节点默认紧凑；悬停显示快捷操作（聊天、重跑、改派、复制）。
- 状态点颜色：灰 idle、蓝 queued、青 running、紫 reviewing、绿 done、红 failed、黄 blocked-on-user。

### 7.2 画布级交互

- 左侧/顶部节点面板：搜索 + 按 provider 分组 + 拖拽入画布。
- 连线：从端口拖出；松开在空白处弹出节点搜索（easy-connect）；边中点可加标签；支持 reroute 节点。
- 选择多个节点成组（subflow），可折叠。
- 便签（sticky note）用于人类批注，不参与执行。
- 小地图、缩放控制、点阵背景；缩放到 60% 以下节点退化为「图标 + 名称 + 状态点」。
- 撤销/重做（zundo 或自建命令栈）；自动保存到本地。
- 运行条：Run/Pause/Stop、当前波次、token/费用、并发数。

### 7.3 点击即对话

- 点击节点：右侧滑出抽屉（可拖宽、可固定），标签页 Chat / Tasks / Logs / **Profile**。
- Chat 是与该槽位的持久线程；消息带任务上下文徽章（属于哪个 subtask）；聊天消息可提升为返修备注。
- 流式输出显示在抽屉里；节点内只显示一行进度回声，避免画布重绘爆炸。
- 抽屉底部提供手动覆盖：改 effort、改派任务、重跑此任务、跳过、编辑验收标准后重跑。
- 点击连线：打开该边的共享线程 + 事件流（v2 支持边级对话）。
- **拖拽任务到另一个节点 = 改派**：中止在飞请求（AbortController），发出 `TaskReassigned`，在新节点重开 attempts，记录 `outcome=human_override`。

### 7.4 选择卡与连线策略

- 固定在画布右下角或对应节点旁；包含问题、2–4 个选项、每个选项的预估代价/后果（`costDelta`、`qualityHint`）。
- 选择后卡片折叠为历史记录，可在 run log 里回看；每个选择写入偏好权重。
- 连线承载策略：`Edge.policy { allowedTaskKinds[], maxParallel }`，由调度器在分派前读取；面板里可编辑。连线是机器可检查的分工，不是装饰。
- 保存图时校验“有且只有一个 orchestrator”，并给可见错误。

### 7.5 快捷键（v1）

| 键 | 动作 |
|---|---|
| Space + 拖拽 | 平移画布 |
| Ctrl/Cmd + K | 命令面板（加节点、搜索、运行） |
| Ctrl/Cmd + Z / Shift+Z | 撤销 / 重做 |
| Delete | 删除选中节点/边 |
| Enter | 打开选中节点的聊天 |
| R | 运行选中节点/整个图 |
| Esc | 关闭抽屉/取消连线 |

### 7.6 视觉方向

深色、扁平但有层次：近黑背景（#0B0D10）、1px 边框、轻微 elevation；只在浮动面板/命令面板/对话框使用模糊，避免数百节点时 backdrop-filter 掉帧。参考 Sim 的信息密度、Langflow 的节点/连线手感、LobeChat 的设置面板质感。

## 8. MVP 范围

**做**：

- 两个协议适配器 + 4 个种子 provider（DeepSeek、MiniMax、Kimi、Claude/本地中转）
- 手动搭图 + 主模型生成 Plan + 任务图执行
- 验收循环（机器检查 + orchestrator rubric + 有界返修）
- 点节点聊天 + 手动改派
- 选择卡（先做预算与连续失败两类）
- 本地 JSON 持久化、run log（JSONL）
- 深色画布与节点状态可视化

**不做（v1）**：

- RAG/知识库、100+ 集成、多人协作、市场/模板商店、云托管、移动端
- 自动能力探测（v2）、离线阈值拟合（v2）、边级对话（v2）
- 桌面打包（先本地 web；v2 再评估 Electron/Tauri）

## 9. 仓库结构

```
Qiansi/
├─ apps/studio/                # React + React Flow 画布
├─ packages/engine/            # 纯 TS 编排引擎（无 DOM）
├─ config/capabilities.seed.json
├─ docs/
│  ├─ blueprint.md
│  ├─ canvas-spec-v0.md
│  ├─ research-notes.md
│  └─ roadmap.md
├─ package.json                # npm workspaces
├─ README.md / README.zh-CN.md
└─ LICENSE (MIT)
```

## 10. 路线图

| 阶段 | 目标 | 验收 |
|---|---|---|
| P0（当前） | 骨架 + 可交互画布 + 引擎类型 + Mock 适配器 | 浏览器里能点节点聊天、跑一次假编排 |
| P1 | 真实 provider（OpenAI-compatible + Anthropic）+ 验收循环 | 用 DeepSeek/MiniMax 真跑一个 3 子任务流程 |
| P2 | 能力档案 + effort 校准日志 + 选择卡 | 失败自动升 effort/升档；日志可回放 |
| P3 | 画布进阶：分组、便签、reroute、缩略图、撤销、模板 | 50+ 节点仍流畅 |
| P4 | 打包与发布：Electron/Tauri、i18n、文档站、示例库 | 一键安装，GitHub Release |

## 11. 连接、执行与保密

模型身份（显示名 / Provider / 协议 / baseUrl / modelId / 密钥引用）与能力档案分离，节点只绑定 `connectionId`，可随时切换；改连接会同步所有引用它的节点，保存前提示并提供克隆。

API Key 只进 OS 密钥链或 0600 保险库，配置与日志只存引用；首连探测由服务端发最小真实请求，返回可达性、流式、usage、工具/JSON/vision/effort 检查与延迟，浏览器只拿结果。电脑操控采用沙箱化工具运行时：每节点授权 `fs.read/fs.write/shell/browser/screen/network`，默认拒绝，危险动作人工放行，全程审计；`shell` 必须在 WSL2/Docker 沙箱内，`screen` 放 V2。

连接稳定性：SSE 心跳 + `Last-Event-ID` + 快照重连 + 幂等命令 ID + 指数退避 + 每 provider EWMA/冷却；全冷却时出选择卡。保密：默认无遥测、本地优先、日志与导出脱敏、导出不含密钥；同时明确告知模型提供方与本地中转能看到 prompt。

完整设计见 [connections-and-security.md](connections-and-security.md)。

## 12. 风险

1. **Provider 漂移**：参数与模型名变化快。对策：能力档案版本化 + 首连探测 + 未知值降级。
2. **限额与网络**：国内订阅常有 5 小时/周窗口。对策：429 可见化、退避、可切换通道、成本账本。
3. **密钥安全**：本地配置文件易泄露。对策：OS 密钥链、掩码、`.gitignore`、日志脱敏。
4. **单人范围失控**：画布产品容易膨胀。对策：严格非目标清单；引擎先行；每个里程碑可发布。
5. **许可证污染**：Dify 修改版 Apache、n8n fair-code、Sim AGPL、Flowise 附加条款。对策：只参考交互，不复制代码；本项目 MIT。
6. **提示词版权**：泄漏的系统提示词只能阅读提炼，不能原样提交。对策：`prompts/` 只放自写文本，引用 bolt.diy（MIT）时保留声明。

## 13. 待定决策（需要创始人拍板）

1. ~~产品名与 GitHub 仓库名~~ 已定：牵丝 / Qiansi；GitHub 组织用 `qiansi-app` 或 `qiansi-labs`（精确 handle 已被个人账号占用）。
2. 桌面形态：本地 web（最快）/ Electron（密钥链方便）/ Tauri（轻但引入 Rust）。
3. 默认存储：JSONL（v0 简单）/ SQLite（可查询、可回放，推荐 v1 起）。
4. 节点语义：Agent Slot（推荐）vs 裸模型节点。
5. 首个真实 provider 组合：建议 DeepSeek（规划/写作）+ MiniMax（多模态）+ 本地 Claude 中转（评审）。
