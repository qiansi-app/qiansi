const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
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
  await win.loadFile(path.join(__dirname, 'promo.html'));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const times = [2, 6, 12, 18, 24, 29];
  for (const time of times) {
    await win.webContents.executeJavaScript(`window.renderFrame(${time}); true`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const image = await win.webContents.capturePage();
    const out = path.join(__dirname, 'snapshots', `t${time}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    console.log('saved', out);
  }
  app.quit();
});
