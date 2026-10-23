# 架构决策 0003：Electron 桌面壳与便携打包

日期：2026-10-21
状态：已采纳

## 决策

以 **Electron** 作为桌面壳，复用现有 Node 服务与纯 TS 引擎：

- 主进程在打包模式下启动 `server-dist/index.cjs`（esbuild 单文件），等待 `/api/health` 后加载 `http://127.0.0.1:8787`。
- 开发模式加载 Vite 的 `http://localhost:5173`；`scripts/desktop-dev.mjs` 清除 Claude Code shell 注入的 `ELECTRON_RUN_AS_NODE=1`。
- 单实例锁；重复启动聚焦已有窗口。
- 开机自启通过 preload 暴露的 IPC 调用 `app.setLoginItemSettings`。
- 画布静态文件由 Hono `serveStatic` 托管，路径来自 `QIANSI_STUDIO_DIR`。

## 打包

- 配置了 electron-builder（NSIS + portable）。
- 本机安全软件会删除 `app-builder-bin` 的 `app-builder.exe`，electron-builder 无法运行。
- 因此提供 `scripts/desktop-portable.mjs`：复制 Electron 发行目录，写入 `resources/app` 与 `resources/studio`，生成免安装便携版 `release/Qiansi-portable/Qiansi.exe`。不依赖 app-builder。
- NSIS 安装包保留给干净机器/CI；正式发布前需要代码签名。

## 后果

- 便携版 exe 未签名，其他机器可能有 SmartScreen 提示。
- 端口固定 8787；桌面版与开发服务器不能同时运行。
- 数据在 `~/.qiansi`，与应用目录分离；移动应用不影响数据。
- 后续：动态端口、托盘、图标、自动更新、`safeStorage` 替换 PowerShell DPAPI。
