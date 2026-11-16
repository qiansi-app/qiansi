/**
 * 产物账本纯函数的自检（不需要起服务、不碰用户数据）。
 *
 *   npx tsx scripts/check-artifacts.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyArtifact,
  diffSnapshots,
  displayPath,
  formatBytes,
  mergeCandidates,
  scanDirectory,
} from '../apps/server/src/artifacts.js';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

console.log('classify');
check('pdf', classifyArtifact('a/b/报告.PDF') === 'pdf', classifyArtifact('报告.PDF'));
check('image', classifyArtifact('shot.png') === 'image');
check('data', classifyArtifact('out.xlsx') === 'data');
check('code', classifyArtifact('src/index.ts') === 'code');
check('unknown', classifyArtifact('blob.bin') === 'other');

console.log('formatBytes');
check('bytes', formatBytes(512) === '512 B', formatBytes(512));
check('kb', formatBytes(2048) === '2.0 KB', formatBytes(2048));
check('mb', formatBytes(5 * 1024 * 1024) === '5.0 MB', formatBytes(5 * 1024 * 1024));

const root = mkdtempSync(join(tmpdir(), 'qiansi-artifacts-'));
try {
  mkdirSync(join(root, 'out'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(root, 'out', '报告.pdf'), Buffer.alloc(2048, 1));
  writeFileSync(join(root, 'out', 'notes.md'), '# hi');
  writeFileSync(join(root, 'node_modules', 'junk', 'skip.js'), 'no');

  const snapshot = scanDirectory(root);
  const paths = [...snapshot.keys()].map((p) => displayPath(root, p));
  check('扫到产物', paths.includes('out/报告.pdf') && paths.includes('out/notes.md'), paths.join(','));
  check('跳过 node_modules', paths.every((p) => !p.includes('node_modules')), paths.join(','));

  // 改一个文件、加一个文件、删一个文件，看 diff 是否只报「新增/变了」
  writeFileSync(join(root, 'out', '报告.pdf'), Buffer.alloc(4096, 1));
  writeFileSync(join(root, 'out', 'chart.png'), Buffer.alloc(1024, 2));
  writeFileSync(join(root, 'out', 'empty.txt'), '');
  rmSync(join(root, 'out', 'notes.md'));
  const after = scanDirectory(root);
  const changed = diffSnapshots(snapshot, after, 'command');
  const changedPaths = changed.map((c) => displayPath(root, c.absolutePath)).sort();
  check(
    'diff 只报新增与改动',
    changedPaths.join(',') === 'out/chart.png,out/报告.pdf',
    changedPaths.join(',')
  );
  check('diff 忽略空文件', !changed.some((c) => c.absolutePath.endsWith('empty.txt')));
  check('diff 带上来源与类型', changed.every((c) => c.source === 'command' && c.kind !== 'other'));

  const future = Date.now() + 60_000;
  utimesSync(join(root, 'out', 'chart.png'), future / 1000, future / 1000);
  const since = scanDirectory(root, { sinceMs: Date.now() + 30_000 });
  check('sinceMs 只留新近改动', [...since.keys()].some((p) => p.endsWith('chart.png')) && since.size === 1, String(since.size));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('merge');
const merged = mergeCandidates([
  { absolutePath: 'D:/a.pdf', bytes: 10, mtime: 1, kind: 'pdf', source: 'scan' },
  { absolutePath: 'D:/a.pdf', bytes: 12, mtime: 2, kind: 'pdf', source: 'write_file' },
  { absolutePath: 'D:/b.png', bytes: 5, mtime: 3, kind: 'image', source: 'command' },
]);
check('同路径合并为一条', merged.length === 2, String(merged.length));
check('来源取更具体的', merged.find((m) => m.absolutePath.endsWith('a.pdf'))?.source === 'write_file');
check('大小取更大者', merged.find((m) => m.absolutePath.endsWith('a.pdf'))?.bytes === 12);

console.log('displayPath');
check('rootDir 内转相对', displayPath('D:/work', 'D:/work/out/a.pdf') === 'out/a.pdf', displayPath('D:/work', 'D:/work/out/a.pdf'));
check('rootDir 外保留绝对', displayPath('D:/work', 'D:/other/a.pdf') === 'D:/other/a.pdf');

console.log(failed === 0 ? '\nARTIFACTS OK' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
