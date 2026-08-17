#!/usr/bin/env node
// Cloudflare installer (AB#7402). Env-file-driven, same contract as
// platforms/azure/install.mjs: fill install.env, run this script.
//
//   node platforms/cloudflare/install.mjs --verify   sanity-checks values +
//                                                     wrangler login, creates nothing
//   node platforms/cloudflare/install.mjs --deploy   adds the brand's wrangler env
//                                                     block, creates D1 + R2,
//                                                     migrates, builds, deploys
//   node platforms/cloudflare/install.mjs --update   pulls the latest engine
//                                                     packages, then migrates +
//                                                     rebuilds + redeploys an
//                                                     EXISTING deployment
//   node platforms/cloudflare/install.mjs --enable-one-click
//                                                     opt in to the /admin
//                                                     "Install update" button
//   node platforms/cloudflare/install.mjs --disable-one-click
//                                                     opt back out
//
// --deploy creates real Cloudflare resources. It refuses to run without
// --yes on top of a passing verify, matching the Azure installer.
//
// --update (AB#7403, "platform updates must not need a GitHub token") is the
// supported way to take a new engine release. It creates nothing: no D1, no
// R2, no secrets, no wrangler.jsonc edits — it bumps the pinned engine
// version, migrates, rebuilds with your brand untouched, and redeploys the
// Worker. The only credential involved is your own `wrangler login`; nothing
// new is ever stored in the deployment. Also needs --yes, because it
// redeploys a live site.
//
// Note for this repo specifically: run inside the StoryLark engine monorepo,
// the Worker is bundled from packages/worker/src, not from the published
// storylark-worker package — so --update here rebuilds and redeploys your
// working tree rather than pulling a release. --update's npm bump only does
// real work in a standalone `npm create storylark` site, which is what a
// customer deployment actually is.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));

// Same two physical layouts platforms/azure/install.mjs handles: inside the
// engine monorepo (the site lives in app/, the Worker is bundled from
// packages/worker/src) or inside a standalone `npm create storylark` scaffold
// (ROOT *is* the site, and both the app and the Worker come from the published
// storylark-core/storylark-worker packages).
const IS_MONOREPO = existsSync(join(ROOT, 'app', 'package.json'));

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

// CONTENT_ORIGIN is deliberately NOT here (AB#7395). Unset means same-origin:
// the Worker serves the R2 bucket's content itself at /manifest.json and
// /books/*, so a fresh deployment needs no R2 custom domain and no DNS work
// before content loads. Set it only to serve content from its own domain.
const REQUIRED = ['BRAND_ID', 'APP_ORIGIN', 'MAIL_FROM', 'APP_NAME'];

// Same-origin default: '' is a real value ("serve content from the app's own
// origin"), and everything downstream — the wrangler vars block, the build's
// STORYLARK_CONTENT_ORIGIN override — needs a string, never undefined.
env.CONTENT_ORIGIN = (env.CONTENT_ORIGIN ?? '').trim();

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
    console.log('ADMIN SETUP — could not mint your setup link automatically.');
    console.log('(The site may not be reachable yet, or the key may not have');
    console.log('propagated.) Once the site is confirmed live, run this yourself:');
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

/**
 * `quiet` skips the closing "re-run with --deploy" line: --update calls this
 * for its own preflight, and telling an operator mid-update to go run --deploy
 * would be actively wrong advice.
 */
