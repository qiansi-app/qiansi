// 渲染宣传片：按时间轴逐帧截取，直接管道给 ffmpeg 编码（不落盘中间帧）。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FFMPEG =
  'C:/Users/lenovo/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const FPS = 30;
const DURATION_MS = 54000;
const OUT = 'E:\\AgentWeave\\promo2\\qiansi-promo.mp4';
const PAGE = path.join('E:\\AgentWeave\\promo2', 'promo.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await win.loadFile(PAGE);
  await sleep(1200);

  const ffmpeg = spawn(FFMPEG, [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(FPS),
    '-vcodec', 'mjpeg',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    OUT,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const total = Math.round((DURATION_MS / 1000) * FPS);
  const started = Date.now();
  for (let index = 0; index < total; index += 1) {
    const t = Math.round((index * 1000) / FPS);
    await win.webContents.executeJavaScript('window.seek(' + t + '); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
    const image = await win.webContents.capturePage();
    const jpeg = image.toJPEG(92);
    if (!ffmpeg.stdin.write(jpeg)) {
      await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
    }
    if (index % 150 === 0) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`frame ${index}/${total} · ${elapsed}s`);
    }
  }
  ffmpeg.stdin.end();
  await new Promise((resolve) => ffmpeg.on('close', resolve));
  console.log('ENCODED', OUT, fs.existsSync(OUT) ? `${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)}MB` : 'missing');
  win.destroy();
  app.quit();
});
