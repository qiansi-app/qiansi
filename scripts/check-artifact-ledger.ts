/**
 * 产物归因与账本的自检（临时目录，不碰真实数据）。
 *
 *   npx tsx scripts/check-artifact-ledger.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactLedger, RunFileWatcher } from '../apps/server/src/artifact-ledger.js';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const root = mkdtempSync(join(tmpdir(), 'qiansi-ledger-'));
const stateDir = mkdtempSync(join(tmpdir(), 'qiansi-ledger-state-'));
try {
  mkdirSync(join(root, 'out'), { recursive: true });

  console.log('write_file 归因');
  const watcher = new RunFileWatcher(root);
  watcher.before('t1');
  writeFileSync(join(root, 'out', '报告.pdf'), Buffer.alloc(2048, 1));
  watcher.noteWrite('t1', 'out/报告.pdf');
  const t1 = watcher.after('t1');
  check('抓到 write_file 产物', t1.length === 1 && t1[0].path === 'out/报告.pdf', JSON.stringify(t1));
  check('来源标成 write_file', t1[0]?.source === 'write_file', t1[0]?.source);
  check('类型识别为 pdf', t1[0]?.kind === 'pdf', t1[0]?.kind);

  console.log('命令产物归因');
  watcher.before('t2');
  writeFileSync(join(root, 'out', 'chart.png'), Buffer.alloc(1024, 2));
  const t2 = watcher.after('t2');
  check('快照差异抓到命令产物', t2.some((file) => file.path === 'out/chart.png'), JSON.stringify(t2));
  check('不把上一个任务的文件算进来', !t2.some((file) => file.path === 'out/报告.pdf'), JSON.stringify(t2));
  check('命令产物来源标成 command', t2.find((f) => f.path === 'out/chart.png')?.source === 'command');

  console.log('并行任务不重复认领');
  const parallel = new RunFileWatcher(root);
  parallel.before('a');
  parallel.before('b');
  writeFileSync(join(root, 'out', 'shared.txt'), 'x');
  const first = parallel.after('a');
  const second = parallel.after('b');
  check('先结束的任务认领文件', first.some((file) => file.path === 'out/shared.txt'), JSON.stringify(first));
  check('后结束的任务不重复认领', !second.some((file) => file.path === 'out/shared.txt'), JSON.stringify(second));

  console.log('账本落盘');
  const ledger = new ArtifactLedger(join(stateDir, 'artifacts'));
  ledger.add('run-1', 'main', 't1', 'node-1', t1);
  ledger.add('run-1', 'main', 't2', 'node-2', t2);
  const record = ledger.load('run-1');
  check('同一运行累计两个文件', record?.files.length === 2, String(record?.files.length));
  check('带上任务与节点归属', record?.files.some((file) => file.taskId === 't2' && file.nodeId === 'node-2'));
  const listed = ledger.list();
  check('能按最近运行列出', listed[0]?.runId === 'run-1', JSON.stringify(listed.map((r) => r.runId)));

  ledger.add('run-1', 'main', 't1', 'node-1', t1);
  check('重复登记不会翻倍', ledger.load('run-1')?.files.length === 2, String(ledger.load('run-1')?.files.length));
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nLEDGER OK' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
