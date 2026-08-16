// The prebuilt engine and the one-click update (AB#7418 — plan §4 layer 3,
// §0d Phase 5).
//
// ── What is real here and what is not ───────────────────────────────────────
// Everything except Cloudflare's and Azure's own servers. The artifact is a
// REAL engine package built by the real packager from real bytes; the download
// runs over a REAL HTTP server on localhost; the checksum is really computed
// and really compared; the D1 migrations really execute against a real SQLite
// database (node:sqlite) and really write the same `d1_migrations` table
// wrangler uses; the Azure deployer really stages a real site directory and
// really produces the zip it would post.
//
// The two remote APIs are stood up locally instead, implementing their
// published contracts, and the tests assert the exact requests they receive:
// the manifest, the hashes, the base64 bodies, the bearer tokens, the metadata
// JSON, the URLs. That proves the choreography and the payloads. It does NOT
// prove that Cloudflare and Azure agree with their own documentation — no test
// that can be run without a credential capable of redeploying a live site can
// prove that, and creating one to find out is the risk this file exists to
// avoid taking. See docs/design/update-flow.md for exactly which call is
// unverified and what happens if it is wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEnginePackage,
  readEnginePackage,
  EnginePackageError,
  engineAssetName,
  engineChecksumName,
  parseChecksumFile,
  sha256Hex,
  isBrandOwned,
} from 'storylark-contracts/engine-package';
import { unzip } from 'storylark-contracts/zip';
import {
  findEngineRelease,
  downloadEngineArtifact,
  EngineReleaseError,
  releaseTag,
  DEFAULT_RELEASE_REPO,
} from '../src/lib/engine-release.ts';
import {
  cloudflareSelfDeploy,
  resolveSelfDeploy,
  applyD1Migrations,
  splitStatements,
  cloudflareAssetHash,
  toBase64,
} from '../src/lib/self-deploy.ts';
import { azureSelfDeploy } from '../../../platforms/azure/self-deploy.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** A small but structurally real engine build: the two files the format requires, plus a chunk and a font. */
function engineDist(extra = {}) {
  return new Map(
    Object.entries({
      'index.html': enc('<!doctype html><html><head><title data-storylark-title="app">StoryLark</title></head></html>'),
      'admin.html': enc('<!doctype html><html><head><title data-storylark-title="admin">Admin — StoryLark</title></head></html>'),
      'sw.js': enc('self.addEventListener("fetch", () => {});'),
      'assets/index-abc123.js': enc('export const engine = 1;'),
      'assets/inter-latin-400.woff2': new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]),
      'fonts.json': enc('{"families":{}}'),
      'outputs.json': enc('{"formatVersion":1,"files":{}}'),
      ...extra,
    })
  );
}

async function anEnginePackage(over = {}) {
  return buildEnginePackage({
    dist: engineDist(),
    worker: enc('export default { fetch: () => new Response("ok") };'),
    migrations: new Map([['0001_init.sql', enc('CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY);')]]),
    migrationsPostgres: new Map([['0001_init.sql', enc('CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY);')]]),
    coreVersion: '9.9.9',
    workerVersion: '9.9.9',
    builtAt: '2026-08-16T00:00:00.000Z',
    ...over,
  });
}

// ── the format ──────────────────────────────────────────────────────────────

test('build → read is a fixed point, so an artifact survives being moved', async () => {
  const built = await anEnginePackage();
  const read = await readEnginePackage(built.bytes);
  assert.equal(read.manifest.coreVersion, '9.9.9');
  assert.equal(read.dist.size, engineDist().size);
  assert.equal(dec(read.dist.get('assets/index-abc123.js')), 'export const engine = 1;');
  assert.ok(read.worker, 'the Worker bundle should survive the round trip');
  assert.equal(read.migrations.size, 1);
  assert.equal(read.migrationsPostgres.size, 1);
  assert.deepEqual(read.warnings, []);
});

test('the package is byte-reproducible — the published sha256 is a fact about the inputs', async () => {
  const a = await anEnginePackage();
  const b = await anEnginePackage();
  assert.equal(await sha256Hex(a.bytes), await sha256Hex(b.bytes));
});

test('a build carrying brand files cannot be packaged — the worst outcome, made impossible', async () => {
  for (const path of ['brand.json', 'presentation.json', 'theme.css', 'manifest.webmanifest', 'icons/icon-192.png']) {
    assert.ok(isBrandOwned(path), `${path} should be recognised as brand-owned`);
    await assert.rejects(
      () => anEnginePackage({ dist: engineDist({ [path]: enc('someone else') }) }),
      (err) => {
        assert.ok(err instanceof EnginePackageError);
        assert.match(err.errors[0], new RegExp(`${path.replace('.', '\\.')}.*belongs to the deployment`));
        return true;
      },
      `${path} should have been refused`
    );
  }
});

