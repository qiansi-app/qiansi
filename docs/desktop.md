# 桌面版

牵丝 Qiansi 以 Electron 桌面应用交付。窗口内加载与本地 Web 模式相同的 Studio；主进程启动打包后的 Hono 服务。开发与 Web 模式固定 `127.0.0.1:8787`，桌面版每次启动挑选空闲端口。

## 运行方式

### 开发模式

```powershell
npm run desktop:dev
```

同时启动 server（8787）、Vite（5173）和 Electron 窗口。Electron 加载 `http://localhost:5173`，代码改动热更新。

### 便携版（当前推荐）

```powershell
npm run desktop:portable
```

产物：`release/Qiansi-portable/Qiansi.exe`。双击即可运行，不需要安装；自带服务端与画布静态文件。打包脚本会用 resedit 把 Electron 的版本资源改写成 Qiansi（产品名、版本、版权、图标），属性页不再显示 Electron 38.x / GitHub, Inc.。

- **动态端口**：生产模式启动时自动选择空闲端口；窗口与内置服务使用同一端口。
- **托盘**：关闭窗口隐藏到托盘；托盘菜单可打开或退出；重复启动聚焦已有窗口。
- **数据位置**：
  - `~/.qiansi/`：DPAPI 保险库、服务令牌、反馈日志、运行历史 `runs/`、上传文件 `files/`、画布 `canvas.json`。
  - `%APPDATA%\Qiansi\`：Chromium 本地存储。首次启动会从 `%APPDATA%\AgentWeave\` 迁移一次。
- 开机自启：设置里的开关通过 IPC 调用 `app.setLoginItemSettings`，便携版生效；移动文件夹后需重新设置。

### NSIS 安装包

```powershell
npm run desktop:build
```

配置在 `apps/desktop/electron-builder.yml`，目标为 NSIS + portable，已设置 `asarUnpack: server-dist/**` 与签名时间戳服务器。本机安全软件会删除 `app-builder.exe`，因此本地通常只能出便携版；CI（GitHub Actions，干净的 windows-latest）可以正常产出 NSIS 安装包。

## 目录结构

- `apps/desktop/main.cjs`：Electron 主进程；生产模式以 `ELECTRON_RUN_AS_NODE` 启动 `server-dist/index.cjs`，等待 `/api/health` 后加载动态端口。
- `apps/desktop/preload.cjs`：只暴露 `setAutostart` / `getAutostart`，同时保留旧名 `window.agentweave` 一个版本的别名。
- `apps/desktop/server-dist/index.cjs`：esbuild 打包后的服务端（含 engine、Hono、静态托管）。
- `resources/app/`：便携版里的应用代码（main/preload/server）。
- `resources/studio/`：构建后的 Studio 静态文件。
- `scripts/desktop-portable.mjs`：从 `node_modules/electron/dist` 复制并组装便携版，不依赖 app-builder。

## 已知限制

- 便携版 exe 未签名，其他机器首次运行可能触发 SmartScreen；正式分发需要代码签名。
- 自动更新尚未实现；electron-builder 的 `publish` 配置与 `latest.yml` 需要等签名就绪后再加。
- 开机自启绑定当前 exe 路径；移动目录后需重新开关一次。旧名版本留下的启动项需要手动清理。
- DPAPI 保险库仍是 CurrentUser 级；同一 Windows 用户下的进程可请求解密。

## 下一步

1. 代码签名（SignPath 或 Certum）与 CI 正式安装包。
2. 自动更新：electron-updater + GitHub Releases。
3. 用 Electron `safeStorage` 替换 PowerShell DPAPI，减少子进程调用。
