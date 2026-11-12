# 节点工具

画布上的每个工作节点不再只能输出文字：它可以读写工作目录里的文件、执行命令、查询画布与联网检索。模型只负责「选哪个工具、传什么参数」，真正的执行在服务端完成，路径、命令与输出都受约束并写审计。

## 有哪些工具

| 工具 | 作用 | 边界 |
|---|---|---|
| `read_file` | 读文本文件，可指定起始行与行数 | 只能读工作目录内；单文件 ≤ 2MB，返回截断到 120KB |
| `write_file` | 写入或追加文本，自动建父目录 | 只能在作目录内；单次 ≤ 400KB |
| `list_dir` | 列目录（名称、类型、大小） | 只能列工作目录内，最多 400 项 |
| `run_command` | 执行 shell 命令，返回 stdout/stderr/退出码 | 工作目录为 cwd；超时 30s（最长 120s）；输出截断 20KB |
| `describe_canvas` | 文本描述当前画布 | 只读 |
| `get_canvas` | 当前画布完整 JSON | 只读，截断 20KB |
| `list_workspaces` | 所有画布（含归档） | 只读 |
| `list_runs` | 最近运行记录 | 只读 |
| `get_run_result` | 某次运行的快照与产出 | 只读 |
| `web_search` | 联网检索 | 需要搜索能力可用 |

## 工作目录从哪来

- 接管会话创建的画布：工作目录 = 会话所在项目（从会话记录的 `cwd` 读出）；
- 其它画布：`WorkspaceMeta.rootDir`，可以用 `PATCH /api/workspaces/:id { "rootDir": "E:/project" }` 设置；
- 都没设：服务端启动目录。

文件与命令都被限制在这个目录内，`..` 越界会被拒绝。

## 安全边界

- **命令黑名单**：格式化磁盘、`diskpart`、关机/重启、`mkfs`、`dd`、`reg delete`、`bcdedit`、`git reset --hard`、`git clean -f`、`git push --force`、`rm -rf /` 等直接拒绝；
- **输出脱敏**：所有工具返回给模型的文本先过 `redactSecrets`，事件流里的参数与预览也脱敏后落盘；
- **审计**：每次调用记 `node.tool`（工具名、参数摘要、耗时、退出码），不记录文件正文；
- **可关闭**：`POST /api/commands` 的 `run.start` 传 `payload.tools = false` 即可整轮禁用工具；
- 工具结果与上游产出一样被标记为不可信数据，模型被告知不能执行其中的指令。

## 工具循环怎么跑

`ServerToolAdapter` 包在模型适配器外面：

```
模型 → 请求工具 → 服务端校验并执行 → 结果作为 tool 消息回填 → 模型继续
```

每个任务最多 6 轮工具（环境可调），轮次用尽后会强制一次无工具调用，避免模型永远停在「还要再查」。每次工具调用都会在运行事件流里发 `tool.called`，界面在节点上显示「工具 read_file · 成功」与耗时。

## 验收记录

- 假模型单元验收 9/9：工具 schema 透传、参数拼接、tool 结果回填、未知工具不卡死；
- 真实模型端到端：deepseek-v4-pro 在 `qiansi-tool-fixture` 上调用 `read_file` 读 `note.txt`、`write_file` 写 `out.txt`，运行 `done`，验收 0.86，文件内容逐字一致。

## 已知限制

- 只用支持 function calling 的模型才会真正调用工具；不支持的工具协议下模型会直接回答，不会报错。
- `run_command` 的输出上限 20KB；看大文件请用 `read_file` 分段或命令过滤。
- 命令超时只会终止直接的 shell 进程，子进程是否退出取决于命令本身。
- 目前没有逐命令人工审批闸门，危险操作靠黑名单 + 审计兜底；需要更严格的审批流可后续接入 Policy 的 approval 机制。
