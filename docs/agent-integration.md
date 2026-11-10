# 接入主流 Agent（网关 + MCP）

Qiansi 把画布上的模型池暴露给主流 agent。两种接法可以同时使用：

1. **MCP（推荐）**：agent 自己的模型当主控；通过 MCP 工具调用画布上的下属模型，危险动作走审批。
2. **OpenAI-compatible 网关**：把 `baseURL` 指向 `http://127.0.0.1:8787/v1`，任何 OpenAI 兼容客户端都能把画布当模型供应商。

## 认证

服务端令牌在 `~/.qiansi/server-token`（或环境变量 `QIANSI_TOKEN`）。

```powershell
$token = Get-Content "$env:USERPROFILE\.qiansi\server-token" -Raw
```

请求头二选一：`Authorization: Bearer <token>` 或 `x-qiansi-token: <token>`。旧名 `x-agentweave-token` 仍被接受，MCP server 也会同时发送新旧两套请求头。

### 端口与两枚令牌

打包版桌面应用每次启动都会挑一个空闲端口，并把实际端口写到 `~/.qiansi/server-port`。MCP server、插件 hook 和 Codex hook 都按「`QIANSI_URL` 环境变量 → 端口文件 → 8787」的顺序找服务，所以不需要手工配置端口。

| 文件 | 用途 |
|---|---|
| `~/.qiansi/server-token` | 全权令牌，可读写画布、写保险库、触发运行 |
| `~/.qiansi/server-token-read` | 只读令牌，只能 `GET`；写请求返回 403 `read_only_token` |
| `~/.qiansi/audit.jsonl` | 只追加的本地审计：谁改了画布、谁触发了运行、谁动了保险库、谁请求了审批 |
| `~/.qiansi/approvals.json` | 审批记录，重启后仍在，agent 的等待不会因重启丢失 |

给第三方脚本或只读看板用**只读令牌**。MCP 默认仍读全权令牌（它要能改画布）。

## MCP server

零依赖，stdio 协议。下面的 `<repo>` 换成本机仓库路径（当前为 `E:\AgentWeave`；仓库改名后可移动）：

```powershell
claude mcp add qiansi -- node <repo>\packages\mcp\server.mjs
```

或在 MCP 配置里：

```json
{
  "mcpServers": {
    "qiansi": {
      "command": "node",
      "args": ["<repo>\\packages\\mcp\\server.mjs"],
      "env": { "QIANSI_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

令牌默认从 `~/.qiansi/server-token` 读取（不存在时回退到 `~/.agentweave/server-token`），无需写进配置。旧环境变量 `AGENTWEAVE_URL` / `AGENTWEAVE_TOKEN` / `AGENTWEAVE_AGENT` 仍被识别。

### 工具

| 工具 | 作用 |
|---|---|
| `list_models` | 列出 `deepseek-chat / minimax / claude-sonnet / claude-opus` |
| `call_model` | 调用一个下属模型，参数 `{model, prompt, system?, max_tokens?, web_search?}`；`web_search: true` 时给该模型挂服务端搜索工具 |
| `web_search` | 直接联网搜索，参数 `{query, max_results?}`，返回标题/链接/摘要；provider 订阅优先 |
| `get_usage` | 返回网关 token 用量与待审批数量 |
| `request_approval` | 请求人类批准危险动作；阻塞到批准/拒绝/超时 |
| `describe_canvas` | 画布文本摘要（agent 的首选，省 token） |
| `get_canvas` | 完整画布 JSON |
| `get_canvas_svg` | 画布 SVG，可直接给用户看 |
| `add_node` | 加节点（model / task / artifact …） |
| `update_node` | 改节点数据（改名、记录产物 `output`） |
| `connect_nodes` | 连线：`assign` / `handoff` / `review` / `context` |
| `remove_node` | 删节点并连带删掉它的连线 |
| `set_orchestrator` | 换主控模型 |
| `adapt_canvas` | 一键适配：以当前 agent 会话为主控（传自己的模型 + 会话摘要），自动连好标准拓扑，可选创建工作节点 |
| `export_canvas` | 导出画布（独立 HTML 或 Markdown），返回可分享的 URL |
| `run_canvas` | 从画布触发一次编排运行，返回 `runId` 与结果地址 |
| `get_run_result` | 结构化运行结果：每个任务的状态、产物、token 用量、计划来源 |

### 资源

| uri | 类型 | 内容 |
|---|---|---|
| `qiansi://canvas` | `application/json` | 完整画布 |
| `qiansi://canvas/summary` | `text/plain` | 上面 `describe_canvas` 返回的那段文本 |
| `qiansi://canvas.svg` | `image/svg+xml` | 画布矢量图（以文本形式返回，能否内联渲染取决于客户端） |

