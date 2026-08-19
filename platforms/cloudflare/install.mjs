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
//                                                     re-run the automatic
//                                                     self-update provisioning
//                                                     (or, if that cannot work,
//                                                     paste a token you scoped
//                                                     yourself) — --deploy and
//                                                     --update already do this
//   node platforms/cloudflare/install.mjs --disable-one-click
//                                                     turn that off, stickily
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
import {
  discoverWranglerAuth,
  mintScopedToken,
  provisionSelfUpdateFromOAuth,
  WRANGLER_CLIENT_ID,
  WRANGLER_TOKEN_URL,
} from './wrangler-oauth.mjs';

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
const contentSource = () => (env.CONTENT_SOURCE || 'portal').trim().toLowerCase();

// CONTENT_ORIGIN is deliberately NOT here (AB#7395). Unset means same-origin:
// the Worker serves the R2 bucket's content itself at /manifest.json and
// /books/*, so a fresh deployment needs no R2 custom domain and no DNS work
// before content loads. Set it only to serve content from its own domain.
const REQUIRED = ['BRAND_ID', 'APP_ORIGIN', 'MAIL_FROM', 'APP_NAME'];

// Same-origin default: '' is a real value ("serve content from the app's own
// origin"), and everything downstream — the wrangler vars block, the build's
// STORYLARK_CONTENT_ORIGIN override — needs a string, never undefined.
env.CONTENT_ORIGIN = (env.CONTENT_ORIGIN ?? '').trim();

// Brand identity and Cloudflare resource identity are usually the same, but
// existing publishers often have deliberate production names. Keep branding
// stable while allowing the installer/update path to address those resources
// explicitly instead of forcing a rename or a hand-maintained fork.
const deployEnv = () => (env.CLOUDFLARE_ENV || env.BRAND_ID || '').trim();
const workerName = () => (env.WORKER_NAME || env.BRAND_ID || '').trim();
const d1Database = () => (env.D1_DATABASE || env.BRAND_ID || '').trim();
const r2Bucket = () => (env.R2_BUCKET || `${env.BRAND_ID || ''}-content`).trim();

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
 * Save the deployment's initial content source through the Worker's real
 * connection gate. A repository is dry-run first and only then saved/synced;
 * this is intentionally the same route the Admin Connections screen uses.
 */
