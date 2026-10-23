# 牵丝（Qiansi）

**一个本地优先的画布，让你接入的每个 AI 模型都成为队友。**

Qiansi 把 API 模型作为一等节点放上画布。你指定一个模型当主模型（orchestrator），它负责拆解目标、按各模型的能力档案分派子任务、为每个子任务校准思考程度、验收，并把不合格的活有界地打回修改。你可以点击任意节点或连线，与那个具体的模型持续对话，并手动改派它的任务。

> 状态：早期原型（v0.1.0）。画布与引擎契约已就位，Studio 目前跑的是模拟编排。架构已定：浏览器 Studio + 无头 CLI + 本地 Hono/SSE 服务（见 [架构决策 0001](docs/decisions/0001-architecture.md)）。发布名为「牵丝 / Qiansi」，早期的代号撞名调查保留在 [命名决策 0002](docs/decisions/0002-naming.md)。

## 为什么做

现有的可视化 AI 构建器都把**步骤**放上画布，模型只是步骤里的一个下拉框。没有一个同时提供：

1. 模型即节点，带活的能力档案
2. 一个公开拥有 拆解 → 分派 → 验收 → 返修 闭环的主模型
3. 逐子任务的思考程度校准
4. 点击节点/连线 → 与该模型持久的 1:1 会话，并可手动改派
5. 多选题式的选择卡，而不是二元批准/拒绝

Qiansi 围绕这五点设计。它不是 RAG 流水线构建器、集成平台或多用户 SaaS。

## 核心概念

- **Agent 槽位** = 角色 + 模型 + 思考程度 + 状态。槽位是画布节点，模型是它的属性；因此同一个模型可以服务多个角色。
- **类型化连线**：`assign`（派活）、`handoff`（交付）、`review`（验收）、`context`（共享上下文）。连线有语义，不只是箭头。
- **任务图**：任务带 `dependsOn`、验收标准、是否可机器检查。
- **能力档案**：每个模型一行可版本化 JSON——协议、effort 方言、模态、上下文、成本、强项、实测健康度。
- **选择卡**：只在真实取舍时出现（成本/质量平局、超预算、验收低置信、重试耗尽）。

## 架构

```
apps/studio        React + React Flow（纯视图）
packages/engine    纯 TypeScript 编排引擎、任务图、验收、effort 校准
provider 适配器     openai-chat | anthropic-messages | MiniMax 多模态子适配器
```

引擎不 import React；画布不持有业务真相。节点位置是视图状态；任务、消息、验收结果在引擎里，并通过事件流发出。

## 快速开始

```bash
npm install
npm run dev        # server :8787 + studio http://localhost:5173
```

### 桌面版

```bash
npm run desktop:dev       # Electron 窗口，热更新
npm run desktop:portable  # 生成 release/Qiansi-portable/Qiansi.exe
```

便携版自带服务端与画布，双击即可运行。打包、开机自启与已知限制见 [docs/desktop.md](docs/desktop.md)。

模型管理里的“测试连接”已经走本地服务真实探测，不再假装成功。画布的「运行编排」会向本地服务提交真实 live 运行（3 个任务 + 真实评委）；服务或中转凭据不可用时自动回退到本地演示。节点状态与输出通过 SSE 实时流入画布。

## 文档

- [蓝图](docs/blueprint.md) — 产品定义、架构、编排状态机、provider 策略、MVP
- [调研笔记](docs/research-notes.md) — 竞品格局与技术结论
- [画布规格](docs/canvas-spec.md) — 从 ComfyUI、n8n、Flowise/Langflow、Dify/Coze 与 React Flow 交互中合成的完整规格（v0 基线见 `docs/canvas-spec-v0.md`）
- [路线图](docs/roadmap.md) — 里程碑与验收标准
- [架构决策 0001](docs/decisions/0001-architecture.md) — 为什么是浏览器 + 无头 CLI + Hono/SSE
- [命名决策 0002](docs/decisions/0002-naming.md) — 已确认的撞名与发布前查重清单
- [连接、执行与保密](docs/connections-and-security.md) — 模型身份可编辑、Key 探测、沙箱工具、连接稳定性、信息保密
- [本地服务 API](docs/server-api.md) — 端点、认证、SSE、探测行为
- [桌面版](docs/desktop.md) — Electron 壳、便携打包、开机自启与限制
- [接入主流 Agent](docs/agent-integration.md) — MCP 工具、OpenAI 兼容网关、审批中继、预算
- [架构决策 0003](docs/decisions/0003-desktop.md) — Electron + 便携打包
- [English README](README.md)

## 许可证

MIT，见 [LICENSE](LICENSE)。

第三方提示词集合与泄漏的系统提示词**不会**被原样收录进本仓库；规则见 `docs/research-notes.md`。
