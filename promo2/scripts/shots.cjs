// 宣传片素材：1920×1080 画布全景 + 密钥与额度面板。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'E:\\AgentWeave\\promo2\\shots';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    useContentSize: true,
    frame: false,
    backgroundColor: '#0b1622',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.setContentSize(1920, 1080);
  await win.loadURL('http://127.0.0.1:8921/');
  await sleep(10000);

  fs.writeFileSync(path.join(OUT, 'canvas-1920.png'), (await win.capturePage()).toPNG());
  console.log('saved canvas-1920.png');

  // 打开「更多 → 密钥与额度」
  await win.webContents.executeJavaScript(`
    (() => {
      const more = [...document.querySelectorAll('button')].find((b) => (b.title || '') === '更多功能');
      more?.click();
      return Boolean(more);
    })()
  `);
  await sleep(500);
  await win.webContents.executeJavaScript(`
    (() => {
      const item = [...document.querySelectorAll('.toolbar-menu-item')].find((b) => /密钥与额度/.test(b.innerText));
      item?.click();
      return Boolean(item);
    })()
  `);
  await sleep(2500);
  fs.writeFileSync(path.join(OUT, 'keys-1920.png'), (await win.capturePage()).toPNG());
  console.log('saved keys-1920.png');

  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const modal = document.querySelector('.keys-modal');
      return modal ? [...modal.querySelectorAll('.keys-slot')].length : -1;
    })()
  `);
  console.log('keys slots visible:', probe);
  win.destroy();
  app.quit();
});