## 画布 API

画布文件仍是 `~/.qiansi/canvas.json`，但所有读写都带版本号，避免 Studio 与 agent 互相覆盖。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/canvas` | `{ ok, canvas, revision }`；`canvas` 为 `null` 表示还没有画布 |
| PUT | `/api/canvas` | 全量保存；body 可带 `revision`，不匹配返回 **409** + 服务端当前画布 |
| GET | `/api/canvas/summary` | `text/plain` 摘要 |
| GET | `/api/canvas/svg` | `image/svg+xml` |
| GET | `/api/canvas/export` | 独立 HTML（`?format=md` 返回 Markdown） |
| POST | `/api/canvas/ops` | `{ ops: [...] }` 批量操作，每条独立报错 |
| GET | `/api/runs/:id/result` | 运行结果契约：状态、逐任务产物、用量、计划来源 |
| GET | `/api/audit` | 本地审计日志的尾部（`?limit=`） |
| POST | `/api/connections/models` | 用一把 key 拉取该供应商的**官方模型目录**（`{protocol, baseUrl, apiKey \| connectionId}`） |
| GET | `/api/connections/ccswitch` | 列出 CC Switch 里已保存的供应商（不含 Key 内容） |
| POST | `/api/connections/ccswitch/import` | 把所选供应商的 Key 直接写入保险库，返回可用的连接定义 |

> 任何未被路由接住的 `/api/*`、`/v1/*` 请求返回 JSON 404，不再退化成 SPA 的 HTML。

### 运行：画布不满足条件会被拒绝

`run.start` 的 live 模式现在**按画布生成计划**：节点变模型档案，主控的出边变子任务，上传的文本文件进上下文。

画布不满足条件时返回 **422**，而不是悄悄退回内置演示：

```json
{ "error": "canvas_not_runnable", "reasons": ["还没有设置主控模型（右键节点 → 设为主控）"] }
```

只想看流程、不在乎画布是否可运行时，传 `payload.allowDemoFallback: true` 才会用内置演示计划。

运行结束后，服务端把每个任务的产物**写回画布对应节点**（`data.output` / `data.status`）。这一点对 agent 触发的运行尤其重要——没有窗口在监听时，只有服务端能把结果落到图上。

同一时刻只允许一个 live 运行：已有运行在途时再提交会返回 **409 `run_in_progress`** 并带上在途的 `runId`。两次运行会写回同一批节点，允许并发只会互相覆盖。

`POST /api/canvas/ops` 是 agent 改画布的唯一入口。支持的操作：

```jsonc
{ "op": "add_node",        "node": { "id": "writer-1", "type": "agent", "position": {"x": 400, "y": 200}, "data": {"kind": "model", "name": "写手", "model": "MiniMax-M3.1-Flash", "role": "长文初稿"} } }
{ "op": "update_node",     "id": "writer-1", "patch": { "output": "第一版初稿……" } }
{ "op": "move_node",       "id": "writer-1", "x": 640, "y": 200 }
{ "op": "remove_node",     "id": "writer-1" }
{ "op": "add_edge",        "edge": { "source": "orchestrator", "target": "writer-1", "data": {"kind": "assign"}, "label": "任务 · T2" } }
{ "op": "remove_edge",     "id": "e-1" }
{ "op": "set_orchestrator","id": "writer-1" }
{ "op": "clear" }
```

返回 `{ ok, applied, errors, revision, summary }`。一条 op 失败不影响其余，错误按 `op[i] <名字>: <原因>` 收集。

### 并发与反向同步

- 每次写入 `revision` 自增。
- Studio 保存时带上自己看到的 `revision`；若服务端已经更新（agent 先写了），服务端返回 409，Studio 接受服务端版本并提示「画布已被外部修改，已同步」。
- Studio 每 1.5 秒轮询一次 `GET /api/canvas`，`revision` 变化就整体替换画布（保留运行态的 `__final__` 节点）。

也就是说：在 Claude Code 里加一个节点，打开着的牵丝画布 1.5 秒内自动出现；在牵丝里拖动节点，agent 下一次读画布就能看到新位置。

## Claude Code 插件

仓库里的 `plugin/` 是一个本地 marketplace：

```powershell
claude plugin marketplace add E:\AgentWeave\plugin
claude plugin install qiansi@qiansi
```

装好之后：

- **MCP**：`.mcp.json` 以 `${CLAUDE_PLUGIN_ROOT}/../../packages/mcp/server.mjs` 启动同一个 MCP server，工具前缀 `mcp__qiansi__`。
- **上下文注入**：`UserPromptSubmit` hook 在 prompt 命中「画布 / 工作流 / 节点 / 连线 / 产物 / 任务 / 主控 / 编排 / canvas / workflow」时，自动把 `/api/canvas/summary` 塞进 `additionalContext`。应用没开就静默跳过，不阻断会话。
- **`/qiansi` 命令**：一句话拿到画布结构，需要时给出 SVG。
- **`qiansi-canvas` skill**：讲清节点/连线语义和「先读后写」的规矩。

> 如果把 `plugin/qiansi` 单独复制到别处，`.mcp.json` 里那两段 `../..` 就失效了，把 `args` 改成 server.mjs 的绝对路径即可。

## Codex 插件

```powershell
codex mcp add qiansi -- node E:\AgentWeave\packages\mcp\server.mjs
```

或把 `codex/config.toml.example` 追加进 `~/.codex/config.toml`。`codex/AGENTS.md.snippet` 可以放进项目根 `AGENTS.md`，让 Codex 知道什么时候该用画布工具。

`codex/plugin/` 是 Codex 插件形态：`SessionStart` hook 注入画布摘要（Codex 没有 `UserPromptSubmit` 这类逐条 prompt 的钩子，所以上下文注入发生在会话开始）。Windows 上走 `commandWindows` 字段。

Codex 的 hook 输出契约与 Claude Code 一致（`hookSpecificOutput.additionalContext`），这一点已在本机 codex 二进制里确认。

## VS Code：画布面板扩展

`apps/vscode/qiansi-canvas/` 是一个 VS Code 扩展，在编辑器旁边嵌入完整的牵丝界面（可拖拽、可缩放、可运行编排）。agent 通过 MCP 改画布，面板 1.5 秒内自动跟上——「聊天里改图、眼前看图变化」。

**自带服务端，开箱即跑**：`npm run vscode:ext` 把服务端捆成 `server.cjs`、studio 构建产物拷进扩展。VS Code 启动即自动拉起服务（`onStartupFinished` 激活）；桌面版已在运行时复用桌面版，不再另起。内嵌服务随 VS Code 关闭而停止，7×24 常驻仍用桌面版。

安装（免构建，复制后重载窗口）：

```powershell
Copy-Item -Recurse <repo>\apps\vscode\qiansi-canvas "$env:USERPROFILE\.vscode\extensions\qiansi.qiansi-canvas-0.1.0"
```

- 命令：`牵丝：打开画布面板`、`牵丝：在浏览器打开画布`、`牵丝：重新连接画布`；**活动栏（左侧竖条）有牵丝图标**，点开就是侧栏画布，常驻可用；另有状态栏按钮和编辑器右上角图标。
- 端口解析顺序：先探测 `~/.qiansi/server-port`（桌面版随机端口），不通则自动启动内置服务。
- **URI 处理器**：`vscode://qiansi.qiansi-canvas/open`。agent 想让用户"看到"画布时直接执行 `start "" "vscode://qiansi.qiansi-canvas/open"`（Windows）或 `open "vscode://qiansi.qiansi-canvas/open"`（macOS），VS Code 会自动打开并聚焦画布。插件 skill 已教 agent 这么做。

主控 agent 的典型用法：

1. `list_models` 看可用模型与能力。
2. 把子任务交给 `call_model`（DeepSeek 调研、MiniMax 写作、Claude 审核）。
3. 需要执行 shell/写文件/外发请求时，先 `request_approval`；用户在画布的「审批」面板批准后才继续。
4. `get_usage` 检查 token 消耗。

## OpenAI-compatible 网关

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $TOKEN"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role":"user","content":"Reply with exactly: ok"}],
    "max_tokens": 32
  }'
```

支持 `stream: true`（SSE）与 `stream: false`。**一把 key 能调用一族模型**，网关按模型 id 自动路由到对应的 key：

| key 槽位 | 目录里的模型 |
|---|---|
| `deepseek` | `deepseek-chat`、`deepseek-reasoner` |
| `minimax` | `MiniMax-M3.1-Flash-Preview`、`MiniMax-M3.1-Flash` |
| `moonshot` | `kimi-k2-thinking` |
| `zhipu` | `glm-4.6`、`glm-4.5-air` |
| `qwen` | `qwen-max`、`qwen-plus`、`qwen-turbo` |
| `openai` | `gpt-4o`、`gpt-4o-mini` |
| `relay` | `claude-opus-4-8[1M]`、`claude-sonnet-4-6[1M]`、`claude-haiku-4-5` |

目录里的 id 只是兜底示例：界面里「新连接 → 选供应商 → 粘 Key → 拉取官方模型」会从供应商自己的 `/models` 端点取**真实可用**的模型名（实测 MiniMax 返回 `MiniMax-M2.7`、智谱返回 `glm-5`、Kimi 返回 `kimi-k2.7-code`，都比内置示例新）。从 CC Switch 导入时，若对应槽位还空着，会自动把 Key 种进槽位，导入即可参与真实运行。

`GET /v1/models` 返回全部目录，`owned_by` 字段标出每 个模型由哪把 key 服务。画布节点只声明 model，运行时按同一张目录路由——所以在连接里给 DeepSeek key 补上 `deepseek-chat`，画布上立刻就能建 deepseek-chat 节点，不需要新连接。未知模型 id 按 provider 提示路由，再兜底 relay。

密钥由服务端按连接 ID 从 DPAPI 保险库读取；请求里不需要带 Key。

## 审批中继

1. agent 调 MCP `request_approval`，附 `action`、`risk`、可选 `cost_estimate`。
2. 服务端创建 pending 审批；画布顶栏「审批 N」出现计数。
3. 用户在「审批」面板点批准/拒绝。
4. MCP 轮询到结果，把 approved/denied 返回给 agent；超时默认 120 秒。

## 外部调用可视化

外部 agent 的每次 `/v1` 调用都会生成一个外部任务，并广播到画布：

- 请求头：
  - `x-qiansi-session`：一个 agent 会话的 ID（MCP server 自动生成）
  - `x-qiansi-agent`：例如 `claude-code`、`codex`
  - `x-qiansi-purpose`：这次调用的用途，例如 `写初稿`
- 服务端：
  - `GET /api/activity`：SSE 实时事件，类型 `external.call`
  - `GET /api/external`：最近 50 次外部调用（用于刷新后补历史）
  - 每次调用同时写入运行历史（`/api/runs`，`~/.qiansi/runs`）
- 画布：
  - 每个 **session** 生成一个「外部 Agent」节点（不是每次调用一个），显示调用次数与累计 token
  - 每个 session × 模型一条连线；连线上显示该模型最近一次调用的产物卡片
  - 点击外部节点打开「外部 Agent 调用」面板：按 agent 分账的 token 表 + 该 session 的全部调用（用途、模型、token、输出摘要）；点击任一条查看完整产物
  - 设置「流程线上显示产物」可统一开关产物卡片

MCP 的 `call_model` 已自动带上 session/agent/purpose；调用时传 `purpose` 参数即可在画布上看到用途标签。`GET /api/usage` 的 `external.byAgent` / `external.bySession` 提供分账数据。

## 预算与速率

- 每次编排运行：设置里的「每次运行」上限（默认 200k token），引擎在超限时立即停止，不再重试。
- 网关：`QIANSI_GATEWAY_TPM` 控制 tokens/min（默认 20k），超限返回 429。
- 引擎运行内还有 `maxTokensPerModel`、`maxCallsPerTask`（默认 100k / 4）。
- UI 顶栏显示本轮 token；结果面板汇总 token。

## 当前限制

- 画布在 agent 界面里的「直接编辑」是两条路拼起来的：看得到（导出 HTML / 打开应用）+ 改得动（MCP 工具）。真正可拖拽的画布面板需要 VS Code 扩展的 webview，属于下一步。
- Codex 侧没有逐条 prompt 的钩子，上下文只能在 SessionStart 注入一次；对话中途画布变了，要靠 agent 主动调 `describe_canvas`。
- Studio 与 agent 同时改同一处时以 revision 先到者为准，后到者拿到 409 并接受服务端版本，不会静默覆盖。
- 审批面板每 3 秒轮询一次；后续改 SSE。
- 网关只实现了 OpenAI 兼容路径；Claude Code 走 MCP 调用（不需要 Anthropic 网关）。
