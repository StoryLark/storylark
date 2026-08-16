// import-theme — install, list or roll back a theme package on a live
// deployment, from a terminal (AB#7417 — plan §0c "two doors, same data").
//
// ── Why this is an HTTP client and not a storage writer ─────────────────────
// The obvious shape for a CLI would be "open the deployment's storage and write
// the theme in". It was rejected. §0c's promise is that the portal and the CLI
// produce IDENTICAL results, and the only version of that which survives future
// edits is one implementation with two callers — so this posts the same zip to
// the same `POST /api/admin/themes/import` the browser's upload button posts to.
// Same validation, same versioning, same rollback, same everything, because it
// is the same code running on the same deployment.
//
// It also means this needs no platform credential: an ADMIN_KEY (the value the
// installer already set, and the same credential the publish pipeline uses for
// POST /publish) is enough, and it works against Cloudflare, Azure, a local
// `wrangler dev` and anything else that serves the engine.
//
// Usage:
//   npm run import-theme -- --url <site> --key <ADMIN_KEY> <package.zip>
//   npm run import-theme -- --url <site> --key <k> --check <package.zip>   validate only
//   npm run import-theme -- --url <site> --key <k> --list
//   npm run import-theme -- --url <site> --key <k> --rollback <versionId>
//   npm run import-theme -- --url <site> --key <k> --rollback previous
//   npm run import-theme -- --url <site> --key <k> --revert                back to the built-in brand
//
// --url and --key default to STORYLARK_URL / STORYLARK_ADMIN_KEY in the
// environment, so a CI job sets them once.

import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const url = String(args.url ?? process.env.STORYLARK_URL ?? '').replace(/\/+$/, '');
const key = String(args.key ?? process.env.STORYLARK_ADMIN_KEY ?? '');

if (!url || !key) {
  fail(
    'import-theme — install a theme package on a live deployment.\n\n' +
      '  npm run import-theme -- --url <site> --key <ADMIN_KEY> <package.zip>\n\n' +
      'Also: --check <zip>   validate without installing\n' +
      '      --list          what is installed and what can be rolled back to\n' +
      '      --rollback <id|previous>\n' +
      '      --revert        stop overriding; wear the brand the build shipped\n\n' +
      '--url/--key fall back to STORYLARK_URL / STORYLARK_ADMIN_KEY.'
  );
}

const headers = { 'x-admin-key': key };

try {
  if (args.list) await list();
  else if (args.revert) await revert();
  else if (args.rollback) await rollback(String(args.rollback));
  else await install(args._[0], Boolean(args.check));
} catch (err) {
  fail(err.message);
}

// ── commands ────────────────────────────────────────────────────────────────

async function install(file, checkOnly) {
  if (!file) fail('Which package? Pass the path to a .storylark-theme.zip.');
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) fail(`No such file: ${file}`);
  const bytes = readFileSync(path);

  const before = await state();
  const res = await post(checkOnly ? '/api/admin/themes/validate' : '/api/admin/themes/import', bytes);
  const body = await json(res);

  if (!res.ok) {
    // The endpoint returns EVERY problem, and printing all of them is the whole
    // reason the packaging step exists — see storylark-contracts/theme-package.
    console.error(`\n✗ ${basename(path)} was rejected (${res.status} ${body.error ?? ''}).\n`);
    for (const e of body.errors ?? [body.message ?? 'unknown error']) console.error(`    ${e}`);
    for (const w of body.warnings ?? []) console.error(`    warning  ${w}`);
    if (body.applied === false) {
      console.error(
        `\n  Nothing was installed. This deployment is still wearing ${describe(before)}.\n`
      );
    }
    process.exit(1);
  }

  for (const w of body.warnings ?? []) console.log(`  warning  ${w}`);

  if (checkOnly) {
    console.log(`\n✓ ${basename(path)} is valid — "${body.manifest.name}" v${body.manifest.version} (${body.icons.length} icons${body.hasPresentation ? ', with presentation' : ''}).`);
    console.log('  Nothing was installed (--check).\n');
    return;
  }

  console.log(`\n✓ installed ${basename(path)} on ${url}`);
  console.log(`    ${describe(before)}  →  "${body.active.brand.appName ?? body.active.name}" (${body.active.themeId})`);
  console.log(`    version ${body.version.id}, ${body.active.icons.length} icons${body.active.hasPresentation ? ', presentation applied' : ', presentation unchanged'}`);
  console.log('    Live now — no rebuild, no redeploy, no restart.\n');
}

async function list() {
  const s = await state();
  console.log(`\n${url}`);
  console.log(`  wearing: ${describe(s)}`);
  if (!s.versions.length) {
    console.log('  no imported versions yet.\n');
    return;
  }
  console.log(`  history (newest first, keeping ${s.versionLimit}):`);
  for (const v of s.versions) {
    console.log(
      `    ${v.live ? '●' : '○'} ${v.id}  ${v.themeId} v${v.version}  ${new Date(v.importedAt).toISOString()}  by ${v.importedBy} (${v.source})`
    );
  }
  console.log('');
}

async function rollback(target) {
  const s = await state();
  let versionId = target;
  if (target === 'previous') {
    const previous = s.versions.filter((v) => !v.live)[0];
    if (!previous) fail('There is no previous version to roll back to.');
    versionId = previous.id;
  }
  const res = await post(`/api/admin/themes/versions/${encodeURIComponent(versionId)}/activate`);
  const body = await json(res);
  if (!res.ok) fail(body.message ?? `Rollback failed (${res.status}).`);
  console.log(`\n✓ rolled back on ${url}`);
  console.log(`    ${describe(s)}  →  "${body.active.brand.appName ?? body.active.name}" (${body.active.themeId}), version ${body.version.id}\n`);
}

async function revert() {
  const s = await state();
  const res = await fetch(`${url}/api/admin/themes/active`, { method: 'DELETE', headers });
  const body = await json(res);
  if (!res.ok) fail(body.message ?? `Revert failed (${res.status}).`);
  console.log(`\n✓ ${url} is wearing the brand its build shipped with again (was ${describe(s)}).`);
  console.log('    The version history is untouched — roll forward with --rollback <id>.\n');
}

// ── plumbing ────────────────────────────────────────────────────────────────

async function state() {
  const res = await fetch(`${url}/api/admin/themes`, { headers });
  if (res.status === 401 || res.status === 403) {
    fail(`${url} refused the ADMIN_KEY. Check --key against the deployment's ADMIN_KEY secret.`);
  }
  if (res.status === 404) {
    fail(`${url} has no theme API. It is running an engine from before theme packages (storylark-worker < 0.14.0).`);
  }
  const body = await json(res);
  if (!res.ok) fail(body.message ?? `${url} answered ${res.status}.`);
  return body;
}

function post(path, bytes) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: bytes ? { ...headers, 'content-type': 'application/zip' } : headers,
    body: bytes,
  });
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: `${res.status} ${res.statusText}: ${text.slice(0, 200)}` };
  }
}

function describe(s) {
  if (!s?.active) return `the built-in brand (${s?.builtIn?.appName ?? 'unknown'})`;
  return `"${s.active.brand?.appName ?? s.active.name}" (${s.active.themeId} v${s.active.version})`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const flag = a.slice(2);
    const next = argv[i + 1];
    // --check takes a file as a positional, not as its value; same for --list
    // and --revert. Only these three take a value.
    if ((flag === 'url' || flag === 'key' || flag === 'rollback') && next !== undefined && !next.startsWith('--')) {
      out[flag] = next;
      i++;
    } else {
      out[flag] = true;
    }
  }
  return out;
}
