# 本地服务 API（P1）

服务只监听回环地址：开发与 Web 模式默认 `127.0.0.1:8787`，桌面版每次启动挑选空闲端口。Studio 通过 Vite 的 `/api` 代理访问；CLI 直接访问。

## 认证模型

- 浏览器：`GET /api/bootstrap` 设置 `qs_session` HttpOnly + SameSite=Strict Cookie；之后所有 `/api/*` 请求都带 Cookie。旧的 `aw_session` 仍会被读取。
- CLI/脚本：请求头 `x-qiansi-token: <token>`；旧名 `x-agentweave-token` 仍被接受。
- Token 在服务启动时生成，写入 `~/.qiansi/server-token`（权限 0600）；也可用 `QIANSI_TOKEN`（旧名 `AGENTWEAVE_TOKEN`）覆盖。
- 数据目录为 `~/.qiansi`；首次启动若只存在旧的 `~/.agentweave`，会整体改名迁移，DPAPI 保险库与运行历史随之保留。
- Origin 白名单：默认 `http://localhost:5173`、`http://127.0.0.1:5173`；无 Origin 的本地 CLI 请求允许。
- 未授权返回 401，Origin 不合法返回 403。
- **策略闸门**：通过 token 之后还要过 Policy（见 `GET /api/policy`）。调用方身份取自 `x-qiansi-agent`（缺省视为 `local-ui`）；作用域不足或 `acceptMode=off` 时返回 403 `not_admitted`。细节见 [superagent-adoption.md](superagent-adoption.md)。

## 端点

### `GET /api/status`

健康契约，给看门狗用。返回四个退出码之一以及逐部件状态：

```json
{
  "code": 0,
  "state": "ok",
  "manuallyStopped": false,
  "parts": { "state": {...}, "vault": {...}, "models": {...}, "canvas": {...}, "run": {...}, "port": {...} },
  "errors": [],
  "setup": [],
  "warnings": [],
  "load": { "activeRunId": null, "activeRunAgeMs": null, "runningTasks": 0 }
}
```

`code`：0 正常或人为停止，1 没在跑（由 CLI 判定），2 有部件坏了且重启无效，3 等人配置。CLI 侧封装为 `qiansi status`，退出码一致。

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

### `GET /api/policy` / `PUT /api/policy`

授权策略。`GET` 返回 `{ ok, policy, revision }`；`PUT` 需要 `policy.write` 作用域（人员默认有，agent 默认没有），body 为 `{ revision, acceptMode, humans, agents }`，版本不匹配返回 409。

- `acceptMode`：`off` 拒绝未在名单内的 agent 发起工作（读与停止不受限），`observe` 放行但标记待复核，`auto` 放行。
- `agents[].scopes` 从 `canvas.read`、`canvas.write`、`run.start`、`run.stop`、`vault.write`、`model.catalog`、`policy.write`、`gateway.use` 中取。
- `run.stop` 永远放行（策略不该能挡住停止），每次停止都记审计。

策略文件在 `~/.qiansi/policy.json`，首次启动按「升级不改行为」写入默认值：`acceptMode=auto` + 通配 agent。

### `POST /api/admin/stop`

人为停止：写 `~/.qiansi/manual-stop` 标记后退出进程。需要 `policy.write`。对应 `qiansi stop`，服务启动时清掉标记。

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

Live 运行限制：每个任务 240 秒超时、输出上限 12288 token、最多 1 次重试；依赖任务的产出会作为上游上下文注入下游 prompt。验收分三级：结构检查（0 token）→ 便宜闸门（主控节点或目录里最便宜的模型，只放行明显通过）→ 完整评委（sonnet 档，25 秒超时后软通过）。每条判定带 `gate` 字段，运行结束的 `run.gates` 审计给出各级命中次数。`run.start` 还要过策略闸门，运行记录里保存 mandate（谁批准、按哪个策略版本），审计里带 `strategy`（性能/订阅/成本优先）与实际使用的 Key。

节点工具默认开启：每个任务可以调用 `read_file` / `write_file` / `list_dir` / `run_command` / `describe_canvas` 等工具，工作目录取画布的 `rootDir`（未设则服务端目录）。传 `payload.tools = false` 可整轮关闭；每次调用发 `tool.called` 事件并写 `node.tool` 审计。

### `GET/POST /api/takeover/watch`

实时接管开关。`POST { "enabled": true, "sessionFile"?: string }` 开始监听（留空则盯全局最新的 Claude Code 会话），`{ "enabled": false }` 停止。状态包含 `enabled` / `file` / `sessionId` / `lastAsk` / `lastFiredAt` / `pendingAsk` / `busy` / `lastError`。状态落盘到 `~/.qiansi/takeover-watch.json`，服务重启后自动恢复；发现新需求会自动调用 `/api/handoff`（任务原文、自动编排、立即运行）。

### `GET /api/runs/active`

正在跑的运行的快照，供没发起这次运行的窗口（VS Code 面板、另一个标签页、agent 触发）显示进度。