function verify(quiet = false) {
  console.log('Verifying install.env and Wrangler CLI state...\n');
  let ok = true;

  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`✗ Missing required values in install.env: ${missing.join(', ')}`);
    ok = false;
  } else {
    console.log('✓ Required values present:', REQUIRED.join(', '));
  }

  if (env.CONTENT_ORIGIN) {
    console.log(`✓ CONTENT_ORIGIN set — content will be served from ${env.CONTENT_ORIGIN} (attach an R2 custom domain there after deploy).`);
  } else {
    console.log('✓ CONTENT_ORIGIN not set — content will be served same-origin by the Worker (no R2 custom domain, no DNS setup needed).');
  }

  if (env.BRAND_ID && !/^[a-z0-9-]{3,24}$/.test(env.BRAND_ID)) {
    console.error('✗ BRAND_ID must be 3-24 lowercase letters, digits, or hyphens.');
    ok = false;
  }

  // brands/<id>/ is a monorepo concept — a standalone scaffolded site carries
  // its brand at its own root, so demanding the folder there is just wrong.
  if (IS_MONOREPO && env.BRAND_ID && !existsSync(join(ROOT, 'brands', env.BRAND_ID))) {
    console.error(`✗ brands/${env.BRAND_ID}/ doesn't exist yet. Create it first (see docs/deploy-your-own.md).`);
    ok = false;
  } else if (IS_MONOREPO && env.BRAND_ID) {
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

  if (!ok) console.log('\nFix the issues above before deploying.');
  else if (!quiet) console.log('\nAll checks passed. Re-run with --deploy --yes to provision.');
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

/**
 * Everything that is NOT provisioning: migrate, build, deploy. Shared verbatim
 * by --deploy and --update so the two paths can never drift — an update runs
 * the exact same app deployment the first install did, which is what makes
 * "re-run this whenever" safe.
 */
function migrateBuildDeploy() {
  console.log('\nApplying D1 migrations...');
  run('wrangler', ['d1', 'migrations', 'apply', env.BRAND_ID, '--env', env.BRAND_ID, '--remote'], { stdio: 'inherit', cwd: ROOT });

  console.log(`\nBuilding app for brand "${env.BRAND_ID}"...`);
  const buildArgs = IS_MONOREPO ? ['run', 'build', '-w', 'app', '--', '--mode', env.BRAND_ID] : ['run', 'build'];
  // Origins are deployment config, and install.env is where this deployment
  // declares them — hand them to the build so the bundle can never disagree
  // with the Worker vars set from the same file above. (Azure already did
  // this; not doing it here meant a site whose install.env and brand file
  // disagreed built against the file and silently served the wrong content.)
  run('npm', buildArgs, {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, STORYLARK_APP_ORIGIN: env.APP_ORIGIN, STORYLARK_CONTENT_ORIGIN: env.CONTENT_ORIGIN },
  });

  console.log(`\nDeploying Worker "${env.BRAND_ID}"...`);
  run('wrangler', ['deploy', '--env', env.BRAND_ID], { stdio: 'inherit', cwd: ROOT });
}

/** The pinned storylark-worker version in this site's package.json, or null. */
function pinnedEngineVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies?.['storylark-worker'] ?? null;
  } catch {
    return null;
  }
}

/**
 * --update (AB#7403): take a new engine release on an EXISTING deployment,
 * using only the operator's own `wrangler login`. No D1/R2 creation, no
 * wrangler.jsonc edits, no new secrets, no GitHub anything. Safe to re-run.
 */
