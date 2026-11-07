# 牵丝 Qiansi · DSH 插件

把牵丝的画布能力接进 [DeepSeek Harness](https://www.deepseek.com/en/harness/)：DSH 会话里出现 `mcp__qiansi__*` 工具，模型可以读写画布、发起编排运行、查运行结果，也可以查各模型家族的 Key 额度与余量。

> 本节说明文字与三条卖点由牵丝画布上的「推广文案员」节点生成（2026-11-08），经人工核对后收窄了范围：插件暴露的是**全部 19 个 MCP 工具**，不只是额度查询。

## 安装

```bash
# 1. 生成 bundle 补丁（把 MCP server 的绝对路径写进 cordis.patch.yml）
node dsh/qiansi/install.mjs

# 2. 装进一个 DSH profile（会调用 pnpm；MCP 桥的版本必须与 dsh 匹配）
dsh plugin --profile <profile> add "link:<仓库>/dsh/qiansi"
dsh plugin --profile <profile> add "@deepseek-ai/dsh-mcp-client@0.2.2-rc.1"

# 3. 启一个带本插件的 DSH
dsh --profile <profile> --patch <仓库>/dsh/qiansi/cordis.patch.yml
```

版本约束：`dsh 0.2.2-rc.1` ↔ `@deepseek-ai/dsh-mcp-client 0.2.2-rc.1`。用 0.0.1-rc.1 会被 DSH 的兼容性检查直接拒绝。

## 依赖

- 牵丝服务在运行（桌面应用、VS Code 面板，或 `npm run server:start`）。插件通过 `~/.qiansi/server-port` 找到它。
- Node ≥ 24.9（DSH 自身要求）。

服务没起时，插件会在日志里说清楚，而不是抛一串子进程堆栈。

## 验证（本机实测通过）

```bash
# 补丁能组合进 profile（会打印我们的两条 insert）
node dsh/qiansi/install.mjs --verify <profile>

# 模块在 profile 里可解析
cd "$DSH_HOME/profiles/<profile>" && node -e "require.resolve('qiansi-dsh')"

# 插件真的能跑：加载、探测服务、返回 dispose
cd "$DSH_HOME/profiles/<profile>" && node --input-type=module -e "
  const m = await import('qiansi-dsh');
  await m.apply({ logger: console }, { serverName: 'qiansi' });
  console.log(m.describe());
"
```

预期：`dump-config` 里出现 `- id: qiansi` 与 `- id: qiansi-mcp`；模块解析返回 `.../dsh/qiansi/index.js`；`apply` 打印 `canvas reachable at http://127.0.0.1:<port>`。

## 卖点

- **画布即工具**：`describe_canvas` / `add_node` / `connect_nodes` / `run_canvas` / `get_run_result` 等直接可用，DSH 里的 agent 能读写同一张图。
- **额度可查、可轮换**：`get_quota` 给出每个家族、每个 Key 的日/月额度与余量；Key 用尽自动切换，家族用尽运行前自动改派。
- **不重复造对话**：DSH 保留自己的会话与工具生态，牵丝只提供那块它没有的：可视化的多模型状态。
