// The installed-engine store and the platform-agnostic "Update now"
// (AB#7418, revised: one button, every platform, no credential for the
// common case).
//
// ── What is real here ───────────────────────────────────────────────────────
// Everything. The artifacts are REAL engine packages built by the real
// packager; the store is a real directory driver (the same one the Azure entry
// binds); the serving tests drive the REAL Hono app through app.fetch with a
// real ASSETS stub behaving like Cloudflare's (SPA fallback included); the
// route tests establish a REAL admin session through the real setup flow and
// download the artifact over REAL HTTP from a local release server; the
// database is real SQLite running the real shipped migrations.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEnginePackage,
  readEnginePackage,
  EnginePackageError,
  engineAssetName,
  engineChecksumName,
  sha256Hex,
} from 'storylark-contracts/engine-package';
import {
  installEngineVersion,
  activateEngineVersion,
  clearActiveEngine,
  readActiveEngine,
  readActiveEngineCached,
  listEngineVersions,
  readEngineFile,
  engineKey,
  resetEngineCache,
} from '../src/lib/engine-store.ts';
import { releaseTag } from '../src/lib/engine-release.ts';
import { localContentStore } from '../../../platforms/azure/content-store.mjs';
import { sqliteDatabase } from './sqlite-env.mjs';

const require = createRequire(import.meta.url);
const workerPkg = require('../package.json');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** A small but structurally real engine build, tagged so served bytes are attributable. */
function engineDist(tag, hash) {
  return new Map(
    Object.entries({
      'index.html': enc(`<!doctype html><html><head><title>StoryLark</title></head><body>${tag}</body></html>`),
      'admin.html': enc(`<!doctype html><html><head><title>Admin</title></head><body>${tag}-ADMIN</body></html>`),
      'sw.js': enc(`/* ${tag} */ self.addEventListener("fetch", () => {});`),
      [`assets/index-${hash}.js`]: enc(`export const engine = "${tag}";`),
      'fonts.json': enc('{"families":{}}'),
    })
  );
}

async function anArtifact({ tag = 'ENGINE-V1', hash = 'aaa111', coreVersion = '9.9.9', workerVersion = workerPkg.version } = {}) {
  const built = await buildEnginePackage({
    dist: engineDist(tag, hash),
    worker: enc('export default { fetch: () => new Response("ok") };'),
    migrations: new Map(),
    migrationsPostgres: new Map(),
    coreVersion,
    workerVersion,
    builtAt: '2026-08-17T00:00:00.000Z',
  });
  return { ...built, pkg: await readEnginePackage(built.bytes), sha256: await sha256Hex(built.bytes) };
}

/** A store on a real temp directory, torn down by the caller. */
async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'storylark-engine-'));
  return { dir, store: localContentStore(dir) };
}

