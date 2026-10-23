# 调研笔记（2026-10-21）

五份并行调研的浓缩版。原始简报保存在本次会话的工作流日志中；这里保留可执行结论与来源。

## 1. 竞品格局：节点是步骤，不是模型

| 产品 | 规模 | 许可 | 画布节点 | 主模型调度 | 点节点聊天 | effort 校准 |
|---|---|---|---|---|---|---|
| Dify | ~145.8k★ | Apache 2.0 修改版 | 工作流步骤 | 无 | 整应用聊天 | 无 |
| n8n | ~208k★ | Sustainable Use（非 OSI） | 集成/动作步骤 | 无 | 整工作流 | 无 |
| Langflow | 100k+★ | MIT | 组件（prompt/LLM/tool） | 无 | 单组件试跑 | 无 |
| Flowise | ~35k★ | Apache 2.0 CE + 企业版 | 工作流步骤 | 无 | 整 flow | 无 |
| ComfyUI | ~80k★ | GPL-3.0 | 张量数据流 | 无 | 无 | 无 |
| Sim | ~29.9k★ | AGPL（待核实） | 工作流步骤 | 无 | 整 flow | 无 |
| AutoGen Studio | ~45k★ | MIT | agent 规格 | 群聊涌现 | 团队级 | 无 |
| CrewAI | ~35k★ | MIT 核心 | 代码/商业云 Studio | 有 manager（仅代码） | — | 无 |

结论：五个空白（模型即节点、主模型验收权、逐任务 effort、点节点直聊+改派、选择卡）没有被任何开源画布同时覆盖。OpenAI AgentKit 与 Google Opal 验证了趋势，但闭源、不可自托管。

**不要做**：Provider 大卖场、RAG 流水线、集成/触发器平台、多人协作。

## 2. 路由与思考程度

- 四条路线：训练型 router（RouteLLM，Apache-2.0，分布漂移严重）、云 meta-router（NotDiamond，闭源）、规则+分类器网关（claude-code-router：按请求类型、token 门限、可选小模型难度分类）、负载均衡（LiteLLM：延迟/成本/冷却/熔断——这是画布连线需要的健康层）。
- Effort 方言：OpenAI `reasoning_effort`；Gemini `thinkingLevel/thinkingBudget`；Claude effort + adaptive thinking；Qwen `enable_thinking` + 128–32768；GLM `thinking.enabled`；Kimi `thinkingBudget`；DeepSeek 无旋钮，reasoner/chat 是模型切换。
- 研究：Ares（arXiv 2603.07915）逐步预测「最低足够 effort」，推理 token 最多降 52.7%，质量几乎不掉；训练-free 的 query-features + history 基线已接近学习型 router。
- v1 设计：计划期批量 rubric；验收失败先升 effort 再升模型；日志积累后离线拟合阈值；只在真平局出选择卡。

来源：https://github.com/lm-sys/RouteLLM · https://github.com/musistudio/claude-code-router · https://github.com/BerriAI/litellm · https://arxiv.org/abs/2603.07915

## 3. 画布技术

- **@xyflow/react（React Flow v12）**：MIT、TS 优先、12.12.0（2026-09-24）、53.3M 下载/月；自定义节点就是 React 组件（可内嵌流式聊天/状态）；内置 MiniMap/Controls/Background/NodeToolbar/NodeResizer/EdgeLabelRenderer/subflows/onEdgeClick；50–200 节点流畅；撤销需自建或 zundo。
- 证明：Dify（reactflow）、Flowise（reactflow@11）、Langflow（@xyflow/react@12）全部使用它。
- 备选：Rete.js v2（MIT，插件全，社区小 100 倍）；拒绝 litegraph/drawflow/baklava（停更或 Canvas 渲染无法内嵌 DOM）。
- 周围：Tailwind + shadcn/ui（组件复制进仓库、零 CDN 依赖、暗色 CSS 变量）、Zustand（React Flow 内部也用）、TanStack Virtual、react-resizable-panels。
- 视觉：深色、扁平有层次；不要重毛玻璃（数百节点时 backdrop-filter 掉帧）；模糊只用于浮层。

## 4. Provider 适配

- 两个协议适配器足够：`openai-chat`（DeepSeek/Kimi/Qwen/GLM/MiniMax 文本/OpenAI/one-api）与 `anthropic-messages`（Claude/本地中转）。
- 多模态不是 chat 形状：MiniMax 图片 `image_generation`、视频异步 `video_generation` + 轮询、TTS `t2a_v2`，需要能力子适配器与 job poller。
- `reasoning_content` 是事实标准（DeepSeek 引入，vLLM/SGLang/GLM/Kimi 跟进），但不在 OpenAI 规范里；Anthropic 用 `thinking` 块且需回传签名。
- 国内陷阱：MiniMax 国内/国际 Key 与域名不通用；Moonshot .cn/.ai 两套；OpenAI/Anthropic 常需本地中转。
- 密钥：OS 密钥链或环境变量；配置只存引用；日志脱敏。

## 5. UI 提示词与视觉参考

- **bolt.diy**（MIT）是唯一可合法原样 vendor 的提示词源：`app/lib/common/prompts.ts`。
- `x1xhlol/system-prompts-and-models-of-ai-tools`：v0/Lovable/Bolt 等泄漏提示词，**无许可证**——只阅读提炼，禁止原样提交。
- `ai-boost/awesome-prompts`、`dontriskit/awesome-ai-system-prompts`：发现索引，使用前核对许可。
- 视觉参考：Sim（信息密度）、Langflow（节点/连线手感）、LobeChat（设置面板）、Dub（运行历史/成本面板的密度）。
- 工作流：所有生成提示词放 `prompts/*.md` 版本化；每次 UI 生成都带固定的设计系统提示 + 反 slop 规则；主模型验收时用同一提示 + 截图对照。

来源：https://github.com/stackblitz-labs/bolt.diy · https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools · https://github.com/ai-boost/awesome-prompts · https://github.com/simstudioai/sim · https://github.com/langflow-ai/langflow
