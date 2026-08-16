// Builds deliberately-invalid theme packages, for exercising the import
// endpoint's rejection path by hand (AB#7417).
//
// It goes through storylark-contracts/zip directly rather than through
// buildThemePackage(), because buildThemePackage validates — which is the point
// of it — so it is structurally incapable of producing these. That asymmetry is
// the feature: the only way to get a bad package onto a deployment is to
// hand-make one, and this is what hand-making one looks like.
//
//   node packages/worker/test/make-broken-packages.mjs [outDir]

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { zip } from 'storylark-contracts/zip';

const out = process.argv[2] ?? 'dist-themes/broken';
mkdirSync(out, { recursive: true });

const brand = JSON.parse(readFileSync('brands/wireless/brand.json', 'utf8'));
const css = readFileSync('brands/wireless/theme.css', 'utf8');
const icons = new Map();
for (const name of readdirSync('brands/wireless/assets/icons')) {
  icons.set(name, new Uint8Array(readFileSync(join('brands/wireless/assets/icons', name))));
}

const cases = {
  // 1. A file written for an engine that does not exist yet. The one hard gate.
  'bad-contract-version': {
    brand: { ...brand, contractVersion: 99 },
    css,
    icons,
  },
  // 2. Missing the Android adaptive icon — the failure nobody notices until it
  //    is on somebody else's phone.
  'missing-icon': {
    brand,
    css,
    icons: new Map([...icons].filter(([n]) => n !== 'icon-maskable-512.png')),
  },
  // 3. A stylesheet that parses as CSS and is still broken: half the tokens
  //    gone and no alternate colour scheme, so the theme toggle would silently
  //    do nothing.
  'malformed-theme-css': {
    brand,
    css: ':root {\n  --bg: #191310;\n  --text: #EFE4D2;\n}\n',
    icons,
  },
};

for (const [name, parts] of Object.entries(cases)) {
  const entries = [
    { name: 'package.json', data: JSON.stringify({ formatVersion: 1, id: parts.brand.id, name: 'Broken', version: '1.0.0' }, null, 2) },
    { name: 'brand.json', data: JSON.stringify(parts.brand, null, 2) },
    { name: 'theme.css', data: parts.css },
  ];
  for (const [icon, data] of parts.icons) entries.push({ name: `icons/${icon}`, data, store: true });
  const bytes = await zip(entries);
  const file = join(out, `${name}.storylark-theme.zip`);
  writeFileSync(file, bytes);
  console.log(`${file}  ${(bytes.length / 1024).toFixed(1)}KB`);
}