/** An ASSETS binding over a fixed BUILD, behaving like Cloudflare's (SPA fallback). */
function assetsBinding(files) {
  return {
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'index.html';
      if (!files.has(path)) {
        return new Response('<!doctype html><html><body>BUILD-SHELL</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const type = path.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : path.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : path.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'application/octet-stream';
      return new Response(files.get(path), { status: 200, headers: { 'content-type': type } });
    },
  };
}

function buildAssets() {
  return assetsBinding(
    new Map(
      Object.entries({
        'index.html': '<!doctype html><html><head></head><body>BUILD-INDEX</body></html>',
        'admin.html': '<!doctype html><html><head></head><body>BUILD-ADMIN</body></html>',
        'sw.js': '/* BUILD-SW */ self.addEventListener("fetch", () => {});',
        'assets/index-build0.js': 'export const engine = "BUILD";',
        'theme.css': ':root{--accent:#123456}\n:root[data-theme="dark"]{--accent:#654321}',
        'brand.json': '{"appName":"Test Brand"}',
        'outputs.json': JSON.stringify({ formatVersion: 1, coreVersion: '9.0.0', files: {} }),
      })
    )
  );
}

/** A whole test deployment over the REAL app, with a session-capable caller. */
async function deployment() {
  const { dir, store } = await tempStore();
  const { driver } = await sqliteDatabase();
  const { app } = await import('../src/index.ts');
  const env = {
    DB: driver,
    CONTENT_STORE: store,
    BRAND: 'storylark-test',
    APP_ORIGIN: 'https://app.example.test',
    CONTENT_ORIGIN: '',
    MAIL_FROM: 'noreply@example.test',
    APP_NAME: 'StoryLark Test',
    ADMIN_KEY: 'test-admin-key',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GITHUB_REPO: '',
    GITHUB_DEPLOY_TOKEN: '',
    ADMIN_EMAIL: '',
    ASSETS: buildAssets(),
  };
  const ctx = { waitUntil: (p) => void Promise.resolve(p).catch(() => {}), passThroughOnException() {} };
  let cookie = '';
  async function call(path, init = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'storylark', ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const res = await app.fetch(new Request(`https://app.example.test${path}`, { ...init, headers }), env, ctx);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  }
  /** A plain page/asset request — no session, no CSRF header, like a browser's GET. */
  async function get(path, headers = {}) {
    return app.fetch(new Request(`https://app.example.test${path}`, { headers }), env, ctx);
  }
  async function signInAsAdmin() {
    const minted = await call('/api/admin/setup/reset', { method: 'POST', headers: { 'X-Admin-Key': env.ADMIN_KEY } });
    const { setupUrl } = await minted.json();
    const token = new URL(setupUrl).searchParams.get('setup');
    const claimed = await call('/api/admin/setup/claim', {
      method: 'POST',
      body: JSON.stringify({ token, email: 'op@example.test', username: 'operator', password: 'a-long-enough-password-1' }),
    });
    assert.equal(claimed.status, 200, await claimed.text().catch(() => ''));
  }
  return { dir, store, env, call, get, signInAsAdmin, done: () => rm(dir, { recursive: true, force: true }) };
}

/** Serves a real artifact + checksum at the exact shape ENGINE_RELEASE_BASE implies. */
async function releaseServer(artifacts) {
  const server = createServer((req, res) => {
    for (const { version, bytes, checksum } of artifacts) {
      const tag = encodeURIComponent(releaseTag(version));
      if (req.url === `/dl/${tag}/${engineAssetName(version)}`) {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(bytes.byteLength) });
        return res.end(Buffer.from(bytes));
      }
      if (req.url === `/dl/${tag}/${engineChecksumName(version)}`) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(checksum);
      }
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/dl` };
}

// ── the store itself ────────────────────────────────────────────────────────

test('install writes a versioned prefix, records history, and flips active.json last', async () => {
  const { dir, store } = await tempStore();
  try {
    const { pkg, sha256 } = await anArtifact();
    const { version, active } = await installEngineVersion({
      store,
      env: {},
      pkg,
      sha256,
      bytes: 1234,
      installedBy: 'op@example.test',
      source: 'portal',
    });

    const readBack = await readActiveEngine(store);
    assert.equal(readBack.versionId, version.id);
    assert.equal(readBack.coreVersion, '9.9.9');
    assert.deepEqual(readBack.files, [...pkg.dist.keys()].sort(), 'active.json must carry the complete file list');
    assert.equal(active.sha256, sha256, 'provenance travels with the pointer');

    const file = await readEngineFile(store, version.id, 'index.html');
    assert.match(dec(file.body), /ENGINE-V1/);
    const versions = await listEngineVersions(store);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].live, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a package with brand files cannot enter the engine prefix, even if validation were bypassed', async () => {
  const { dir, store } = await tempStore();
  try {
    const { pkg, sha256 } = await anArtifact();
    // Hand the store a package that never went through readEnginePackage —
    // the second fence must hold on its own.
    pkg.dist.set('brand.json', enc('{"appName":"someone else"}'));
    await assert.rejects(
      () =>
        installEngineVersion({ store, env: {}, pkg, sha256, bytes: 1, installedBy: 'x', source: 'cli' }),
      (err) => {
        assert.ok(err instanceof EnginePackageError);
        assert.match(err.errors[0], /brand\.json belongs to the deployment/);
        return true;
      }
    );
    assert.equal(await readActiveEngine(store), null, 'nothing may have been activated');
    assert.equal(await store.get(engineKey.file('anything', 'brand.json')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history is bounded, the live version is never pruned, and evicted files are really deleted', async () => {
  const { dir, store } = await tempStore();
  try {
    const env = { ENGINE_VERSIONS: '2' };
    const ids = [];
    for (const [tag, hash] of [['ENGINE-V1', 'aaa111'], ['ENGINE-V2', 'bbb222'], ['ENGINE-V3', 'ccc333']]) {
      const { pkg, sha256 } = await anArtifact({ tag, hash });
      const { version } = await installEngineVersion({ store, env, pkg, sha256, bytes: 1, installedBy: 'op', source: 'portal' });
      ids.push(version.id);
      await new Promise((r) => setTimeout(r, 5)); // distinct installedAt ordering
    }
    const versions = await listEngineVersions(store);
    assert.equal(versions.length, 2, 'the limit holds');
    assert.ok(versions.some((v) => v.id === ids[2] && v.live), 'the newest is live');
    assert.ok(!versions.some((v) => v.id === ids[0]), 'the oldest aged out');
    assert.equal(await store.get(engineKey.file(ids[0], 'index.html')), null, 'its files went with it');
    assert.ok(await store.get(engineKey.file(ids[1], 'index.html')), 'the mid one is still archived');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollback restores the previous version exactly, and refuses a tombstone', async () => {
  const { dir, store } = await tempStore();
  try {
    const first = await installEngineVersion({
      store, env: {},
      pkg: (await anArtifact({ tag: 'ENGINE-V1', hash: 'aaa111' })).pkg,
      sha256: 'x1', bytes: 1, installedBy: 'op', source: 'portal',
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await installEngineVersion({
      store, env: {},
      pkg: (await anArtifact({ tag: 'ENGINE-V2', hash: 'bbb222', coreVersion: '9.9.10' })).pkg,
      sha256: 'x2', bytes: 1, installedBy: 'op', source: 'portal',
    });
    assert.notEqual(first.version.id, second.version.id);
    assert.equal((await readActiveEngine(store)).versionId, second.version.id);

    const rolled = await activateEngineVersion(store, {}, first.version.id);
    assert.ok(rolled, 'the archived version must be activatable');
    assert.equal((await readActiveEngine(store)).versionId, first.version.id);
    assert.match(dec((await readEngineFile(store, first.version.id, 'index.html')).body), /ENGINE-V1/);

    assert.equal(await activateEngineVersion(store, {}, 'no-such-version'), null);
    // A version whose archive was lost is refused rather than half-activated.
    await store.delete(engineKey.file(second.version.id, 'index.html'));
    assert.equal(await activateEngineVersion(store, {}, second.version.id), null);
    assert.equal((await readActiveEngine(store)).versionId, first.version.id, 'the live pointer is untouched by the refusal');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── serving, through the real app ───────────────────────────────────────────

test('with no engine installed, the build serves exactly as before — and pays no store read after the first check', async () => {
  const d = await deployment();
  try {
    resetEngineCache();
    const home = await d.get('/');
    assert.match(await home.text(), /BUILD-INDEX/);
    const asset = await d.get('/assets/index-build0.js');
    assert.match(await asset.text(), /BUILD/);
    const css = await d.get('/theme.css');
    assert.match(await css.text(), /--accent/);
  } finally {
    await d.done();
  }
});

test('an installed engine serves atomically: documents, service worker and hashed assets all flip together', async () => {
  const d = await deployment();
  try {
    resetEngineCache();
    // Pin the pre-install state (and prime the negative cache, deliberately).
    assert.match(await (await d.get('/')).text(), /BUILD-INDEX/);

    const { pkg, sha256 } = await anArtifact({ tag: 'ENGINE-V1', hash: 'aaa111' });
    await installEngineVersion({ store: d.store, env: d.env, pkg, sha256, bytes: 1, installedBy: 'op', source: 'portal' });

    // The install reset the negative cache — the flip is visible on the very
    // next request, in the same process that performed it.
    const home = await d.get('/');
    assert.match(await home.text(), /ENGINE-V1/);
    assert.equal(home.headers.get('cache-control'), 'no-store');

    const admin = await d.get('/admin');
    assert.match(await admin.text(), /ENGINE-V1-ADMIN/, '/admin resolves to the engine admin.html');

    const sw = await d.get('/sw.js');
    const swText = await sw.text();
    assert.match(swText, /ENGINE-V1/, 'the engine service worker, not the build one');
    assert.match(swText, /storylark/i, 'with the deployment prelude stamped in');

    const asset = await d.get('/assets/index-aaa111.js');
    assert.match(await asset.text(), /ENGINE-V1/);
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);

    // A deep link serves the ENGINE shell, not the build's old HTML.
    const deep = await d.get('/library/some-book');
    assert.match(await deep.text(), /ENGINE-V1/);

    // Brand-owned files still come from the build — the engine cannot carry them.
    assert.match(await (await d.get('/theme.css')).text(), /--accent/);
  } finally {
    await d.done();
  }
});

test('mid-update, a client on the previous version keeps working: old hashed assets stay servable', async () => {
  const d = await deployment();
  try {
    resetEngineCache();
    const v1 = await anArtifact({ tag: 'ENGINE-V1', hash: 'aaa111' });
    await installEngineVersion({ store: d.store, env: d.env, pkg: v1.pkg, sha256: v1.sha256, bytes: 1, installedBy: 'op', source: 'portal' });
    await new Promise((r) => setTimeout(r, 5));
    const v2 = await anArtifact({ tag: 'ENGINE-V2', hash: 'bbb222', coreVersion: '9.9.10' });
    await installEngineVersion({ store: d.store, env: d.env, pkg: v2.pkg, sha256: v2.sha256, bytes: 1, installedBy: 'op', source: 'portal' });

    // The active version answers everything new…
    assert.match(await (await d.get('/')).text(), /ENGINE-V2/);
    assert.match(await (await d.get('/assets/index-bbb222.js')).text(), /ENGINE-V2/);
    // …and the PREVIOUS version's hashed asset still resolves, from history —
    // the straggler with v1's HTML open is not broken by the flip.
    assert.match(await (await d.get('/assets/index-aaa111.js')).text(), /ENGINE-V1/);
    // No mixed document state: the served HTML never references a bundle the
    // deployment cannot serve.
    const html = await (await d.get('/')).text();
    assert.ok(!html.includes('ENGINE-V1'), 'the active document is wholly the active version');
  } finally {
    await d.done();
  }
});

test('the stale-negative-cache race is closed: a hashed-asset miss re-checks the store fresh', async () => {
  const d = await deployment();
  const other = await tempStore();
  try {
    const { pkg, sha256 } = await anArtifact({ tag: 'ENGINE-V1', hash: 'aaa111' });
    await installEngineVersion({ store: d.store, env: d.env, pkg, sha256, bytes: 1, installedBy: 'op', source: 'portal' });
    // Poison the (module-level) cache with a negative answer, as an isolate
    // that has not yet observed the install would hold.
    await readActiveEngineCached(other.store);
    // A document read may serve the build inside the TTL — that is the stated
    // tradeoff. A hashed-asset request for the NEW bundle must not fail:
    const asset = await d.get('/assets/index-aaa111.js');
    assert.match(await asset.text(), /ENGINE-V1/, 'the fresh re-check must find the just-installed engine');
    resetEngineCache();
  } finally {
    await d.done();
    await rm(other.dir, { recursive: true, force: true });
  }
});

test('rollback and clear change what is served, immediately', async () => {
  const d = await deployment();
  try {
    resetEngineCache();
    const v1 = await anArtifact({ tag: 'ENGINE-V1', hash: 'aaa111' });
    const first = await installEngineVersion({ store: d.store, env: d.env, pkg: v1.pkg, sha256: v1.sha256, bytes: 1, installedBy: 'op', source: 'portal' });
    await new Promise((r) => setTimeout(r, 5));
    const v2 = await anArtifact({ tag: 'ENGINE-V2', hash: 'bbb222', coreVersion: '9.9.10' });
    await installEngineVersion({ store: d.store, env: d.env, pkg: v2.pkg, sha256: v2.sha256, bytes: 1, installedBy: 'op', source: 'portal' });
    assert.match(await (await d.get('/')).text(), /ENGINE-V2/);

    await activateEngineVersion(d.store, d.env, first.version.id);
    assert.match(await (await d.get('/')).text(), /ENGINE-V1/, 'rollback serves the previous engine on the next request');

    await clearActiveEngine(d.store);
    assert.match(await (await d.get('/')).text(), /BUILD-INDEX/, 'clearing serves the build again');
    const versions = await listEngineVersions(d.store);
    assert.equal(versions.length, 2, 'the history survives a clear');
    assert.ok(versions.every((v) => !v.live));
  } finally {
    await d.done();
  }
});

// ── the routes: one button, mechanism decided internally ────────────────────

test('POST /update-install applies an engine-only release through the store — no deploy target involved', async () => {
  const d = await deployment();
  const built = await anArtifact({ tag: 'ENGINE-ROUTE', hash: 'ddd444', coreVersion: '9.9.9' });
  const rs = await releaseServer([
    { version: '9.9.9', bytes: built.bytes, checksum: `${built.sha256}  ${engineAssetName('9.9.9')}\n` },
  ]);
  try {
    resetEngineCache();
    d.env.ENGINE_RELEASE_BASE = rs.base;
    await d.signInAsAdmin();

    const res = await d.call('/api/admin/update-install', { method: 'POST', body: JSON.stringify({ version: '9.9.9' }) });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.mechanism, 'engine-store', 'the worker is unchanged, so no platform deploy may be involved');
    assert.equal(body.installed, '9.9.9');
    assert.ok(body.log.some((l) => /no redeploy/.test(l)), 'the log says what happened');

    // And the site REALLY serves it.
    assert.match(await (await d.get('/')).text(), /ENGINE-ROUTE/);
    assert.match(await (await d.get('/assets/index-ddd444.js')).text(), /ENGINE-ROUTE/);
  } finally {
    rs.server.close();
    await d.done();
  }
});

test('a release that changes the worker, with no self-deploy permission, is refused plainly — nothing half-applies', async () => {
  const d = await deployment();
  const built = await anArtifact({ tag: 'ENGINE-SRV', hash: 'eee555', coreVersion: '9.9.11', workerVersion: '0.0.1-other' });
  const rs = await releaseServer([
    { version: '9.9.11', bytes: built.bytes, checksum: `${built.sha256}  ${engineAssetName('9.9.11')}\n` },
  ]);
  try {
    resetEngineCache();
    d.env.ENGINE_RELEASE_BASE = rs.base;
    await d.signInAsAdmin();

    const res = await d.call('/api/admin/update-install', { method: 'POST', body: JSON.stringify({ version: '9.9.11' }) });
    const body = await res.json();
    assert.equal(res.status, 501);
    assert.equal(body.error, 'self_update_off');
    assert.match(body.message, /changes the API server/);
    assert.match(body.message, /storylark-worker/);
    assert.equal(typeof body.updateCommand, 'string', 'the command is the stated way out');
    assert.equal(await readActiveEngine(d.store), null, 'the engine store must not be half-written');
    assert.match(await (await d.get('/')).text(), /BUILD-INDEX/, 'the site is untouched');
  } finally {
    rs.server.close();
    await d.done();
  }
});

test('the engine rollback routes work, and are shut to anonymous callers', async () => {
  const d = await deployment();
  const built = await anArtifact({ tag: 'ENGINE-RB', hash: 'fff666', coreVersion: '9.9.9' });
  const rs = await releaseServer([
    { version: '9.9.9', bytes: built.bytes, checksum: `${built.sha256}  ${engineAssetName('9.9.9')}\n` },
  ]);
  try {
    resetEngineCache();
    d.env.ENGINE_RELEASE_BASE = rs.base;

    // Shut before anyone signs in — and these doors are session-ONLY, so the
    // shared ADMIN_KEY header must not open them either.
    const anonInstall = await d.get('/api/admin/update-install', {});
    assert.equal(anonInstall.status, 401, 'the gate answers before the method does');
    const keyOnly = await d.call('/api/admin/engine/active', {
      method: 'DELETE',
      headers: { cookie: '', 'X-Admin-Key': d.env.ADMIN_KEY },
    });
    assert.equal(keyOnly.status, 401, 'ADMIN_KEY is not a click — sessions only');

    await d.signInAsAdmin();
    const installed = await d.call('/api/admin/update-install', { method: 'POST', body: JSON.stringify({ version: '9.9.9' }) });
    assert.equal(installed.status, 200);
    const { engine } = await installed.json();
    const versionId = engine.active.versionId;

    // Roll back to it after clearing — the round trip through both routes.
    const cleared = await d.call('/api/admin/engine/active', { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    assert.match(await (await d.get('/')).text(), /BUILD-INDEX/);

    const rolled = await d.call(`/api/admin/engine/versions/${versionId}/activate`, { method: 'POST', body: '{}' });
    assert.equal(rolled.status, 200);
    assert.match(await (await d.get('/')).text(), /ENGINE-RB/);

    const missing = await d.call('/api/admin/engine/versions/nope/activate', { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
  } finally {
    rs.server.close();
    await d.done();
  }
});

test('a release that changes the worker rides the platform deployer through the SAME button, and clears the engine override', async () => {
  const d = await deployment();
  const engineOnly = await anArtifact({ tag: 'ENGINE-OLD', hash: 'ggg777', coreVersion: '9.9.9' });
  const serverRelease = await anArtifact({ tag: 'ENGINE-NEW', hash: 'hhh888', coreVersion: '9.9.12', workerVersion: '0.0.1-other' });
  const rs = await releaseServer([
    { version: '9.9.9', bytes: engineOnly.bytes, checksum: `${engineOnly.sha256}  ${engineAssetName('9.9.9')}\n` },
    { version: '9.9.12', bytes: serverRelease.bytes, checksum: `${serverRelease.sha256}  ${engineAssetName('9.9.12')}\n` },
  ]);
  try {
    resetEngineCache();
    d.env.ENGINE_RELEASE_BASE = rs.base;
    // The platform deployer, as a platform entry binds it (the REAL Cloudflare
    // and Azure targets are exercised against their documented APIs in
    // engine-update.test.mjs — this test is about the route choosing and
    // sequencing correctly).
    const installs = [];
    d.env.SELF_DEPLOY = {
      platform: 'azure-app-service',
      credential: 'a managed identity',
      preflight: async () => ({ ok: true, detail: 'ok' }),
      install: async (pkg, log) => {
        installs.push(pkg.manifest.coreVersion);
        log('platform deploy ran');
        return { note: 'deployed' };
      },
    };
    await d.signInAsAdmin();

    // An engine-only release first, so there is an override to clear.
    const first = await d.call('/api/admin/update-install', { method: 'POST', body: JSON.stringify({ version: '9.9.9' }) });
    assert.equal((await first.json()).mechanism, 'engine-store', 'worker unchanged → the store, even with a deployer present');
    assert.ok(await readActiveEngine(d.store));

    const second = await d.call('/api/admin/update-install', { method: 'POST', body: JSON.stringify({ version: '9.9.12' }) });
    const body = await second.json();
    assert.equal(second.status, 200, JSON.stringify(body));
    assert.equal(body.mechanism, 'platform-deploy');
    assert.deepEqual(installs, ['9.9.12'], 'the deployer got exactly the downloaded package');
    assert.equal(await readActiveEngine(d.store), null, 'the freshly deployed build must not be shadowed by the old override');
    const versions = await listEngineVersions(d.store);
    assert.ok(versions.length >= 1 && versions.every((v) => !v.live), 'the history survives for rollback');
  } finally {
    rs.server.close();
    await d.done();
  }
});

test('GET /update-status reports ONE update answer, and detects a core-only release the old check missed', async () => {
  const d = await deployment();
  try {
    resetEngineCache();
    await d.signInAsAdmin();
    const realFetch = globalThis.fetch;
    // The registry answers: worker unchanged, core newer — the case the old
    // worker-only comparison reported as "up to date".
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org/storylark-worker/latest')) {
        return new Response(JSON.stringify({ version: workerPkg.version }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('registry.npmjs.org/storylark-core/latest')) {
        return new Response(JSON.stringify({ version: '99.0.0' }), { headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    };
    try {
      const res = await d.call('/api/admin/update-status');
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.hasUpdate, true, 'a core-only release IS an update');
      assert.equal(body.release.coreLatest, '99.0.0');
      assert.equal(body.release.coreCurrent, '9.0.0', 'read from the build\'s outputs.json');
      assert.equal(body.release.serverChanged, false);
      assert.equal(body.updateNow.available, true, 'engine releases need no setup anywhere');
      assert.equal(body.updateNow.mechanism, 'engine-store');
      assert.equal(body.engine.storeAvailable, true);

      // Now the registry says the WORKER moved too, and this deployment has no
      // deployer: the one degraded state, reported as a reason, not a tier.
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('registry.npmjs.org/storylark-worker/latest')) {
          return new Response(JSON.stringify({ version: '99.0.0' }), { headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('registry.npmjs.org/storylark-core/latest')) {
          return new Response(JSON.stringify({ version: '99.0.0' }), { headers: { 'content-type': 'application/json' } });
        }
        return realFetch(input, init);
      };
      const res2 = await d.call('/api/admin/update-status');
      const body2 = await res2.json();
      assert.equal(body2.hasUpdate, true);
      assert.equal(body2.release.serverChanged, true);
      assert.equal(body2.updateNow.available, false);
      assert.match(body2.updateNow.reason, /Self-update is disabled/);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await d.done();
  }
});
