/**
 * Bundles the Qiansi server and the built studio UI into the VS Code extension,
 * so the extension can boot the whole stack itself instead of requiring the
 * desktop app to be running. Mirrors `desktop:bundle`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
// scripts/ → qiansi-canvas/ → vscode/ → apps/ → repo root: three levels up.
const root = path.resolve(extDir, '..', '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');

await build({
  entryPoints: [path.join(root, 'apps', 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(extDir, 'server.cjs'),
  external: ['electron'],
  target: 'node18',
  logLevel: 'info',
});

fs.rmSync(path.join(extDir, 'studio'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'apps', 'studio', 'dist'), path.join(extDir, 'studio'), {
  recursive: true,
});

console.log('extension assets ready: server.cjs + studio/');
