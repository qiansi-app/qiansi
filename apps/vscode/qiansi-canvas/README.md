# 牵丝画布（VS Code 扩展）

在 VS Code 里直接打开牵丝画布：可拖拽节点、看连线产物、跑编排。它嵌入的是完整的牵丝界面，和 Claude Code 对话面板并排——agent 通过 MCP 改画布，这个面板 1.5 秒内自动跟上。

**自动运行**：扩展自带完整的牵丝服务端（`server.cjs`）。VS Code 一打开就自动拉起服务，点开左侧活动栏的牵丝图标即用，不需要先打开桌面应用。如果桌面版已经在运行，扩展会复用它而不是再起一个。

服务随 VS Code 关闭而停止；需要 7×24 常驻时用桌面版（开机自启）。

## 安装

构建产物（`server.cjs`、`studio/`）不进仓库，先在仓库根目录跑一次打包：

```bash
npm install
npm run vscode:ext
```

然后把本目录复制进 VS Code 扩展目录，重载窗口：

```powershell
Copy-Item -Recurse <仓库路径>\apps\vscode\qiansi-canvas "$env:USERPROFILE\.vscode\extensions\qiansi.qiansi-canvas-0.1.0"
```

`Ctrl+Shift+P` → 「重新加载窗口」→ 左侧活动栏点牵丝图标。

改了仓库代码后重新跑 `npm run vscode:ext`，再把 `server.cjs` 和 `studio/` 覆盖到扩展目录。

## 前提

无。服务端和界面都打进扩展里了；桌面版只是可选的常驻方式。

## 命令

| 命令 | 作用 |
|---|---|
| 牵丝：打开画布面板 | 在编辑器旁边打开画布（首次）或重新连接（牵丝重启后） |
| 牵丝：在浏览器打开画布 | 用默认浏览器打开同一个界面 |
| 牵丝：重新连接画布 | 重新探测/重启服务并刷新侧栏与标签页 |

**活动栏（左侧竖条）有牵丝图标**，点它展开侧栏画布，随时都在；也可以用状态栏右下角的「牵丝」按钮或编辑器右上角的牵丝图标。侧栏窄，拖动分隔条可以加宽；要整幅大画布就用「打开画布面板」。

## 让 agent 唤起画布

扩展注册了 URI 处理器。在 Claude Code / Codex 的对话里让 agent 执行：

```powershell
start "" "vscode://qiansi.qiansi-canvas/open"    # Windows
open "vscode://qiansi.qiansi-canvas/open"        # macOS
```

VS Code 会自动打开并聚焦画布面板。配合 MCP 的画布工具，就是「agent 在聊天里改图、画布在你眼前实时变化」的完整闭环。

## 限制

- 内嵌服务随 VS Code 关闭而停止；关掉 VS Code 后，桌面版（若在运行）仍是可用的常驻服务。
- 系统通知（运行完成提醒）在 iframe 里可能被浏览器策略拦掉，属预期行为。
