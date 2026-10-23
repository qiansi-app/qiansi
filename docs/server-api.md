# 本地服务 API（P1）

服务只监听回环地址：开发与 Web 模式默认 `127.0.0.1:8787`，桌面版每次启动挑选空闲端口。Studio 通过 Vite 的 `/api` 代理访问；CLI 直接访问。

## 认证模型

- 浏览器：`GET /api/bootstrap` 设置 `qs_session` HttpOnly + SameSite=Strict Cookie；之后所有 `/api/*` 请求都带 Cookie。旧的 `aw_session` 仍会被读取。
- CLI/脚本：请求头 `x-qiansi-token: <token>`；旧名 `x-agentweave-token` 仍被接受。
- Token 在服务启动时生成，写入 `~/.qiansi/server-token`（权限 0600）；也可用 `QIANSI_TOKEN`（旧名 `AGENTWEAVE_TOKEN`）覆盖。
- 数据目录为 `~/.qiansi`；首次启动若只存在旧的 `~/.agentweave`，会整体改名迁移，DPAPI 保险库与运行历史随之保留。
- Origin 白名单：默认 `http://localhost:5173`、`http://127.0.0.1:5173`；无 Origin 的本地 CLI 请求允许。
- 未授权返回 401，Origin 不合法返回 403。

## 端点

### `GET /api/health`

公开。返回服务状态与**环境变量是否存在**（不返回密钥值）：

```json
{ "ok": true, "version": "0.1.0", "relay": true, "deepseek": false, "minimax": false, "moonshot": false }
```

### `GET /api/bootstrap`

设置会话 Cookie。浏览器加载 Studio 时调用一次。

### `GET /api/vault/status`

返回已存入保险库的连接引用（不返回值）：`{ "refs": ["conn-deepseek", "conn-minimax"] }`。

### `POST /api/vault/set`

把密钥加密存入 Windows DPAPI：`{ "ref": "conn-deepseek", "value": "..." }`。磁盘只存密文；随后测试与运行可按 `connectionId` 自动读取。

### `POST /api/vault/remove`

删除某个引用。

### `POST /api/feedback`

提交用户反馈（需会话或令牌）。请求 `{ "message": "...", "contact": "可选" }`；服务端写入 `~/.qiansi/feedback.jsonl`，不上传第三方。

### `POST /api/connections/test`

真实首连探测。请求：

```json
{
  "protocol": "anthropic-messages",
  "baseUrl": "http://127.0.0.1:15721",
  "model": "claude-opus-4-8[1M]",
  "apiKey": "可选；留空则按 baseUrl 从环境变量取"
}
```

Key 解析顺序：

1. 请求体 `apiKey`（仅本次请求使用，不落盘）
2. 保险库按 `connectionId` 解密（Windows DPAPI）
3. 本地地址 → `ANTHROPIC_AUTH_TOKEN`
4. `deepseek` → `DEEPSEEK_API_KEY`
5. `moonshot` → `MOONSHOT_API_KEY`
6. `minimaxi` → `MINIMAX_API_KEY`

响应（实测本机中转）：

```json
{
  "ok": true,
  "latencyMs": 885,
  "checks": [
    { "name": "reachable", "ok": true },
    { "name": "streaming", "ok": true },
    { "name": "text", "ok": true },
    { "name": "reasoning", "ok": true },
    { "name": "usage", "ok": true }
  ]
}
```

说明：探测预算 512 token。推理模型可能先输出 `thinking` 再输出正文；`streaming` 认可任一增量，`text` 单独报告是否已进入正文。错误信息在返回前经 `redactSecrets()` 脱敏。

### `POST /api/commands`

幂等命令入口。支持：

- `run.start`：`payload.mode` 为 `demo`（默认，演示适配器）或 `live`（真实 Anthropic 协议中转，要求 `ANTHROPIC_AUTH_TOKEN`）。
- `run.stop`：`payload.runId`，中止正在运行的任务；中止后任务会失败并结束运行。

```json
{
  "commandId": "全局唯一 UUID",
  "type": "run.start",
  "payload": { "mode": "live" }
}
```

相同 `commandId` 重复提交返回同一结果，不会重复执行。

Live 运行限制：每个任务 45 秒超时、输出上限 512 token、最多 1 次重试；依赖任务的产出会作为上游上下文注入下游 prompt。评委使用独立的 sonnet 档连接，25 秒超时后软通过（日志会标注）。

### `GET /api/runs`

返回最近的运行摘要（来自 `~/.qiansi/runs/*.json`）：

```json
{
  "items": [
    {
      "runId": "...",
      "status": "done",
      "goal": "...",
      "tokens": 600,
      "events": 30,
      "startedAt": 1792588539807,
      "finishedAt": 1792588540565
    }
  ]
}
```

运行结束时会把 `{snapshot, events}` 持久化到 `~/.qiansi/runs/<runId>.json`；重启服务后仍可用 `snapshot` 与 SSE 回放。

### `GET /api/approvals`

列出最近的审批记录（pending / approved / denied）。

### `POST /api/approvals`

创建审批：`{ "action": "...", "risk": "...", "costEstimate": 0 }`。MCP 的 `request_approval` 会调用它并轮询结果。

### `POST /api/approvals/:id/resolve`

批准或拒绝：`{ "decision": "approved" | "denied", "note": "可选" }`。

