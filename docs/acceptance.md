# 验收索引

项目的铁律是**验收证据先于交付**：每轮改动必须附可复现的检查结果，CHANGELOG 里
每一条都以「N/N」收尾。这里把检验项、命令、覆盖点与期望输出一次列清，接手时不用
再翻会话记录。

## 一次性全量

```bash
npm run typecheck                 # engine / server / cli / studio 四个包
npm run build -w @qiansi/studio   # 前端能构建
node scripts/check-version.mjs    # 版本号一致性
```

## 引擎与服务端

| 检查 | 命令 | 覆盖 | 期望 |
|---|---|---|---|
| 产物纯函数 | `npx tsx scripts/check-artifacts.ts` | 扩展名识别、目录快照跳过依赖目录、前后差异只报新增/改动、空文件不计、同路径多来源合并、rootDir 内外路径换算 | `ARTIFACTS OK`（18 项） |
| 产物账本与归因 | `npx tsx scripts/check-artifact-ledger.ts` | write_file 归因、命令产物归因、并行任务不重复认领、落盘与去重 | `LEDGER OK`（12 项） |
| 纠错回路 | `npx tsx scripts/check-correction.mts` | 第一次提示词不含纠错段、第二次带失败原因与建议、成功的工具调用不进错误清单、attemptLog 两条 | `CORRECTION OK`（19 项） |
| 对话风格 | `npx tsx scripts/check-styles.mts` | 九种风格三段齐全、中英文关键词推断、大小写不敏感、非法值回落、提示词拼装、**画布节点 style 字段真的进计划** | `STYLES OK`（59 项） |
| 工具循环护栏 | 见 `scripts/`（历史脚本，如需重跑参考 CHANGELOG） | 重复写跳过、调用预算、字符预算、跨重试共享 | 14/14 |

> `.mts` 后缀是必需的：`check-correction` 用了顶层 await，`.ts` 会被 tsx 当成 CJS 编译失败。

## 端到端（需要模型 Key）

```bash
QIANSI_HOME=<隔离目录> QIANSI_PORT=8983 QIANSI_E2E_PROJECT=<临时项目目录> \
  node scripts/e2e-artifacts.mjs
```

起一个隔离实例、真模型跑一次写文件的编排，断言产物账本、预览接口、越权路径拒绝、
聚合接口。期望结尾 `ARTIFACTS E2E OK`。**必须用隔离目录**：它会把工作区、运行记录
写进 `QIANSI_HOME`，不要指向真实 `~/.qiansi`。

## DSH 插件（dsh/qiansi）

```bash
cd dsh/qiansi
node build-server.mjs        # 重新打包内置画布服务（prepack 也会跑）
node bridge-check.mjs        # 自带服务拉起/复用/停止/插件入口，期望 BRIDGE OK（11 项）
node pack-check.mjs          # 包清单、静态补丁、市场索引一致性，期望 PACK OK
node ../../dsh/marketplace/validate.mjs   # 市场索引（优先用 DSH 官方校验器），期望 MARKET INDEX OK
```

发布前还要 `npm publish --dry-run` 过一遍；实际发布见 `memory/qiansi-npm-publish.md`
（必须 `--registry https://registry.npmjs.org`，且用带 bypass-2FA 的 granular token）。

## 隔离测试的正确姿势

```bash
QIANSI_HOME=/tmp/qiansi-test QIANSI_PORT=8899 npx tsx apps/server/src/index.ts
```

- `QIANSI_HOME` 是正式开关：服务端状态、端口文件、MCP 客户端解析都只认它；
- **不要**在 Linux 上用 `USERPROFILE` 覆盖（那是 Windows 才生效的旧办法）；
- 停进程：`ss -ltnp | grep 8899` 取 pid 后 `kill`；Windows 用
  `netstat -ano | findstr 8899` + `Stop-Process -Id`。
