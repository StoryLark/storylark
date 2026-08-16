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
import { randomBytes } from 'node:crypto';
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

/**
 * Admin bootstrap (AB#7404), shared with platforms/azure/install.mjs.
 *
 * ADMIN_KEY is no longer something a human types into /admin — the portal is
 * gated by a normal account in the app's own users table now. It survives as
 * a deployment-config credential whose one job is to mint the FIRST admin
 * setup link, plus the printed recovery codes that are the offline way back
 * in. So the installer always needs one, generates it if the operator didn't
 * supply one, and calls the mint endpoint at the end of a successful deploy.
 */
function generateAdminKey() {
  return randomBytes(24).toString('base64url');
}

/** Poll the freshly-deployed site until it answers, so the mint below isn't racing DNS/cold start. */
async function waitForSite(origin, attempts = 10, delayMs = 6000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet — DNS still propagating, or the platform is cold starting
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Mint the setup link + recovery codes and print them. Never throws: a
 * failure here means the site just isn't reachable from this machine yet,
 * which is a "run one command later" problem, not a reason to fail a deploy
 * that otherwise succeeded — so it prints the exact curl to run instead.
 */
async function printAdminSetup(origin, adminKey) {
  const endpoint = `${origin}/api/admin/setup/reset`;
  const manual = () => {
    console.log('\n' + '='.repeat(72));
    console.log('ADMIN SETUP — could not reach the site to mint your setup link.');
    console.log('Once the site is confirmed live, run this yourself:');
    console.log(`\n  curl -X POST ${endpoint} -H "x-admin-key: <your ADMIN_KEY>"\n`);
    console.log('It returns a one-time setup URL and 10 recovery codes.');
    console.log('='.repeat(72) + '\n');
  };

  if (!(await waitForSite(origin))) return manual();

  let data;
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'x-admin-key': adminKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(`\nCould not mint the admin setup link: ${err.message}`);
    return manual();
  }

  console.log('\n' + '='.repeat(72));
  console.log('ADMIN SETUP — do this now, this is the only time these are shown.');
  console.log('='.repeat(72));
  console.log('\n1. Open this link and create your admin login (email + password).');
  console.log('   It works once, and expires in an hour:\n');
  console.log(`   ${data.setupUrl}\n`);
  console.log('2. Save these recovery codes somewhere safe — a password manager,');
  console.log('   NOT this terminal\'s scrollback. Each one works once, and they are');
  console.log('   how you get back in if you forget the password and email reset');
  console.log('   is not available:\n');
  for (const code of data.recoveryCodes ?? []) console.log(`   ${code}`);
  console.log('\nAfter that, sign in at /admin with the email and password you just');
  console.log('chose — same as any account on the site.');
  console.log('='.repeat(72) + '\n');
}

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
      },
      "triggers": { "crons": ["0 13 * * *"] }
    }`;
  // Insert right before the closing brace of the "env" object's last entry.
  const insertAt = text.lastIndexOf('\n  }');
  const updated = text.slice(0, insertAt) + block + text.slice(insertAt);
  writeFileSync(wranglerPath, updated);
  console.log(`✓ Added a wrangler.jsonc env block for "${env.BRAND_ID}" — fill in the real database_id after creating D1 below.`);
}

async function deploy() {
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

  // ADMIN_KEY has to exist as a Worker secret before the mint call below can
  // authenticate. Set after `deploy` because `wrangler secret put` needs the
  // Worker script to already exist for this env.
  const adminKey = env.ADMIN_KEY || generateAdminKey();
  if (!env.ADMIN_KEY) console.log('\nNo ADMIN_KEY in install.env — generating one for this deployment.');
  console.log('Setting the ADMIN_KEY secret...');
  run('wrangler', ['secret', 'put', 'ADMIN_KEY', '--env', env.BRAND_ID], {
    // Piped, never on the command line: an argv value would land in the
    // shell history and in any process listing on this machine.
    input: adminKey,
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: ROOT,
  });

  console.log('\nDeployed. Publish content next: node packages/pipeline/publish.mjs --brand ' + env.BRAND_ID + ' --source <path>.');

  console.log('\nWaiting for the site to come up so we can mint your admin setup link...');
  await printAdminSetup(env.APP_ORIGIN, adminKey);
}

if (args.has('--deploy')) await deploy();
else if (args.has('--verify') || args.size === 0) verify();
else {
  console.error('Usage: node install.mjs --verify | --deploy --yes');
  process.exit(1);
}
