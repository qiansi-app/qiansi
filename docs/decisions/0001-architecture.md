# 架构决策记录 0001：采用「浏览器 Studio + 无头 CLI + Hono/SSE」

日期：2026-10-21
状态：已采纳
输入：5 份调研简报、3 套竞争性架构、3 位独立评委（产品体验 / 工程可持续 / 开源生态）

## 决策

采用 **Proposal B**：引擎优先、无头 CLI 先行、浏览器 Studio 通过本地 Hono 服务与 SSE 事件流通信。不采用 Electron 作为 v0.1 的壳。

```
packages/engine     纯 TS 编排引擎（可独立运行、可用 FakeModel 离线测试）
packages/providers  两个协议适配器（openai-chat / anthropic-messages）
packages/cli        weft run <plan>，M1 即可跑通完整闭环
apps/server         Hono + @hono/node-server：命令 POST，事件 SSE，快照接口
apps/studio         React + React Flow，纯视图，订阅事件
```

## 评委评分

| 评委 | A Maestro（Electron 单应用） | B Weft（浏览器 + CLI） | C Weft（Electron 事件溯源） |
|---|---|---|---|
| 产品体验 | 40.0 | **41.5** | 38.5 |
| 工程可持续 | 41.0 | **43.0** | 39.0 |
| 开源生态 | 40.0 | **41.0** | 40.5 |

三位评委一致选择 B。理由集中在三点：

1. **引擎先行的可证明性**：M1 就能用 CLI + FakeModel 跑完“3 个模型 + 一次强制返修”，在任何 UI 存在之前证明引擎与界面可分离。
2. **单人可完成性**：一个 Node 进程，没有 Electron 主版本、安装包签名、safeStorage 边界情况与自动更新通道要维护；12 周兼职计划最可信。
3. **中国大陆首个运行体验**：`npx` 经 npm 镜像即可试用，不需要下载约 100 MB 的 Electron 包，也不会触发 SmartScreen 未签名警告。

B 的代价与对策：

- 没有 OS 密钥链 → v0.1 用 0600 文件保险库，VaultPort 预留，桌面壳落地时换 safeStorage/DPAPI。
- 原生感弱 → 接受；画布体验靠 React Flow + 设计令牌补足。
- 本地命令端点有 CSRF 风险 → 必须加 Origin 校验 + 每次启动的 bearer token（评委明确指出 B 原方案缺失）。

## 必须从落选方案吸收的规则

### 验收安全（来自 A + C）

1. **机器检查优先于 LLM 评审**：`checkerSpec` 作为数据（JSON schema / regex / file-exists；command-exit 推迟到有沙箱与超时之后）。
2. **机器检查失败 → 强制返修**，无论 LLM 评委怎么说；**机器检查通过 → 直接接受**，不再调用评委（省 token）。
3. **主控不得自评**：当 orchestrator 节点就是执行者时，验收路由到指定 reviewer 节点或人类选择卡，绝不通过提示词要求“公正”。
4. **严格评委契约**：`{pass, score, failures:[{criterionId, evidence}]}`；每个失败必须引用 criterion id；无法解析视为失败；评委 effort 固定 medium，禁止递归评审；评委与人类判断不一致要记录，供后续调 prompt。

### 计划与 effort（来自 A + C）

5. **计划 schema 失败处理**：一次带 zod 错误文本的修复重试，仍失败则用确定性启发式线性计划 + 可见提示，绝不因 plan_invalid 卡死。
6. **计划偏差策略**：计划分派到未连接/无资格的节点时，替换为最佳合格节点并记录偏差；两个候选强度差 < 0.05 或计划置信度 < 0.55 时出选择卡。
7. **effort 来源可追溯**：每个任务记录 `effortSource: rubric | heuristic | human | escalation` 与原因字符串，UI 徽章悬停可解释。
8. **无 effort 旋钮的模型**（DeepSeek reasoner、强制思考的 Kimi/Qwen 变体）：跳过 effort+1，直接升模型档位；UI 显示 `effort ignored`，不伪造数值。
9. **非对称规则**：只有在验收可机器检查时才允许降低 effort；主观验收只能升不能降。

### 画布与交互（来自 A + C）

10. **连线承载策略**：`Edge.policy { allowedTaskKinds[], maxParallel }` 由调度器读取；连线是分工策略，不是装饰。
11. **拖拽任务到节点改派**：中止在飞请求（AbortController），发出 `TaskReassigned`，在新节点重开 attempts，记录 `outcome=human_override`。
12. **快照 + 约 50ms 批量事件**：重连/刷新读快照，不从事件日志重放数千条；事件日志保留用于审计与回放。
13. **撤销/重做必须在 v0.1**：zundo 或自建命令栈；画布的核心手势就是画线，不能撤销会立刻显得像玩具。
14. **节点视觉词汇**：状态点、effort 徽章 + 原因、成本微型条、provider 强调色；流式输出只进侧栏，不进节点。
15. **一个图只能有一个 orchestrator**：在保存时校验并给可见错误，而不是运行时才报。
16. **Profile 标签页**：节点面板里可直接编辑能力档案，与聊天并列。

### 数据与运维（来自 A + C）

17. **RunEvent 固定 schema**：`(seq, runId, type, payload, ts)`；`PromptVersion(path, sha256, body, usageCount)`；Artifact 记录 `promptVersionId` 与内容哈希。
18. **调度器健康**：每个 profile 维护 EWMA 成功率/延迟、`Retry-After` 感知的指数冷却、沿出边回退；全部冷却时出选择卡，而不是静默卡住。
19. **首连一致性探测**：`{streaming, tools, json, vision, effortParam, reasoningField}` 探测矩阵填充能力档案；网络失败时回退到种子档案。
20. **国内连接检查**：连接时检测 Key/域名不匹配（MiniMax/Moonshot 国内 vs 国际），每连接可配代理；发布 `provider-quirks.md`。
21. **运行导出**：JSON manifest + artifacts 文件夹；不能离开应用的产出没有真实价值。
22. **关键路径调度**：priority 降序，criticalPathLength 降序作为 tiebreak。
23. **密钥与脱敏**：vault 引用、UI 掩码、事件 payload 中的请求体脱敏、日志不得出现 Key；v0.1 至少 0600 文件保险库 + 环境变量回退。
24. **命名与发布**：发布前查 GitHub/npm/crates.io/商标；三名候选（Weft、Maestro、Heddle）均已被占用。最终发布名定为 牵丝 / Qiansi，查重记录见 [0002](0002-naming.md)。

## 对当前仓库的影响

- `packages/engine` 已按「无 UI 依赖」实现，下一步补：`checkerSpec`、`effortSource`、`PromptVersion`、`RunEvent.seq`、调度器健康、计划修复重试。
- `apps/studio` 当前是纯前端模拟；P1 增加 `apps/server`（Hono + SSE）与 `packages/cli`，Studio 改为订阅快照与事件。
- `apps/studio` 的节点/连线/对话抽屉已按评委的视觉词汇实现；下一步补撤销/重做、连线策略面板、拖拽改派。
- 选定浏览器形态后，桌面壳（Electron/Tauri）推迟到 P4，VaultPort 保留。

## 未决

1. 产品名（Qiansi 需查重；备选需重新做 GitHub/npm 检索）。
2. v0.1 是否内置 `apps/server` 的最小鉴权（Origin 白名单 + bearer）——建议必须有。
3. `command-exit` 检查器是否进入 v0.1（评委建议：没有沙箱就不要进）。
