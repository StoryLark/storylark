// Renders neutral placeholder PWA icons for a brand: a simple ring mark in the
// brand's colours, at all three sizes (192, 512, maskable-512).
//   node packages/pipeline/gen-icons.mjs --brand storylark
// A brand with its own artwork drops its finished PNGs into
// brands/<id>/assets/icons/ and skips this generator.

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const brand = process.argv.includes('--brand') ? process.argv[process.argv.indexOf('--brand') + 1] : 'storylark';

// A nearly-closed ring: a circle with a deliberate gap at the top.
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
  storylark: { bg: '#FFFFFF', fg: '#4F46E5' },
};
const { bg, fg } = PALETTES[brand] ?? PALETTES.storylark;

const outDir = join(ROOT, 'brands', brand, 'assets', 'icons');
await mkdir(outDir, { recursive: true });

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
