# 连接、执行与保密

日期：2026-10-21
适用范围：模型连接、API Key、电脑操控、连接稳定性、信息保密。

## 1. 模型身份可编辑

三层分离，避免“改一个模型把整张图改坏”：

| 层 | 内容 | 谁改 |
|---|---|---|
| 能力档案 CapabilityProfile | 协议、effort 方言、上下文、模态、成本、强项 | 首连探测自动填充 + 用户可改 |
| 连接 ModelConnection | 显示名、Provider、baseUrl、modelId、密钥引用、工具策略 | 用户随时可改 |
| 节点绑定 GraphNode.connectionId | 这个节点用哪条连接 | 用户在节点的「能力」页切换 |

规则：

- 节点只存 `connectionId`，不复制密钥、不复制 baseUrl。
- 改连接身份会影响所有引用它的节点；保存前提示影响范围，并提供「克隆连接」避免误改。
- 每个节点可单独切换连接（当前 Studio 已实现：节点 → 能力 → 连接下拉）。
- 连接可禁用；禁用后节点显示 `config-error`，调度器跳过并提示，而不是报错崩溃。
- 连接与能力档案都版本化；导出图时不包含密钥。

## 2. API Key 与首连探测

### 2.1 密钥存放

- **已实现（Windows）**：DPAPI 保险库 `apps/server/src/vault.ts`。值以 `ProtectedData`（CurrentUser）加密后写入 `~/.qiansi/vault.json`，磁盘上只有密文；明文只在内存或 PowerShell stdin 管道中存在。实测写入假值后文件 364 字节、搜索不到明文。
- 使用方式：模型管理 → 选择连接 → 粘贴 Key → 「存入保险库」。存入后 Key 字段清空，只显示「已存保险库」；测试连接与 live 运行由服务端按 `connectionId` 解密读取。
- 解析顺序：请求体 `apiKey` → 保险库（按连接 ID）→ 环境变量。
- 桌面壳：Electron `safeStorage` 可替换同一 `VaultPort`。
- `.env.local` 仅保留空占位供开发参考，禁止放真实 Key；CI 用平台 secret。
- 安全边界：DPAPI CurrentUser 能防止明文、误提交、备份/日志抓取，但**同一 Windows 用户下的进程仍可请求解密**；生产版应加 per-app secret/ACL 或系统凭据管理器条目。

### 2.2 首连探测（服务端执行）

`probeConnection()` 在服务端/CLI 运行，浏览器只拿结果：

1. 发一次最小请求（`max_tokens` 很小，effort=off）。
2. 检查：可达性、流式首 token、usage 是否返回。
3. P1 扩展检查矩阵：工具调用、JSON 模式、vision、effort 参数是否被接受、推理字段（`reasoning_content` / `thinking`）。
4. 返回 `{ ok, latencyMs, checks[], error }`。
5. 失败分类：401 密钥错误、403 权限、404 模型名、429 限额、5xx 上游、超时/网络。
6. 结果写入连接档案；未知能力保持 unknown，不猜测。

国内特有检查：

- MiniMax / Moonshot 国内与国际 Key/域名不通用，连接时检测并提示。
- 每个连接可单独配置代理；禁止硬编码 baseUrl。
- 本地中转（如 127.0.0.1）允许不填 Key，由中转自身管理凭据。

## 3. AI 操控电脑（Agent 工具）

结论：**可以，但不是裸控制主机**。采用沙箱化工具运行时 + 每节点授权。

### 3.1 工具能力

| 能力 | 说明 | 默认 | 风险 |
|---|---|---|---|
| `fs.read` | 只读工作区 | 允许 | 低 |
| `fs.write` | 写工作区，写前备份 | 需授权 | 中 |
| `shell` | 执行命令，白名单 + 超时 | 禁止 | 高 |
| `browser` | 打开页面、抓取内容 | 需授权 | 中 |
| `screen` | 截图 + 鼠标键盘控制 | V2，禁止 | 极高 |
| `network` | 访问域名白名单 | 需授权 | 中 |

### 3.2 策略对象

```ts
interface ToolPolicy {
  allow: ToolCapability[]
  approval: 'always' | 'per-run' | 'auto'   // auto 仅限只读工具
  workspaceRoot?: string
  networkAllowlist?: string[]
}
```

- 每个节点一份策略；默认继承全局安全默认（只读）。
- `shell` 必须运行在 WSL2 或 Docker 沙箱内，工作目录挂载限定；命令白名单 + 超时 + 输出截断。
- `screen` 属于 V2：启用时显示持续录制指示、逐动作批准、急停快捷键；不进入 v1。
- 所有工具调用写入审计日志：谁（节点/任务）、什么工具、参数摘要、结果摘要、耗时、批准人。
- 危险操作（删除、覆盖、外发网络、提交表单）必须人工放行；选择卡可直接在画布上出现。

### 3.3 为什么不做“直接控制桌面”

- 无法回滚、难以审计、密钥与文件暴露面过大。
- 模型幻觉可能触发不可逆操作。
- Windows 原生没有沙箱；必须依赖 WSL2/Docker 隔离。
- 产品定位是“协作工作台”，不是远程控制木马；默认拒绝是信任的基础。

