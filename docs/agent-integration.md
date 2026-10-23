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
| `call_model` | 调用一个下属模型，参数 `{model, prompt, system?, max_tokens?}` |
| `get_usage` | 返回网关 token 用量与待审批数量 |
| `request_approval` | 请求人类批准危险动作；阻塞到批准/拒绝/超时 |

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

支持 `stream: true`（SSE）与 `stream: false`。模型 ID：

- `deepseek-chat` → DeepSeek（OpenAI-compatible）
- `minimax` → MiniMax M3.1（Anthropic 格式）
- `claude-sonnet` / `claude-opus` → 本机 Claude 中转

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

- 网关/MCP 调用还没有作为节点任务绘制到画布上；画布主要展示内置编排运行。下一步会把外部调用也映射成事件与节点状态。
- 审批面板每 3 秒轮询一次；后续改 SSE。
- 网关只实现了 OpenAI 兼容路径；Claude Code 走 MCP 调用（不需要 Anthropic 网关）。
- 外部 agent 的 token 用量计入网关总量，但尚未按 agent 分账。
