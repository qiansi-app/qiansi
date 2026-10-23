# 命名决策 0002：暂不发布，先做查重

日期：2026-10-21
状态：已被 2026-10-21 的发布名决定取代（牵丝 / Qiansi）

> 更新：产品发布名定为「牵丝 / Qiansi」，工程代号 AgentWeave 及 `@agentweave/*` 作用域已全部迁移到 `@qiansi/*`。本文件保留为历史查重记录。

## 已确认的撞名

| 候选 | 冲突 |
|---|---|
| **AgentWeave** | PyPI `agentweave-ai`（0.15/0.41）、`agentweave-sdk`；GitHub `arniesaha/agentweave`、`aj-geddes/agentweave`、`gutohuida/AgentWeave`、`bushm2092-del/agent-weave`（就是多 agent 无限画布）；arXiv 论文 AGENTWEAVE；`sauravsingla.github.io/agentweave` |
| **Weft** | `WeaveMindAI/weft`（Rust AI 编排语言，约 1.1k star，上过 ruanyf/weekly） |
| **Maestro** | `mobile-dev-inc/Maestro`（移动端 UI 测试）、`josstei/maestro-orchestrate` |
| **Heddle** | `HeddleCo/heddle`（agent runtime） |
| **Patchbay** | `patchbay.help`（agent 求助服务）、`tangent2pi/patchbay-mcp`、`Robinbinu/patchbay`、npm `codepatchbay` |

结论：以上全部不能用于公开发布。`AgentWeave` 仅作为当前仓库的工程代号，包作用域 `@agentweave/*` 也只在本地有效。

## 发布前必须执行的查重清单

1. GitHub 仓库名与组织名（含 `agent`、`ai` 变体）
2. npm 包名与 scope（`npm view <name>`、`npm view @scope/<name>`）
3. PyPI、crates.io、Go module、Maven
4. 商标（中国商标网 + USPTO/EUIPO 至少各查一次）
5. 域名（`.dev`、`.ai`、`.app`）与社交账号
6. 竞品近邻：Dify、Langflow、Flowise、n8n、Sim、CrewAI、AutoGen、ComfyUI 的命名风格，避免只差一个字母

通过后：先注册 GitHub org + npm scope + 域名，再创建公开仓库。

## 好名字的约束

- 2–3 个音节，拼写即读，电话里能说清
- 与“编织 / 指挥 / 配线 / 路由”相关，但不要再用 `agent`、`flow`、`weave`、`mesh` 这些 AI 陈词
- 不撞已有 AI 编排产品；不撞大公司产品
- npm scope 与 `.dev` 域名可拿

## 待查候选（均未验证，只是方向）

- **Loomery**（织机工坊）
- **Selvage**（织物的锁边；防止散线）
- **Treadle**（织机踏板）
- **Skein**（一绞纱线）
- **Ostinato**（重复音型）
- **Hocket**（中世纪声部交替技巧，天然对应 agent 交接）
- **Switchyard**（铁路调车场）
- **Signalbox**（铁路信号楼）

注意：这几个词本身也可能已被占用（Skein 是一种哈希函数，Switchyard 曾是测试框架）。必须逐项查。

## 开发期规则

- 代码、文档、包名暂时保留 `AgentWeave` / `@agentweave/*`，避免反复重命名。
- 任何公开 commit、Release、包发布之前，必须先完成本清单并把结果写回本文件。
- README 顶部必须保留“暂定名”提示，直到命名决策变为“已定”。
