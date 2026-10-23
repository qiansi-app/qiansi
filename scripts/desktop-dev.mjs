import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('Electron is not installed. Run: npm install');
  process.exit(1);
}

const env = {
  ...process.env,
  QIANSI_UI_URL: process.env.QIANSI_UI_URL ?? 'http://localhost:5173',
};

// Claude Code's shell sets ELECTRON_RUN_AS_NODE=1, which makes Electron exit
// silently instead of opening a window. Clear it before spawning the desktop app.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['apps/desktop'], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => process.exit(code ?? 0));