## 4. 连接稳定性

### 4.1 事件流

- SSE 心跳（15s）；断线自动重连，带 `Last-Event-ID`。
- 重连先拉 `snapshot(runId)`，再接收约 50ms 批量事件；不从零重放数千条。
- 每条命令带幂等 `commandId`；重复提交返回同一结果。
- 事件 schema `(seq, runId, type, payload, ts)`；服务端保留至少一次运行的完整日志。

### 4.2 Provider 健康

- 每连接维护 EWMA 成功率、P50/P95 延迟、连续失败数。
- 429/5xx 尊重 `Retry-After`，指数退避 + 抖动；进入冷却期。
- 冷却中的连接不参与调度；全部冷却时出「等待/换线/终止」选择卡，而不是静默卡住。
- SSE 空闲超时（provider 中途静默）单独检测：abort + 重试，并标注「上游静默」。
- 流式解析容错：半包、keep-alive、CRLF、`[DONE]` 缺失。

### 4.3 UI 可见性

- 顶栏显示连接状态：在线 / 重连中 / 冷却 / 离线。
- 节点显示 `offline` / `config-error` 徽章；连线显示错误与重试次数。
- 不把“没有输出”伪装成“正在思考”：区分「等待首 token」与「已断开」。

## 5. 信息保密

### 5.1 默认

- 本地优先：默认不向任何第三方发送遥测、使用统计或崩溃报告。
- 密钥只在服务端/CLI 读取；浏览器只拿掩码与探测结果。
- 日志、事件、导出包统一脱敏；导出默认不含密钥与原始请求体。
- 数据库可选加密（SQLCipher 或应用层 AES-GCM）；v0 至少 0600 + 磁盘加密建议。

### 5.2 必须如实告知用户的边界

- **模型提供方能看到 prompt 与上下文**；这不是本产品能消除的，只能在 UI 中明确提示。
- 本地中转/网关（如 cc-switch、one-api）同样能看到明文请求；用户需信任该进程。
- 代理与网络中间人可能记录流量；HTTPS + 可信代理是前提。
- 屏幕控制/浏览器自动化会把屏幕内容送给模型（V2）；必须显式同意。

### 5.3 导出与分享

- 运行导出包：图 JSON（不含密钥）、任务与验收、产物文件、事件日志（脱敏）。
- 分享前可勾选「移除 prompt 原文 / 移除产物 / 仅保留结构」。
- 公开仓库的示例图只使用演示连接与假 Key。

## 6. 威胁模型（摘要）

| 威胁 | 缓解 |
|---|---|
| Key 泄漏到 Git/日志/截图 | keyRef、掩码、`redactSecrets`、CI secret scan、导出过滤 |
| 恶意 prompt 诱导执行危险命令 | 默认拒绝、沙箱、白名单、逐动作批准、审计 |
| 本地命令端点被网页 CSRF | Origin 白名单 + 启动 bearer token + 仅回环监听 |
| 上游断流被误判为模型思考 | 心跳、首 token 超时、显式「上游静默」状态 |
| 供应商 429/故障导致整图卡死 | 健康度、冷却、换线选择卡、失败可重试 |
| 导出/分享泄露隐私 | 导出选项、脱敏、默认不含原始 prompt |
| 依赖供应链 | 锁定版本、最少依赖、license header 检查、定期升级窗口 |

## 7. 当前实现状态

- ✅ 引擎：`ModelConnection`、`ToolPolicy`、`VaultPort`、`probeConnection()`、`redactSecrets()` 类型与实现。探测预算 512 token；`streaming` 认可 text 或 reasoning 增量，`text` 单独报告。
- ✅ Studio：模型管理面板（身份编辑、Key 输入、真实测试连接、工具权限）、节点「能力」页切换连接、连接变更同步节点。
- ✅ 服务端：Hono `127.0.0.1:8787`，bootstrap Cookie + `x-qiansi-token`，真实 `/api/connections/test`，幂等 `/api/commands`（`run.start` demo/live、`run.stop`），快照与 SSE（`Last-Event-ID`、15s 心跳）。
- ✅ DPAPI 保险库：`/api/vault/set|status|remove`；模型管理可一键存入；测试与 live 运行按连接 ID 读取；磁盘只存密文。
- ✅ 真实运行：本机 Claude 中转，3 个子任务 + 真实评委，约 40 秒；依赖产物注入下游；任务 45s 超时、512 token 上限、1 次重试，可中止。
- ✅ CLI：`npx tsx packages/cli/src/index.ts probe config/connection.example.json`，读取 `apiKeyEnv` 或 `apiKey`。
- ⏳ P1 剩余：DeepSeek/MiniMax 直连、0600 vault、SQLite 持久化、健康度/冷却、机器检查器。
- ⏳ P2：工具运行时（fs/shell/browser）与沙箱、审计日志、危险动作选择卡。
- ⏳ V2：screen 控制、加密数据库、团队共享与只读模式。