test('a package whose bytes were swapped after signing is refused, per file', async () => {
  const built = await anEnginePackage();
  // Rebuild the zip with one file's contents replaced, leaving engine.json's
  // sha256 for it untouched — exactly what a tampered mirror would produce.
  const entries = await unzip(built.bytes, { maxEntries: 1024 });
  entries.set('dist/assets/index-abc123.js', enc('export const engine = 666; /* not what was published */'));
  const { zip } = await import('storylark-contracts/zip');
  const repacked = await zip([...entries].map(([name, data]) => ({ name, data })), { date: new Date(0) });
  await assert.rejects(
    () => readEnginePackage(repacked),
    (err) => {
      assert.ok(err instanceof EnginePackageError);
      assert.match(err.errors[0], /dist\/assets\/index-abc123\.js does not match the sha256/);
      return true;
    }
  );
});

test('a package with a file nothing vouched for is refused', async () => {
  const built = await anEnginePackage();
  const entries = await unzip(built.bytes, { maxEntries: 1024 });
  entries.set('dist/assets/backdoor.js', enc('fetch("https://elsewhere.example")'));
  const { zip } = await import('storylark-contracts/zip');
  const repacked = await zip([...entries].map(([name, data]) => ({ name, data })), { date: new Date(0) });
  await assert.rejects(
    () => readEnginePackage(repacked),
    (err) => {
      assert.match(err.errors[0], /backdoor\.js is in the package but not in engine\.json/);
      return true;
    }
  );
});

test('something that is not an engine package fails with an explanation, not a stack trace', async () => {
  await assert.rejects(
    () => readEnginePackage(enc('this is not a zip at all, it is a sentence')),
    (err) => {
      assert.ok(err instanceof EnginePackageError);
      assert.match(err.errors[0], /not a readable zip|could not be read/);
      return true;
    }
  );
});

test('a checksum file is parsed in sha256sum format, and only for the right name', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseChecksumFile(`${digest}  storylark-engine-1.0.0.zip\n`, 'storylark-engine-1.0.0.zip'), digest);
  assert.equal(parseChecksumFile(`${digest} *storylark-engine-1.0.0.zip`, 'storylark-engine-1.0.0.zip'), digest);
  assert.equal(parseChecksumFile(`${digest}\n`, 'storylark-engine-1.0.0.zip'), digest, 'a bare digest is unambiguous');
  assert.equal(parseChecksumFile(`${digest}  something-else.zip\n`, 'storylark-engine-1.0.0.zip'), null);
  assert.equal(parseChecksumFile('not a checksum', 'storylark-engine-1.0.0.zip'), null);
});

// ── finding, downloading and verifying a release, over real HTTP ────────────

/** A server that answers like the GitHub Releases API and a release-asset CDN. */
// Serves at the exact shape findEngineRelease's opts.base path constructs
// (`${base}/${tag}/${asset}`) — findEngineRelease no longer calls out to
// api.github.com at all (fixed live, 2026-08-16: that API is rate-limited
// per source IP, and a Cloudflare Worker's outbound IP is shared across
// unrelated tenants' traffic, which hit a real 429 on the very first live
// one-click update; github.com's direct release-download URL convention
// 302s to a separate, non-rate-limited asset host instead), so these tests
// exercise the download+checksum+verify pipeline through the already-
// supported ENGINE_RELEASE_BASE override path rather than re-mocking a
// GitHub API call that no longer happens.
async function releaseServer({ artifact, checksum, tag, version }) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === `/dl/${encodeURIComponent(tag)}/${engineAssetName(version)}`) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(artifact.byteLength) });
      return res.end(Buffer.from(artifact));
    }
    if (req.url === `/dl/${encodeURIComponent(tag)}/${engineChecksumName(version)}`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(checksum);
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, hits, origin: `http://127.0.0.1:${server.address().port}`, base: `http://127.0.0.1:${server.address().port}/dl` };
}

test('a release is located, downloaded over real HTTP, and verified against its published checksum', async () => {
  const built = await anEnginePackage();
  const digest = await sha256Hex(built.bytes);
  const version = '9.9.9';
  const { server, base } = await releaseServer({
    artifact: built.bytes,
    checksum: `${digest}  ${engineAssetName(version)}\n`,
    tag: releaseTag(version),
    version,
  });
  try {
    const release = await findEngineRelease(version, { base });
    assert.equal(release.tag, 'storylark-core@9.9.9');
    assert.ok(release.artifactUrl.endsWith(engineAssetName(version)));

    const downloaded = await downloadEngineArtifact(release);
    assert.equal(downloaded.sha256, digest);
    assert.equal(downloaded.bytes.byteLength, built.bytes.byteLength);

    // …and it really is the package, not just bytes of the right length.
    const pkg = await readEnginePackage(downloaded.bytes);
    assert.equal(pkg.manifest.coreVersion, '9.9.9');
  } finally {
    server.close();
  }
});