async function update() {
  if (!verify(true)) {
    console.error('\nRefusing to update: verification failed.');
    process.exit(1);
  }
  if (!args.has('--yes')) {
    console.error('\n--update rebuilds and redeploys a live site. Re-run with --update --yes to confirm.');
    process.exit(1);
  }

  const before = pinnedEngineVersion();
  if (IS_MONOREPO) {
    console.log(
      '\nThis is the StoryLark engine monorepo: the Worker is bundled from\n' +
        'packages/worker/src and the app from packages/core, so there is no pinned\n' +
        'engine package to bump here. --update will migrate, rebuild, and redeploy\n' +
        'this working tree as it stands. (In a standalone site — what a customer\n' +
        'deployment is — this step pulls the latest published engine from npm.)'
    );
  } else {
    console.log(`\nCurrently pinned engine: storylark-worker ${before ?? '(not pinned)'}`);
    console.log('\nFetching the latest engine packages from npm...');
    // Mirrors self-update.yml's bump step: pin exactly, so what you deployed
    // is reproducible rather than "whatever the range resolved to that day".
    run('npm', ['install', '--save-exact', 'storylark-core@latest', 'storylark-worker@latest'], { stdio: 'inherit', cwd: ROOT });
  }

  migrateBuildDeploy();

  const after = pinnedEngineVersion();
  console.log('\n' + '='.repeat(72));
  console.log('UPDATE COMPLETE');
  console.log('='.repeat(72));
  if (!IS_MONOREPO && before && after && before !== after) {
    console.log(`\nEngine: storylark-worker ${before} -> ${after}`);
  } else if (!IS_MONOREPO && after) {
    console.log(`\nEngine: storylark-worker ${after} (already the latest — rebuilt and redeployed anyway).`);
  } else {
    console.log('\nEngine: rebuilt and redeployed from this working tree.');
  }
  console.log(`Site:   ${env.APP_ORIGIN}`);
  console.log('\nNothing about your brand or your content was touched: no resource was');
  console.log('created or changed, no secret was added, and nothing new is stored in');
  console.log('the deployment. The only credential used was your own wrangler login.');
  console.log('\nCheck it landed: open /admin on the site — the Platform update card');
  console.log('reads the version out of the deployment itself.');
  console.log('='.repeat(72) + '\n');
}

/**
 * --enable-one-click (AB#7418 — plan §4 layer 3): opt this deployment in to the
 * /admin "Install update" button.
 *
 * What it does is store ONE thing: a Cloudflare API token, as a Worker secret,
 * that the operator issued themselves. That is the honest shape of layer 3 on
 * Cloudflare — a Worker has no ambient identity, so the only way it can call
 * the Cloudflare API is with a token, and the only acceptable token is one the
 * operator minted, scoped, and can revoke without asking anyone.
 *
 * Deliberately NOT generated here. `wrangler` could mint an account-wide token
 * on the operator's behalf, and doing so would be the single worst decision in
 * this file: the operator would end up with a broad standing credential inside
 * their reading app that they never consciously created and would not think to
 * revoke. So this prints exactly which scopes to grant and reads the token from
 * stdin, and the token never appears in argv, in shell history or in
 * install.env.
 */
async function enableOneClick() {
  if (!env.BRAND_ID) {
    console.error('✗ BRAND_ID is missing from install.env — it names the Worker this would apply to.');
    process.exit(1);
  }
  if (!args.has('--yes')) {
    console.error(
      '\n--enable-one-click gives this deployment standing permission to redeploy itself.\n' +
        'Re-run with --enable-one-click --yes to confirm.'
    );
    process.exit(1);
  }

  console.log('\n' + '='.repeat(72));
  console.log('ONE-CLICK UPDATES — what you are about to allow');
  console.log('='.repeat(72));
  console.log('\nAn admin signed into /admin will be able to press "Install update".');
  console.log('That downloads the prebuilt engine for the version the portal shows,');
  console.log('checks it against its published checksum, migrates the database, and');
  console.log('redeploys THIS Worker — using a Cloudflare API token you create now.');
  console.log('\nIt cannot touch your brand, your content, or any binding: the update');
  console.log('uses Cloudflare\'s "put script content" endpoint, which leaves the');
  console.log("Worker's configuration alone.");
  console.log('\nYou do not have to do this. Without it, updates run from your own');
  console.log('machine with:  node platforms/cloudflare/install.mjs --update --yes');
  console.log('\n--- Create the token ---------------------------------------------------');
  console.log('\n  1. https://dash.cloudflare.com/profile/api-tokens -> Create Token');
  console.log('  2. Custom token. Permissions:');
  console.log('       Account | Workers Scripts | Edit');
  console.log('  3. Account Resources: your account only.');
  console.log('  4. Create, and copy the token.');
  console.log('\nRevoke it on that same page whenever you like — the button disappears');
  console.log('on the next page load and nothing else changes.');
  console.log('\n' + '='.repeat(72) + '\n');

  const token = (await prompt('Paste the API token (input is not echoed to your shell history): ')).trim();
  if (!token) {
    console.error('\nNothing pasted — nothing changed.');
    process.exit(1);
  }
  const accountId = (env.CF_ACCOUNT_ID || (await prompt('Cloudflare account id: '))).trim();
  if (!accountId) {
    console.error('\nNo account id — nothing changed. Find it on any Cloudflare dashboard URL, or with `wrangler whoami`.');
    process.exit(1);
  }

  // Piped, never on the command line: an argv value would land in this
  // machine's shell history and in any process listing. Same rule --deploy
  // already follows for ADMIN_KEY.
  run('wrangler', ['secret', 'put', 'CF_API_TOKEN', '--env', env.BRAND_ID], {
    input: token,
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: ROOT,
  });
  run('wrangler', ['secret', 'put', 'CF_ACCOUNT_ID', '--env', env.BRAND_ID], {
    // A secret rather than a var: it is not sensitive on its own, but keeping
    // it beside the token means one `--disable-one-click` removes the pair and
    // there is no half-configured state where the portal thinks it is enabled.
    input: accountId,
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: ROOT,
  });

  console.log('\n✓ One-click updates are on.');
  console.log('  Open /admin — the Platform update card now offers a button when there is');
  console.log('  something to install, and still shows the command either way.');
  console.log('  Turn it off with: node platforms/cloudflare/install.mjs --disable-one-click --yes\n');
}