### `POST /api/chat`

单模型非流式对话，供节点聊天与讨论使用。请求：

```json
{
  "connectionId": "conn-deepseek",
  "protocol": "openai-chat",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "messages": [{ "role": "user", "content": "Reply with exactly: ok" }],
  "maxTokens": 800
}
```

Key 解析顺序：请求体（本次不落盘）→ 保险库 `connectionId` → 按 baseUrl/连接推导的环境变量。响应 `{ ok, text, usage }`；失败返回 502 与脱敏后的错误。

### `POST /api/discuss`

多模型讨论。请求 `{ topic, rounds: 1-3, participants: [{ id, name, model, connectionId, protocol, baseUrl }] }`，最多 5 个参与者。服务端按顺序调用，后发言者能看到前面全部发言；返回 `{ rounds: [{ round, messages: [{ name, model, content }] }] }`。

### `POST /api/layout`

让主控模型给节点排坐标。请求 `{ orchestratorId, nodes: [{ id, name, kind }], edges: [{ source, target }] }`。使用 Claude 中转；返回 `{ positions: { id: { x, y } }, source: "ai" }`。模型不可用或输出不合法时返回 502，Studio 会回退到本地分层排版。

### `POST /api/workflow`

主控模型生成工作流。请求 `{ goal, orchestrator: { connectionId, protocol, baseUrl, model }, models: [{ connectionId, name, provider, model, effort }], files: [{ name, preview }] }`。

主控返回并经过服务端校验的结构：

```json
{
  "summary": "三节点流水线：调研 → 写作 → 核对",
  "nodes": [{ "id": "n1", "name": "调研员", "role": "…", "connectionId": "conn-deepseek", "effort": "high" }],
  "edges": [{ "source": "orchestrator", "target": "n1", "kind": "assign", "label": "任务 · 调研" }]
}
```

`connectionId` 必须来自请求中的模型列表；连线只能是 `assign` / `handoff` / `review` / `context`。解析或校验失败返回 502，Studio 会提示错误，不会改动画布。

### `POST /api/files`

上传文件作为画布上下文。请求 `{ name, type, data }`，`data` 为 base64，单文件上限 8 MB。文件写入 `~/.qiansi/files/`，返回 `{ file: { id, name, size, preview, path } }`；文本类文件返回前 1200 字预览。

### `GET /api/canvas` / `PUT /api/canvas`

画布持久化。`PUT` 请求 `{ orchestratorId, nodes, edges }`，服务端写入 `~/.qiansi/canvas.json`（先写临时文件再原子替换，上限 5 MB）；`GET` 返回 `{ canvas: { version, savedAt, orchestratorId, nodes, edges } }`，没有保存过时 `canvas` 为 `null`。

### `DELETE /api/files/:id`

删除上传的文件。画布删除文件模块时自动调用，避免留下孤儿文件。

### `GET /api/usage`

返回网关 token 用量、待审批数量，以及外部 agent 分账：

```json
{
  "gateway": { "total": 100, "perMinute": 100 },
  "pendingApprovals": 0,
  "external": {
    "byAgent": { "claude-code": { "tokens": 99, "calls": 2 } },
    "bySession": { "aggregate-session": { "tokens": 99, "calls": 2, "agent": "claude-code", "updatedAt": 1792594451743 } }
  }
}
```

### `GET /v1/models`

OpenAI 兼容模型列表（需 Bearer token）：`deepseek-chat / minimax / claude-sonnet / claude-opus`。

### `POST /v1/chat/completions`

OpenAI 兼容调用，支持 `stream: true`（SSE）与非流式。模型由服务端映射到保险库中的连接，请求里不需要带 Key。

### `GET /api/runs/:id/snapshot`

返回 `{ runId, status, goal, plan, outputs, lastSeq, startedAt, finishedAt }`。重连时先读它，再接收事件。

### `GET /api/runs/:id/events`

SSE。事件格式：

```text
event: task.started
id: 4
data: {"seq":4,"ts":...,"event":{"type":"task.started","taskId":"T1","nodeId":"researcher","effort":"medium","attempt":0}}
```

- 支持 `Last-Event-ID` 或 `?lastEventId=` 续传。
- 每 15s 发 `heartbeat`。
- 运行结束后回放完事件再发 `end`。
- 目前为演示计划；接入真实 provider 后事件 schema 不变。

## 环境变量

| 变量 | 作用 |
|---|---|
| `QIANSI_PORT` | 服务端口，默认 8787 |
| `QIANSI_TOKEN` | 覆盖自动生成的访问令牌 |
| `QIANSI_ORIGINS` | 逗号分隔的 Origin 白名单 |
| `ANTHROPIC_AUTH_TOKEN` | 本机 Claude 中转凭据（也用于探测） |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `MINIMAX_API_KEY` | MiniMax |
| `MOONSHOT_API_KEY` | Kimi |

## 当前限制

- `live` 模式目前只走本机 Claude 中转 + DeepSeek + MiniMax 的组合，依赖三条连接凭据（请求体、DPAPI 保险库或环境变量）。
- 密钥优先使用 DPAPI 保险库；服务端与日志不返回明文。
- 未实现持久化（服务重启后运行记录丢失）。
- 未实现 SSE 事件落盘与回放文件；内存中保留最近运行。
- 评委在输出不可解析或超时时会软通过；机器检查器尚未实现。
