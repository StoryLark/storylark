#!/usr/bin/env node
// Read-only deployment diagnostics for a standalone StoryLark site.
// Human output is concise; --json is stable enough for CI/AI inspection.
// Secret values are never read or printed — only binding names returned by
// Wrangler's list command are considered.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const live = args.has('--live');
const checks = [];

function add(id, ok, message, severity = 'error', details = undefined) {
  checks.push({ id, ok, severity, message, ...(details === undefined ? {} : { details }) });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function envFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

const pkg = readJson(join(root, 'package.json'));
add('package-json', !!pkg, 'package.json parses');

const marker = readJson(join(root, '.storylark', 'project.json'));
add(
  'project-marker',
  !!marker,
  marker ? `npm-create project metadata found (${marker.brandId})` : 'Missing .storylark/project.json; provenance cannot be proven',
  'warning'
);

const brandDirs = existsSync(join(root, 'brands'))
  ? readdirSync(join(root, 'brands'), { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name)
  : [];
const brandId = marker?.brandId ?? (brandDirs.length === 1 ? brandDirs[0] : null);
add('brand-id', !!brandId, brandId ? `Brand id: ${brandId}` : 'Could not determine one brand id');

for (const name of ['storylark-core', 'storylark-worker', 'storylark-pipeline']) {
  const declared = pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name];
  const exact = typeof declared === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(declared);
  add(`dependency:${name}`, !!declared, declared ? `${name} declared at ${declared}` : `${name} is not declared`);
  add(`exact:${name}`, exact, exact ? `${name} is pinned exactly` : `${name} must use an exact version`, 'warning');

  const installed = readJson(join(root, 'node_modules', name, 'package.json'))?.version;
  add(
    `installed:${name}`,
    !!installed,
    installed ? `${name} ${installed} installed` : `${name} is not installed; run npm install`
  );
  if (installed && exact) add(`version-match:${name}`, installed === declared, `${name}: package.json ${declared}, installed ${installed}`);
}

const lock = readJson(join(root, 'package-lock.json'));
add('package-lock', !!lock, lock ? 'package-lock.json parses' : 'Missing or invalid package-lock.json');
if (lock) {
  for (const name of ['storylark-core', 'storylark-worker', 'storylark-pipeline']) {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    add(`locked:${name}`, !!locked, locked ? `${name} ${locked} locked` : `${name} is missing from package-lock.json`);
  }
}

if (brandId) {
  const brand = readJson(join(root, 'brands', brandId, 'brand.json'));
  const deployment = readJson(join(root, 'deployment', brandId, 'deployment.json'));
  const presentation = readJson(join(root, 'presentation', brandId, 'presentation.json'));
  add('brand-config', !!brand && brand.contractVersion === 1 && brand.id === brandId, 'brand.json exists, parses, and matches the brand id');
  add('deployment-config', !!deployment && deployment.contractVersion === 1, 'deployment.json exists and parses');
  add('presentation-config', !!presentation && presentation.contractVersion === 1, 'presentation.json exists and parses');
}

for (const workflow of ['publish.yml', 'sync.yml', 'narrate.yml']) {
  const file = join(root, '.github', 'workflows', workflow);
  if (!existsSync(file)) continue;
  add(`workflow:${workflow}`, !!pkg?.devDependencies?.['storylark-pipeline'], `${workflow} has a declared storylark-pipeline dependency`);
}

const platform = marker?.platform;
if (platform) {
  const env = envFile(join(root, 'platforms', platform, 'install.env'));
  const deployEnv = env.CLOUDFLARE_ENV || marker?.cloudflare?.environment || brandId;
  const d1Database = env.D1_DATABASE || marker?.cloudflare?.d1Database || brandId;
  add('install-env', Object.keys(env).length > 0, `platforms/${platform}/install.env is present`);
  add(
    'self-update-opt-out',
    String(env.SELF_UPDATE ?? '').toLowerCase() !== 'off',
    String(env.SELF_UPDATE ?? '').toLowerCase() === 'off' ? 'One-click Worker updates are explicitly disabled' : 'No explicit self-update opt-out',
    'warning'
  );

  if (live && platform === 'cloudflare' && brandId) {
    const wranglerCli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    add('local:wrangler', existsSync(wranglerCli), existsSync(wranglerCli) ? 'Local Wrangler CLI is installed' : 'Wrangler is not installed locally');
    const command = process.execPath;
    const secrets = spawnSync(command, [wranglerCli, 'secret', 'list', '--env', deployEnv, '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    let names = [];
    try {
      names = JSON.parse(secrets.stdout || '[]').map((x) => x.name).filter(Boolean);
    } catch {
      names = [];
    }
    add('live:secrets', secrets.status === 0, secrets.status === 0 ? `Worker secret names readable (${names.length})` : 'Could not list Worker secret names');
    add(
      'live:self-update',
      names.includes('CF_API_TOKEN') || names.includes('CF_OAUTH_REFRESH_TOKEN'),
      names.includes('CF_API_TOKEN') || names.includes('CF_OAUTH_REFRESH_TOKEN')
        ? 'Worker self-update credential is present'
        : 'Worker self-update credential is missing',
      'warning'
    );
    add('live:admin-key', names.includes('ADMIN_KEY'), names.includes('ADMIN_KEY') ? 'ADMIN_KEY is present' : 'ADMIN_KEY is missing', 'warning');

    const state = spawnSync(
      command,
      [
        wranglerCli,
        'd1',
        'execute',
        d1Database,
        '--env',
        deployEnv,
        '--remote',
        '--json',
        '--command',
        'SELECT config FROM content_sync WHERE id = 1; SELECT COUNT(*) AS admins FROM users WHERE is_admin = 1;',
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true }
    );
    let resultSets = [];
    try {
      resultSets = JSON.parse(state.stdout || '[]');
    } catch {
      resultSets = [];
    }
    const rows = resultSets.flatMap((result) => result?.results ?? []);
    const configRow = rows.find((row) => Object.hasOwn(row, 'config'));
    const adminRow = rows.find((row) => Object.hasOwn(row, 'admins'));
    let contentMode = null;
    try {
      contentMode = configRow?.config ? JSON.parse(configRow.config).mode : null;
    } catch {
      contentMode = 'invalid';
    }
    add(
      'live:content-connection',
      contentMode === 'repo',
      contentMode === 'repo' ? 'First-party repository content connection is configured' : `Content connection mode is ${contentMode ?? 'not configured'}`,
      'warning'
    );
    add(
      'live:admin-account',
      Number(adminRow?.admins ?? 0) > 0,
      Number(adminRow?.admins ?? 0) > 0 ? `${adminRow.admins} admin account(s) found` : 'No admin account found',
      'warning'
    );

    const origin = env.APP_ORIGIN;
    if (origin) {
      try {
        const health = await fetch(`${origin.replace(/\/+$/, '')}/api/health`);
        const body = await health.json().catch(() => null);
        add('live:health', health.ok && body?.ok === true, health.ok ? `Live health answered for ${body?.brand ?? 'unknown brand'}` : `Live health returned HTTP ${health.status}`);
      } catch (err) {
        add('live:health', false, `Live health failed: ${err.message}`);
      }
    }
  }
}

const failures = checks.filter((x) => !x.ok && x.severity === 'error');
const warnings = checks.filter((x) => !x.ok && x.severity === 'warning');
if (json) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures: failures.length, warnings: warnings.length, checks }, null, 2));
} else {
  console.log('StoryLark doctor\n');
  for (const check of checks) console.log(`${check.ok ? '✓' : check.severity === 'warning' ? '!' : '✗'} ${check.message}`);
  console.log(`\n${failures.length} error(s), ${warnings.length} warning(s).`);
}
process.exitCode = failures.length ? 1 : 0;
