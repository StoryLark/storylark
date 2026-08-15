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
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

function deploy() {
  if (!verify()) {
    console.error('\nRefusing to deploy: verification failed.');
    process.exit(1);
  }
  if (!args.has('--yes')) {
    console.error('\n--deploy creates real Azure resources and real cost. Re-run with --deploy --yes to confirm.');
    process.exit(1);
  }

  console.log(`\nDeploying infrastructure for brand "${env.BRAND_ID}" to resource group "${env.AZURE_RESOURCE_GROUP}"...`);
  run(
    'az',
    [
      'deployment', 'group', 'create',
      '--resource-group', env.AZURE_RESOURCE_GROUP,
      '--template-file', join(__dirname, 'infra.bicep'),
      '--parameters', `brandId=${env.BRAND_ID}`, `location=${env.AZURE_LOCATION}`, `dbAdminPassword=${env.DB_ADMIN_PASSWORD}`,
    ],
    { stdio: 'inherit' }
  );

  console.log('\nInfrastructure deployed. Next: fill platforms/azure/.env from the deployment outputs, run `npm run migrate`, then `npm start` or deploy the App Service.');
}

if (args.has('--deploy')) deploy();
else if (args.has('--verify') || args.size === 0) verify();
else {
  console.error('Usage: node install.mjs --verify | --deploy --yes');
  process.exit(1);
}