/** The exact inverse. Deleting the token is also enough on its own — this is just tidier. */
function disableOneClick() {
  if (!args.has('--yes')) {
    console.error('\nRe-run with --disable-one-click --yes to confirm.');
    process.exit(1);
  }
  for (const name of ['CF_API_TOKEN', 'CF_ACCOUNT_ID']) {
    try {
      run('wrangler', ['secret', 'delete', name, '--env', env.BRAND_ID], { stdio: 'inherit', cwd: ROOT, input: 'y\n' });
    } catch {
      console.log(`  (${name} was not set — nothing to remove.)`);
    }
  }
  console.log('\n✓ One-click updates are off. Revoke the token itself at');
  console.log('  https://dash.cloudflare.com/profile/api-tokens if you have not already.\n');
}

/** One line from stdin. No echo suppression: a terminal that supports it is not guaranteed, and the value is pasted, not typed. */
function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(String(data).replace(/[\r\n]+$/, ''));
    });
  });
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

  migrateBuildDeploy();

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
  if (env.CONTENT_ORIGIN) {
    console.log(
      `\nCONTENT_ORIGIN is ${env.CONTENT_ORIGIN}: attach an R2 custom domain to the\n` +
        `"${env.BRAND_ID}-content" bucket so it serves there (Cloudflare dashboard -> R2 ->\n` +
        'bucket -> Settings -> Custom Domains). Content will not load until that domain resolves.'
    );
  } else {
    console.log(
      '\nContent is served same-origin (no CONTENT_ORIGIN set): the Worker answers\n' +
        '/manifest.json and /books/* from the R2 bucket directly. Nothing to configure.\n' +
        'To move content onto its own domain later, set CONTENT_ORIGIN in install.env\n' +
        'and wrangler.jsonc, attach an R2 custom domain, and redeploy.'
    );
  }

  console.log('\nWaiting for the site to come up so we can mint your admin setup link...');
  await printAdminSetup(env.APP_ORIGIN, adminKey);
}

if (args.has('--deploy')) await deploy();
else if (args.has('--update')) await update();
else if (args.has('--enable-one-click')) await enableOneClick();
else if (args.has('--disable-one-click')) disableOneClick();
else if (args.has('--verify') || args.size === 0) verify();
else {
  console.error(
    'Usage: node install.mjs --verify | --deploy --yes | --update --yes | --enable-one-click --yes | --disable-one-click --yes'
  );
  process.exit(1);
}
