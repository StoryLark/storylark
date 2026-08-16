#!/usr/bin/env node
// Azure installer (AB#7402). Env-file-driven, per the platforms/ contract:
// fill install.env (see install.env.example), run this script.
//
//   node install.mjs --verify    sanity-checks values + az login, creates nothing
//   node install.mjs --deploy    provisions infra.bicep, then migrates + deploys
//
// --deploy creates real Azure resources and real cost. It refuses to run
// without --yes as an explicit second flag, on top of whatever your own
// deployment process already requires for approval.
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
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

const REQUIRED = ['BRAND_ID', 'AZURE_RESOURCE_GROUP', 'AZURE_LOCATION', 'DB_ADMIN_PASSWORD'];

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
    console.log('ADMIN SETUP — could not reach the site to mint your setup link.');
    console.log('Once the site is confirmed live, run this yourself:');
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

function verify() {
  console.log('Verifying install.env and Azure CLI state...\n');
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
  const parameters = [`brandId=${env.BRAND_ID}`, `location=${env.AZURE_LOCATION}`, `dbAdminPassword=${env.DB_ADMIN_PASSWORD}`];
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

  const outputs = JSON.parse(
    run('az', ['deployment', 'group', 'show', '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', 'infra', '--query', 'properties.outputs'], { encoding: 'utf8' })
  );
  const dbAdminUser = env.DB_ADMIN_USER || 'storylark';
  const databaseUrl = `postgresql://${dbAdminUser}:${env.DB_ADMIN_PASSWORD}@${outputs.postgresHost.value}:5432/storylark?sslmode=require`;
  const webAppName = `${env.BRAND_ID}-app`;

  console.log('\nApplying database migrations...');
  // migrate-postgres.mjs ships as part of storylark-worker itself (not the
  // engine-repo-only path this used to hardcode) — resolves the same way in
  // both the monorepo (platforms/azure's own standalone npm install) and a
  // standalone scaffolded site, since both get storylark-worker from npm.
  const migrateScript = join(__dirname, 'node_modules', 'storylark-worker', 'migrate-postgres.mjs');
  run('node', [migrateScript, `--connection-string=${databaseUrl}`], { stdio: 'inherit' });

  const brandFolder = env.BRAND || env.BRAND_ID;
  console.log(`\nBuilding the app for brand "${brandFolder}"...`);
  // brand.json's appOrigin/contentOrigin are fixed values (e.g. pointing at
  // Cloudflare) — override them at build time to this deployment's real
  // origins, so the client fetches its manifest from the Azure content it
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
  cpSync(join(__dirname, 'server.mjs'), join(stage, 'server.mjs'));
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

  console.log(`\nDeployed. Live at: https://${webAppName}.azurewebsites.net`);
  const bucketHint = env.BRAND_ID !== brandFolder ? ` --bucket ${env.BRAND_ID}-content` : '';
  console.log(`Publish content with: AZURE_STORAGE_CONNECTION_STRING=<from the app's own settings> node ../../packages/pipeline/publish.mjs --brand ${brandFolder}${bucketHint} --source <path> --storage azure-blob`);

  console.log('\nWaiting for the site to come up so we can mint your admin setup link...');
  await printAdminSetup(outputs.appOrigin?.value ?? `https://${webAppName}.azurewebsites.net`, adminKey);
}

if (args.has('--deploy')) await deploy();
else if (args.has('--verify') || args.size === 0) verify();
else {
  console.error('Usage: node install.mjs --verify | --deploy --yes');
  process.exit(1);
}
