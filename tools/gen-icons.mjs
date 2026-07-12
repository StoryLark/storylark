// Renders PWA icons for a brand.
//   node tools/gen-icons.mjs --brand holdfast   → Broken Binding ring (bone stroke on stone-deep), all sizes
//   node tools/gen-icons.mjs --brand gunner     → keeps the site-repo paw artwork for icon-192/icon-512,
//                                                 regenerates icon-maskable-512 from icon-512 (content scaled
//                                                 to the 80% safe zone on a padded canvas so circular masks
//                                                 don't crop the paw)

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = process.argv.includes('--brand') ? process.argv[process.argv.indexOf('--brand') + 1] : 'holdfast';

// Broken Binding ring: a nearly-closed circle with a deliberate gap at the top.
const ringSvg = (size, pad, stroke, bg, fg) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="${bg}" rx="${pad ? 18 : 0}"/>
  <g transform="translate(0, 2)">
    <path d="M 53.49 10.15 A 40 40 0 1 1 46.51 10.15"
          transform="translate(50 48) scale(${pad ? 0.62 : 0.78}) translate(-50 -50)"
          fill="none" stroke="${fg}" stroke-width="${stroke}" stroke-linecap="round"/>
  </g>
</svg>`;

const PALETTES = {
  holdfast: { bg: '#1A1D24', fg: '#EDE6D6' },
  gunner: { bg: '#FDF6EC', fg: '#3B2412' },
};
const { bg, fg } = PALETTES[brand] ?? PALETTES.holdfast;

const outDir = join(ROOT, 'brands', brand, 'assets', 'icons');
await mkdir(outDir, { recursive: true });

// Gunner's launcher icons are the site-repo paw artwork, not the ring. Only the
// maskable needs generating: scale the 512 artwork into the 80% safe zone and pad
// with the artwork's own paper-white background (the paw art sits on ~#FEFEFE, so
// padding with the brand cream #FDF6EC would leave a visible white inner square).
if (brand === 'gunner') {
  const SIZE = 512;
  const SAFE = Math.round(SIZE * 0.8); // 410 — inside the maskable safe zone
  const pad = Math.round((SIZE - SAFE) / 2);
  const paperWhite = { r: 254, g: 254, b: 254, alpha: 1 };
  const inner = await sharp(join(outDir, 'icon-512.png'))
    .flatten({ background: paperWhite })
    .resize(SAFE, SAFE)
    .toBuffer();
  await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: paperWhite } })
    .composite([{ input: inner, left: pad, top: pad }])
    .png()
    .toFile(join(outDir, 'icon-maskable-512.png'));
  console.log(`${brand}/icon-maskable-512.png (regenerated from icon-512.png, 80% safe zone)`);
  process.exit(0);
}

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const t of targets) {
  // Maskable icons keep content inside the 80% safe zone (pad = true).
  const svg = ringSvg(t.size, t.maskable, t.maskable ? 7 : 6, bg, fg);
  await sharp(Buffer.from(svg)).resize(t.size, t.size).png().toFile(join(outDir, t.file));
  console.log(`${brand}/${t.file}`);
}
