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
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
    },
  });

  win.setContentSize(1920, 1080);
  await win.loadFile(path.join(__dirname, 'promo.html'));
  await new Promise((resolve) => setTimeout(resolve, 1800));

  const fps = 30;
  const duration = 30;
  const limit = Number(process.env.LIMIT || fps * duration);
  const dir = path.join(__dirname, 'frames');
  fs.mkdirSync(dir, { recursive: true });

  for (let index = 0; index < limit; index += 1) {
    const t = index / fps;
    await win.webContents.executeJavaScript(`window.renderFrame(${t}); true`);
    await new Promise((resolve) => setTimeout(resolve, 12));
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    fs.writeFileSync(path.join(dir, `f${String(index).padStart(4, '0')}.png`), png);
    if (index % 60 === 0) console.log(`frame ${index} (${png.length} bytes)`);
  }

  console.log(`captured ${limit} frames`);
  app.quit();
});
