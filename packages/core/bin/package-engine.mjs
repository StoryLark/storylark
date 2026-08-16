#!/usr/bin/env node
// package-engine — turn a brand-free build into one downloadable release
// artifact (AB#7418 — plan §0d Phase 5).
//
// This is the CI half of Phase 5. It takes:
//
//   app/dist/                     built with `--mode engine` (no brand files)
//   .engine-worker/index.js       `wrangler deploy --dry-run --outdir`
//   packages/worker/migrations*/  the SQL that belongs to this engine
//
// and writes:
//
//   dist-engine/storylark-engine-<coreVersion>.zip
//   dist-engine/storylark-engine-<coreVersion>.zip.sha256
//
// which .github/workflows/release.yml attaches to the GitHub Release that
// changesets already cuts for `storylark-core@<version>`. Nothing here invents
// a second release mechanism; it adds two files to the one that exists.
//
// ── It refuses to package a branded build ───────────────────────────────────
// The check is not advisory. `storylark-contracts/engine-package` rejects a
// `dist/` containing brand.json, presentation.json, theme.css,
// manifest.webmanifest or icons/, so the artifact physically cannot contain
// one customer's identity — which, shipped to every other customer, would be
// the worst thing this feature could do. On top of that this script scans every
// output byte for the identity and free-text strings of every brand in the repo
// (`--verify-brands`, on by default when brands/ exists) and fails on a hit.
//
// Usage:
//   node packages/core/bin/package-engine.mjs
//   node packages/core/bin/package-engine.mjs --dist app/dist --out dist-engine
//   node packages/core/bin/package-engine.mjs --check        validate, write nothing
//   node packages/core/bin/package-engine.mjs --no-verify-brands

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnginePackage, engineAssetName, engineChecksumName, sha256Hex, EnginePackageError } from 'storylark-contracts/engine-package';

const ROOT = process.cwd();
const CORE_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

const args = parseArgs(process.argv.slice(2));
const distDir = resolve(ROOT, typeof args.dist === 'string' ? args.dist : 'app/dist');
const workerFile = resolve(ROOT, typeof args.worker === 'string' ? args.worker : '.engine-worker/index.js');
const migrationsDir = resolve(ROOT, typeof args.migrations === 'string' ? args.migrations : 'packages/worker/migrations');
const migrationsPgDir = `${migrationsDir}-postgres`;
const outDir = resolve(ROOT, typeof args.out === 'string' ? args.out : 'dist-engine');
const checkOnly = Boolean(args.check);
const verifyBrands = args['verify-brands'] !== false && existsSync(join(ROOT, 'brands'));

if (!existsSync(distDir)) {
  console.error(`✗ ${relative(ROOT, distDir)} does not exist. Build the engine first:\n\n    npm run build -w app -- --mode engine\n`);
  process.exit(1);
}

const coreVersion = JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8')).version;
const workerVersion = readWorkerVersion();

const dist = readTree(distDir);
// dist/outputs.json is this build's own inventory. It stays IN the package (the
// updater uses it to know which paths the engine owns) but the sha256 it would
// state for itself is unknowable, which is why it never lists itself.
console.log(`Engine build: ${dist.size} files from ${relative(ROOT, distDir) || distDir}`);

const worker = existsSync(workerFile) ? new Uint8Array(readFileSync(workerFile)) : undefined;
if (!worker) {
  console.warn(
    `! No ${relative(ROOT, workerFile)} — packaging without the Cloudflare Worker bundle.\n` +
      '  A Cloudflare deployment cannot take a one-click update from this artifact. Produce it with:\n' +
      '    npx wrangler deploy --env <brand> --dry-run --outdir=.engine-worker\n'
  );
}

if (verifyBrands) {
  const leaks = brandLeaks(distDir);
  if (leaks.length) {
    console.error(`\n✗ The build carries brand data — it is not an engine build.\n`);
    for (const leak of leaks.slice(0, 20)) console.error(`  ${leak}`);
    if (leaks.length > 20) console.error(`  … and ${leaks.length - 20} more`);
    console.error('\nBuild with `--mode engine`.\n');
    process.exit(1);
  }
  console.log('✓ No brand data in the build (checked every output byte against every brand in this repo)');
}

