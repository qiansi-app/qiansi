import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronDist = join(root, 'node_modules', 'electron', 'dist');
const output = join(root, 'release', 'Qiansi-portable');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

if (!existsSync(electronDist)) {
  console.error('Electron dist not found. Run: node node_modules/electron/install.js');
  process.exit(1);
}

rmSync(output, { recursive: true, force: true });
cpSync(electronDist, output, { recursive: true });

const exePath = join(output, 'Qiansi.exe');
const electronExe = join(output, 'electron.exe');
if (existsSync(electronExe)) renameSync(electronExe, exePath);

// Remove Electron's default app; our app lives in resources/app (unpacked, so
// no asar tooling or app-builder is required).
rmSync(join(output, 'resources', 'default_app.asar'), { force: true });
rmSync(join(output, 'resources', 'app.asar'), { force: true });

const appDir = join(output, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
for (const file of ['main.cjs', 'preload.cjs', 'icon.png']) {
  cpSync(join(root, 'apps', 'desktop', file), join(appDir, file));
}
cpSync(join(root, 'apps', 'desktop', 'server-dist'), join(appDir, 'server-dist'), {
  recursive: true,
});

writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'qiansi-desktop',
      version,
      description: '牵丝 Qiansi desktop',
      main: 'main.cjs',
    },
    null,
    2
  ),
  'utf8'
);

cpSync(join(root, 'apps', 'studio', 'dist'), join(output, 'resources', 'studio'), {
  recursive: true,
});

// The copied Electron binary still identifies as Electron. Stamp product
// metadata and the app icon so the exe properties and Explorer look right.
if (existsSync(exePath)) {
  try {
    stampWindowsResources(exePath, version);
  } catch (error) {
    console.warn(`Could not stamp Windows resources: ${error.message}`);
  }
}

console.log(`Portable desktop app: ${output}`);
console.log(`Run: ${exePath}`);

function stampWindowsResources(target, appVersion) {
  const executable = ResEdit.NtExecutable.from(readFileSync(target));
  const resources = ResEdit.NtExecutableResource.from(executable);
  const info = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  if (!info) throw new Error('no version resource in the Electron binary');
  const lang = info.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };

  info.setFileVersion(`${appVersion}.0`, lang.lang);
  info.setProductVersion(`${appVersion}.0`, lang.lang);
  info.setStringValues(lang, {
    ProductName: 'Qiansi',
    FileDescription: '牵丝 Qiansi',
    CompanyName: 'Qiansi contributors',
    LegalCopyright: 'Copyright (c) 2026 Qiansi contributors',
    OriginalFilename: 'Qiansi.exe',
    InternalName: 'Qiansi',
    FileVersion: `${appVersion}.0`,
    ProductVersion: `${appVersion}.0`,
  });
  info.outputToResourceEntries(resources.entries);

  const ico = ResEdit.Data.IconFile.from(readFileSync(join(root, 'apps', 'desktop', 'icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    1,
    lang.lang,
    ico.icons.map((icon) => icon.data)
  );

  resources.outputResource(executable);
  writeFileSync(target, Buffer.from(executable.generate()));
}