async function configureContentSource(origin, adminKey) {
  if (!(await waitForSite(origin))) throw new Error('the deployed site did not become reachable in time to save its content source');
  const mode = contentSource();
  const body = { mode };
  if (mode === 'repo') {
    body.repo = {
      provider: 'github',
      url: env.CONTENT_REPO_URL.trim(),
      visibility: (env.CONTENT_REPO_VISIBILITY || 'private').trim().toLowerCase(),
      branch: (env.CONTENT_REPO_BRANCH || 'main').trim(),
      path: (env.CONTENT_REPO_PATH || '').trim(),
      intervalHours: Number(env.CONTENT_REPO_INTERVAL_HOURS || 24),
      ...(String(env.CONTENT_REPO_ADOPT_MATCHING || '').toLowerCase() === 'true' ? { adoptMatchingExisting: true } : {}),
    };
    body.syncNow = true;
  }

  const res = await fetch(`${origin.replace(/\/+$/, '')}/api/admin/content-source`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `the deployment answered HTTP ${res.status}`);
  }
  if (mode === 'repo') {
    const report = data.initialSync;
    if (!report?.ok) throw new Error(report?.failure || 'the initial repository sync did not complete successfully');
    console.log(
      `✓ Repository connected and synced: ${report.books} book(s), ${report.chaptersWritten} chapter(s) written, ` +
        `${report.chaptersUnchanged} unchanged, ${report.errors.length} error(s).`
    );
  } else {
    console.log(`✓ Content source saved as ${mode}.`);
  }
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

  const source = contentSource();
  if (!['portal', 'repo', 'api'].includes(source)) {
    console.error('✗ CONTENT_SOURCE must be portal, repo, or api.');
    ok = false;
  } else if (source === 'repo') {
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?\/?$/.test((env.CONTENT_REPO_URL || '').trim())) {
      console.error('✗ CONTENT_REPO_URL must be an HTTPS GitHub repository URL.');
      ok = false;
    }
    const visibility = (env.CONTENT_REPO_VISIBILITY || 'private').trim().toLowerCase();
    if (!['public', 'private'].includes(visibility)) {
      console.error('✗ CONTENT_REPO_VISIBILITY must be public or private.');
      ok = false;
    } else if (visibility === 'private' && !(env.CONTENT_SYNC_TOKEN || '').trim()) {
      console.error('✗ A private repository requires CONTENT_SYNC_TOKEN in install.env or the process environment.');
      ok = false;
    } else {
      console.log(`✓ Initial content source: GitHub repository (${visibility})`);
    }
  } else {
    console.log(`✓ Initial content source: ${source}`);
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
  if (text.includes(`"${deployEnv()}": {`)) {
    console.log(`✓ wrangler.jsonc already has an env block for "${deployEnv()}"`);
    return;
  }
  const block = `,
    "${deployEnv()}": {
      "name": "${workerName()}",
      "routes": [{ "pattern": "${new URL(env.APP_ORIGIN).host}", "custom_domain": true }],
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "${d1Database()}",
          "database_id": "00000000-0000-0000-0000-000000000000",
          "migrations_dir": "packages/worker/migrations"
        }
      ],
      "r2_buckets": [
        { "binding": "CONTENT", "bucket_name": "${r2Bucket()}" }
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
  console.log(`✓ Added a wrangler.jsonc env block for "${deployEnv()}" — fill in the real database_id after creating D1 below.`);
}

/**
 * Everything that is NOT provisioning: migrate, build, deploy. Shared verbatim
 * by --deploy and --update so the two paths can never drift — an update runs
 * the exact same app deployment the first install did, which is what makes
 * "re-run this whenever" safe.
 */
function migrateBuildDeploy() {
  console.log('\nApplying D1 migrations...');
  run('wrangler', ['d1', 'migrations', 'apply', d1Database(), '--env', deployEnv(), '--remote'], { stdio: 'inherit', cwd: ROOT });

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

  console.log(`\nDeploying Worker "${workerName()}" (environment "${deployEnv()}")...`);
  run('wrangler', ['deploy', '--env', deployEnv()], { stdio: 'inherit', cwd: ROOT });
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

  // Existing deployments gain self-update the same way new ones do: as part
  // of a normal update, automatically — including deployments made before
  // automatic setup existed, and OAuth-authenticated operators. Taking one
  // update the old way fixes the site permanently going forward. A failure
  // here fails the command (below), because "updated, but still cannot
  // self-update" is a fault, not a footnote.
  const selfUpdate = await ensureSelfUpdate();

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
  console.log('\nNothing about your brand or your content was touched, and the update');
  console.log('itself created no resource and stored nothing. If the self-update step');
  console.log('above provisioned a credential for the /admin button, it said so there,');
  console.log('in full — including its scope and how to revoke it.');
  console.log('\nCheck it landed: open /admin on the site — the Platform update card');
  console.log('reads the version out of the deployment itself.');
  console.log('='.repeat(72) + '\n');

  if (!selfUpdate.ok) failSelfUpdateLoudly(selfUpdate.why);
}

/**
 * Self-update provisioning (AB#7418, revised twice): part of a NORMAL install,
 * and it always ends with a working credential or a loud failure.
 *
 * The /admin "Update now" button needs no credential at all for releases that
 * only change the engine — those install through the deployment's own storage
 * (storylark-worker/lib/engine-store) on every platform identically. The one
 * thing that still needs a permission is a release that changes the Worker's
 * own script, because a running Worker cannot replace its own code. Azure
 * solves that with a managed identity provisioned at install; this is the
 * Cloudflare counterpart, run automatically by --deploy and --update:
 *
 *   1. If the self-update secrets already exist → leave them alone.
 *   2. If the installer authenticated with an API token (CLOUDFLARE_API_TOKEN)
 *      → try to MINT a new token scoped to Account | Workers Scripts | Edit
 *      and store that; if the operator's token lacks token-creation permission
 *      (common), fall back to storing the token the installer is already
 *      using — disclosed plainly, because it is broader than the minted one
 *      would have been.
 *   3. If the installer authenticated with `wrangler login` (OAuth) → read the
 *      credentials wrangler itself persisted (plaintext TOML, or the opt-in
 *      keyring-encrypted file) and provision from them: mint if Cloudflare
 *      permits it (it currently does not for OAuth sessions — see
 *      wrangler-oauth.mjs), else hand the OAuth session itself to the
 *      deployment as a refresh token the Worker exchanges at the moment of
 *      use. Zero operator action either way.
 *   4. If nothing usable exists at all, the CALLER fails loudly — a deploy
 *      that quietly leaves a site unable to self-update is the bug this
 *      revision exists to eliminate. There is no expected state in which the
 *      operator is handed a command as their path forward.
 *
 * Every path prints what was provisioned, how broad it is, and how to revoke
 * it. The manual step is what was removed — never the disclosure.
 *
 * `--disable-one-click` still turns it off, and writes SELF_UPDATE=off into
 * install.env so a later --update does not silently turn it back on.
 */
// `let`, not const: an explicit --enable-one-click clears the opt-out before
// re-running the provisioning, and setSelfUpdateFlag keeps this in sync with
// what it writes to install.env.
let SELF_UPDATE_OFF = (env.SELF_UPDATE ?? '').toLowerCase() === 'off';

/** Are the self-update secrets already on this Worker (either credential shape)? */
function selfUpdateConfigured() {
  try {
    const out = run('wrangler', ['secret', 'list', '--env', deployEnv()], { encoding: 'utf8', cwd: ROOT });
    return (out.includes('CF_API_TOKEN') || out.includes('CF_OAUTH_REFRESH_TOKEN')) && out.includes('CF_ACCOUNT_ID');
  } catch {
    return false;
  }
}

/** The account id, from install.env or `wrangler whoami`. */
function resolveAccountId() {
  if (env.CF_ACCOUNT_ID) return env.CF_ACCOUNT_ID.trim();
  try {
    const out = run('wrangler', ['whoami'], { encoding: 'utf8', cwd: ROOT });
    const m = /\b([0-9a-f]{32})\b/.exec(out);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Store the pair of secrets that turn the button on. Token piped, never argv. */
function storeSelfUpdateSecrets(token, accountId) {
  run('wrangler', ['secret', 'put', 'CF_API_TOKEN', '--env', deployEnv()], {
    input: token,
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: ROOT,
  });
  run('wrangler', ['secret', 'put', 'CF_ACCOUNT_ID', '--env', deployEnv()], {
    // A secret rather than a var: it is not sensitive on its own, but keeping
    // it beside the token means one `--disable-one-click` removes the pair and
    // there is no half-configured state where the portal thinks it is enabled.
    input: accountId,
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: ROOT,
  });
}

/**
 * Provision self-update, whatever way the operator is authenticated. Returns
 * { ok: true } or { ok: false, why } — it never exits itself, because the
 * loudness of the failure is the caller's decision (--deploy and --update
 * exit non-zero; see failSelfUpdateLoudly).
 */
async function ensureSelfUpdate() {
  console.log('\nSelf-update setup (the /admin "Update now" button)...');
  console.log('Engine releases already update from /admin with NO setup on any platform');
  console.log('— they install through the site\'s own storage. This step only covers the');
  console.log('rarer releases that change the API server itself.');
  if (SELF_UPDATE_OFF) {
    console.log('… SELF_UPDATE=off in install.env — leaving self-update disabled, as you asked.');
    return { ok: true, optedOut: true };
  }
  try {
    if (selfUpdateConfigured()) {
      console.log('✓ Already configured for this Worker — leaving it exactly as it is.');
      return { ok: true };
    }
    const accountId = resolveAccountId();
    if (!accountId) {
      return { ok: false, why: 'could not determine the Cloudflare account id (set CF_ACCOUNT_ID in install.env, or check `wrangler whoami`).' };
    }

    // Path 1: the installer was run with an API token in the environment.
    const baseToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
    if (baseToken) {
      let token;
      let provisioned;
      try {
        token = await mintScopedToken(baseToken, accountId, `storylark-self-update-${env.BRAND_ID}`);
        provisioned = [
          `✓ Minted a NEW API token "storylark-self-update-${env.BRAND_ID}", scoped to`,
          '  Account | Workers Scripts | Edit on this account only, and stored it as a',
          '  Worker secret. Your own token was not stored.',
          '  Revoke it anytime at https://dash.cloudflare.com/profile/api-tokens —',
          '  the button degrades gracefully on the next page load.',
        ];
      } catch (err) {
        token = baseToken;
        provisioned = [
          `… Could not mint a scoped token (${err.message}), so the token this`,
          '  installer authenticated with was stored as the Worker secret instead.',
          '  NOTE: that token is whatever scope YOU gave it — likely broader than the',
          '  Workers Scripts | Edit this feature needs. To narrow it: mint a token',
          '  with just that permission and run --enable-one-click to replace it.',
          '  Withdraw it anytime with --disable-one-click, or revoke the token at',
          '  https://dash.cloudflare.com/profile/api-tokens.',
        ];
      }
      storeSelfUpdateSecrets(token, accountId);
      for (const line of provisioned) console.log(line);
      return { ok: true };
    }

    // Path 2: `wrangler login` (OAuth). Read the credentials wrangler itself
    // persisted and provision from them — see wrangler-oauth.mjs for exactly
    // what is read, why the refresh token is what gets stored, and why the
    // operator's local wrangler may ask them to log in again afterwards.
    const auth = discoverWranglerAuth();
    if (!auth) {
      return {
        ok: false,
        why:
          'no Cloudflare credential was found to provision from. The installer looked for\n' +
          '  CLOUDFLARE_API_TOKEN in the environment and for the credentials `wrangler login`\n' +
          '  stores on this machine (including the keyring-encrypted form), and found neither\n' +
          '  readable. Run `wrangler login` (or set CLOUDFLARE_API_TOKEN) and re-run\n' +
          '  `node platforms/cloudflare/install.mjs --update --yes`.',
      };
    }
    if (auth.apiToken) {
      // A wrangler-v1-era api_token in the config file: same posture as the
      // environment-token path, just sourced from disk.
      let token;
      try {
        token = await mintScopedToken(auth.apiToken, accountId, `storylark-self-update-${env.BRAND_ID}`);
        console.log(`✓ Minted a NEW API token "storylark-self-update-${env.BRAND_ID}" (scoped to`);
        console.log('  Account | Workers Scripts | Edit) using the api_token in your wrangler');
        console.log('  config, and stored it as a Worker secret. Your own token was not stored.');
      } catch (err) {
        token = auth.apiToken;
        console.log(`… Could not mint a scoped token (${err.message}); stored the api_token from`);
        console.log(`  your wrangler config (${auth.source}) as the Worker secret instead.`);
        console.log('  Replace it with a narrower one anytime via --enable-one-click.');
      }
      storeSelfUpdateSecrets(token, accountId);
      return { ok: true };
    }
    if (!auth.oauth.refreshToken) {
      return {
        ok: false,
        why:
          `the wrangler credentials at ${auth.source} carry no refresh token, so the\n` +
          '  session cannot be handed to the deployment. Run `wrangler login` again and\n' +
          '  re-run `node platforms/cloudflare/install.mjs --update --yes`.',
      };
    }
    console.log(`Found your wrangler login session (${auth.source}). Provisioning from it...`);
    const { notes } = await provisionSelfUpdateFromOAuth({
      creds: auth.oauth,
      accountId,
      scriptName: workerName(),
      tokenName: `storylark-self-update-${env.BRAND_ID}`,
    });
    for (const line of notes) console.log(line);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

/**
 * The loud failure (AB#7418, revised): a deploy/update that ends without a
 * working self-update credential is a FAULT, reported with a non-zero exit —
 * not a tip printed under a successful banner. The deploy itself already
 * happened and the site serves; the exit code is about what did NOT happen.
 */
function failSelfUpdateLoudly(why) {
  console.error('\n' + '!'.repeat(72));
  console.error('SELF-UPDATE WAS NOT PROVISIONED — this deployment cannot take releases');
  console.error('that change the API server from /admin until it is.');
  console.error('!'.repeat(72));
  console.error(`\nReason: ${why}`);
  console.error('\nThe site itself deployed fine and serves normally, and engine releases');
  console.error('still update from /admin with no setup. Fix the reason above and re-run:');
  console.error('  node platforms/cloudflare/install.mjs --update --yes');
  console.error('(or, to deliberately keep self-update off, run --disable-one-click --yes');
  console.error('so this stops being reported as a failure).');
  console.error('!'.repeat(72) + '\n');
  process.exit(1);
}

/**
 * --enable-one-click: runs the same automatic provisioning --deploy/--update
 * run (so a deployment that predates automatic setup, or was disabled, gets
 * fixed with one command and zero further action), and only falls back to
 * prompting for a pasted token when automatic provisioning is impossible —
 * or when the operator explicitly wants to supply a token they scoped
 * themselves, via --manual.
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
  if (!args.has('--manual')) {
    // Enabling on purpose overrides a previous opt-out — but only an explicit
    // --enable-one-click does; --deploy/--update always respect the flag.
    if (SELF_UPDATE_OFF) setSelfUpdateFlag('on');
    const result = await ensureSelfUpdate();
    if (result.ok) {
      setSelfUpdateFlag('on');
      console.log('\n✓ Self-update now covers API-server releases too. Open /admin — the');
      console.log('  Platform update card\'s "Update now" completes every release.');
      return;
    }
    console.log(`\n… automatic provisioning did not work (${result.why})`);
    console.log('Falling back to supplying a token by hand:');
  }
  await doEnableOneClick();
}

/**
 * The manual door: paste a token you minted and scoped yourself. No longer a
 * step anyone is REQUIRED to take — ensureSelfUpdate() provisions
 * automatically from whatever credential the install ran with, including a
 * plain `wrangler login` — but kept for the operator who wants to hand the
 * deployment exactly the token they chose, or to replace a broad fallback
 * credential with a narrow one (--enable-one-click --manual --yes).
 */
async function doEnableOneClick() {
  console.log('\n' + '='.repeat(72));
  console.log('SELF-UPDATE FOR API-SERVER RELEASES — what you are about to allow');
  console.log('='.repeat(72));
  console.log('\nMost releases only change the engine (the app itself), and /admin\'s');
  console.log('"Update now" already installs those with no setup and no credential —');
  console.log('they go into the site\'s own storage. This step covers the rarer release');
  console.log('that changes the API server (storylark-worker): a running Worker cannot');
  console.log('replace its own script, so redeploying it needs a Cloudflare API token.');
  console.log('\nIt cannot touch your brand or your content, and your bindings, vars and');
  console.log('secrets are read back and carried forward unchanged.');
  console.log('\nYou do not have to do this. Without it, those releases run from your own');
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
  storeSelfUpdateSecrets(token, accountId);
  setSelfUpdateFlag('on');

  console.log('\n✓ Self-update now covers API-server releases too.');
  console.log('  Open /admin — the Platform update card\'s "Update now" completes every');
  console.log('  release. (The command-line equivalent stays documented in the card as');
  console.log('  reference — it is never the required path.)');
  console.log('  Turn it off with: node platforms/cloudflare/install.mjs --disable-one-click --yes\n');
}

/** The exact inverse. Deleting the credential is also enough on its own — this is just tidier. */
async function disableOneClick() {
  if (!args.has('--yes')) {
    console.error('\nRe-run with --disable-one-click --yes to confirm.');
    process.exit(1);
  }
  for (const name of ['CF_API_TOKEN', 'CF_OAUTH_REFRESH_TOKEN', 'CF_ACCOUNT_ID']) {
    try {
      run('wrangler', ['secret', 'delete', name, '--env', deployEnv()], { stdio: 'inherit', cwd: ROOT, input: 'y\n' });
    } catch {
      console.log(`  (${name} was not set — nothing to remove.)`);
    }
  }
  // The OAuth-provisioned deployment persists the ROTATED refresh token in its
  // own database (see storylark-worker's self-deploy: the seed secret above is
  // only the chain's starting point). Deleting the secret already turns the
  // feature off — the worker refuses to use the row without the secret — but a
  // live refresh token should not be left sitting in a table, so best-effort:
  // read it, revoke it against Cloudflare's OAuth endpoint, delete the row.
  try {
    const out = run(
      'wrangler',
      ['d1', 'execute', d1Database(), '--env', deployEnv(), '--remote', '--json', '--command', 'SELECT refresh_token FROM self_update_oauth'],
      { encoding: 'utf8', cwd: ROOT }
    );
    const rows = JSON.parse(out)?.[0]?.results ?? [];
    for (const row of rows) {
      if (!row.refresh_token) continue;
      await fetch(WRANGLER_TOKEN_URL.replace(/token$/, 'revoke'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: row.refresh_token, token_type_hint: 'refresh_token', client_id: WRANGLER_CLIENT_ID }).toString(),
      }).catch(() => undefined);
    }
    run(
      'wrangler',
      ['d1', 'execute', d1Database(), '--env', deployEnv(), '--remote', '--command', 'DELETE FROM self_update_oauth'],
      { encoding: 'utf8', cwd: ROOT }
    );
    if (rows.length) console.log('  (Also revoked and removed the OAuth session state the deployment held.)');
  } catch {
    // The table may simply not exist (token-based deployments, or no install
    // ever ran) — nothing to clean is the common case, not an error.
  }
  // Sticky: --deploy/--update provision self-update automatically now, so an
  // explicit opt-out has to be recorded somewhere they will read, or the next
  // routine update would silently undo this. install.env is that somewhere.
  setSelfUpdateFlag('off');
  console.log('\n✓ Self-update is off for API-server releases, and SELF_UPDATE=off was');
  console.log('  written to install.env so --update will not re-enable it. Engine releases');
  console.log('  still update from /admin — that path stores no credential to remove.');
  console.log('  If a minted API token existed, revoke it too at');
  console.log('  https://dash.cloudflare.com/profile/api-tokens if you have not already.\n');
}

/** Record the operator's self-update choice in install.env (and in this process). */
function setSelfUpdateFlag(value) {
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (/^SELF_UPDATE=/m.test(text)) text = text.replace(/^SELF_UPDATE=.*$/m, `SELF_UPDATE=${value}`);
  else text += `${text.endsWith('\n') || text === '' ? '' : '\n'}SELF_UPDATE=${value}\n`;
  writeFileSync(envPath, text);
  SELF_UPDATE_OFF = value === 'off';
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

  console.log(`\nCreating D1 database "${d1Database()}"...`);
  let databaseId;
  try {
    const out = run('wrangler', ['d1', 'create', d1Database(), '--json'], { encoding: 'utf8', cwd: ROOT });
    databaseId = JSON.parse(out).d1_databases?.[0]?.database_id ?? JSON.parse(out).uuid;
  } catch (err) {
    console.error('Could not create/parse the D1 database. If it already exists, find its id with `wrangler d1 list` and set it in wrangler.jsonc by hand.');
    throw err;
  }
  if (!databaseId) throw new Error('wrangler d1 create --json did not return a database_id — check the wrangler version.');
  const wranglerPath = join(ROOT, 'wrangler.jsonc');
  const patched = readFileSync(wranglerPath, 'utf8').replace(
    new RegExp(`("database_name": "${d1Database()}",\\s*\\n\\s*"database_id": ")[^"]*(")`),
    `$1${databaseId}$2`
  );
  writeFileSync(wranglerPath, patched);
  console.log(`✓ wrangler.jsonc updated with database_id ${databaseId}`);

  console.log(`\nCreating R2 bucket "${r2Bucket()}"...`);
  run('wrangler', ['r2', 'bucket', 'create', r2Bucket()], { stdio: 'inherit', cwd: ROOT });

  migrateBuildDeploy();

  // ADMIN_KEY has to exist as a Worker secret before the mint call below can
  // authenticate. Set after `deploy` because `wrangler secret put` needs the
  // Worker script to already exist for this env.
  const adminKey = env.ADMIN_KEY || generateAdminKey();
  if (!env.ADMIN_KEY) console.log('\nNo ADMIN_KEY in install.env — generating one for this deployment.');
  console.log('Setting the ADMIN_KEY secret...');
  run('wrangler', ['secret', 'put', 'ADMIN_KEY', '--env', deployEnv()], {
    // Piped, never on the command line: an argv value would land in the
    // shell history and in any process listing on this machine.
    input: adminKey,
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: ROOT,
  });

  if (contentSource() === 'repo' && (env.CONTENT_SYNC_TOKEN || '').trim()) {
    console.log('Setting the repository read credential as CONTENT_SYNC_TOKEN...');
    run('wrangler', ['secret', 'put', 'CONTENT_SYNC_TOKEN', '--env', deployEnv()], {
      input: env.CONTENT_SYNC_TOKEN,
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd: ROOT,
    });
  }

  console.log('\nSaving the initial content source through StoryLark\'s validation gate...');
  await configureContentSource(env.APP_ORIGIN, adminKey);

  if (contentSource() === 'repo') console.log('\nDeployed. Repository content is connected and the initial sync completed.');
  else console.log('\nDeployed. Publish content next: node packages/pipeline/publish.mjs --brand ' + env.BRAND_ID + ' --source <path>.');
  if (env.CONTENT_ORIGIN) {
    console.log(
      `\nCONTENT_ORIGIN is ${env.CONTENT_ORIGIN}: attach an R2 custom domain to the\n` +
        `"${r2Bucket()}" bucket so it serves there (Cloudflare dashboard -> R2 ->\n` +
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

  // Self-update is part of a normal install now (AB#7418, revised): provision
  // it automatically, say exactly what was provisioned, and treat coming up
  // empty as a loud, non-zero-exit fault — never a quiet footnote.
  const selfUpdate = await ensureSelfUpdate();
  if (!selfUpdate.ok) failSelfUpdateLoudly(selfUpdate.why);
}

if (args.has('--deploy')) await deploy();
else if (args.has('--update')) await update();
else if (args.has('--enable-one-click')) await enableOneClick();
else if (args.has('--disable-one-click')) await disableOneClick();
else if (args.has('--verify') || args.size === 0) verify();
else {
  console.error(
    'Usage: node install.mjs --verify | --deploy --yes | --update --yes | --enable-one-click [--manual] --yes | --disable-one-click --yes'
  );
  process.exit(1);
}
