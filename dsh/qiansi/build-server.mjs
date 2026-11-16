#!/usr/bin/env node
/**
 * 把牵丝服务端打成单文件，随 DSH 组合包一起发布。
 *
 *   node dsh/qiansi/build-server.mjs
 *
 * 产物 dsh/qiansi/server/server.cjs 是纯 JS（hono 之类的依赖全部内联，没有原生
 * 模块），~550 KB。插件启动时探不到本机服务就用它把服务拉起来，所以用户装完
 * 插件即可用，不必先开桌面应用。
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outfile = join(here, 'server', 'server.cjs');

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(root, 'apps', 'server', 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
});

const size = statSync(outfile).size;
console.log(`built server/server.cjs (${(size / 1024).toFixed(0)} kB)`);
