#!/usr/bin/env node
// npm create storylark (AB#7402). Two experiences, one machine underneath:
//
//   npm create storylark my-site           "copy" experience — you land in
//                                           the folder and choose manually
//                                           or run `npm run setup` yourself
//
//   npm create storylark my-site -- --deploy   "one-experience installer" —
//                                           chains straight into the wizard
//                                           with no visible seam
//
// Copies template/ into the target folder (filling __BRAND_ID__/__APP_NAME__/
// __ENGINE_VERSION__), scaffolds brands/<id>/ from the engine's base brand,
// and copies platforms/ (the wizard + both platform installers) in.
import { createInterface } from 'node:readline/promises';
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
// This package lives at create-storylark/ inside the engine monorepo when
// run from a checkout (for scaffolding during development/testing); once
// published, ENGINE_ROOT resolution below falls back to fetching the
// published brands/theme instead.
const ENGINE_ROOT = join(PKG_ROOT, '..');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'create-storylark' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// storylark-core and storylark-worker are independently versioned (a release
// only bumps the packages a changeset actually touches — confirmed live: at
// the time this was written, core was 0.5.0 but worker was still 0.4.0), so
// each needs its own registry lookup rather than assuming lockstep versions.
async function latestVersion(pkg, fallback) {
  try {
    const info = await fetchJson(`https://registry.npmjs.org/${pkg}/latest`);
    return info.version;
  } catch {
    return fallback;
  }
}

function copyTemplate(targetDir, brandId, appName, coreVersion, workerVersion) {
  const replacements = {
    __BRAND_ID__: brandId,
    __APP_NAME__: appName,
    __CORE_VERSION__: coreVersion,
    __WORKER_VERSION__: workerVersion,
  };
  function walk(src, dest) {
    for (const name of readdirSync(src)) {
      const srcPath = join(src, name);
      const destName = name.endsWith('.tmpl') ? name.slice(0, -5) : name;
      const destPath = join(dest, destName);
      if (statSync(srcPath).isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath);
      } else {
        let content = readFileSync(srcPath, 'utf8');
        for (const [key, value] of Object.entries(replacements)) content = content.split(key).join(value);
        writeFileSync(destPath, content);
      }
    }
  }
  mkdirSync(targetDir, { recursive: true });
  walk(join(PKG_ROOT, 'template'), targetDir);
}

/**
 * Scaffolds the three contracts a site is described by — identity, shape, and
 * deployment config — as three separate files, because a brand has to be
 * portable and a deployment has to be configurable, and one file can't be both.
 *
 *   brands/<id>/brand.json                identity + look
 *   presentation/<id>/presentation.json   shape (layout, nouns)
 *   deployment/<id>/deployment.json       origins/keys/tts — filled in by the installer
 */
function scaffoldBrand(targetDir, brandId, appName) {
  const baseBrand = join(ENGINE_ROOT, 'brands', 'storylark');
  const destBrand = join(targetDir, 'brands', brandId);
  const destPresentation = join(targetDir, 'presentation', brandId);
  const writeJson = (file, value) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  };
  const defaultPresentation = {
    contractVersion: 1,
    layout: 'flat',
    nouns: { unit: 'story', unitPlural: 'stories', Unit: 'Story', UnitPlural: 'Stories', collection: null, Collection: null },
  };

  if (existsSync(baseBrand)) {
    // Skip migrate-brand's backups — a freshly scaffolded site should not
    // inherit the engine checkout's pre-split leftovers.
    cpSync(baseBrand, destBrand, { recursive: true, filter: (src) => !src.endsWith('.pre-split.bak') });
    const brandJsonPath = join(destBrand, 'brand.json');
    const brand = JSON.parse(readFileSync(brandJsonPath, 'utf8'));
    brand.id = brandId;
    brand.name = appName;
    brand.appName = appName;
    brand.shortName = appName;
    writeJson(brandJsonPath, brand);
    const basePresentation = join(ENGINE_ROOT, 'presentation', 'storylark', 'presentation.json');
    writeJson(
      join(destPresentation, 'presentation.json'),
      existsSync(basePresentation) ? JSON.parse(readFileSync(basePresentation, 'utf8')) : defaultPresentation
    );
  } else {
    // Published-package fallback: minimal files, no base theme to copy from
    // (this path is for when create-storylark itself is installed from npm
    // rather than run from an engine checkout).
    writeJson(join(destBrand, 'brand.json'), {
      contractVersion: 1,
      id: brandId,
      name: appName,
      appName,
      shortName: appName,
    });
    writeJson(join(destPresentation, 'presentation.json'), defaultPresentation);
    writeFileSync(join(destBrand, 'theme.css'), '/* Add your theme tokens — see docs/build-your-own-theme.md */\n:root {}\n');
  }

  // Deployment config: intentionally empty of addresses. The installer fills
  // these in (or sets STORYLARK_APP_ORIGIN / STORYLARK_CONTENT_ORIGIN at build
  // time) — a scaffold must never ship someone else's origins.
  writeJson(join(targetDir, 'deployment', brandId, 'deployment.json'), {
    contractVersion: 1,
    appOrigin: '',
    contentOrigin: '',
    vapidPublicKey: '',
    tts: { voice: 'af_heart', rate: '0%', outputFormat: 'Audio48Khz96KBitRateMonoMp3' },
  });
}

