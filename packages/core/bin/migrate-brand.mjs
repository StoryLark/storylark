// migrate-brand — splits a pre-split brands/<id>/brand.json into the three
// contracts it should always have been (plan §0d, Phase 0):
//
//   brands/<id>/brand.json              identity + look   — portable
//   presentation/<id>/presentation.json shape             — portable
//   deployment/<id>/deployment.json     origins/keys/tts  — never portable
//
// Why: one file mixing identity, shape and deployment config means a brand is
// not portable and a deployment is not configurable — which is exactly how an
// Azure deployment ended up serving the wrong content origin, because
// `contentOrigin` was baked into the brand both platforms share.
//
// Usage:
//   npm run migrate-brand                 every brand under brands/
//   npm run migrate-brand -- --brand <id> just that one
//   npm run migrate-brand -- --dry-run    print what would change, write nothing
//
// Safe to re-run: an already-split brand is skipped, and the original is backed
// up to brand.json.pre-split.bak before anything is written.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  BRAND_SCHEMA,
  PRESENTATION_SCHEMA,
  DEPLOYMENT_SCHEMA,
  SUPPORTED_CONTRACT_VERSION,
  assertValid,
} from '../schemas/validate.mjs';

// Site-agnostic: runs from the site repo root (cwd), which owns brands/. It
// ships inside storylark-core because a core update is what introduces the
// split, so the tool that performs it arrives with the same update.
const ROOT = process.cwd();
const BRANDS_DIR = join(ROOT, 'brands');
const PRESENTATION_DIR = join(ROOT, 'presentation');
const DEPLOYMENT_DIR = join(ROOT, 'deployment');

/** brand.json keeps exactly these — identity and look, nothing about where it runs. */
const IDENTITY_KEYS = [
  'id',
  'name',
  'appName',
  'shortName',
  'tagline',
  'author',
  'themeColor',
  'backgroundColor',
  'defaultTheme',
  'fonts',
];
/** presentation.json takes these today. The rest of the §0b contract is left
 *  absent on purpose so it resolves to core defaults — see docs. */
const PRESENTATION_KEYS = ['layout', 'nouns'];
/** deployment.json takes these — addresses, a key, and publishing config. */
const DEPLOYMENT_KEYS = ['appOrigin', 'contentOrigin', 'vapidPublicKey', 'tts'];

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const only = typeof args.brand === 'string' ? args.brand : null;

const brandIds = only
  ? [only]
  : existsSync(BRANDS_DIR)
    ? readdirSync(BRANDS_DIR).filter((n) => statSync(join(BRANDS_DIR, n)).isDirectory())
    : [];

if (!brandIds.length) {
  console.error(`No brand folders found under ${rel(BRANDS_DIR)}.`);
  process.exit(1);
}

console.log(`migrate-brand — ${brandIds.length} brand folder(s) under ${rel(BRANDS_DIR)}${dryRun ? '  [dry run]' : ''}\n`);

let migrated = 0;
let skipped = 0;
/** @type {{ brandId: string, deployment: object }[]} */
const deploymentsToReport = [];

