const vscode = require('vscode');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let panel = null;
let sidebarView = null;
let ensurePromise = null;

/**
 * The Qiansi server publishes its live port to ~/.qiansi/server-port because
 * the packaged desktop app picks a free one on every launch. Always read fresh:
 * a cached port dies the next time the user restarts the app.
 */
function readPort() {
  try {
    const value = parseInt(
      fs.readFileSync(path.join(os.homedir(), '.qiansi', 'server-port'), 'utf8').trim(),
      10
    );
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {
    // no port file: fall through to the dev default
  }
  return 8787;
}

function probe(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

/**
 * The API being healthy is not the same as the canvas being servable: a dev
 * server started from the wrong working directory answers every API call but
 * returns "not found" for the studio itself. The panel used to cement whatever
 * it saw first; now it waits on this check and flips over when the page is real.
 */
function studioReady(base) {
  return new Promise((resolve) => {
    const port = Number(new URL(base).port) || 80;
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

function findFreePort(start) {
  return new Promise((resolve) => {
    const attempt = (port) => {
      if (port > 65535) {
        resolve(start);
        return;
      }
      const server = net.createServer();
      server.once('error', () => attempt(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    attempt(start);
  });
}

/**
 * Boots the server bundled into this extension. Runs inside the extension host,
 * so it lives and dies with VS Code — the desktop app remains the
 * always-on host, this one just removes the "start the app first" step.
 */
function startEmbedded() {
  const serverPath = path.join(__dirname, 'server.cjs');
  if (!fs.existsSync(serverPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    void findFreePort(8787).then((port) => {
      process.env.QIANSI_PORT = String(port);
      const studioDir = path.join(__dirname, 'studio');
      if (fs.existsSync(studioDir)) process.env.QIANSI_STUDIO_DIR = studioDir;
      try {
        require(serverPath);
      } catch (error) {
        console.error('[qiansi] embedded server failed to boot:', error);
        resolve(null);
        return;
      }
      const startedAt = Date.now();
      const attempt = () => {
        void probe(port).then((ok) => {
          if (ok) {
            resolve(`http://127.0.0.1:${port}`);
          } else if (Date.now() - startedAt > 15000) {
            console.error('[qiansi] embedded server did not become healthy in time');
            resolve(null);
          } else {
            setTimeout(attempt, 400);
          }
        });
      };
      attempt();
    });
  });
}

/**
 * Reuse a server that is already running (desktop app, npm run dev:server, or a
 * previous embedded boot); otherwise start our own. The promise is cached so a
 * burst of callers (sidebar + status bar + URI) share one boot.
 */
let resolvedPort = null;

function ensureServer(fresh = false) {
  if (fresh) ensurePromise = null;
  const filePort = readPort();
  // The port file is the source of truth: when it names a different server than
  // the one we cached (standalone app started after our embedded boot, or the
  // other way round), drop the cache instead of talking to a stale instance
  // that may lack newer routes.
  if (ensurePromise && resolvedPort !== null && filePort !== resolvedPort) {
    ensurePromise = null;
  }
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const existing = readPort();
      if (await probe(existing)) {
        resolvedPort = existing;
        return `http://127.0.0.1:${existing}`;
      }
      const started = await startEmbedded();
      resolvedPort = started ? Number(new URL(started).port) : null;
      return started;
    })();
    ensurePromise.catch(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

let renderSeq = 0;

function pageHtml(base) {
  // VS Code only rebuilds a webview when its html actually CHANGES. A static
  // template string means every re-render is a silent no-op and the panel
  // shows whatever it loaded days ago. A unique nonce per render (in the
  // iframe URL and in the markup) forces a genuine reload every time.
  const nonce = `r${Date.now().toString(36)}${++renderSeq}`;
  const csp = [
    "default-src 'none'",
    `frame-src ${base}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { margin: 0; height: 100%; background: #0b1622; overflow: hidden; }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body data-nonce="${nonce}">
<!-- ${nonce} -->
<iframe src="${base}/?${nonce}" title="牵丝画布"></iframe>
</body>
</html>`;
}

function startingHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0b1622;
         color: #93a4bb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  div { text-align: center; line-height: 2; }
  b { color: #e6edf6; }
</style></head>
<body><div><b>正在自动启动牵丝服务…</b><br>首次启动需要几秒钟。</div></body>
</html>`;
}

function failedHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0b1622;
         color: #93a4bb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  div { text-align: center; line-height: 2; padding: 0 24px; }
  b { color: #e6edf6; }
</style></head>
<body><div>
<b>牵丝服务启动失败</b><br>
查看 输出 → 面板里的日志，或重新运行「牵丝：重新连接画布」。
</div></body>
</html>`;
}

function waitingHtml(base) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0b1622;
         color: #93a4bb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  div { text-align: center; line-height: 2; }
  b { color: #e6edf6; }
  code { color: #38d9c2; }
</style></head>
<body><div><b>牵丝服务已连上（${base}）</b><br>画布界面还没就绪，正在自动重试…<br>几秒内会自动进入画布，无需手动刷新。</div></body>
</html>`;
}

let watching = false;

/**
 * Keeps retrying until the canvas page actually renders, then swaps it in.
 * This is what makes the panel self-healing: a server restart, a port change
 * or a half-configured dev server all recover on their own.
 */
function scheduleWatch() {
  if (watching) return;
  watching = true;
  const timer = setInterval(async () => {
    if (!sidebarView && !panel) {
      clearInterval(timer);
      watching = false;
      return;
    }
    ensurePromise = null;
    const base = await ensureServer();
    if (base && (await studioReady(base))) {
      clearInterval(timer);
      watching = false;
      if (sidebarView) sidebarView.webview.html = pageHtml(base);
      if (panel) panel.webview.html = pageHtml(base);
    }
  }, 3000);
}

async function renderSidebar() {
  if (!sidebarView) return;
  sidebarView.webview.html = startingHtml();
  const base = await ensureServer(true);
  if (!base) {
    sidebarView.webview.html = failedHtml();
    scheduleWatch();
    return;
  }
  if (await studioReady(base)) {
    sidebarView.webview.html = pageHtml(base);
  } else {
    sidebarView.webview.html = waitingHtml(base);
    scheduleWatch();
  }
}

async function openPanel() {
  const base = await ensureServer(true);
  if (!base) {
    vscode.window.showErrorMessage(
      '牵丝服务自动启动失败：查看「输出」面板里的 Qiansi 日志。'
    );
    await renderSidebar();
    scheduleWatch();
    return;
  }
  const html = (await studioReady(base)) ? pageHtml(base) : waitingHtml(base);
  if (!html.includes('<iframe')) scheduleWatch();
  if (panel) {
    panel.reveal(undefined, true);
    panel.webview.html = html;
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'qiansiCanvas',
    '牵丝画布',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = html;
  panel.onDidDispose(() => {
    panel = null;
  });
}

async function openBrowser() {
  const base = await ensureServer();
  if (!base) {
    vscode.window.showErrorMessage('牵丝服务自动启动失败：查看「输出」面板。');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(`${base}/`));
}

class SidebarProvider {
  resolveWebviewView(view) {
    sidebarView = view;
    view.webview.options = { enableScripts: true };
    void renderSidebar();
  }
}

/**
 * Agents can bring the canvas up on the user's screen without any extension
 * API: run `start "" "vscode://qiansi.qiansi-canvas/open"` (Windows) or
 * `open "vscode://qiansi.qiansi-canvas/open"` (macOS/Linux).
 */
async function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('qiansi.canvas.open', openPanel),
    vscode.commands.registerCommand('qiansi.canvas.openBrowser', openBrowser),
    vscode.commands.registerCommand('qiansi.canvas.refresh', async () => {
      ensurePromise = null;
      await renderSidebar();
      if (panel) await openPanel();
    }),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === '/open' || uri.path === '/openCanvas') void openPanel();
      },
    }),
    vscode.window.registerWebviewViewProvider(
      'qiansi.canvas.view',
      new SidebarProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  item.text = '$(orbit) 牵丝';
  item.tooltip = '牵丝画布在左侧活动栏；点击在编辑器旁打开画布标签页';
  item.command = 'qiansi.canvas.open';
  item.show();
  context.subscriptions.push(item);

  // Boot the server in the background so the canvas is warm by the time the
  // user clicks anything — no "start the app first" step.
  void ensureServer();
}

function deactivate() {}

module.exports = { activate, deactivate };
