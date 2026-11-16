# 牵丝 Qiansi · DSH 插件

把牵丝的画布能力接进 [DeepSeek Harness](https://www.deepseek.com/en/harness/)：DSH 会话里出现 `mcp__qiansi__*` 工具（共 43 个），模型可以读写画布、发起与诊断运行、管理团队名册、触发自我优化并核对落地、做用户视角验收，也可以查各模型家族的 Key 额度。

## 安装

先让牵丝服务跑起来（桌面应用、VS Code 面板，或 `npm run server:start`）。三种安装方式等价：

**A. 从插件市场 / npm（推荐）**

```bash
dsh plugin --profile qiansi add qiansi-dsh            # 已发布 0.2.0，直接从 npm 装
```

或者在 DSH 的 **插件 → 发现 → 添加索引源** 里填入：

```
https://raw.githubusercontent.com/qiansi-app/qiansi/main/dsh/marketplace/index.json
```

**B. 从 tarball（离线）**

```bash
cd dsh/qiansi && npm pack
dsh plugin --profile qiansi add ./qiansi-dsh-0.2.0.tgz
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
[qiansi] canvas reachable at http://127.0.0.1:8931 — tools are mcp__qiansi__*
[qiansi-mcp] ready
```

`QIANSI_DSH_DEBUG=1` 把状态行同时打到 stderr；不开时只进 DSH 自己的日志。

## 工作原理

bundle 的补丁是**静态**的（`cordis.patch.yml`）：启动时通过 profile 的模块图解析打包内的 MCP server，不依赖安装器写绝对路径。

```yaml
args:
  - !!js "process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('qiansi-dsh/mcp/server.mjs')"
```

`baseUrl` 由 DSH loader 注入（profile 目录的 file URL）。`link:`、npm tarball、只装 qiansi-dsh 的市场形态三种安装都实测能启动。`!!js` 求值环境里没有 `require` 和 `import.meta`，所以必须走 `process.getBuiltinModule`（Node ≥ 22.3）。

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
- 牵丝服务在运行；插件通过 `~/.qiansi/server-port` 找到它（也可用 `QIANSI_PORT` 覆盖）。
- `@deepseek-ai/dsh-mcp-client` 是 bundle 的普通依赖，随 qiansi-dsh 一起装；无需单独安装。
- 命令行跑 `headless`/`web` 需要模型凭据：`export DEEPSEEK_API_KEY=...`，或在 DSH 的 Models 页存一次。桌面应用用的是 OAuth，CLI 读不到，会报 `MISSING_CREDENTIAL`——**这个错误发生在插件加载之后**，不影响验证工具是否注册。

## 发布与市场维护

```bash
cd dsh/qiansi
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

注意 npm 的路线图：**带 bypass-2FA 的直接发布令牌从 2027-01 起被取消**。到时应切换成「读写（仅阶段）」令牌 + `npm stage publish`，由维护者用 `npm stage approve <stage-id> --otp <code>` 推广。现在先用 bypass 令牌把 0.2.0 发出去，后续版本可以提前演练 stage 流程。

### 市场索引

市场索引在 `dsh/marketplace/index.json`（格式 1，图标为内联 SVG）。发新版本时更新三处：`package.json.version`、索引里的 `versions[].version` 与 `publishTimestamp`、以及 README 里的 tarball 文件名。索引托管在仓库里，任何 https 静态地址都能作为索引源。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot find package 'qiansi-dsh'` | 用 `--patch` 叠加，但目标 profile 没装 bundle | 改用 `dsh plugin add` 安装 |
| 只有 `[qiansi-mcp] ready`、没有 `[qiansi]` 行 | 状态插件的日志只进 DSH 日志 | 加 `QIANSI_DSH_DEBUG=1` |
| `[qiansi] 画布服务没有应答` | 牵丝没启动 | 起服务后重启 DSH |
| `MISSING_CREDENTIAL` | CLI 缺模型 Key | `export DEEPSEEK_API_KEY=...` |
| `!!js` 报 `require is not defined` | Node 低于 22.3 | 升级 Node（DSH 本身要求 ≥24.9） |