- 覆盖**所有来源**的运行：画布发起、agent 通过 MCP 触发、演示模式、接续会话的自动运行。
- `run` 为当前运行（逐任务状态由事件日志折叠得到）；没有在跑时返回 `run: null`。
- 若最近 30 秒内刚结束过一轮，附带 `recent`（含完成态任务），客户端据此显示「刚刚完成」，而不是空白。
- `recent` 同时带 `failureSummary` / `attempt` / `maxAttempts`：失败原因与自动重试进度直接从轮询拿到，不必再发一次请求。
- 客户端每秒轮询，并在页面重新可见 / 窗口获得焦点时立即补查——隐藏页面会把定时器节流到分钟级，靠立即补查才不会迟到一个轮询周期。

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
  "maxTokens": 800,
  "webSearch": false
}
```

Key 解析顺序：请求体（本次不落盘）→ 保险库 `connectionId` → 按 baseUrl/连接推导的环境变量。响应 `{ ok, text, usage, searches? }`；失败返回 502 与脱敏后的错误。

`webSearch: true` 时给这次对话挂上服务端 `web_search` 工具：模型决定搜什么，服务端执行并把结果作为工具消息交回模型，最多 2 轮搜索，随后强制一轮不带工具的作答。响应里的 `searches` 是实际执行的查询与命中数，供界面展示。搜索 provider 的选择、Key 与限制见 [web-search.md](web-search.md)。

### `GET /api/search/status`

不返回 Key，只说明当前会走哪家 provider：

```json
{
  "ok": true,
  "provider": { "id": "zhipu", "label": "智谱 Web 搜索", "billing": "subscription", "requiresKey": true },
  "configured": [{ "id": "zhipu", "ready": true }, { "id": "html", "ready": true }],
  "cachedQueries": 0
}
```

### `POST /api/search`

直接执行一次联网搜索，供画布节点或外部 agent 先把结果当上下文：

```json
{ "query": "CNNIC 第57次 中国互联网络发展状况统计报告", "maxResults": 6 }
```

返回 `{ ok, query, hits: [{ title, url, snippet, source?, publishedAt? }], provider }`。结果缓存 10 分钟。

### `POST /api/discuss`

多模型讨论。请求 `{ topic, rounds: 1-3, participants: [{ id, name, model, connectionId, protocol, baseUrl }] }`，最多 5 个参与者。服务端按顺序调用，后发言者能看到前面全部发言；返回 `{ rounds: [{ round, messages: [{ name, model, content }] }] }`。

### `POST /api/layout`

让主控模型给节点排坐标。请求 `{ orchestratorId, nodes: [{ id, name, kind }], edges: [{ source, target }] }`。使用 Claude 中转；返回 `{ positions: { id: { x, y } }, source: "ai" }`。模型不可用或输出不合法时返回 502，Studio 会回退到本地分层排版。

### `POST /api/workflow`

主控模型生成工作流。请求 `{ goal, orchestrator: { connectionId, protocol, baseUrl, model }, models: [{ connectionId, name, provider, model, effort }], files: [{ name, preview }], critique?: boolean }`。

主控返回并经过服务端校验的结构：

```json
{
  "summary": "四节点流水线：事实梳理 → 起草 → 核对 → 整合",
  "nodes": [{
    "id": "n1",
    "name": "事实梳理",
    "role": "用研究员视角工作",
    "task": "从资料包里收集并核实事实，输出事实卡",
    "deliverable": "事实卡（要点清单，每条带来源）",
    "acceptance": ["至少 5 条事实", "每条事实能在资料包里找到出处"],
    "connectionId": "conn-deepseek",
    "model": "deepseek-v4-pro",
    "effort": "high"
  }],
  "edges": [{ "source": "orchestrator", "target": "n1", "kind": "assign", "label": "任务 · 梳理" }],
  "notes": ["n2 与 n3 都产出初稿"],
  "revised": true
}
```

拆解按**任务**而不是按角色：节点名写任务名，`task` 说清输入与产出，`deliverable` 是具名、可交接的交付物，`acceptance` 是 2–3 条可被第三方独立判定的条件。

节点数跟着任务走，不再是固定 3–5：单一产出 2–3 个，中等任务 4–6 个，要覆盖多个独立部分或多轮验证的复杂任务 7–10 个。每个节点都要能回答「删掉它，哪份交付物就没人产出了」。

生成后再跑一遍审校（`critique` 默认 `true`）：同一个主控换一顶「审校者」的帽子，只挑四件事——分工重叠、总目标里有没人负责的缺口、无法判定的验收条件、节点数与任务规模不匹配（该拆没拆或硬凑）。`verdict` 为 `revise` 时返回修正后的完整计划并置 `revised: true`，问题写进 `notes`，界面用 toast 提示。

服务端还会做确定性兜底：同名节点自动加序号；节点验收不足两条时补通用可判定条目；每个执行节点必须有来自主控的 `assign` 边。

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

可选 `"web_search": true`（或 `qiansi_web_search`）给这次请求挂服务端搜索工具，行为与 `/api/chat` 的 `webSearch` 相同；默认关闭。

### `GET /api/runs/:id/diagnosis`

失败运行的环境诊断：为什么失败、哪些任务没产出、工作目录与模型 Key 现在是否可用、
有哪几种重跑方式。返回：

```json
{
  "ok": true,
  "runId": "...",
  "status": "failed",
  "attempt": 1, "maxAttempts": 1,
  "failure": { "headline": "1 个任务失败", "reasons": ["验收未通过 ×1", "C1「…」：产出为空或过短"], "retryScheduled": false, "attempt": 1, "maxAttempts": 1 },
  "tasks": [{ "id": "C1", "title": "写确认句", "status": "failed", "error": "产出为空或过短" }],
  "environment": {
    "rootDir": { "path": "E:\\proj", "exists": true, "writable": true, "source": "workspace" },
    "models": [{ "nodeId": "n1", "name": "写确认句", "model": "deepseek-flash", "slot": "deepseek", "disabled": false, "ready": true, "note": "可用" }],
    "missing": [],
    "hints": ["自动重试已用尽（3/3）。下面的重跑是手动发起的，不占自动额度。"]
  },
  "actions": {
    "resume": { "available": true, "pending": 1 },
    "fresh": { "available": true },
    "userView": { "available": true }
  },
  "activeRunId": null
}
```

`failure.retryScheduled` 会在已经有续跑子运行之后自动变为 `false`，避免旧快照误导。
工作目录来自画布的 `rootDir`；没设置时用服务端目录并标注 `source: "server"`。
厂商被停用或没有 Key 时 `models[].note` 会写清楚，界面据此给出「启用」按钮。

### `GET /api/team` / `PUT /api/team`

团队名册与手册（每张画布一份，存在 `~/.qiansi/workspaces/<id>/team.json`）。

`GET` 返回：

```json
{
  "ok": true,
  "team": {
    "playbook": "交付必须附证据……",
    "members": [{ "id": "...", "name": "小核", "job": "核实事实与来源", "autonomy": "investigate", "model": "deepseek-flash", "memory": "只信官方文档" }],
    "warnings": ["团队手册是空的……"],
    "cap": 12
  }
}
```

`PUT` 请求 `{ "members": [...], "playbook": "..." }`。校验规则：称呼唯一、职责非空、
职责不能完全相同（包含关系只提醒）、成员上限 12（超过 8 提醒）。失败返回 400 与
`error` / `hint`；成功返回规范化后的团队。

名册的用途：自动编排优先按职责把任务分给成员（节点带 `memberId` / `memberName`），
运行时把成员身份、自治档位（调查/草稿=只读工具，执行/全权=全部工具）和记忆注入任务提示。
`/api/workflow` 接受可选的 `team`（`[{id,name,job,model}]`）与 `playbook`；
`/api/discuss` 的参与者接受可选的 `role`，用于团队会议。详见 [team.md](team.md)。

### `POST /api/runs/:id/rerun`

主动重跑。请求 `{ "mode": "resume" | "fresh", "rootDir": "可选，顺手修正工作目录" }`。

- `resume`：断点续跑，只重跑没有产出的任务（走 `/api/commands` 的 `resumeOf`）；
- `fresh`：按当前画布重新规划、整轮重跑；
- 已有运行在跑时返回 `{ ok: true, queued: true, runId: null }`，当前运行结束后自动开始；
- 返回 `{ ok, runId?, mode, workspaceId }`，失败时带 `error` / `missing` / `hint`。

### `POST /api/user-view`

用户视角验收：把项目真的启动起来，用无头 Edge/Chrome 打开页面、截图、逐项检查。
请求 `{ "runId"?: "...", "rootDir"?: "...", "url"?: "..." }`。
给了 `url` 只验收已有地址；否则按画布工作目录启动项目。
返回 `{ ok, report }`；项目无法识别时 422，带 `kind` / `reason` / `hint`。
检查项、自动触发条件与限制见 [user-view.md](user-view.md)。

### `GET /api/user-view/latest?ws=` / `GET /api/user-view/:id` / `GET /api/user-view/:id/shot/desktop|mobile`

最近一次报告（按画布过滤后再取最新）、完整报告、截图 PNG。
`<img>` 同源请求会带会话 Cookie，界面可直接显示。

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
| `QIANSI_SEARCH_PROVIDER` | 强制搜索 provider：`zhipu` / `bocha` / `tavily` / `html`（默认订阅优先） |
| `QIANSI_SEARCH_ENGINE` | 智谱搜索档位，默认 `search_std` |
| `BOCHA_API_KEY` / `TAVILY_API_KEY` | 可选的按量搜索 provider |

## 当前限制

- `live` 模式目前只走本机 Claude 中转 + DeepSeek + MiniMax 的组合，依赖三条连接凭据（请求体、DPAPI 保险库或环境变量）。
- 密钥优先使用 DPAPI 保险库；服务端与日志不返回明文。
- 未实现持久化（服务重启后运行记录丢失）。
- 未实现 SSE 事件落盘与回放文件；内存中保留最近运行。
- 评委在输出不可解析或超时时会软通过；机器检查器尚未实现。
