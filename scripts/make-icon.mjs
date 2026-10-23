import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps', 'desktop');
const sizes = [256, 128, 64, 48, 32, 24, 20, 16];

const shared = `
  <rect x="36" y="36" width="952" height="952" rx="214" fill="url(#bg)" stroke="#243341" stroke-width="10"/>
`;

const large = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#10202b"/>
      <stop offset="0.55" stop-color="#0b1118"/>
      <stop offset="1" stop-color="#080a0f"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.25" cy="0.2" r="0.8">
      <stop offset="0" stop-color="#2dd4bf" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="white" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dbeafe"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
  </defs>
  <rect x="20" y="20" width="984" height="984" rx="232" fill="url(#bg)"/>
  <rect x="20" y="20" width="984" height="984" rx="232" fill="url(#glow)"/>
  <rect x="34" y="34" width="956" height="956" rx="220" fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="5"/>
  <path d="M 512 512 C 430 368 238 368 238 512 C 238 656 430 656 512 512 C 594 368 786 368 786 512 C 786 656 594 656 512 512"
    fill="none" stroke="url(#white)" stroke-width="112" stroke-linecap="round"/>
  <circle cx="512" cy="512" r="58" fill="url(#accent)"/>
</svg>`;

// Small sizes drop the centre node, background glow and border so the white
// infinity survives the downscale instead of collapsing into a grey blob.
const small = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="16" y="16" width="992" height="992" rx="238" fill="#0b1118"/>
  <path d="M 512 512 C 430 368 238 368 238 512 C 238 656 430 656 512 512 C 594 368 786 368 786 512 C 786 656 594 656 512 512"
    fill="none" stroke="#ffffff" stroke-width="150" stroke-linecap="round"/>
</svg>`;

const pngs = [];
for (const size of sizes) {
  const svg = size <= 24 ? small : large;
  const data = await sharp(Buffer.from(svg)).resize(size, size, { fit: 'contain' }).png().toBuffer();
  writeFileSync(join(outDir, `icon-${size}.png`), data);
  pngs.push({ size, data });
}
writeFileSync(join(outDir, 'icon.png'), readFileSync(join(outDir, 'icon-256.png')));
await sharp(Buffer.from(large)).resize(1024, 1024).png().toFile(join(outDir, 'icon-1024.png'));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const entries = Buffer.alloc(16 * pngs.length);
let offset = 6 + entries.length;
pngs.forEach((image, index) => {
  const entry = index * 16;
  const dimension = image.size >= 256 ? 0 : image.size;
  entries.writeUInt8(dimension, entry);
  entries.writeUInt8(dimension, entry + 1);
  entries.writeUInt8(0, entry + 2);
  entries.writeUInt8(0, entry + 3);
  entries.writeUInt16LE(1, entry + 4);
  entries.writeUInt16LE(32, entry + 6);
  entries.writeUInt32LE(image.data.length, entry + 8);
  entries.writeUInt32LE(offset, entry + 12);
  offset += image.data.length;
});
writeFileSync(
  join(outDir, 'icon.ico'),
  Buffer.concat([header, entries, ...pngs.map((image) => image.data)])
);

console.log(`icons: ${sizes.join(', ')} -> apps/desktop/icon.ico`);