let built;
try {
  built = await buildEnginePackage({
    dist,
    worker,
    migrations: readTree(migrationsDir),
    migrationsPostgres: readTree(migrationsPgDir),
    coreVersion,
    workerVersion,
    commit: process.env.GITHUB_SHA ?? undefined,
    builtAt: process.env.STORYLARK_BUILD_TIME ?? undefined,
  });
} catch (err) {
  if (err instanceof EnginePackageError) {
    console.error('\n✗ Refusing to package:\n');
    for (const e of err.errors) console.error(`  ${e}`);
    console.error('');
    process.exit(1);
  }
  throw err;
}

const name = engineAssetName(coreVersion);
const digest = await sha256Hex(built.bytes);

console.log(`\n  ${name}`);
console.log(`  engine    storylark-core ${coreVersion}, storylark-worker ${workerVersion}`);
console.log(`  files     ${Object.keys(built.manifest.files).length}`);
console.log(`  size      ${(built.bytes.byteLength / 1024).toFixed(0)}KB`);
console.log(`  sha256    ${digest}`);

if (checkOnly) {
  console.log('\n--check: nothing written.\n');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, name), built.bytes);
// `sha256sum` format, so `sha256sum -c` verifies it without a bespoke tool.
writeFileSync(join(outDir, engineChecksumName(coreVersion)), `${digest}  ${name}\n`);
console.log(`\n✓ ${relative(ROOT, join(outDir, name))}`);
console.log(`✓ ${relative(ROOT, join(outDir, engineChecksumName(coreVersion)))}\n`);

// ── helpers ─────────────────────────────────────────────────────────────────

/** Every file under `dir`, keyed by its path relative to it, forward slashes. */
function readTree(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(dir, full).split(sep).join('/'), new Uint8Array(readFileSync(full)));
    }
  };
  walk(dir);
  return new Map([...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * The storylark-worker version this engine belongs with.
 *
 * Read from the monorepo's own packages/worker first (that is the version this
 * release is cutting), falling back to whatever is installed. It is recorded so
 * a deployment can tell whether the artifact it is about to install is actually
 * newer than what it is running.
 */
function readWorkerVersion() {
  for (const candidate of [join(ROOT, 'packages/worker/package.json'), join(ROOT, 'node_modules/storylark-worker/package.json')]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')).version;
  }
  return '0.0.0';
}

/**
 * Every occurrence, in any output byte, of a string that only a brand file
 * could have contributed.
 *
 * The filter is what makes this precise rather than noisy: a string found in
 * a brand file is discarded as a needle if it ALSO occurs in storylark-core's
 * own source, because then it is engine vocabulary — a default noun, a section
 * key, a curated font family, the product's own name — and finding it in a
 * build proves nothing. What survives can only be there because a brand put it
 * there.
 */
function brandLeaks(dir) {
  const coreText = ['src', 'vite', 'schemas']
    .map((d) => join(CORE_DIR, d))
    .flatMap(allFiles)
    .concat(existsSync(join(ROOT, 'app/index.html')) ? [join(ROOT, 'app/index.html')] : [])
    .map((f) => readFileSync(f, 'latin1'))
    .join('\n');

  const needles = new Map();
  const collect = (file, source) => {
    if (!existsSync(file)) return;
    const push = (v) => {
      if (typeof v === 'string') {
        if (v.length > 4 && !coreText.includes(v)) needles.set(v, source);
      } else if (Array.isArray(v)) v.forEach(push);
      else if (v && typeof v === 'object') Object.values(v).forEach(push);
    };
    push(JSON.parse(readFileSync(file, 'utf8')));
  };
  for (const id of readdirSync(join(ROOT, 'brands'))) {
    collect(join(ROOT, 'brands', id, 'brand.json'), `brands/${id}/brand.json`);
    collect(join(ROOT, 'presentation', id, 'presentation.json'), `presentation/${id}/presentation.json`);
  }

  const leaks = [];
  for (const file of allFiles(dir)) {
    const body = readFileSync(file, 'latin1');
    for (const [needle, source] of needles) {
      if (body.includes(needle)) {
        leaks.push(`${relative(dir, file).split(sep).join('/')}  <- ${JSON.stringify(needle)} (${source})`);
      }
    }
  }
  return leaks;
}

function allFiles(p) {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [p];
  return readdirSync(p, { withFileTypes: true }).flatMap((e) => allFiles(join(p, e.name)));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key.startsWith('no-')) {
      out[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}
