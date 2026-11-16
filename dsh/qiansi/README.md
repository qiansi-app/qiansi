# 牵丝 Qiansi · DSH 插件

把牵丝的画布能力接进 [DeepSeek Harness](https://www.deepseek.com/en/harness/)：DSH 会话里出现 `mcp__qiansi__*` 工具（共 43 个），模型可以读写画布、发起与诊断运行、管理团队名册、触发自我优化并核对落地、做用户视角验收，也可以查各模型家族的 Key 额度。

**装完即可用**：组合包自带画布服务（`server/server.cjs`，esbuild 单文件、无原生模块）。插件启动时先看本机有没有已经在跑的牵丝（桌面版、VS Code 面板、`npm run server:start` 都算），有就复用，没有就把自带的这个拉起来——不需要另外启动任何东西。

## 安装

**A. 从插件市场 / npm（推荐）**

```bash
dsh plugin --profile qiansi add qiansi-dsh
```

或者在 DSH 的 **插件 → 发现 → 添加索引源** 里填入：

```
https://raw.githubusercontent.com/qiansi-app/qiansi/main/dsh/marketplace/index.json
```

**B. 从 tarball（离线）**

```bash
cd dsh/qiansi && npm pack
dsh plugin --profile qiansi add ./qiansi-dsh-0.3.0.tgz
```

**C. 在仓库里开发**

```bash
node dsh/qiansi/install.mjs --profile qiansi --template headless
```

B/C 两种如果 profile 是新建的，先用 `dsh --profile <name> --from-default-profile headless` 落到一个能启动的模板：只 `dsh plugin add` 出来的是纯 base profile，没有 app。

然后：

```bash
QIANSI_DSH_DEBUG=1 dsh --profile qiansi "随便说句话"
```

前两行应该是：

```
[qiansi] canvas started at http://127.0.0.1:8787 (bundled server, pid 4321) — tools are mcp__qiansi__*
[qiansi-mcp] ready
```

本机已经有牵丝在跑时，第一行会是 `canvas reachable at …`（复用，不会再起第二个）。

`QIANSI_DSH_DEBUG=1` 把状态行同时打到 stderr；不开时只进 DSH 自己的日志。

## 自带服务

插件启动时按这个顺序找服务：显式 `port` → `QIANSI_PORT` → `~/.qiansi/server-port` → `8787`。全都没应答，才用包内的 `server/server.cjs` 起一个（detached、日志在 `~/.qiansi/logs/server.log`、端口占用时自动在附近找空闲的），最多等 30 秒。

```bash
qiansi-dsh server start     # 现在就把服务拉起来（插件启动时也会自动做）
qiansi-dsh server stop      # 停掉本机服务
qiansi-dsh server status    # 探测当前端口与连通性
```

- **共享而非独占**：插件拉起的服务在 DSH 退出后继续跑，桌面版、VS Code 面板都能接着用；不想留着就 `server stop`。
- **不再抢端口**：服务把实际端口写进 `~/.qiansi/server-port`，MCP 客户端每次请求都重读，重启换端口不会指向死地址。
- **可关**：配置 `autoStart: false` 退回「只探测、不起服务」；`port` 指定端口；`fallbackPorts: []` 表示不连 8787 默认端口（环境变量版：`QIANSI_DSH_PORT_FALLBACK=0`）。
- **隔离实例**：`QIANSI_HOME` 指到别的目录时，服务、端口文件、管理令牌都只认这一个目录，不会碰到真实的 `~/.qiansi`。

## 工作原理

两层，都是静态的：

1. **MCP 客户端**——`cordis.patch.yml` 启动时通过 profile 的模块图解析包内的 MCP server，不依赖安装器写绝对路径。

```yaml
args:
  - !!js "process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('qiansi-dsh/mcp/server.mjs')"
```

`baseUrl` 由 DSH loader 注入（profile 目录的 file URL）。`link:`、npm tarball、只装 qiansi-dsh 的市场形态三种安装都实测能启动。`!!js` 求值环境里没有 `require` 和 `import.meta`，所以必须走 `process.getBuiltinModule`（Node ≥ 22.3）。

2. **画布服务**——`index.js` 这个 bundle 插件在 `apply()` 里调 `ensureServer()`（`server-bridge.mjs`），需要时把 `server/server.cjs` 作为独立进程拉起并等它就绪。这个 bundle 由 `node build-server.mjs` 从 `apps/server` 打包，`prepack` 会自动跑一次。

## 工具（43 个）

| 分组 | 工具 |
|---|---|
| 画布 | `describe_canvas` `get_canvas` `get_canvas_svg` `add_node` `update_node` `connect_nodes` `remove_node` `set_orchestrator` `adapt_canvas` `export_canvas` |
| 运行 | `run_canvas` `get_run_result` `get_run_diagnosis` `rerun_run` `stop_run` `list_runs` `get_active_run` `save_deliverable` `resume_project` |
| 团队 | `get_team` `update_team` |
| 自我优化 | `self_optimize` `self_opt_status` `self_opt_versions` `list_selfopt_sessions` `get_selfopt_report` `check_selfopt_landing` |
| 模型与检索 | `list_models` `call_model` `delegate` `delegate_task` `web_search` `get_usage` `request_approval` |
| 工作区与接续 | `list_workspaces` `use_workspace` `upload_file` `handoff_from_agent` |
| 用户视角验收 | `run_user_view` `get_user_view` |

典型闭环：`get_run_diagnosis` 看为什么失败 → `rerun_run`（或先传 `root_dir`）重跑 → `get_active_run` 轮询 → `save_deliverable` 落盘。`stop_run` 与界面共用同一条策略检查，可以随时止损。

## 兼容性与依赖

- DSH `>=0.2.2-rc.1 <0.3.0`（`engines.dsh`，安装与启动都会检查）；Node ≥ 22.3。
- **不需要预先启动牵丝**：包内 `server/server.cjs` 会在需要时被拉起；本机已有实例则直接复用（通过 `~/.qiansi/server-port` 找到，也可用 `QIANSI_PORT` 覆盖）。
- `@deepseek-ai/dsh-mcp-client` 是 bundle 的普通依赖，随 qiansi-dsh 一起装；无需单独安装。
- 包体约 700 kB（内置服务 672 kB），安装不需要编译、没有原生模块。
- 命令行跑 `headless`/`web` 需要模型凭据：`export DEEPSEEK_API_KEY=...`，或在 DSH 的 Models 页存一次。桌面应用用的是 OAuth，CLI 读不到，会报 `MISSING_CREDENTIAL`——**这个错误发生在插件加载之后**，不影响验证工具是否注册。画布工具本身不需要模型 Key（要跑编排才需要）。

## 发布与市场维护

```bash
cd dsh/qiansi
node build-server.mjs              # 重新打包内置服务（prepack 也会自动跑）
npm run bridge:check               # 自带服务自检：拉起、复用、停止、插件入口
npm run pack:check                 # 包清单、补丁、与源文件同步、市场索引一致性
node ../../dsh/marketplace/validate.mjs   # 用本机 DSH 官方校验器校验索引
npm pack                           # 产物用于 tarball 安装
npm publish --access public        # 需要 npm 登录 + 2FA 或 bypass-2FA 令牌
```

### npm 令牌怎么配（2026-11 规则）

账号开着 2FA 时，命令行直接发布会被 403 拒绝（`Two-factor authentication or granular access token with bypass 2fa enabled is required`）。两条路：

- **一次性验证码**：`npm publish --access public --otp=123456`（30 秒内有效，适合手动发一次）；
- **Granular Access Token（推荐）**：npmjs.com → Access Tokens → Generate New Token → Granular：
  - Permissions 选 **Read and write**；
  - Packages 只勾 `qiansi-dsh`（最小权限）；
  - **Bypass 2FA 勾上**（写权限令牌默认 false，不勾就必须每次给 OTP）；
  - 设一个到期日；创建后 `npm config set //registry.npmjs.org/:_authToken=<token>`。

注意 npm 的路线图：**带 bypass-2FA 的直接发布令牌从 2027-01 起被取消**。到时应切换成「读写（仅阶段）」令牌 + `npm stage publish`，由维护者用 `npm stage approve <stage-id> --otp <code>` 推广。现在先用 bypass 令牌把 0.3.0 发出去，后续版本可以提前演练 stage 流程。

还有一点实测经验：**全新包名第一次 `npm publish` 会走暂存流程**——注册表先建一个 `0.0.0-stage` 占位版本，真正版本异步落库。头两次可能报 `409 Cannot publish over previously staged version`，过十几秒再发一次会变成 `cannot publish over the previously published versions`，那其实说明**已经发成功了**，用 `npm view <pkg> versions` 确认即可。

### 市场索引

市场索引在 `dsh/marketplace/index.json`（格式 1，图标为内联 SVG）。发新版本时更新三处：`package.json.version`、索引里的 `versions[].version` 与 `publishTimestamp`、以及 README 里的 tarball 文件名。索引托管在仓库里，任何 https 静态地址都能作为索引源。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot find package 'qiansi-dsh'` | 用 `--patch` 叠加，但目标 profile 没装 bundle | 改用 `dsh plugin add` 安装 |
| 只有 `[qiansi-mcp] ready`、没有 `[qiansi]` 行 | 状态插件的日志只进 DSH 日志 | 加 `QIANSI_DSH_DEBUG=1` |
| `[qiansi] 画布服务没有就绪` | 内置服务起不来（日志在 `~/.qiansi/logs/server.log`） | 看日志最后几行；或手动 `qiansi-dsh server start` 复现 |
| 30 秒内没就绪 | 机器慢或端口被抢 | 调大 `startTimeoutMs`，或 `port` 指定一个空闲端口 |
| 装完没反应、工具也没出现 | 包内缺 `server/server.cjs`（从源码树直接拷的包） | `node dsh/qiansi/build-server.mjs` 后重装 |
| `MISSING_CREDENTIAL` | CLI 缺模型 Key | `export DEEPSEEK_API_KEY=...` |
| `!!js` 报 `require is not defined` | Node 低于 22.3 | 升级 Node（DSH 本身要求 ≥24.9） |
