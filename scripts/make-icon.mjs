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
      <stop offset="0" stop-color="#8db8f5"/>
      <stop offset="0.55" stop-color="#b7a6f2"/>
      <stop offset="1" stop-color="#f3b78e"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="992" height="992" rx="232" fill="url(#bg)"/>
  <g fill="#101116">
    <rect x="446" y="230" width="132" height="132" rx="34"/>
    <rect x="264" y="628" width="132" height="132" rx="34"/>
    <rect x="628" y="628" width="132" height="132" rx="34"/>
  </g>
  <g fill="none" stroke="#101116" stroke-width="42" stroke-linecap="round">
    <path d="M512 362 L512 528"/>
    <path d="M330 528 L694 528"/>
    <path d="M330 528 L330 628"/>
    <path d="M694 528 L694 628"/>
  </g>
</svg>`;

const small = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8db8f5"/>
      <stop offset="0.55" stop-color="#b7a6f2"/>
      <stop offset="1" stop-color="#f3b78e"/>
    </linearGradient>
  </defs>
  <rect x="12" y="12" width="1000" height="1000" rx="238" fill="url(#bg)"/>
  <g fill="#101116">
    <rect x="432" y="208" width="160" height="160" rx="40"/>
    <rect x="232" y="616" width="160" height="160" rx="40"/>
    <rect x="632" y="616" width="160" height="160" rx="40"/>
  </g>
  <g fill="none" stroke="#101116" stroke-width="56" stroke-linecap="round">
    <path d="M512 368 L512 520"/>
    <path d="M312 520 L712 520"/>
    <path d="M312 520 L312 616"/>
    <path d="M712 520 L712 616"/>
  </g>
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
