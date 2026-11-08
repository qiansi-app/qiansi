// 预览：每个场景取一帧，检查排版。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'E:\\AgentWeave\\promo2\\preview';

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
  await win.loadFile(path.join('E:\\AgentWeave\\promo2', 'promo.html'));
  await sleep(1200);

  const marks = [2600, 9500, 16500, 24500, 31500, 38500, 46000, 52000];
  for (const [index, t] of marks.entries()) {
    await win.webContents.executeJavaScript('window.seek(' + t + '); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
    await sleep(120);
    fs.writeFileSync(path.join(OUT, `s${index + 1}-${t}.png`), (await win.capturePage()).toPNG());
    console.log('shot', t);
  }
  win.destroy();
  app.quit();
});
