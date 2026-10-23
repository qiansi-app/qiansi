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
      <stop offset="0" stop-color="#12202a"/>
      <stop offset="1" stop-color="#0a0d11"/>
    </linearGradient>
    <linearGradient id="teal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#2dd4bf"/>
    </linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7dd3fc"/>
      <stop offset="1" stop-color="#38bdf8"/>
    </linearGradient>
    <linearGradient id="violet" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c4b5fd"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  ${shared}
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M512 292 L262 730" stroke="url(#teal)" stroke-width="74"/>
    <path d="M512 292 L762 730" stroke="url(#sky)" stroke-width="74"/>
    <path d="M262 730 L762 730" stroke="url(#violet)" stroke-width="74"/>
  </g>
  <g fill="#0b0e12" stroke="#f1f5f9" stroke-width="42">
    <circle cx="512" cy="292" r="102"/>
    <circle cx="262" cy="730" r="102"/>
    <circle cx="762" cy="730" r="102"/>
  </g>
  <g fill="#f1f5f9">
    <circle cx="512" cy="292" r="34"/>
    <circle cx="262" cy="730" r="34"/>
    <circle cx="762" cy="730" r="34"/>
  </g>
</svg>`;

// Small sizes drop the outer border and inner dots so the triangle survives
// the downscale instead of turning into a grey blob.
const small = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12202a"/>
      <stop offset="1" stop-color="#0a0d11"/>
    </linearGradient>
  </defs>
  <rect x="36" y="36" width="952" height="952" rx="214" fill="url(#bg)"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M512 300 L270 722" stroke="#2dd4bf" stroke-width="92"/>
    <path d="M512 300 L754 722" stroke="#38bdf8" stroke-width="92"/>
    <path d="M270 722 L754 722" stroke="#8b5cf6" stroke-width="92"/>
  </g>
  <g fill="#0b0e12" stroke="#f1f5f9" stroke-width="46">
    <circle cx="512" cy="300" r="108"/>
    <circle cx="270" cy="722" r="108"/>
    <circle cx="754" cy="722" r="108"/>
  </g>
</svg>`;

const pngs = [];
for (const size of sizes) {
  const svg = size <= 32 ? small : large;
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