for (const brandId of brandIds) {
  const brandFile = join(BRANDS_DIR, brandId, 'brand.json');
  if (!existsSync(brandFile)) {
    console.log(`- ${brandId}: no brand.json — skipped.`);
    skipped++;
    continue;
  }

  const raw = JSON.parse(readFileSync(brandFile, 'utf8'));
  const presentationFile = join(PRESENTATION_DIR, brandId, 'presentation.json');

  // Idempotency: already split = brand.json carries a contractVersion AND the
  // presentation file exists with one too. Both, so a half-finished run (or a
  // hand-edit) still gets completed rather than silently left broken.
  const brandSplit = Number.isInteger(raw.contractVersion);
  const presentationSplit =
    existsSync(presentationFile) && Number.isInteger(JSON.parse(readFileSync(presentationFile, 'utf8')).contractVersion);
  if (brandSplit && presentationSplit) {
    console.log(`- ${brandId}: already split (contractVersion ${raw.contractVersion}) — no change.`);
    skipped++;
    continue;
  }

  const identity = { contractVersion: SUPPORTED_CONTRACT_VERSION, ...pick(raw, IDENTITY_KEYS) };
  const presentation = { contractVersion: SUPPORTED_CONTRACT_VERSION, ...pick(raw, PRESENTATION_KEYS) };
  const deployment = { contractVersion: SUPPORTED_CONTRACT_VERSION, ...pick(raw, DEPLOYMENT_KEYS) };

  const unclaimed = Object.keys(raw).filter(
    (k) => k !== 'contractVersion' && ![...IDENTITY_KEYS, ...PRESENTATION_KEYS, ...DEPLOYMENT_KEYS].includes(k)
  );
  if (unclaimed.length) {
    // Never silently dropped: an unrecognised key is the operator's data.
    console.log(`  ! ${brandId}: unrecognised key(s) ${unclaimed.join(', ')} — left in brand.json for you to place.`);
    for (const k of unclaimed) identity[k] = raw[k];
  }

  // strict: this script PRODUCES these files, so anything wrong in them is our
  // bug or the operator's, and it should stop here rather than surface later in
  // somebody's build.
  assertValid(identity, BRAND_SCHEMA, { strict: true, label: `${brandId} brand.json` });
  assertValid(presentation, PRESENTATION_SCHEMA, { strict: true, label: `${brandId} presentation.json` });
  assertValid(deployment, DEPLOYMENT_SCHEMA, { strict: true, label: `${brandId} deployment.json` });

  console.log(`- ${brandId}:`);
  if (dryRun) {
    console.log(`    would write ${rel(brandFile)}.pre-split.bak`);
    console.log(`    would write ${rel(brandFile)}          ${Object.keys(identity).join(', ')}`);
    console.log(`    would write ${rel(presentationFile)}   ${Object.keys(presentation).join(', ')}`);
    console.log(`    would write ${rel(join(DEPLOYMENT_DIR, brandId, 'deployment.json'))}  ${Object.keys(deployment).join(', ')}`);
  } else {
    writeFileSync(`${brandFile}.pre-split.bak`, readFileSync(brandFile));
    writeJson(brandFile, identity);
    writeJson(presentationFile, presentation);
    writeJson(join(DEPLOYMENT_DIR, brandId, 'deployment.json'), deployment);
    console.log(`    backed up  ${rel(brandFile)}.pre-split.bak`);
    console.log(`    wrote      ${rel(brandFile)}`);
    console.log(`    wrote      ${rel(presentationFile)}`);
    console.log(`    wrote      ${rel(join(DEPLOYMENT_DIR, brandId, 'deployment.json'))}`);
  }
  migrated++;
  deploymentsToReport.push({ brandId, deployment, hadVapid: typeof raw.vapidPublicKey === 'string' && raw.vapidPublicKey !== '' });
}

console.log(`\n${migrated} migrated, ${skipped} unchanged.`);

// ── the operator's half of the job ──────────────────────────────────────────
// The deployment values are now install config. They are written to
// deployment/<id>/deployment.json so this checkout still builds unchanged, but
// on a real install they belong in the platform's env — the same install.env /
// .env the installers already read — because two deployments of one brand
// differ here and nowhere else.
for (const { brandId, deployment, hadVapid } of deploymentsToReport) {
  console.log(`\n─── deployment config moved out of brands/${brandId}/brand.json ───\n`);
  console.log('  Set these on each deployment of this brand (platforms/*/install.env,');
  console.log('  platforms/azure/.env, or the build environment directly):\n');
  console.log(`    APP_ORIGIN=${deployment.appOrigin ?? ''}                # build override: STORYLARK_APP_ORIGIN`);
  console.log(`    CONTENT_ORIGIN=${deployment.contentOrigin ?? ''}        # build override: STORYLARK_CONTENT_ORIGIN`);
  if (deployment.tts) {
    console.log(`    STORYLARK_TTS_VOICE=${deployment.tts.voice ?? ''}`);
    console.log(`    STORYLARK_TTS_RATE=${deployment.tts.rate ?? ''}`);
    console.log(`    STORYLARK_TTS_OUTPUT_FORMAT=${deployment.tts.outputFormat ?? ''}`);
    if (deployment.tts.voices?.length) console.log(`    STORYLARK_TTS_VOICES=${deployment.tts.voices.join(',')}`);
  }
  console.log('\n  ** VAPID **');
  if (hadVapid) {
    console.log(`    VAPID_PUBLIC_KEY=${deployment.vapidPublicKey}   # build override: STORYLARK_VAPID_PUBLIC_KEY`);
    console.log('    This key is now deployment config, not brand identity. KEEP IT.');
    console.log('    Every device already subscribed to push is bound to this exact key —');
    console.log('    a deployment that loses or changes it can no longer notify any of them,');
    console.log('    and every reader has to re-subscribe. Copy it into your deployment');
    console.log('    config NOW, alongside the matching VAPID_PRIVATE_KEY secret.');
  } else {
    console.log('    No VAPID public key was set in this brand, so nothing to preserve —');
    console.log('    push is off. When you enable it (node packages/pipeline/gen-vapid.mjs),');
    console.log('    the PUBLIC key goes in deployment config, never in brand.json.');
  }
  console.log('    The PRIVATE key was never in brand.json and is not touched here — it');
  console.log('    lives only as a platform secret (VAPID_PRIVATE_KEY).');
}

if (migrated && !dryRun) {
  console.log('\nOriginals are preserved as brands/<id>/brand.json.pre-split.bak — delete them once you are happy.');
}

// ── helpers ─────────────────────────────────────────────────────────────────

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function rel(p) {
  return relative(ROOT, p).split('\\').join('/') || p;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}