function copyPlatforms(targetDir) {
  // Bundled inside this package (create-storylark/platforms/, kept in sync
  // with the engine repo's platforms/ by sync-platforms.mjs, run as a
  // prepublishOnly step) — NOT read from ENGINE_ROOT. That used to be the
  // source, which only worked when this script ran from inside an engine
  // checkout; a real `npx create-storylark` install has no engine checkout
  // anywhere nearby, so ENGINE_ROOT/platforms never existed and this
  // silently no-op'd, leaving every scaffolded site with no installer at
  // all (confirmed live: a real npm-published create-storylark run produced
  // no platforms/ folder, and the documented `npm run setup` step failed
  // outright since it shells out to platforms/wizard.mjs).
  const src = join(PKG_ROOT, 'platforms');
  if (!existsSync(src)) return;
  cpSync(src, join(targetDir, 'platforms'), { recursive: true });
}

function flag(argv, name) {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const deployFlag = argv.includes('--deploy');
  const positional = argv.filter((a) => !a.startsWith('--'));

  // --name/--brand/--app-name make this scriptable (CI, testing) without
  // readline's piped-stdin quirks; omit any of them to be prompted instead.
  let targetName = flag(argv, 'name') ?? positional[0];
  let brandId = flag(argv, 'brand');
  let appName = flag(argv, 'app-name');

  const needsPrompt = !targetName || !brandId || !appName;
  const rl = needsPrompt ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  if (!targetName) targetName = await rl.question('Folder to create (e.g. my-story-app): ');
  const targetDir = join(process.cwd(), targetName);
  if (existsSync(targetDir)) {
    console.error(`"${targetName}" already exists.`);
    process.exit(1);
  }
  if (!brandId) brandId = (await rl.question(`Brand id [${targetName}]: `)) || targetName;
  if (!appName) appName = (await rl.question(`App display name [${targetName}]: `)) || targetName;
  rl?.close();

  console.log(`\nFetching the current StoryLark engine versions...`);
  const [coreVersion, workerVersion] = await Promise.all([
    latestVersion('storylark-core', '0.5.0'),
    latestVersion('storylark-worker', '0.4.0'),
  ]);
  console.log(`Using storylark-core ${coreVersion}, storylark-worker ${workerVersion}.`);

  console.log(`\nCreating ${targetName}/ ...`);
  copyTemplate(targetDir, brandId, appName, coreVersion, workerVersion);
  scaffoldBrand(targetDir, brandId, appName);
  copyPlatforms(targetDir);
  console.log(`✓ ${targetName}/ created.`);

  if (deployFlag) {
    console.log('\nContinuing straight into setup (no separate step)...\n');
    const result = spawnSync(process.execPath, [join(targetDir, 'platforms', 'wizard.mjs')], {
      stdio: 'inherit',
      cwd: targetDir,
    });
    process.exit(result.status ?? 0);
  } else {
    console.log(`\nNext:\n  cd ${targetName}\n  npm install\n  npm run setup   # or edit brands/${brandId}/ by hand first`);
  }
}

main();
