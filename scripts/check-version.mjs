import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const versionSource = readFileSync(
  new URL('../apps/server/src/version.ts', import.meta.url),
  'utf8'
);
const declared = versionSource.match(/APP_VERSION = '([^']+)'/)?.[1];

const manifests = [
  'apps/server/package.json',
  'apps/studio/package.json',
  'apps/desktop/package.json',
  'packages/engine/package.json',
  'packages/cli/package.json',
].map((path) => ({
  path,
  version: JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).version,
}));

const mismatched = manifests.filter((item) => item.version !== root.version);
if (!declared || declared !== root.version || mismatched.length) {
  console.error(`package.json: ${root.version}`);
  console.error(`apps/server/src/version.ts: ${declared ?? 'missing'}`);
  for (const item of mismatched) console.error(`${item.path}: ${item.version}`);
  process.exit(1);
}

console.log(`version ${root.version} is consistent across ${manifests.length + 2} files`);