test('an empty-string repo falls back to the default, same as an absent one', async () => {
  // Azure's server.mjs sets ENGINE_RELEASE_REPO to `process.env.X ?? ''` —
  // an empty string when unset, not undefined. Node env vars don't
  // distinguish "absent" the way a Cloudflare Workers binding does. A `??`
  // fallback would leave repo === '' and produce a real
  // "https://github.com//releases/..." 404 — found live against Azure dev,
  // 2026-08-16.
  const release = await findEngineRelease('9.9.9', { repo: '' });
  assert.ok(release.artifactUrl.startsWith(`https://github.com/${DEFAULT_RELEASE_REPO}/releases/download/`));
  assert.ok(!release.artifactUrl.includes('github.com//'));
});

test('a substituted artifact is caught by the checksum and nothing is installed', async () => {
  const real = await anEnginePackage();
  const evil = await anEnginePackage({ dist: engineDist({ 'assets/index-abc123.js': enc('export const engine = 666;') }) });
  const version = '9.9.9';
  // The checksum published is the REAL one; the bytes served are the other one.
  const { server, base } = await releaseServer({
    artifact: evil.bytes,
    checksum: `${await sha256Hex(real.bytes)}  ${engineAssetName(version)}\n`,
    tag: releaseTag(version),
    version,
  });
  try {
    const release = await findEngineRelease(version, { base });
    await assert.rejects(
      () => downloadEngineArtifact(release),
      (err) => {
        assert.ok(err instanceof EngineReleaseError);
        assert.equal(err.code, 'checksum_mismatch');
        assert.match(err.message, /Nothing was installed/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test('a version with no published artifact says so, instead of half-installing something', async () => {
  // findEngineRelease no longer checks existence — it just constructs the
  // URL GitHub's direct-download convention implies. Non-existence now
  // surfaces as a 404 on the actual download, caught by downloadEngineArtifact.
  const version = '9.9.9';
  const { server, base } = await releaseServer({ artifact: new Uint8Array(), checksum: '', tag: 'other', version });
  try {
    const release = await findEngineRelease(version, { base });
    await assert.rejects(
      () => downloadEngineArtifact(release),
      (err) => {
        assert.ok(err instanceof EngineReleaseError);
        assert.equal(err.code, 'no_release');
        assert.match(err.message, /installer command/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

// ── the not-configured path: the whole feature is opt-in ────────────────────

test('with nothing configured there is no deploy target, and the reason names the CLI', () => {
  const { target, reason } = resolveSelfDeploy({ BRAND: 'acme' });
  assert.equal(target, null);
  assert.match(reason, /One-click updates are off/);
  assert.match(reason, /install\.mjs --enable-one-click/);
});

test('a Cloudflare token alone is not enough — a half-configured deployment offers no button', () => {
  const { target } = resolveSelfDeploy({ BRAND: 'acme', CF_API_TOKEN: 'x' });
  assert.equal(target, null, 'without an account id there is nothing to call');
});

test('the platform entry\'s own reason wins over the generic one', () => {
  const { target, reason } = resolveSelfDeploy({ BRAND: 'acme', SELF_DEPLOY_REASON: 'this is not App Service' });
  assert.equal(target, null);
  assert.equal(reason, 'this is not App Service');
});

// ── D1 migrations, against a real SQL engine ────────────────────────────────

/** The Database seam over node:sqlite — a real database, not a spy. */
function sqliteSeam(db) {
  return {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...values) {
          bound = values;
          return stmt;
        },
        async run() {
          db.prepare(sql).run(...bound);
          return { success: true };
        },
        async all() {
          return { results: db.prepare(sql).all(...bound) };
        },
        async first() {
          return db.prepare(sql).get(...bound) ?? null;
        },
      };
      return stmt;
    },
  };
}

test('D1 migrations really run, are recorded in wrangler\'s own table, and are not re-run', async () => {
  const db = new DatabaseSync(':memory:');
  const seam = sqliteSeam(db);
  const log = [];
  const migrations = new Map([
    ['0001_init.sql', enc('CREATE TABLE widgets (id TEXT PRIMARY KEY);\nINSERT INTO widgets (id) VALUES (\'a;b\');')],
    ['0002_more.sql', enc('-- a comment with a ; in it\nALTER TABLE widgets ADD COLUMN label TEXT;')],
  ]);

  const first = await applyD1Migrations(seam, migrations, (l) => log.push(l));
  assert.deepEqual(first, ['0001_init.sql', '0002_more.sql']);
  // The schema really changed…
  assert.deepEqual(db.prepare('SELECT id, label FROM widgets').all().map((r) => ({ ...r })), [{ id: 'a;b', label: null }]);
  // …and the semicolon inside the string literal was not treated as a statement
  // boundary, which is the bug a naive split(';') would have.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM widgets').get().n, 1);

  // wrangler's table, wrangler's column names, wrangler's `name` values — so a
  // later `wrangler d1 migrations apply` agrees rather than re-running these.
  const recorded = db.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map((r) => ({ ...r }));
  assert.deepEqual(recorded, [{ name: '0001_init.sql' }, { name: '0002_more.sql' }]);

  const second = await applyD1Migrations(seam, migrations, (l) => log.push(l));
  assert.deepEqual(second, [], 'a second run must be a no-op');
});

test('statement splitting survives the things real migration files contain', () => {
  assert.deepEqual(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;"), ["INSERT INTO t VALUES ('a;b')", 'SELECT 1']);
  assert.deepEqual(splitStatements('-- drop it all;\nSELECT 1;'), ['SELECT 1']);
  assert.deepEqual(splitStatements("SELECT 'it''s fine; really';"), ["SELECT 'it''s fine; really'"]);
  assert.deepEqual(splitStatements('SELECT 1'), ['SELECT 1'], 'a trailing semicolon is optional');
  assert.deepEqual(splitStatements(';;\n'), []);
});

// ── Cloudflare, against a local server implementing the documented contract ─

test("Cloudflare's asset hash is theirs, not ours — sha256(base64 + extension), 32 hex", async () => {
  // Cloudflare's own example client computes exactly this; if we computed a
  // hash of the file instead, every manifest entry would be a cache miss and
  // the whole bundle would re-upload on every release.
  const bytes = enc('hello');
  const expected = await sha256Hex(enc(`${toBase64(bytes)}html`));
  assert.equal(await cloudflareAssetHash('index.html', bytes), expected.slice(0, 32));
  assert.equal((await cloudflareAssetHash('assets/x.woff2', bytes)).length, 32);
});

/** A server implementing the three documented Workers endpoints, recording everything. */
async function cloudflareApi({ knownHashes = new Set() } = {}) {
  const calls = [];
  const uploaded = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const call = { method: req.method, url: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'], body };
    calls.push(call);
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url.endsWith('/settings') && req.method === 'GET') {
      // A realistic settings response: a plain var WITH its value, a secret
      // by name only (Cloudflare never returns a secret's value), a D1
      // binding — so the test can assert all three come back unchanged on
      // the swap, exactly as a real deployment's bindings would.
      return json({
        success: true,
        result: {
          compatibility_date: '2026-06-01',
          compatibility_flags: ['nodejs_compat'],
          bindings: [
            { name: 'BRAND', type: 'plain_text', text: 'acme' },
            { name: 'ADMIN_KEY', type: 'secret_text' },
            { name: 'DB', type: 'd1', id: 'db-id-123' },
          ],
        },
      });
    }

    if (req.url.endsWith('/assets-upload-session')) {
      const manifest = JSON.parse(body.toString()).manifest;
      call.manifest = manifest;
      const missing = Object.values(manifest)
        .map((m) => m.hash)
        .filter((h) => !knownHashes.has(h));
      return json({ success: true, result: { jwt: 'SESSION-JWT', buckets: missing.length ? [missing] : [] } });
    }

    if (req.url.startsWith('/accounts/acct/workers/assets/upload')) {
      // Real multipart, parsed the crude-but-sufficient way: each part's name
      // is the asset hash and its body is base64 text.
      const boundary = `--${/boundary=(.+)$/.exec(call.contentType)[1]}`;
      for (const part of body.toString('latin1').split(boundary).slice(1, -1)) {
        const name = /name="([^"]+)"/.exec(part)?.[1];
        if (!name) continue;
        uploaded.set(name, part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      }
      return json({ success: true, result: { jwt: 'COMPLETION-JWT' } }, 201);
    }

    if (req.url === '/accounts/acct/workers/scripts/acme' && req.method === 'PUT') {
      const text = body.toString('latin1');
      call.metadata = JSON.parse(/name="metadata"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)[1]);
      return json({ success: true, result: { id: 'acme' } });
    }
    json({ success: false, errors: [{ message: `unexpected ${req.method} ${req.url}` }] }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, uploaded, base: `http://127.0.0.1:${server.address().port}` };
}

/** An ASSETS binding over a fixed set of files, behaving like Cloudflare's (SPA fallback included). */
function assetsBinding(files) {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname.slice(1);
      if (!files.has(path)) {
        // not_found_handling: single-page-application — the shell, not a 404.
        return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(files.get(path), { status: 200 });
    },
  };
}

test('a Cloudflare update uploads the engine AND carries the deployment\'s own brand files across', async () => {
  const api = await cloudflareApi();
  const db = new DatabaseSync(':memory:');
  const brandJson = enc('{"appName":"Acme Reader","tagline":"ours, not theirs"}');
  const iconPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
  const env = {
    BRAND: 'acme',
    CF_API_TOKEN: 'operator-token',
    CF_ACCOUNT_ID: 'acct',
    CF_API_BASE: api.base,
    DB: sqliteSeam(db),
    ASSETS: assetsBinding(
      new Map([
        // The build's inventory names the brand-owned files, including an icon
        // whose name no fixed list could have known.
        [
          'outputs.json',
          enc(
            JSON.stringify({
              files: {
                'index.html': { sha256: 'x' },
                'brand.json': { sha256: 'x', brandOwned: true },
                'theme.css': { sha256: 'x', brandOwned: true },
                'icons/acme-mascot.png': { sha256: 'x', brandOwned: true },
              },
            })
          ),
        ],
        ['brand.json', brandJson],
        ['theme.css', enc(':root{--accent:#ff0000}')],
        ['icons/acme-mascot.png', iconPng],
      ])
    ),
  };

  try {
    const target = cloudflareSelfDeploy(env);
    assert.equal(target.platform, 'cloudflare');
    assert.equal((await target.preflight()).ok, true);

    const pkg = await readEnginePackage((await anEnginePackage()).bytes);
    const log = [];
    const result = await target.install(pkg, (l) => log.push(l));
    assert.match(result.note, /untouched/);

    // 1. The migration ran first, for real.
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='widgets'").get(), 'the migration should have created the table');
    assert.deepEqual(db.prepare('SELECT name FROM d1_migrations').all().map((r) => ({ ...r })), [{ name: '0001_init.sql' }]);

    // 2. The manifest is the COMPLETE new asset set: engine files from the
    //    artifact plus the deployment's own. Cloudflare deletes anything left
    //    out, so this is the assertion that "keep your brand" is true rather than
    //    merely intended.
    const session = api.calls.find((c) => c.url.endsWith('/assets-upload-session'));
    const paths = Object.keys(session.manifest).sort();
    assert.ok(paths.includes('/index.html'), 'the engine shell');
    assert.ok(paths.includes('/assets/index-abc123.js'), 'the engine bundle');
    assert.ok(paths.includes('/brand.json'), "the deployment's identity must survive an engine update");
    assert.ok(paths.includes('/theme.css'), "the deployment's look must survive an engine update");
    assert.ok(paths.includes('/icons/acme-mascot.png'), 'an icon with a name no fixed list knew about must survive too');

    // 3. The bytes uploaded for brand.json are the DEPLOYMENT's, not a neutral
    //    one — the failure this whole design exists to prevent.
    const brandHash = session.manifest['/brand.json'].hash;
    assert.equal(api.uploaded.get(brandHash), toBase64(brandJson));
    assert.equal(api.uploaded.get(session.manifest['/icons/acme-mascot.png'].hash), toBase64(iconPng));

    // 4. The script swap reads back this deployment's own bindings first
    //    (confirmed live 2026-08-16: /content does not exist for an
    //    asset-backed Worker; the plain script endpoint does, but replaces
    //    the whole config, so bindings have to be resent, not avoided), then
    //    PUTs to the plain script endpoint carrying them forward — the plain
    //    var keeps its VALUE; ADMIN_KEY (secret_text) is OMITTED entirely,
    //    not referenced (also confirmed live: resending a secret_text binding
    //    by name with no value is REJECTED by Cloudflare's API, not treated
    //    as "keep it" — the real rule is that omitted secrets are preserved
    //    automatically from the previous version) — plus the engine's own
    //    asset-routing contract, which is NOT read back the same way: it is
    //    the engine's routing architecture, not this deployment's state.
    const settingsCall = api.calls.find((c) => c.url.endsWith('/settings'));
    assert.equal(settingsCall.method, 'GET');
    const put = api.calls.find((c) => c.method === 'PUT' && c.url === '/accounts/acct/workers/scripts/acme');
    assert.ok(put, 'the swap must PUT to the plain script endpoint, not /content');
    assert.equal(put.auth, 'Bearer operator-token');
    assert.deepEqual(put.metadata, {
      main_module: 'index.js',
      bindings: [
        { name: 'BRAND', type: 'plain_text', text: 'acme' },
        { name: 'DB', type: 'd1', id: 'db-id-123' },
      ],
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      assets: {
        jwt: 'COMPLETION-JWT',
        config: { not_found_handling: 'single-page-application', run_worker_first: ['/*', '!/assets/*'] },
      },
    });

    // 5. The asset upload used the SESSION token, not the account token.
    const upload = api.calls.find((c) => c.url.startsWith('/accounts/acct/workers/assets/upload'));
    assert.equal(upload.auth, 'Bearer SESSION-JWT');
    assert.match(upload.url, /base64=true/);
  } finally {
    api.server.close();
  }
});

test('files Cloudflare already holds are not re-uploaded', async () => {
  // Fonts do not change between engine releases; re-sending 3MB of them on
  // every update would be the difference between a click and a coffee break.
  const dist = engineDist();
  const fontHash = await cloudflareAssetHash('assets/inter-latin-400.woff2', dist.get('assets/inter-latin-400.woff2'));
  const api = await cloudflareApi({ knownHashes: new Set([fontHash]) });
  const db = new DatabaseSync(':memory:');
  const env = {
    BRAND: 'acme',
    CF_API_TOKEN: 't',
    CF_ACCOUNT_ID: 'acct',
    CF_API_BASE: api.base,
    DB: sqliteSeam(db),
    ASSETS: assetsBinding(new Map()),
  };
  try {
    const pkg = await readEnginePackage((await anEnginePackage()).bytes);
    await cloudflareSelfDeploy(env).install(pkg, () => {});
    assert.ok(!api.uploaded.has(fontHash), 'a file Cloudflare already has must not be re-uploaded');
    assert.ok(api.uploaded.size > 0, 'but the new files must be');
  } finally {
    api.server.close();
  }
});

test('a site built before dist/outputs.json existed still keeps its standard brand files', async () => {
  const api = await cloudflareApi();
  const db = new DatabaseSync(':memory:');
  const env = {
    BRAND: 'acme',
    CF_API_TOKEN: 't',
    CF_ACCOUNT_ID: 'acct',
    CF_API_BASE: api.base,
    DB: sqliteSeam(db),
    // No outputs.json — an older build. The known names must still be found.
    ASSETS: assetsBinding(new Map([['brand.json', enc('{"appName":"Legacy"}')], ['icons/icon-192.png', new Uint8Array([1, 2, 3])]])),
  };
  try {
    const pkg = await readEnginePackage((await anEnginePackage()).bytes);
    const log = [];
    await cloudflareSelfDeploy(env).install(pkg, (l) => log.push(l));
    const session = api.calls.find((c) => c.url.endsWith('/assets-upload-session'));
    assert.ok(session.manifest['/brand.json'], 'the fallback list must still preserve brand.json');
    assert.ok(session.manifest['/icons/icon-192.png']);
    assert.ok(log.some((l) => /built before dist\/outputs\.json/.test(l)), 'and it should say so');
  } finally {
    api.server.close();
  }
});

test('an artifact with no Worker bundle is refused rather than half-installed', async () => {
  const api = await cloudflareApi();
  const db = new DatabaseSync(':memory:');
  const env = { BRAND: 'acme', CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct', CF_API_BASE: api.base, DB: sqliteSeam(db), ASSETS: assetsBinding(new Map()) };
  try {
    const pkg = await readEnginePackage((await anEnginePackage({ worker: undefined })).bytes);
    await assert.rejects(
      () => cloudflareSelfDeploy(env).install(pkg, () => {}),
      /carries no Cloudflare Worker bundle/
    );
    assert.ok(!api.calls.some((c) => c.method === 'PUT'), 'nothing should have been deployed');
  } finally {
    api.server.close();
  }
});

test('a Cloudflare API error surfaces the API\'s own message and deploys nothing', async () => {
  const db = new DatabaseSync(':memory:');
  const server = createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, errors: [{ message: 'Authentication error' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const env = {
      BRAND: 'acme',
      CF_API_TOKEN: 'revoked',
      CF_ACCOUNT_ID: 'acct',
      CF_API_BASE: `http://127.0.0.1:${server.address().port}`,
      DB: sqliteSeam(db),
      ASSETS: assetsBinding(new Map()),
    };
    const check = await cloudflareSelfDeploy(env).preflight();
    assert.equal(check.ok, false);
    assert.match(check.detail, /Authentication error/);
  } finally {
    server.close();
  }
});

// ── Azure, against a local IMDS + Kudu ──────────────────────────────────────

/** A server standing in for the managed-identity endpoint and for Kudu. */
async function azureApi({ tokenStatus = 200, kuduStatus = 200 } = {}) {
  const calls = [];
  let deployed = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    calls.push({ method: req.method, url: req.url, headers: req.headers, size: body.byteLength });
    if (req.url.startsWith('/msi/token')) {
      if (tokenStatus !== 200) return res.writeHead(tokenStatus).end('no');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'ARM-TOKEN', expires_on: '9999999999' }));
    }
    if (req.url === '/api/deployments') {
      return res.writeHead(kuduStatus, { 'content-type': 'application/json' }).end('[]');
    }
    if (req.url === '/api/publish?type=zip') {
      if (kuduStatus !== 200) return res.writeHead(kuduStatus).end('denied');
      deployed = body;
      return res.writeHead(200).end('ok');
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, calls, base: `http://127.0.0.1:${port}`, get deployed() { return deployed; } };
}

/** A site directory shaped like a real App Service wwwroot. */
function stagedSite() {
  const root = mkdtempSync(join(tmpdir(), 'storylark-site-'));
  writeFileSync(join(root, 'server.mjs'), '// the running entry\n');
  writeFileSync(join(root, 'content-store.mjs'), '// a sibling the entry imports\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'site', dependencies: { 'storylark-worker': '0.1.0', hono: '^4' } }, null, 2));
  mkdirSync(join(root, 'app', 'dist', 'icons'), { recursive: true });
  mkdirSync(join(root, 'app', 'dist', 'assets'), { recursive: true });
  writeFileSync(join(root, 'app', 'dist', 'brand.json'), '{"appName":"Acme Reader"}');
  writeFileSync(join(root, 'app', 'dist', 'theme.css'), ':root{--accent:#ff0000}');
  writeFileSync(join(root, 'app', 'dist', 'icons', 'acme-mascot.png'), 'MASCOT');
  writeFileSync(join(root, 'app', 'dist', 'index.html'), '<!-- the OLD engine shell -->');
  writeFileSync(join(root, 'app', 'dist', 'assets', 'index-old000.js'), '// the OLD bundle');
  return root;
}

function azureEnv(base) {
  return {
    WEBSITE_SITE_NAME: 'acme-app',
    IDENTITY_ENDPOINT: `${base}/msi/token`,
    IDENTITY_HEADER: 'secret-header',
    // The SCM host is normally derived from the site name; pointed at the local
    // server so the deploy is real HTTP against a real listener.
    AZURE_SCM_HOST: base.replace('http://', ''),
  };
}

/** The deployer talks https://<scmHost>/…; rewrite to the local http listener. */
function localFetch(base) {
  return (url, init) => fetch(String(url).replace(`https://${base.replace('http://', '')}`, base), init);
}

test('storylark-worker/migrate-postgres.mjs resolves through the package exports map', () => {
  // self-deploy.mjs's migrate() resolves this exact specifier with
  // createRequire(...).resolve() before running Postgres migrations for a
  // real Azure one-click update. migrate-postgres.mjs was listed in `files`
  // (so it really shipped in the published tarball) but missing from
  // `exports` — Node's strict exports-map resolution rejects any subpath not
  // explicitly listed there regardless of `files`, so the resolve() call
  // threw ERR_PACKAGE_PATH_NOT_EXPORTED, self-deploy.mjs's catch turned that
  // into "not found", and every real Azure one-click update failed at the
  // migration step with a false "file is missing" — found live against
  // Azure dev, 2026-08-16, after two earlier real bugs in this same flow
  // were already fixed and the artifact was downloading and verifying
  // correctly. Node's package self-reference feature resolves this straight
  // from packages/worker/package.json's own exports map — no install step
  // needed — so this test catches a regression here directly, the same
  // place self-deploy.mjs's real failure was.
  const script = createRequire(import.meta.url).resolve('storylark-worker/migrate-postgres.mjs');
  assert.ok(existsSync(script), 'the resolved path should exist on disk');
});

test('an Azure update stages the whole site, swaps the engine, keeps the brand, and pins the new worker', async () => {
  const api = await azureApi();
  const siteRoot = stagedSite();
  try {
    const { target } = azureSelfDeploy(azureEnv(api.base), {
      siteRoot,
      staticRoot: join(siteRoot, 'app', 'dist'),
      fetchImpl: localFetch(api.base),
    });
    assert.ok(target, 'a managed identity should produce a target');
    assert.equal(target.platform, 'azure-app-service');
    assert.match(target.credential, /no credential is stored/);

    const check = await target.preflight();
    assert.equal(check.ok, true, check.detail);

    // No Postgres here, so the artifact carries no Postgres migrations — the
    // migration step is covered separately by migrate-postgres.mjs's own
    // --dir flag and by the D1 test above.
    const pkg = await readEnginePackage((await anEnginePackage({ migrationsPostgres: new Map() })).bytes);
    const log = [];
    const result = await target.install(pkg, (l) => log.push(l));
    assert.match(result.note, /restarting/);

    // The zip Kudu received is the receipt. Read it back and check the site.
    assert.ok(api.deployed, 'Kudu should have received a zip');
    const entries = await unzip(new Uint8Array(api.deployed), { maxEntries: 1024 });
    const text = (name) => dec(entries.get(name));

    // The engine was replaced…
    assert.equal(text('app/dist/index.html').includes('StoryLark'), true);
    assert.ok(!entries.has('app/dist/assets/index-old000.js'), 'the old bundle should be gone');
    assert.ok(entries.has('app/dist/assets/index-abc123.js'), 'the new bundle should be there');
    // …the brand was kept, byte for byte…
    assert.equal(text('app/dist/brand.json'), '{"appName":"Acme Reader"}');
    assert.equal(text('app/dist/theme.css'), ':root{--accent:#ff0000}');
    assert.equal(text('app/dist/icons/acme-mascot.png'), 'MASCOT');
    // …the runtime files travelled untouched…
    assert.equal(text('server.mjs'), '// the running entry\n');
    assert.equal(text('content-store.mjs'), '// a sibling the entry imports\n');
    // …and package.json was rewritten to pin the engine the artifact belongs to,
    // which is what makes App Service's build step install the right one.
    const deployedPkg = JSON.parse(text('package.json'));
    assert.equal(deployedPkg.dependencies['storylark-worker'], '9.9.9');
    assert.equal(deployedPkg.dependencies.hono, '^4', 'other dependencies must be left alone');

    // The request itself: Kudu's publish endpoint, with a managed-identity token.
    const publish = api.calls.find((c) => c.url === '/api/publish?type=zip');
    assert.equal(publish.method, 'POST');
    assert.equal(publish.headers.authorization, 'Bearer ARM-TOKEN');
    // …and the token was fetched from IMDS with the documented header and resource.
    const token = api.calls.find((c) => c.url.startsWith('/msi/token'));
    assert.equal(token.headers['x-identity-header'], 'secret-header');
    assert.match(token.url, /resource=https%3A%2F%2Fmanagement\.azure\.com%2F/);
    assert.match(token.url, /api-version=2019-08-01/);
  } finally {
    api.server.close();
    rmSync(siteRoot, { recursive: true, force: true });
  }
});

test('Azure with no managed identity offers no button and says why', () => {
  const { target, reason } = azureSelfDeploy({ WEBSITE_SITE_NAME: 'acme-app' });
  assert.equal(target, null);
  assert.match(reason, /managed identity/);
  assert.match(reason, /--enable-one-click/);
});

test('a process that is not App Service at all says so plainly', () => {
  const { target, reason } = azureSelfDeploy({});
  assert.equal(target, null);
  assert.match(reason, /not running on App Service/);
});

test('a managed identity Kudu rejects fails in the STATUS check, not half way through a deploy', async () => {
  const api = await azureApi({ kuduStatus: 403 });
  try {
    const { target } = azureSelfDeploy(azureEnv(api.base), { fetchImpl: localFetch(api.base) });
    const check = await target.preflight();
    assert.equal(check.ok, false);
    assert.match(check.detail, /Website Contributor|publish\/Action/);
  } finally {
    api.server.close();
  }
});

// ── the artifact this repo actually publishes ───────────────────────────────

test('the real engine artifact, if one has been built here, reads clean and carries no brand', async (t) => {
  const file = existsSync('dist-engine')
    ? (await import('node:fs')).readdirSync('dist-engine').find((n) => n.endsWith('.zip'))
    : null;
  if (!file) return t.skip('no dist-engine/*.zip — run `npm run build-engine && npm run package-engine` to include this check');

  const bytes = new Uint8Array(readFileSync(join('dist-engine', file)));
  const sums = readFileSync(join('dist-engine', `${file}.sha256`), 'utf8');
  assert.equal(await sha256Hex(bytes), parseChecksumFile(sums, file), 'the published checksum must match the artifact');

  const pkg = await readEnginePackage(bytes);
  assert.ok(pkg.dist.size > 100, 'a real engine build is a couple of hundred files');
  assert.ok(pkg.dist.has('index.html') && pkg.dist.has('sw.js'));
  assert.ok(pkg.worker, 'a real artifact carries the Cloudflare Worker bundle');
  assert.ok(pkg.migrations.size > 0 && pkg.migrationsPostgres.size > 0, 'and both migration sets');
  for (const path of pkg.dist.keys()) assert.ok(!isBrandOwned(path), `${path} should not be in an engine artifact`);
});
