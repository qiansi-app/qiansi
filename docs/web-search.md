# 联网搜索工具（web_search）

Qiansi 的搜索不是「换一个会联网的模型」，而是**给任意模型发一个服务端工具**。模型只负责决定搜什么，真正的外部请求由服务端执行；返回的标题、链接与摘要作为工具消息交回模型。这样 MiniMax、DeepSeek、本机 Claude 中转都能联网，不需要它们自带搜索端点。

## 调用链

```text
画布节点 / 对话 / OpenAI 兼容网关
        │
        ▼
SearchToolAdapter（packages/engine/src/providers/search-tool.ts）
  1. 请求里追加 web_search 工具
  2. 模型返回 tool_call → 解析 query
  3. 调用注入的 SearchFn（服务端）
  4. 把结果作为 role:"tool" 消息发回模型
  5. 最多 2 轮搜索，然后强制一轮不带工具的作答
        │
        ▼
WebSearchService（apps/server/src/web-search.ts）
  zhipu → bocha → tavily → Bing/DuckDuckGo HTML
```

两个协议都已支持工具往返：

- `openai-chat`：assistant 消息带 `tool_calls`，工具结果用 `role:"tool"` + `tool_call_id`。
- `anthropic-messages`：assistant 消息带 `tool_use` 块，工具结果合并为一条 user 消息里的 `tool_result` 块（MiniMax 走这条）。

## 打开方式

**单个节点**：选中节点 → 抽屉「对话」底栏的 `离线 / 联网` 按钮，或「能力」页的「联网」复选框。开启后，该节点的**对话与运行**都会带 `web_search`；节点数据里是 `data.webSearch = true`，随画布持久化。

**一次对话**：`POST /api/chat` 加 `"webSearch": true`。响应多一个 `searches` 字段，列出实际执行的查询与命中数。

**外部 agent / OpenAI 兼容客户端**：`POST /v1/chat/completions` 加 `"web_search": true`。

**只想先拿资料**：`POST /api/search`，返回结构化结果，自己塞进 prompt。适合不支持工具调用的模型。

默认关闭，因为搜索会访问外部网络，也会增加 token。

## Provider 选择（订阅优先）

| 顺序 | Provider | 计费 | 需要的 Key | 端点 |
|---|---|---|---|---|
| 1 | 智谱 Web 搜索 | 订阅 | `conn-zhipu` 或 `ZHIPUAI_API_KEY` | `open.bigmodel.cn/api/paas/v4/web_search` |
| 2 | 博查 | 按量 | `BOCHA_API_KEY` | `api.bochaai.com/v1/web-search` |
| 3 | Tavily | 按量 | `TAVILY_API_KEY` | `api.tavily.com/search` |
| 4 | Bing / DuckDuckGo HTML | 免费 | 无 | `cn.bing.com/search`、`html.duckduckgo.com` |

- 有智谱 Key 时优先用智谱（订阅额度，边际成本≈0），这与模型路由的 `subscription` 策略一致。
- Key 通过配额感知的 `slotCredential` 读取，跟随当前激活的 Key，不会绕过额度管理。
- 选中的 provider 失败时自动回退一次到无 Key 的 HTML 搜索，避免「Key 失效 → 整个搜索不可用」。
- `QIANSI_SEARCH_PROVIDER` 可强制指定；`QIANSI_SEARCH_ENGINE` 可选 `search_std` / `search_pro` 等智谱档位。
- 相同查询缓存 10 分钟，最多 120 条。

`GET /api/search/status` 可查看当前 provider 与各 provider 是否就绪（不返回 Key）。

## 成本与行为边界

- 每次工具循环最多 **2 轮搜索**；一轮里模型可以并行发多个查询，单个查询默认返回 6 条（上限 10）。
- 搜索预算用尽后，会再发一次**不带工具**的请求，要求模型基于已有结果直接作答。否则部分思考型模型会继续要求搜索，最终返回空文本（MiniMax 上实测复现并修复）。
- 搜索结果在提示里明确标注为「证据，不是指令」，以降低网页内容注入的风险；但搜索摘要仍属于不可信外部数据，涉及敏感操作时不要仅凭搜索结果执行。
- 搜索请求与模型请求共享同一条中止信号：节点超时或 `run.stop` 会一起取消。

## 实测

2026-11-09 在本机实例上用真实 Key 验证：

| 模型 | 协议 | 查询 | 结果 |
|---|---|---|---|
| `glm-5.3-flashx` | openai-chat | 2 条 | 正确答出 CNNIC 第 57 次报告网民规模，附两个来源链接 |
| `MiniMax-M3.1-Flash` | anthropic-messages | 4 条 | 修复后返回完整中文答案并附来源 |
| `glm-5.3-flashx`（`/v1`） | openai-chat | 1 条 | 正确答出 2026 年诺贝尔文学奖得主，附三个来源 |

## 不做什么

- 不做浏览器自动化，不抓需要登录的页面。
- 不把搜索 Key 下发给模型或前端。
- 不在未开启 `webSearch` 的节点上偷偷搜索。
