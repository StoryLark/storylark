#!/usr/bin/env node
// Cloudflare installer (AB#7402). Env-file-driven, same contract as
// platforms/azure/install.mjs: fill install.env, run this script.
//
//   node platforms/cloudflare/install.mjs --verify   sanity-checks values +
//                                                     wrangler login, creates nothing
//   node platforms/cloudflare/install.mjs --deploy   adds the brand's wrangler env
//                                                     block, creates D1 + R2,
//                                                     migrates, builds, deploys
//
// --deploy creates real Cloudflare resources. It refuses to run without
// --yes on top of a passing verify, matching the Azure installer.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));

const WIN = process.platform === 'win32';
const q = (s) => (WIN && /[\s,]/.test(s) ? `"${s}"` : s);
function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs.map(q), { shell: WIN, ...opts });
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const envPath = join(__dirname, 'install.env');
const env = { ...loadEnvFile(envPath), ...process.env };

const REQUIRED = ['BRAND_ID', 'APP_ORIGIN', 'CONTENT_ORIGIN', 'MAIL_FROM', 'APP_NAME'];

function verify() {
  console.log('Verifying install.env and Wrangler CLI state...\n');
  let ok = true;

  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`✗ Missing required values in install.env: ${missing.join(', ')}`);
    ok = false;
  } else {
    console.log('✓ Required values present:', REQUIRED.join(', '));
  }

  if (env.BRAND_ID && !/^[a-z0-9-]{3,24}$/.test(env.BRAND_ID)) {
    console.error('✗ BRAND_ID must be 3-24 lowercase letters, digits, or hyphens.');
    ok = false;
  }

  if (env.BRAND_ID && !existsSync(join(ROOT, 'brands', env.BRAND_ID))) {
    console.error(`✗ brands/${env.BRAND_ID}/ doesn't exist yet. Create it first (see docs/deploy-your-own.md).`);
    ok = false;
  } else if (env.BRAND_ID) {
    console.log(`✓ brands/${env.BRAND_ID}/ exists`);
  }

  try {
    const whoami = run('wrangler', ['whoami'], { encoding: 'utf8', cwd: ROOT });
    if (/not.*logg?ed in|not authenticated/i.test(whoami)) throw new Error('not logged in');
    console.log('✓ Logged into Cloudflare (wrangler whoami)');
  } catch {
    console.error('✗ Not logged into Wrangler. Run: npx wrangler login');
    ok = false;
  }

  console.log(ok ? '\nAll checks passed. Re-run with --deploy --yes to provision.' : '\nFix the issues above before deploying.');
  return ok;
}

/** Add (or confirm) the brand's env block in the root wrangler.jsonc. Idempotent. */
function ensureWranglerEnvBlock() {
  const wranglerPath = join(ROOT, 'wrangler.jsonc');
  const text = readFileSync(wranglerPath, 'utf8');
  if (text.includes(`"${env.BRAND_ID}": {`)) {
    console.log(`✓ wrangler.jsonc already has an env block for "${env.BRAND_ID}"`);
    return;
  }
  const block = `,
    "${env.BRAND_ID}": {
      "name": "${env.BRAND_ID}",
      "routes": [{ "pattern": "${new URL(env.APP_ORIGIN).host}", "custom_domain": true }],
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "${env.BRAND_ID}",
          "database_id": "00000000-0000-0000-0000-000000000000",
          "migrations_dir": "packages/worker/migrations"
        }
      ],
      "r2_buckets": [
        { "binding": "CONTENT", "bucket_name": "${env.BRAND_ID}-content" }
      ],
      "vars": {
        "BRAND": "${env.BRAND_ID}",
        "APP_ORIGIN": "${env.APP_ORIGIN}",
        "CONTENT_ORIGIN": "${env.CONTENT_ORIGIN}",
        "MAIL_FROM": "${env.MAIL_FROM}",
        "APP_NAME": "${env.APP_NAME}"
      }
    }`;
  // Insert right before the closing brace of the "env" object's last entry.
  const insertAt = text.lastIndexOf('\n  }');
  const updated = text.slice(0, insertAt) + block + text.slice(insertAt);
  writeFileSync(wranglerPath, updated);
  console.log(`✓ Added a wrangler.jsonc env block for "${env.BRAND_ID}" — fill in the real database_id after creating D1 below.`);
}

function deploy() {
  if (!verify()) {
    console.error('\nRefusing to deploy: verification failed.');
    process.exit(1);
  }
  if (!args.has('--yes')) {
    console.error('\n--deploy creates real Cloudflare resources. Re-run with --deploy --yes to confirm.');
    process.exit(1);
  }

  ensureWranglerEnvBlock();

  console.log(`\nCreating D1 database "${env.BRAND_ID}"...`);
  let databaseId;
  try {
    const out = run('wrangler', ['d1', 'create', env.BRAND_ID, '--json'], { encoding: 'utf8', cwd: ROOT });
    databaseId = JSON.parse(out).d1_databases?.[0]?.database_id ?? JSON.parse(out).uuid;
  } catch (err) {
    console.error('Could not create/parse the D1 database. If it already exists, find its id with `wrangler d1 list` and set it in wrangler.jsonc by hand.');
    throw err;
  }
  if (!databaseId) throw new Error('wrangler d1 create --json did not return a database_id — check the wrangler version.');
  const wranglerPath = join(ROOT, 'wrangler.jsonc');
  const patched = readFileSync(wranglerPath, 'utf8').replace(
    new RegExp(`("database_name": "${env.BRAND_ID}",\\s*\\n\\s*"database_id": ")[^"]*(")`),
    `$1${databaseId}$2`
  );
  writeFileSync(wranglerPath, patched);
  console.log(`✓ wrangler.jsonc updated with database_id ${databaseId}`);

  console.log(`\nCreating R2 bucket "${env.BRAND_ID}-content"...`);
  run('wrangler', ['r2', 'bucket', 'create', `${env.BRAND_ID}-content`], { stdio: 'inherit', cwd: ROOT });

  console.log('\nApplying D1 migrations...');
  run('wrangler', ['d1', 'migrations', 'apply', env.BRAND_ID, '--env', env.BRAND_ID, '--remote'], { stdio: 'inherit', cwd: ROOT });

  console.log(`\nBuilding app for brand "${env.BRAND_ID}"...`);
  run('npm', ['run', 'build', '-w', 'app', '--', '--mode', env.BRAND_ID], { stdio: 'inherit', cwd: ROOT });

  console.log(`\nDeploying Worker "${env.BRAND_ID}"...`);
  run('wrangler', ['deploy', '--env', env.BRAND_ID], { stdio: 'inherit', cwd: ROOT });

  console.log('\nDeployed. Publish content next: node packages/pipeline/publish.mjs --brand ' + env.BRAND_ID + ' --source <path>.');
}

if (args.has('--deploy')) deploy();
else if (args.has('--verify') || args.size === 0) verify();
else {
  console.error('Usage: node install.mjs --verify | --deploy --yes');
  process.exit(1);
}
