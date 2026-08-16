// package-theme — validate a brand folder, then emit a theme package
// (AB#7417 — plan §0c / §0d Phase 4).
//
// Takes what Phase 0 split apart:
//
//   brands/<id>/brand.json          identity + look
//   brands/<id>/theme.css           design tokens
//   brands/<id>/assets/icons/       the app icons
//   presentation/<id>/presentation.json   optional — the §0b arrangement
//
// and produces one file that can be moved, versioned, published to the gallery,
// and installed on any deployment through the portal or the CLI:
//
//   themes/<id>.storylark-theme.zip
//
// ── The value is the validation, not the zip (plan §0c) ─────────────────────
// This refuses to emit a package that the deployment's import endpoint would
// refuse to accept, and it uses literally the same code to decide
// (`storylark-contracts/theme-package`) — so "it packaged fine but the upload
// failed" is not a state that can exist. Schema validation runs in STRICT mode,
// so an unknown key in brand.json is an error here even though a running site
// would only warn about it: a typo should be caught by the person making the
// theme, not by the person installing it.
//
// Usage:
//   npm run package-theme -- <brandId>              one brand
//   npm run package-theme -- --all                  every brand under brands/
//   npm run package-theme -- <id> --version 1.2.0   stamp a package version
//   npm run package-theme -- <id> --out dist-themes
//   npm run package-theme -- <id> --check           validate only, write nothing
//
// Output is byte-for-byte reproducible — no clock is read unless you pass
// `--dated` — so re-running it on an unchanged brand produces an unchanged
// file, and a committed default package does not churn.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildThemePackage, THEME_PACKAGE_EXT, ThemePackageError } from 'storylark-contracts/theme-package';
import { CURATED_FONTS } from '../vite/fonts.mjs';

// Site-agnostic: runs from the site repo root (cwd), which owns brands/ — the
// same convention migrate-brand established, and for the same reason. It ships
// inside storylark-core because the engine defines the format.
const ROOT = process.cwd();
const BRANDS_DIR = join(ROOT, 'brands');
const PRESENTATION_DIR = join(ROOT, 'presentation');

const args = parseArgs(process.argv.slice(2));
const outDir = typeof args.out === 'string' ? resolve(ROOT, args.out) : join(ROOT, 'themes');
const checkOnly = Boolean(args.check);
const dated = Boolean(args.dated);
const version = typeof args.version === 'string' ? args.version : '1.0.0';

const ids = args.all
  ? existsSync(BRANDS_DIR)
    ? readdirSync(BRANDS_DIR).filter((n) => statSync(join(BRANDS_DIR, n)).isDirectory())
    : []
  : args._;

if (!ids.length) {
  console.error(
    'package-theme — validate a brand folder and emit a theme package.\n\n' +
      '  npm run package-theme -- <brandId>          one brand\n' +
      '  npm run package-theme -- --all              every brand under brands/\n\n' +
      'Options: --version <v>  --out <dir>  --check (validate only)  --dated (stamp the clock)\n'
  );
  process.exit(1);
}

const engine = readJson(fileURLToPath(new URL('../package.json', import.meta.url)))?.version;
const fontFamilies = CURATED_FONTS.map((f) => f.name);

let built = 0;
let failed = 0;

for (const id of ids) {
  const brandDir = join(BRANDS_DIR, id);
  if (!existsSync(brandDir)) {
    console.error(`✗ ${id}  no such brand folder: ${rel(brandDir)}`);
    failed++;
    continue;
  }
  console.log(`\n${id}`);

  const brandFile = join(brandDir, 'brand.json');
  const cssFile = join(brandDir, 'theme.css');
  const presentationFile = join(PRESENTATION_DIR, id, 'presentation.json');
  const iconsDir = join(brandDir, 'assets', 'icons');

  if (!existsSync(brandFile) || !existsSync(cssFile)) {
    console.error(`  ✗ ${rel(!existsSync(brandFile) ? brandFile : cssFile)} is missing.`);
    failed++;
    continue;
  }

  const brand = readJson(brandFile);
  if (!brand) {
    console.error(`  ✗ ${rel(brandFile)} is not valid JSON.`);
    failed++;
    continue;
  }
  const presentation = existsSync(presentationFile) ? readJson(presentationFile) : undefined;
  if (existsSync(presentationFile) && !presentation) {
    console.error(`  ✗ ${rel(presentationFile)} is not valid JSON.`);
    failed++;
    continue;
  }
  const themeCss = readFileSync(cssFile, 'utf8');

  const icons = new Map();
  if (existsSync(iconsDir)) {
    for (const name of readdirSync(iconsDir)) {
      const file = join(iconsDir, name);
      if (statSync(file).isFile()) icons.set(name, new Uint8Array(readFileSync(file)));
    }
  }

  console.log(
    `  ${rel(brandFile)}, ${rel(cssFile)}, ${icons.size} icon(s)${presentation ? `, ${rel(presentationFile)}` : ' (no presentation — the deployment keeps its own)'}`
  );

  let result;
  try {
    result = await buildThemePackage({
      brand,
      presentation,
      themeCss,
      icons,
      version,
      engine,
      fontFamilies,
      createdAt: dated ? new Date() : undefined,
    });
  } catch (err) {
    if (err instanceof ThemePackageError) {
      for (const w of err.warnings) console.log(`  warning  ${w}`);
      console.error(`  ✗ not packaged — ${err.errors.length} problem(s):`);
      for (const e of err.errors) console.error(`      ${e}`);
      failed++;
      continue;
    }
    throw err;
  }

  for (const w of result.warnings) console.log(`  warning  ${w}`);

  if (checkOnly) {
    console.log(`  ✓ valid (nothing written — --check)`);
    built++;
    continue;
  }

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${id}${THEME_PACKAGE_EXT}`);
  writeFileSync(outFile, result.bytes);
  console.log(`  ✓ ${rel(outFile)}  ${(result.bytes.length / 1024).toFixed(1)}KB  v${result.manifest.version}`);
  built++;
}

console.log(
  `\n${built} package(s) ${checkOnly ? 'validated' : 'written'}${failed ? `, ${failed} failed` : ''}.` +
    (built && !checkOnly
      ? `\nInstall one with:  npm run import-theme -- --url <site> --key <ADMIN_KEY> ${rel(join(outDir, `${ids[0]}${THEME_PACKAGE_EXT}`))}\n` +
        `             or:  the Brand & Themes card in /admin`
      : '')
);
process.exit(failed ? 1 : 0);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function rel(p) {
  const r = relative(ROOT, p);
  return r.startsWith('..') ? p : r.replace(/\\/g, '/');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
