const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const isDev = !app.isPackaged;
let activePort = Number(process.env.QIANSI_PORT ?? process.env.AGENTWEAVE_PORT ?? 8787);
let serverProcess = null;
let tray = null;
let isQuitting = false;
let mainWindow = null;

const iconPath = path.join(__dirname, 'icon.png');

function baseUrl() {
  return `http://127.0.0.1:${activePort}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : activePort;
      probe.close(() => resolve(port));
    });
  });
}

function startBundledServer() {
  if (isDev) return;
  const serverEntry = path
    .join(__dirname, 'server-dist', 'index.cjs')
    .replace('app.asar', 'app.asar.unpacked');
  const studioDir = path.join(process.resourcesPath, 'studio');
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      QIANSI_STUDIO_DIR: studioDir,
      QIANSI_PORT: String(activePort),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
}

function waitForServer(url, timeoutMs = 25000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.on('error', retry);
      request.setTimeout(1500, () => {
        request.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('牵丝 Qiansi server did not start in time'));
        return;
      }
      setTimeout(attempt, 350);
    };
    attempt();
  });
}

function showWindow() {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0d10',
    title: '牵丝 Qiansi',
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const target = isDev ? process.env.QIANSI_UI_URL ?? 'http://localhost:5173' : baseUrl();
  if (!isDev) await waitForServer(`${baseUrl()}/api/health`);
  await mainWindow.loadURL(target);
}

function createTray() {
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('牵丝 Qiansi');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开牵丝', click: showWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', showWindow);
}

app.setName('Qiansi');

// Chromium storage lives under %APPDATA%\<app name>; carry it over once so the
// rebrand does not reset settings for an existing install.
const appDataDir = app.getPath('appData');
const userDataDir = path.join(appDataDir, 'Qiansi');
const legacyUserDataDir = path.join(appDataDir, 'AgentWeave');
if (!fs.existsSync(userDataDir) && fs.existsSync(legacyUserDataDir)) {
  try {
    fs.renameSync(legacyUserDataDir, userDataDir);
  } catch {
    try {
      fs.cpSync(legacyUserDataDir, userDataDir, { recursive: true });
    } catch {
      // a running old instance can lock the folder; settings fall back to defaults
    }
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(async () => {
    if (!isDev) activePort = await findFreePort();
    startBundledServer();
    createTray();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      else showWindow();
    });
  });
}

ipcMain.handle('autostart:set', (_event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    openAsHidden: false,
  });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);

app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
