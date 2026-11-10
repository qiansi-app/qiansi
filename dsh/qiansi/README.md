# 牵丝 Qiansi · DSH 插件

把牵丝的画布能力接进 [DeepSeek Harness](https://www.deepseek.com/en/harness/)：DSH 会话里出现 `mcp__qiansi__*` 工具，模型可以读写画布、发起编排运行、查运行结果、让项目优化自己，也可以查各模型家族的 Key 额度与余量。

> 本节说明文字与卖点由牵丝画布上的「推广文案员」节点生成（2026-11-08），经人工核对后收窄了范围：插件暴露的是**全部 29 个 MCP 工具**，不只是额度查询。

## 安装（一条命令）

```bash
node dsh/qiansi/install.mjs --profile qiansi --template headless
```

它会做三件事：把 MCP server 拷进 bundle、生成带绝对路径的 `cordis.patch.yml`、把 bundle 与 MCP 桥装进 `<profile>`。`--template` 会先用随附模板（`headless` / `web` / `tui`）建一个**能启动**的 profile——只跑 `dsh plugin add` 初始化出来的是纯 base profile，没有 app，启动会直接退出。

然后：

```bash
QIANSI_DSH_DEBUG=1 dsh --profile qiansi "随便说句话"
```

前两行应该是：

```
[qiansi] canvas reachable at http://127.0.0.1:8921 — tools are mcp__qiansi__*
[qiansi-mcp] ready
```

`QIANSI_DSH_DEBUG=1` 把状态行同时打到 stderr；不开时它只进 DSH 自己的日志。

版本约束：`dsh 0.2.2-rc.1` ↔ `@deepseek-ai/dsh-mcp-client 0.2.2-rc.1`。用 0.0.1-rc.1 会被 DSH 的兼容性检查直接拒绝。

> 装进 profile 之后**不需要**再传 `--patch`：bundle 自己的 `dsh.bundle.patch` 就是一层。`--patch` 是给「不想改 profile」的场景用的，但要求目标 profile 里已经能解析到 `qiansi-dsh`，否则会报 `Cannot find package 'qiansi-dsh'`。

## 依赖

- 牵丝服务在运行（桌面应用、VS Code 面板，或 `npm run server:start`）。插件通过 `~/.qiansi/server-port` 找到它。
- Node ≥ 24.9（DSH 自身要求）。
- 命令行跑 `headless` / `web` 需要一个模型凭据：`export DEEPSEEK_API_KEY=...`，或在 DSH 的 Models 页存一次。桌面应用用的是 OAuth 授权（`~/.dsh/.credentials.yaml` 里是 grant 记录），CLI 读不到，会报 `MISSING_CREDENTIAL: llm-deepseek`。**这个错误发生在插件加载之后**，不影响验证工具是否注册。

## 验证（本机实测通过）

```bash
# 1. 一条命令装进全新 profile，并打印组合后的配置
node dsh/qiansi/install.mjs --profile qiansi-check --template headless
#   → dump-config: OK，出现 - id: qiansi 与 - id: qiansi-mcp

# 2. 启动，看插件是否真的激活
QIANSI_DSH_DEBUG=1 dsh --profile qiansi-check "say hi"
#   → [qiansi] canvas reachable at http://127.0.0.1:8921
#   → [qiansi-mcp] ready

# 3. 用 DSH 同款的 stdio 调用列出工具（不依赖模型）
cd "$DSH_HOME/profiles/qiansi/node_modules" && node --input-type=module -e "
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const client = new Client({ name: 'verify', version: '0.1.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['<仓库>/dsh/qiansi/mcp/server.mjs'],
  env: { ...process.env, QIANSI_AGENT: 'dsh' },
}));
const list = await client.listTools();
console.log(list.tools.length, list.tools.map(t => t.name).join(','));
await client.close();
"
#   → 29 list_models,call_model,...,self_optimize,self_opt_status,self_opt_versions
```

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot find package 'qiansi-dsh'` | 用 `--patch` 叠加，但目标 profile 没装 bundle | 改用 `install.mjs --profile <name> --template ...` |
| 只有 `[qiansi-mcp] ready`、没有 `[qiansi]` 行 | 状态插件的日志只进 DSH 日志 | 加 `QIANSI_DSH_DEBUG=1` |
| `[qiansi] 画布服务没有应答` | 牵丝没启动 | 起服务后重启 DSH |
| `MISSING_CREDENTIAL` | CLI 缺模型 Key | `export DEEPSEEK_API_KEY=...` |

## 卖点

- **画布即工具**：`describe_canvas` / `add_node` / `connect_nodes` / `run_canvas` / `get_run_result` 等直接可用，DSH 里的 agent 能读写同一张图。
- **额度可查、可轮换**：`get_quota` 给出每个家族、每个 Key 的日/月额度与余量；Key 用尽自动切换，家族用尽运行前自动改派。
- **自己优化自己**：`self_optimize` / `self_opt_status` / `self_opt_versions` 让 DSH 里的 agent 也能触发牵丝的自我优化循环。
- **不重复造对话**：DSH 保留自己的会话与工具生态，牵丝只提供那块它没有的：可视化的多模型状态。
