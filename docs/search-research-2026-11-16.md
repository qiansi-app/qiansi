# 检索与功能对标研究（2026-11-16）

方法：三路并行调研——① GitHub 上主流 agentic 检索实现；② 把牵丝现有功能与开源竞品逐项对比；③ 2024–2026 检索增强/agentic search 文献。共 44 条技术线索，逐条标注来源、采纳代价与价值；同时在本机做了 9 组联网实测（含被墙/质量差的负结果）。本文件是采纳与拒绝的依据。

## 一、本机实测的基线（先于任何参考）

| 实测 | 结果 |
|---|---|
| 智谱 `web_search` + `content_size=high` | 200，单条直接返回 6–8KB 正文（掘金/CSDN/腾讯新闻）；`search_pro` + `freshness` 同样可用，正文最长 29KB |
| `search_std` + `freshness=oneWeek` | 200，参数被接受 |
| cn.bing（直连）英文技术查询 | 被重写成词典结果（引号无效），示例：`reciprocal rank fusion RRF` → 剑桥词典/iciba |
| `www.bing.com?setmkt=en-US` | 同样词典化——出口被 geo 锁死，不是参数问题 |
| html.duckduckgo.com / lite.ddg / r.jina.ai | 连接超时（本机网络不可达） |
| 直连抓页（arxiv.org / github.com / juejin.cn） | 可达，200 |
| en.wikipedia.org | 连接超时 |

结论：**有 Key 的检索源是主力，HTML 兜底天然弱**；页面阅读必须本地实现，不能依赖 Jina/Firecrawl 服务。

## 二、已采纳（本轮落地）

| 技术 | 来源 | 落地 |
|---|---|---|
| 正文直达（content_size=high） | 智谱 API 实测；Tavily `include_raw_content` 同思路 | `web-search.ts` 的 zhipu adapter；`SearchHit.content` |
| 多源并发 + RRF（K=60）+ URL 归一化 + 单站上限 | [SearXNG](https://github.com/searxng/searxng) 的 engine 加权；[LangChain EnsembleRetriever](https://github.com/langchain-ai/langchain)（weighted RRF, c=60） | `rrfMerge`/`canonicalUrl`；关键词源权重 1.0、HTML 0.7 |
| 查询改写扇出 | [dzhng/open-deep-research](https://github.com/dzhng/open-deep-research) `generateSerpQueries`；[gpt-researcher](https://github.com/assafelovic/gpt-researcher)；[MultiQueryRetriever](https://github.com/langchain-ai/langchain) | `QIANSI_SEARCH_REWRITE=on`：快模型生成 2 个变体并发检索后融合；失败降级单路 |
| LLM listwise 重排 | [FlashRank](https://github.com/PrithivirajDamodaran/FlashRank)、bge-reranker 的零依赖等价 | `rerankWithLlm`：命中 >4 时一次调用返回索引序；失败保持原序；`QIANSI_SEARCH_RERANK=off` 可关 |
| 时效检索 | [Tavily docs](https://docs.tavily.com/) 的 time_range；[FreshQA](https://arxiv.org/abs/2310.03214) | 工具新增 `freshness`；query 含「最新/今年/新闻」自动 year；周级缓存 TTL 3 分钟 |
| `read_url` 页面阅读 | [crawl4ai](https://github.com/unclecode/crawl4ai) `fit_markdown`；[Jina Reader](https://github.com/jina-ai/reader) | `node-tools.ts` 本地抓取+去噪，2MB/GBK/缓存；不依赖外部阅读服务 |
| 研究循环写进工单 | deep-research 递归；gpt-researcher `researcher.py`；[Search-o1](https://arxiv.org/abs/2501.05366) | 规划规则 15：检索方向 → web_search → read_url → learnings（含数字/日期/主体）→ 追问；交付按编号引用 URL |
| 编号证据 + 引用纪律 | [ALCE](https://arxiv.org/abs/2305.14627)；WebDancer | 工具说明要求 cite URL、不得编造；未能核实要写明 |

验收：管线单测 22/22（正文透传、freshness、扇出、缓存、去重、单站上限、重排、失败降级、HTML 回落、read_url 提取与缓存）；真实 Key 线上检索 2.0s / 6 条，每条 1–29KB 正文，来源分散。

## 三、牵丝相对开源的优势与差距

**领先或独特**（在这轮对比里没有找到把这几件事做在一起的 OSS）：画布即工作流（节点=可执行任务+验收标准，运行结果写回节点）、团队名册（职责/手册/自治档位/能力白名单）、自省闭环（多模型复盘→互审→改码→校验→复核→提交+报告+落地核验）、用户视角验收（浏览器截图断言）、从 Claude Code/Codex 会话接管继续工作。

**落后、值得借鉴（按价值/代价排序）**：

1. **成员长期记忆回写**（[CrewAI memory](https://docs.crewai.com/concepts/memory)，value high / effort small）：运行结束把「任务→评分→改法」滚动写回成员记忆，下一次任务 prompt 自动带上。牵丝已有 `TeamMember.memory` 字段与注入，只缺写回。
2. **研究节点自动提高工具轮次**（deep-research 递归、Search-o1）：研究型任务现在仍受 6 轮上限；应按工单意图放宽。
3. **acceptance 的 faithfulness 断言**（[promptfoo context-faithfulness](https://www.promptfoo.dev/docs/configuration/expected-outputs/)、ALCE）：带检索证据的 run，逐条判「有出处/无出处」，无出处的引用即判失败并指认。
4. **自省 repo map**（[aider repomap](https://aider.chat/docs/repomap.html)）：用符号引用图按预算生成「文件: 签名」摘要，取代现在按文件大小取前 8KB 的做法。
5. **测试先行的自省改码**（[aider lint-edit](https://aider.chat/2024/edit-lint-mode.html)、AlphaCodium）：先写失败测试，改到测试转绿再过既有校验。
6. **画布模板库**（[Dify](https://github.com/langgenius/dify)、[Flowise](https://github.com/FlowiseAI/Flowise)）：常用工作流一键复用。

## 四、明确拒绝（对本地单用户工具属于过度工程）

| 拒绝项 | 理由 |
|---|---|
| 本地 embedding / cross-encoder 重排模型（bge、Qwen3-Reranker） | 需要 Python/ONNX 运行时，破坏纯 TS 零部署形态；LLM 重排已覆盖同等收益 |
| HyDE | 主要收益在稠密检索；对关键词型搜索 API 收益有限，增加一次生成本与噪声 |
| RL 训练系（Search-R1、DeepResearcher、WebSailor） | 只借推理期模式（多子目标查询、双源核验、空结果反思），训练不在范围 |
| MindSearch 子问题 DAG、WebWeaver 动态大纲 | 2–3 路扇出 + 追问循环已覆盖多跳需求；图规划改动大、真实使用频率低 |
| LangGraph 式 interrupt/checkpoint 硬暂停 | 单用户场景下画布可见性 + needsHuman 标注已足够，SSE 状态机重构成本不抵收益 |
| r.jina.ai / Firecrawl 作默认阅读通道 | 本机实测不可达，仅作为可选增强 |

## 五、下一批（未在本次实现）

成员记忆回写 → 研究节点轮次放宽 → faithfulness 断言 → 自省 repo map → 测试先行→模板库。每项都已在上文给出落点文件与验收口径。
