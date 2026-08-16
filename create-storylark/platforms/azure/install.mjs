#!/usr/bin/env node
// Azure installer (AB#7402). Env-file-driven, per the platforms/ contract:
// fill install.env (see install.env.example), run this script.
//
//   node install.mjs --verify    sanity-checks values + az login, creates nothing
//   node install.mjs --deploy    provisions infra.bicep, then migrates + deploys
//   node install.mjs --update    pulls the latest engine packages, then migrates
//                                + rebuilds + redeploys an EXISTING deployment
//   node install.mjs --enable-one-click   opt in to the /admin "Install update"
//                                button — grants the app permission to deploy
//                                itself, and stores no credential
//   node install.mjs --disable-one-click  opt back out
//
// --deploy creates real Azure resources and real cost. It refuses to run
// without --yes as an explicit second flag, on top of whatever your own
// deployment process already requires for approval.
//
// --update (AB#7403, "platform updates must not need a GitHub token") is the
// supported way to take a new engine release. It touches no infrastructure:
// no `az deployment group create`, no new resources, nothing provisioned —
// it reads the existing deployment's outputs, bumps the pinned engine
// version, migrates, rebuilds with your brand untouched, and redeploys the
// app code. The only credential involved is your own `az login` session;
// nothing new is ever stored in the deployment. Also needs --yes, because it
// redeploys a live site.
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
// Windows resolves `az`/`wrangler`-style CLIs via .cmd shims on PATH, which
// execFileSync only finds with shell:true (matches r2-upload.mjs's own fix
// for the same issue with wrangler).
const WIN = process.platform === 'win32';
// Windows .cmd shims (az, wrangler) can't be spawned directly — Node's
// CreateProcess needs shell:true to run a batch file at all (confirmed:
// resolving `az.cmd` explicitly without shell:true fails with EINVAL). With
// shell:true args are concatenated, not escaped, so quote anything with
// spaces by hand — same pattern packages/pipeline/r2-upload.mjs already uses
// for wrangler. This script runs locally against the operator's own
// install.env, not remote/untrusted input.
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

const REQUIRED = ['BRAND_ID', 'AZURE_RESOURCE_GROUP', 'AZURE_LOCATION', 'DB_ADMIN_PASSWORD', 'APP_NAME'];

// This script runs from two different physical layouts: inside the engine
// monorepo (platforms/azure/ two levels under repo root, the site lives in
// app/) or inside a standalone `npm create storylark` scaffold (platforms/azure/
// two levels under the site root, which IS the site — no app/ subfolder).
// Detected once so the build step below can target the right one.
const REPO_ROOT = join(__dirname, '..', '..');
const IS_MONOREPO = existsSync(join(REPO_ROOT, 'app', 'package.json'));
const SITE_ROOT = IS_MONOREPO ? join(REPO_ROOT, 'app') : REPO_ROOT;

/**
 * Admin bootstrap (AB#7404), same contract as platforms/cloudflare/install.mjs.
 *
 * ADMIN_KEY is no longer something a human types into /admin — the portal is
 * gated by a normal account in the app's own users table now. It survives as
 * a deployment-config credential whose one job is to mint the FIRST admin
 * setup link, plus the printed recovery codes that are the offline way back
 * in. So the installer always needs one, generates it if the operator didn't
 * supply one (it goes in as the infra.bicep `adminKey` parameter, never on a
 * command line beyond that), and calls the mint endpoint after deploy.
 */
function generateAdminKey() {
  return randomBytes(24).toString('base64url');
}

/**
 * Poll the freshly-deployed site until it answers. App Service needs a
 * genuinely slow first boot after a zip deploy (npm install + cold start),
 * so this is patient: up to ~3 minutes.
 */
async function waitForSite(origin, attempts = 20, delayMs = 10000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet — App Service is still installing/starting
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Mint the setup link + recovery codes and print them. Never throws: a
 * failure here means the site just isn't answering yet, which is a "run one
 * command later" problem, not a reason to fail a deploy that otherwise
 * succeeded — so it prints the exact curl to run instead.
 */
async function printAdminSetup(origin, adminKey) {
  const endpoint = `${origin}/api/admin/setup/reset`;
  const manual = () => {
    console.log('\n' + '='.repeat(72));
    console.log('ADMIN SETUP — could not mint your setup link automatically.');
    console.log('(The site may not be reachable yet, or the key may not have');
    console.log('propagated.) Once the site is confirmed live, run this yourself:');
    console.log(`\n  curl -X POST ${endpoint} -H "x-admin-key: <your ADMIN_KEY>"\n`);
    console.log('ADMIN_KEY is an app setting on the Web App — read it with:');
    console.log('  az webapp config appsettings list --resource-group <rg> --name <app> \\');
    console.log('    --query "[?name==\'ADMIN_KEY\'].value" -o tsv');
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
 * Checks that apply to every mode: the values this script needs and a live
 * `az login`. Split out of verify() so --update can run them without also
 * demanding infra.bicep compile — --update never touches infrastructure, so a
 * bicep problem is not a reason to block an engine update.
 */
function verifyCommon() {
  let ok = true;

  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`✗ Missing required values in install.env: ${missing.join(', ')}`);
    ok = false;
  } else {
    console.log('✓ Required values present:', REQUIRED.join(', '));
  }

  if (env.BRAND_ID && !/^[a-z0-9-]{3,24}$/.test(env.BRAND_ID)) {
    console.error('✗ BRAND_ID must be 3-24 lowercase letters, digits, or hyphens (used to derive Azure resource names).');
    ok = false;
  }

  if (env.DB_ADMIN_PASSWORD && env.DB_ADMIN_PASSWORD.length < 12) {
    console.error('✗ DB_ADMIN_PASSWORD should be at least 12 characters.');
    ok = false;
  }

  try {
    const account = JSON.parse(run('az', ['account', 'show'], { encoding: 'utf8' }));
    console.log(`✓ Logged into Azure as ${account.user?.name ?? account.name} (subscription: ${account.name})`);
  } catch {
    console.error('✗ Not logged into Azure CLI. Run: az login');
    ok = false;
  }

  return ok;
}

function verify() {
  console.log('Verifying install.env and Azure CLI state...\n');
  let ok = verifyCommon();

  if (!existsSync(join(__dirname, 'infra.bicep'))) {
    console.error('✗ infra.bicep not found next to this script.');
    ok = false;
  } else {
    try {
      run('az', ['bicep', 'build', '--file', join(__dirname, 'infra.bicep'), '--stdout'], { stdio: 'pipe' });
      console.log('✓ infra.bicep compiles');
    } catch (err) {
      console.error('✗ infra.bicep failed to compile:', err.message);
      ok = false;
    }
  }

  console.log(ok ? '\nAll checks passed. Re-run with --deploy --yes to provision.' : '\nFix the issues above before deploying.');
  return ok;
}

/**
 * Read the existing `infra` deployment's outputs. Used by both modes: --deploy
 * reads them back after provisioning, --update reads them without provisioning
 * anything at all (that's the whole point of --update — the infrastructure is
 * already there and stays untouched).
 */
function readInfraOutputs() {
  return JSON.parse(
    run('az', ['deployment', 'group', 'show', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', 'infra', '--query', 'properties.outputs'], { encoding: 'utf8' })
  );
}

function databaseUrlFrom(outputs) {
  const dbAdminUser = env.DB_ADMIN_USER || 'storylark';
  return `postgresql://${dbAdminUser}:${env.DB_ADMIN_PASSWORD}@${outputs.postgresHost.value}:5432/storylark?sslmode=require`;
}

/** The installed storylark-worker version on disk, or null if it isn't installed yet. */
function installedEngineVersion() {
  const pkg = join(__dirname, 'node_modules', 'storylark-worker', 'package.json');
  if (!existsSync(pkg)) return null;
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * Everything that is NOT infrastructure: refresh dependencies, migrate, build,
 * zip, deploy. Shared verbatim by --deploy and --update so the two paths can
 * never drift — an update runs the exact same app deployment the first install
 * did, which is what makes "re-run this whenever" safe.
 */
function installMigrateBuildDeploy({ outputs, webAppName, brandFolder }) {
  // Refresh node_modules BEFORE migrating: migrate-postgres.mjs ships as
  // part of storylark-worker's own npm package, so its migrations-postgres/
  // set is only as current as whatever's on disk here. A bumped
  // package.json dependency range means nothing until an install actually
  // pulls the new version — confirmed live: a package.json bump to
  // ^0.8.0 with no `npm install` ran the migrate step against a stale
  // 0.7.1 node_modules, which truthfully reported "up to date" against an
  // incomplete migration set (missing 0007_admin_accounts.sql) while the
  // separately-built/deployed app code was already current, leaving the
  // database out of sync with the code that reads it.
  console.log('\nInstalling dependencies (picks up any storylark-worker/storylark-core version bump)...');
  run('npm', ['install'], { stdio: 'inherit', cwd: __dirname });

  console.log('\nApplying database migrations...');
  // migrate-postgres.mjs ships as part of storylark-worker itself (not the
  // engine-repo-only path this used to hardcode) — resolves the same way in
  // both the monorepo (platforms/azure's own standalone npm install) and a
  // standalone scaffolded site, since both get storylark-worker from npm.
  const migrateScript = join(__dirname, 'node_modules', 'storylark-worker', 'migrate-postgres.mjs');
  run('node', [migrateScript, `--connection-string=${databaseUrlFrom(outputs)}`], { stdio: 'inherit' });

  console.log(`\nBuilding the app for brand "${brandFolder}"...`);
  // appOrigin/contentOrigin are deployment config (deployment/<id>/deployment.json),
  // and the file's values belong to whichever deployment wrote them (e.g. pointing
  // at Cloudflare) — override them at build time to THIS deployment's real origins, so the client fetches its manifest from the Azure content it
  // actually has instead of silently hitting a different platform's content
  // (confirmed bug: without this, the deployed app hung on "Loading the
  // library..." forever, fetching content.storylark.dev's manifest instead
  // of this deployment's own storage).
  const buildArgs = IS_MONOREPO ? ['run', 'build', '-w', 'app', '--', '--mode', brandFolder] : ['run', 'build'];
  run('npm', buildArgs, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, STORYLARK_APP_ORIGIN: outputs.appOrigin.value, STORYLARK_CONTENT_ORIGIN: outputs.contentOrigin.value },
  });

  console.log('\nStaging and deploying app code to App Service...');
  const stage = join(tmpdir(), `storylark-azure-deploy-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  // Every runtime source file next to server.mjs, not just server.mjs itself
  // — confirmed live: a sibling .mjs file (content-store.mjs) that server.mjs
  // imports was left out of a hand-picked file list here, so the deployed zip
  // was missing a module server.mjs needed and the container crashed on boot
  // with ERR_MODULE_NOT_FOUND. install.mjs itself is excluded (it's the
  // deploy tool, never imported at runtime); everything else `.mjs` in this
  // directory ships, so a future runtime file added the same way as
  // content-store.mjs can't hit this again.
  for (const entry of readdirSync(__dirname)) {
    if (entry.endsWith('.mjs') && entry !== 'install.mjs') {
      cpSync(join(__dirname, entry), join(stage, entry));
    }
  }
  cpSync(join(__dirname, 'package.json'), join(stage, 'package.json'));
  if (existsSync(join(__dirname, 'package-lock.json'))) cpSync(join(__dirname, 'package-lock.json'), join(stage, 'package-lock.json'));
  cpSync(join(SITE_ROOT, 'dist'), join(stage, 'app', 'dist'), { recursive: true });

  const zipPath = join(tmpdir(), `storylark-azure-deploy-${Date.now()}.zip`);
  if (WIN) {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`]);
  } else {
    run('zip', ['-rq', zipPath, '.'], { cwd: stage });
  }
  run('az', ['webapp', 'deploy', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', webAppName, '--src-path', zipPath, '--type', 'zip'], { stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
}

/**
 * --update (AB#7403): take a new engine release on an EXISTING deployment,
 * using only the operator's own `az login`. No infrastructure calls, no new
 * secrets, no GitHub anything. Safe to re-run: if you're already on the latest
 * engine it just rebuilds and redeploys what you have, which also repairs a
 * deployment that drifted from its own source.
 */
async function update() {
  console.log('Verifying install.env and Azure CLI state...\n');
  if (!verifyCommon()) {
    console.error('\nRefusing to update: verification failed.');
    process.exit(1);
  }
  if (!args.has('--yes')) {
    console.error('\n--update rebuilds and redeploys a live site. Re-run with --update --yes to confirm.');
    process.exit(1);
  }

  let outputs;
  try {
    outputs = readInfraOutputs();
  } catch {
    console.error(
      `\nNo existing "infra" deployment found in resource group "${env.AZURE_RESOURCE_GROUP}".\n` +
        '--update only updates a site that is already deployed. Run --deploy --yes first.'
    );
    process.exit(1);
  }

  const before = installedEngineVersion();
  console.log(`\nCurrently installed engine: storylark-worker ${before ?? '(not installed yet)'}`);

  // Mirrors self-update.yml's bump step: pin exactly, so what you deployed is
  // reproducible rather than "whatever the range resolved to that day".
  console.log('\nFetching the latest engine packages from npm...');
  run('npm', ['install', '--save-exact', 'storylark-worker@latest'], { stdio: 'inherit', cwd: __dirname });
  if (IS_MONOREPO) {
    console.log(
      '\nNote: this is the StoryLark engine monorepo, so the app itself builds from\n' +
        'packages/core in this working tree, not from the published storylark-core.\n' +
        'To move the app forward here, pull the repo — --update only refreshes the\n' +
        'server-side engine package that platforms/azure/ depends on.'
    );
  } else {
    run('npm', ['install', '--save-exact', 'storylark-core@latest', 'storylark-worker@latest'], { stdio: 'inherit', cwd: REPO_ROOT });
  }

  const brandFolder = env.BRAND || env.BRAND_ID;
  const webAppName = `${env.BRAND_ID}-app`;
  installMigrateBuildDeploy({ outputs, webAppName, brandFolder });

  const after = installedEngineVersion();
  const origin = outputs.appOrigin?.value ?? `https://${webAppName}.azurewebsites.net`;
  console.log('\n' + '='.repeat(72));
  console.log('UPDATE COMPLETE');
  console.log('='.repeat(72));
  if (before && after && before !== after) {
    console.log(`\nEngine: storylark-worker ${before} -> ${after}`);
  } else if (after) {
    console.log(`\nEngine: storylark-worker ${after} (already the latest — rebuilt and redeployed anyway).`);
  }
  console.log(`Site:   ${origin}`);
  console.log('\nNothing about your brand or your content was touched: no resource was');
  console.log('created or changed, no secret was added, and nothing new is stored in');
  console.log('the deployment. The only credential used was your own az login.');
  console.log('\nCheck it landed: open /admin on the site — the Platform update card');
  console.log('reads the version out of the deployment itself.');
  console.log('='.repeat(72) + '\n');
}

/**
 * --enable-one-click (AB#7418 — plan §4 layer 3): opt this deployment in to the
 * /admin "Install update" button.
 *
 * §4 wrote layer 3 as "the installer stores that platform's own deploy
 * credential as a deployment secret". On Azure that turns out to be the wrong
 * shape, and a strictly worse one: App Service already gives a running site an
 * identity, and Kudu — the deployment engine that `az webapp deploy` itself
 * drives — accepts a Microsoft Entra token. So this stores NO credential at
 * all. It does two things, both of them visible in the portal and both
 * revocable there:
 *
 *   1. turns on a system-assigned managed identity for the Web App
 *   2. gives that identity "Website Contributor" ON THE WEB APP ITSELF —
 *      not the resource group, not the subscription — which carries
 *      Microsoft.Web/sites/publish/Action, the permission Kudu checks
 *
 * The blast radius is one site: the identity can redeploy the app it belongs
 * to and nothing else. Nothing to leak, nothing to rotate, and turning it off
 * is deleting a role assignment.
 */
async function enableOneClick() {
  console.log('Verifying install.env and Azure CLI state...\n');
  if (!verifyCommon()) {
    console.error('\nRefusing to continue: verification failed.');
    process.exit(1);
  }
  if (!args.has('--yes')) {
    console.error(
      '\n--enable-one-click gives this Web App permission to redeploy itself.\n' +
        'Re-run with --enable-one-click --yes to confirm.'
    );
    process.exit(1);
  }

  const webAppName = `${env.BRAND_ID}-app`;
  console.log('\n' + '='.repeat(72));
  console.log('ONE-CLICK UPDATES — what you are about to allow');
  console.log('='.repeat(72));
  console.log(`\nAn admin signed into /admin on ${webAppName} will be able to press`);
  console.log('"Install update". That downloads the prebuilt engine for the version the');
  console.log('portal shows, checks it against its published checksum, migrates the');
  console.log('database, and redeploys this app through its own Kudu endpoint.');
  console.log('\nNo credential is stored anywhere. The app authenticates with a managed');
  console.log('identity token it fetches at the moment of use, and the permission below');
  console.log('is scoped to this one site.');
  console.log('\nYou do not have to do this. Without it, updates run from your own');
  console.log('machine with:  node platforms/azure/install.mjs --update --yes');
  console.log('='.repeat(72));

  console.log('\nEnabling the system-assigned managed identity...');
  const identity = JSON.parse(
    run('az', ['webapp', 'identity', 'assign', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', webAppName], { encoding: 'utf8' })
  );
  const principalId = identity.principalId ?? identity.PrincipalId;
  if (!principalId) throw new Error('az webapp identity assign returned no principalId.');
  console.log(`✓ Managed identity principal ${principalId}`);

  const scope = run(
    'az',
    ['webapp', 'show', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', webAppName, '--query', 'id', '-o', 'tsv'],
    { encoding: 'utf8' }
  ).trim();

  console.log(`\nGranting "Website Contributor" on ${scope}...`);
  try {
    run(
      'az',
      [
        'role', 'assignment', 'create',
        '--assignee-object-id', principalId,
        '--assignee-principal-type', 'ServicePrincipal',
        '--role', 'Website Contributor',
        '--scope', scope,
      ],
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error(
      '\n✗ Could not create the role assignment. This needs Owner or User Access Administrator on the site\n' +
        '  (Contributor cannot grant roles). Either re-run as someone who has it, or ask them for:\n\n' +
        `    az role assignment create --assignee-object-id ${principalId} \\\n` +
        '      --assignee-principal-type ServicePrincipal --role "Website Contributor" \\\n' +
        `      --scope ${scope}\n`
    );
    throw err;
  }

  console.log('\n✓ One-click updates are on.');
  console.log('  Role assignments can take a minute or two to take effect. Open /admin —');
  console.log('  the Platform update card checks the permission for real before it offers');
  console.log('  a button, so if it still says "off", give it a moment and reload.');
  console.log('  Turn it off with: node platforms/azure/install.mjs --disable-one-click --yes\n');
}

/** The exact inverse: drop the role assignment, then the identity. */
function disableOneClick() {
  if (!args.has('--yes')) {
    console.error('\nRe-run with --disable-one-click --yes to confirm.');
    process.exit(1);
  }
  const webAppName = `${env.BRAND_ID}-app`;
  const scope = run(
    'az',
    ['webapp', 'show', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', webAppName, '--query', 'id', '-o', 'tsv'],
    { encoding: 'utf8' }
  ).trim();
  const principalId = run(
    'az',
    ['webapp', 'identity', 'show', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', webAppName, '--query', 'principalId', '-o', 'tsv'],
    { encoding: 'utf8' }
  ).trim();

  if (principalId) {
    console.log('Removing the role assignment...');
    try {
      run('az', ['role', 'assignment', 'delete', '--assignee', principalId, '--role', 'Website Contributor', '--scope', scope], {
        stdio: 'inherit',
      });
    } catch {
      console.log('  (no matching role assignment — already gone.)');
    }
  }
  console.log('Removing the managed identity...');
  run('az', ['webapp', 'identity', 'remove', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', webAppName], { stdio: 'inherit' });
  console.log('\n✓ One-click updates are off. /admin now shows the installer command only.\n');
}

async function deploy() {
  if (!verify()) {
    console.error('\nRefusing to deploy: verification failed.');
    process.exit(1);
  }
  if (!args.has('--yes')) {
    console.error('\n--deploy creates real Azure resources and real cost. Re-run with --deploy --yes to confirm.');
    process.exit(1);
  }

  console.log(`\nDeploying infrastructure for brand "${env.BRAND_ID}" to resource group "${env.AZURE_RESOURCE_GROUP}"...`);
  const parameters = [
    `brandId=${env.BRAND_ID}`,
    `location=${env.AZURE_LOCATION}`,
    `dbAdminPassword=${env.DB_ADMIN_PASSWORD}`,
    // Explicit, required (see REQUIRED above) — matches the Cloudflare
    // installer's own APP_NAME field. infra.bicep has no default for this
    // anymore: it used to silently fall back to the brandId/brand folder
    // slug (e.g. "storylark"), which is a resource-naming id, not a display
    // name, and diverged from what a Cloudflare install of the same brand
    // shows in the UI, emails, and WebAuthn prompts.
    `appName=${env.APP_NAME}`,
  ];
  // Optional: run a brands/<id>/ folder that differs from the Azure resource
  // naming prefix (BRAND_ID) — e.g. testing BRAND_ID=my-brand-dev against the
  // real brands/my-brand/ folder.
  if (env.BRAND) parameters.push(`brand=${env.BRAND}`);
  // Postgres Flexible Server provisioning is restricted to a subset of regions
  // per subscription (independent of the region's general availability) — a
  // deploy can fail with `ParameterOutOfRange: 'Version' should be in: []`
  // even though the SKU/version combo genuinely exists. If AZURE_LOCATION is
  // restricted for your subscription, set DB_LOCATION to an unrestricted one
  // (check via: az rest --method get --url "https://management.azure.com/subscriptions/<sub>/providers/Microsoft.DBforPostgreSQL/locations/<region>/capabilities?api-version=2025-08-01" --query "value[0].reason").
  if (env.DB_LOCATION) parameters.push(`dbLocation=${env.DB_LOCATION}`);
  if (env.APP_SERVICE_SKU) parameters.push(`appServiceSku=${env.APP_SERVICE_SKU}`);
  // Always set, generated if the operator didn't supply one: the admin
  // portal's first-login setup link can't be minted without it (AB#7404).
  const adminKey = env.ADMIN_KEY || generateAdminKey();
  if (!env.ADMIN_KEY) console.log('\nNo ADMIN_KEY in install.env — generating one for this deployment.');
  parameters.push(`adminKey=${adminKey}`);
  run(
    'az',
    [
      'deployment', 'group', 'create',
      '--resource-group', env.AZURE_RESOURCE_GROUP,
      '--template-file', join(__dirname, 'infra.bicep'),
      '--parameters', ...parameters,
    ],
    { stdio: 'inherit' }
  );
  console.log('\nInfrastructure deployed.');

  const outputs = readInfraOutputs();
  const webAppName = `${env.BRAND_ID}-app`;
  const brandFolder = env.BRAND || env.BRAND_ID;
  installMigrateBuildDeploy({ outputs, webAppName, brandFolder });

  console.log(`\nDeployed. Live at: https://${webAppName}.azurewebsites.net`);
  const bucketHint = env.BRAND_ID !== brandFolder ? ` --bucket ${env.BRAND_ID}-content` : '';
  console.log(`Publish content with: AZURE_STORAGE_CONNECTION_STRING=<from the app's own settings> node ../../packages/pipeline/publish.mjs --brand ${brandFolder}${bucketHint} --source <path> --storage azure-blob`);

  console.log('\nWaiting for the site to come up so we can mint your admin setup link...');
  await printAdminSetup(outputs.appOrigin?.value ?? `https://${webAppName}.azurewebsites.net`, adminKey);
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
