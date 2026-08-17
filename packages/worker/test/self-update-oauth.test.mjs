// The OAuth self-update path (AB#7418, revised): `wrangler login` is enough.
//
// ── What is real here and what is not ───────────────────────────────────────
// Everything except Cloudflare's own servers. Credential discovery runs
// against REAL fixture files on disk, laid out byte-for-byte the way wrangler
// 4.107 lays them out (plaintext TOML, and the opt-in AES-256-GCM envelope —
// which these tests really encrypt and really decrypt with node:crypto). The
// OAuth token exchange, the mint attempt, and the secret writes run over REAL
// HTTP against local servers implementing the documented contracts, and the
// tests assert the exact requests received: grant types, client ids, bearer
// tokens, secret names and values. The worker-side refresh state persists in
// a REAL SQLite database through the same Database seam D1 uses.
//
// What none of this can prove: that Cloudflare's live OAuth endpoint honours
// wrangler's client id for a refresh initiated outside wrangler, whether it
// rotates the refresh token on every exchange (both behaviours are handled),
// and that POST /user/tokens really refuses an OAuth bearer (expected from
// wrangler's own scope list — no token-management scope exists — and handled
// either way by the attempt-then-fall-back order). Proving those requires a
// live `wrangler login` session, which this environment does not have. See
// the code comments in platforms/cloudflare/wrangler-oauth.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  wranglerConfigDirCandidates,
  parseWranglerAuthToml,
  decryptWranglerEnvelope,
  discoverWranglerAuth,
  refreshOAuthToken,
  provisionSelfUpdateFromOAuth,
  WRANGLER_CLIENT_ID,
} from '../../../platforms/cloudflare/wrangler-oauth.mjs';
import {
  cloudflareSelfDeploy,
  resolveSelfDeploy,
  getOAuthAccessToken,
  resetOAuthTokenCache,
} from '../src/lib/self-deploy.ts';
import { buildEnginePackage, readEnginePackage } from 'storylark-contracts/engine-package';

const HERE = dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);

// ── Fixtures: wrangler's on-disk credential formats, reproduced exactly ─────

/** The TOML wrangler 4.x writes after `wrangler login` (field names verified against its shipped source). */
const WRANGLER_TOML = `oauth_token = "live-access-token"
expiration_time = "${new Date(Date.now() + 3600_000).toISOString()}"
refresh_token = "live-refresh-token"
scopes = [ "account:read", "user:read", "workers:write", "workers_scripts:write", "d1:write", "offline_access" ]
`;

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'storylark-oauth-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

test('config-dir candidates match wrangler\'s own resolution order on every platform', () => {
  const linux = wranglerConfigDirCandidates({ env: {}, home: '/home/op', platform: 'linux' });
  assert.deepEqual(linux, [join('/home/op', '.wrangler'), join('/home/op', '.config', '.wrangler')]);

  const mac = wranglerConfigDirCandidates({ env: {}, home: '/Users/op', platform: 'darwin' });
  assert.deepEqual(mac, [join('/Users/op', '.wrangler'), join('/Users/op', 'Library', 'Preferences', '.wrangler')]);

  const win = wranglerConfigDirCandidates({ env: { APPDATA: 'C:\\Users\\op\\AppData\\Roaming' }, home: 'C:\\Users\\op', platform: 'win32' });
  assert.deepEqual(win, [join('C:\\Users\\op', '.wrangler'), join('C:\\Users\\op\\AppData\\Roaming', 'xdg.config', '.wrangler')]);

  // XDG_CONFIG_HOME beats the platform default, exactly as xdg-app-paths has it.
  const xdg = wranglerConfigDirCandidates({ env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/op', platform: 'linux' });
  assert.deepEqual(xdg, [join('/home/op', '.wrangler'), join('/xdg', '.wrangler'), join('/home/op', '.config', '.wrangler')]);
});

test('parsing the real TOML shape yields the OAuth triple, and a v1 api_token file yields that', () => {
  const parsed = parseWranglerAuthToml(WRANGLER_TOML);
  assert.equal(parsed.oauthToken, 'live-access-token');
  assert.equal(parsed.refreshToken, 'live-refresh-token');
  assert.ok(Date.parse(parsed.expirationTime) > Date.now());

  const legacy = parseWranglerAuthToml('api_token = "v1-era-token"\n');
  assert.equal(legacy.apiToken, 'v1-era-token');
  assert.equal(legacy.oauthToken, undefined);
});

test('discovery reads a real plaintext credential file from a realistic layout', () => {
  const dir = fixtureDir({ 'config/default.toml': WRANGLER_TOML });
  try {
    const auth = discoverWranglerAuth({ dirs: [dir] });
    assert.equal(auth.source, join(dir, 'config', 'default.toml'));
    assert.equal(auth.oauth.accessToken, 'live-access-token');
    assert.equal(auth.oauth.refreshToken, 'live-refresh-token');
    assert.ok(auth.oauth.expiresAt > Date.now());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery falls through empty dirs to the first dir that actually has credentials, and reports null when none do', () => {
  const empty = fixtureDir({});
  const real = fixtureDir({ 'config/default.toml': 'api_token = "from-second-dir"\n' });
  try {
    const auth = discoverWranglerAuth({ dirs: [empty, real] });
    assert.equal(auth.apiToken, 'from-second-dir');
    assert.equal(discoverWranglerAuth({ dirs: [empty] }), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('a file with no expiration_time is treated as already expired — refresh before use, never trust it', () => {
  const dir = fixtureDir({ 'config/default.toml': 'oauth_token = "old"\nrefresh_token = "r"\n' });
  try {
    const auth = discoverWranglerAuth({ dirs: [dir] });
    assert.equal(auth.oauth.expiresAt, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the keyring-encrypted layout really decrypts: AES-256-GCM envelope, key from the OS keyring', () => {
  // Encrypt the fixture TOML exactly the way wrangler's
  // EncryptedFileCredentialStore does, then hand discovery a fake keyring
  // (the exec seam) serving the key in wrangler's own JSON envelope.
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(WRANGLER_TOML, 'utf-8'), cipher.final()]);
  const envelope = JSON.stringify({
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });

  // The primitive on its own…
  assert.equal(decryptWranglerEnvelope(envelope, key), WRANGLER_TOML);

  // …and the full discovery path through it.
  const dir = fixtureDir({ 'config/default.enc': envelope });
  const keyringExec = (cmd, args) => {
    assert.equal(cmd, 'secret-tool');
    assert.deepEqual(args, ['lookup', 'service', 'wrangler', 'account', 'default']);
    return JSON.stringify({ v: 1, key: key.toString('base64'), created: new Date().toISOString() });
  };
  try {
    const auth = discoverWranglerAuth({ dirs: [dir], platform: 'linux', exec: keyringExec });
    assert.equal(auth.oauth.refreshToken, 'live-refresh-token');

    // Key unreachable → treated as nothing found, for the caller to report loudly.
    const noKey = discoverWranglerAuth({
      dirs: [dir],
      platform: 'linux',
      exec: () => {
        throw new Error('no keyring on this host');
      },
    });
    assert.equal(noKey, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The token exchange, over real HTTP ──────────────────────────────────────

/**
 * A local stand-in for https://dash.cloudflare.com/oauth2/token implementing
 * the documented refresh grant. `chain` maps a refresh token to what the next
 * exchange returns; anything else gets OAuth's own invalid_grant shape.
 */
function oauthServer(chain) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    hits.push({ url: req.url, contentType: req.headers['content-type'], params: Object.fromEntries(params) });
    const next = req.url === '/oauth/token' && params.get('grant_type') === 'refresh_token' ? chain[params.get('refresh_token')] : undefined;
    if (!next) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token is invalid or has been rotated away' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}/oauth/token` }));
  });
}

test('the refresh exchange sends exactly what wrangler sends, and follows rotation when Cloudflare rotates', async () => {
  const oauth = await oauthServer({
    'r-0': { access_token: 'a-1', refresh_token: 'r-1', expires_in: 3600 },
  });
  try {
    const fresh = await refreshOAuthToken('r-0', { tokenUrl: oauth.url });
    assert.equal(fresh.accessToken, 'a-1');
    assert.equal(fresh.refreshToken, 'r-1', 'the rotated token replaces the spent one');
    assert.ok(fresh.expiresAt > Date.now() + 3000_000);

    const hit = oauth.hits[0];
    assert.match(hit.contentType, /application\/x-www-form-urlencoded/);
    assert.equal(hit.params.grant_type, 'refresh_token');
    assert.equal(hit.params.refresh_token, 'r-0');
    assert.equal(hit.params.client_id, WRANGLER_CLIENT_ID, "wrangler's public client id — the session was issued to it");
  } finally {
    oauth.server.close();
  }
});

test('no rotation in the response means the refresh token is kept, exactly as wrangler itself behaves', async () => {
  const oauth = await oauthServer({ 'r-0': { access_token: 'a-1', expires_in: 3600 } });
  try {
    const fresh = await refreshOAuthToken('r-0', { tokenUrl: oauth.url });
    assert.equal(fresh.refreshToken, 'r-0');
  } finally {
    oauth.server.close();
  }
});

test('a dead session surfaces as invalid_grant, machine-readably', async () => {
  const oauth = await oauthServer({});
  try {
    await assert.rejects(
      () => refreshOAuthToken('revoked', { tokenUrl: oauth.url }),
      (err) => {
        assert.equal(err.oauthError, 'invalid_grant');
        assert.match(err.message, /invalid or has been rotated/);
        return true;
      }
    );
  } finally {
    oauth.server.close();
  }
});

// ── Provisioning: the choreography the installer runs ───────────────────────

/**
 * A local Cloudflare API implementing the two endpoints provisioning touches:
 * the token mint pair and the Worker-secrets PUT. `allowMint: false` answers
 * the mint the way the real API is expected to answer an OAuth bearer —
 * refused for lack of token-management permission.
 */
function cloudflareApi({ allowMint }) {
  const calls = [];
  const secrets = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/user/tokens/permission_groups') {
      if (!allowMint) return json({ success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] }, 403);
      return json({ success: true, result: [{ id: 'pg-1', name: 'Workers Scripts Write' }] });
    }
    if (req.url === '/user/tokens' && req.method === 'POST') {
      if (!allowMint) return json({ success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] }, 403);
      return json({ success: true, result: { id: 'tok-1', value: 'minted-token-value' } });
    }
    const secretPut = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/secrets$/.exec(req.url);
    if (secretPut && req.method === 'PUT') {
      const parsed = JSON.parse(body);
      secrets.set(parsed.name, { ...parsed, account: secretPut[1], script: secretPut[2], auth: req.headers.authorization });
      return json({ success: true, result: { name: parsed.name } });
    }
    json({ success: false, errors: [{ message: `unexpected ${req.method} ${req.url}` }] }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, secrets, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('OAuth provisioning, mint refused (the expected live answer): the session is handed over — refreshed once, rotated token stored', async () => {
  const oauth = await oauthServer({ 'r-0': { access_token: 'a-1', refresh_token: 'r-1', expires_in: 3600 } });
  const api = await cloudflareApi({ allowMint: false });
  try {
    const result = await provisionSelfUpdateFromOAuth({
      creds: { accessToken: 'live-access-token', refreshToken: 'r-0', expiresAt: Date.now() + 3600_000 },
      accountId: 'acct',
      scriptName: 'acme',
      tokenName: 'storylark-self-update-acme',
      apiBase: api.base,
      tokenUrl: oauth.url,
    });
    assert.equal(result.mode, 'oauth-refresh');

    // The handoff took ownership: one refresh happened even though the stored
    // access token was still valid — sharing a rotating chain with the
    // operator's CLI is how the button silently dies later.
    assert.equal(oauth.hits.length, 1);
    assert.equal(oauth.hits[0].params.refresh_token, 'r-0');

    // What landed on the Worker: the ROTATED refresh token (r-1, not the spent
    // r-0) and the account id, both written with the fresh access token.
    const refresh = api.secrets.get('CF_OAUTH_REFRESH_TOKEN');
    assert.equal(refresh.text, 'r-1');
    assert.equal(refresh.type, 'secret_text');
    assert.equal(refresh.script, 'acme');
    assert.equal(refresh.auth, 'Bearer a-1');
    assert.equal(api.secrets.get('CF_ACCOUNT_ID').text, 'acct');
    assert.equal(api.secrets.has('CF_API_TOKEN'), false, 'no API token exists to store on this path');

    // The transparency contract: scope, revocation, and the wrangler-relogin
    // side effect are all said out loud.
    const notes = result.notes.join('\n');
    assert.match(notes, /refresh token/);
    assert.match(notes, /broader than the ideal/);
    assert.match(notes, /--disable-one-click/);
    assert.match(notes, /wrangler login` again/);
  } finally {
    oauth.server.close();
    api.server.close();
  }
});

test('OAuth provisioning, mint permitted (if Cloudflare ever allows it): the narrow token is stored and the session is not', async () => {
  const oauth = await oauthServer({});
  const api = await cloudflareApi({ allowMint: true });
  try {
    const result = await provisionSelfUpdateFromOAuth({
      creds: { accessToken: 'live-access-token', refreshToken: 'r-0', expiresAt: Date.now() + 3600_000 },
      accountId: 'acct',
      scriptName: 'acme',
      tokenName: 'storylark-self-update-acme',
      apiBase: api.base,
      tokenUrl: oauth.url,
    });
    assert.equal(result.mode, 'minted-token');
    assert.equal(oauth.hits.length, 0, 'the still-valid access token needed no refresh, so the operator\'s session is untouched');
    assert.equal(api.secrets.get('CF_API_TOKEN').text, 'minted-token-value');
    assert.equal(api.secrets.get('CF_ACCOUNT_ID').text, 'acct');
    assert.equal(api.secrets.has('CF_OAUTH_REFRESH_TOKEN'), false);
    const mint = api.calls.find((c) => c.url === '/user/tokens' && c.method === 'POST');
    assert.equal(mint.auth, 'Bearer live-access-token');
    const policy = JSON.parse(mint.body).policies[0];
    assert.deepEqual(policy.resources, { 'com.cloudflare.api.account.acct': '*' });
    assert.deepEqual(policy.permission_groups, [{ id: 'pg-1' }]);
  } finally {
    oauth.server.close();
    api.server.close();
  }
});

test('an expired stored access token is refreshed before anything else is attempted', async () => {
  const oauth = await oauthServer({ 'r-0': { access_token: 'a-1', refresh_token: 'r-1', expires_in: 3600 } });
  const api = await cloudflareApi({ allowMint: false });
  try {
    const result = await provisionSelfUpdateFromOAuth({
      creds: { accessToken: 'stale', refreshToken: 'r-0', expiresAt: Date.now() - 1000 },
      accountId: 'acct',
      scriptName: 'acme',
      tokenName: 'n',
      apiBase: api.base,
      tokenUrl: oauth.url,
    });
    assert.equal(result.mode, 'oauth-refresh');
    assert.equal(oauth.hits.length, 1, 'one refresh covers both the mint attempt and the handoff');
    assert.ok(api.calls.every((c) => c.auth !== 'Bearer stale'), 'the expired token must never be presented');
    assert.equal(api.secrets.get('CF_OAUTH_REFRESH_TOKEN').text, 'r-1');
  } finally {
    oauth.server.close();
    api.server.close();
  }
});

test('a dead session fails provisioning with the OAuth error intact — the installer turns this into its loud failure', async () => {
  const oauth = await oauthServer({});
  const api = await cloudflareApi({ allowMint: false });
  try {
    await assert.rejects(
      () =>
        provisionSelfUpdateFromOAuth({
          creds: { accessToken: '', refreshToken: 'revoked', expiresAt: 0 },
          accountId: 'acct',
          scriptName: 'acme',
          tokenName: 'n',
          apiBase: api.base,
          tokenUrl: oauth.url,
        }),
      /token refresh failed/
    );
    assert.equal(api.secrets.size, 0, 'nothing may be stored when the credential is dead');
  } finally {
    oauth.server.close();
    api.server.close();
  }
});

// ── The worker side: a live access token at the moment of use ───────────────

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

function oauthEnv(db, oauth, extra = {}) {
  return {
    BRAND: 'acme',
    CF_ACCOUNT_ID: 'acct',
    CF_OAUTH_REFRESH_TOKEN: 'seed-refresh',
    CF_OAUTH_TOKEN_URL: oauth.url,
    DB: sqliteSeam(db),
    ...extra,
  };
}

test('first use exchanges the seed and PERSISTS the rotated chain before returning — a crash cannot orphan the session', async () => {
  const oauth = await oauthServer({ 'seed-refresh': { access_token: 'a-1', refresh_token: 'r-1', expires_in: 3600 } });
  const db = new DatabaseSync(':memory:');
  try {
    resetOAuthTokenCache();
    const env = oauthEnv(db, oauth);
    assert.equal(await getOAuthAccessToken(env), 'a-1');

    const row = db.prepare('SELECT * FROM self_update_oauth').get();
    assert.equal(row.refresh_token, 'r-1', 'the rotated token is the recorded successor');
    assert.equal(row.access_token, 'a-1');
    assert.ok(row.expires_at > Date.now());
    assert.equal(row.seed_sha256.length, 64, 'the row remembers which secret it grew from');

    // Same isolate: served from memory, no second exchange.
    assert.equal(await getOAuthAccessToken(env), 'a-1');
    assert.equal(oauth.hits.length, 1);

    // A "new isolate" (cache cleared): served from the persisted row, still no
    // second exchange while the access token lives.
    resetOAuthTokenCache();
    assert.equal(await getOAuthAccessToken(env), 'a-1');
    assert.equal(oauth.hits.length, 1);
  } finally {
    oauth.server.close();
  }
});

test('an expired persisted access token refreshes with the ROTATED refresh token, never the spent seed', async () => {
  const oauth = await oauthServer({ 'r-1': { access_token: 'a-2', refresh_token: 'r-2', expires_in: 3600 } });
  const db = new DatabaseSync(':memory:');
  try {
    resetOAuthTokenCache();
    const env = oauthEnv(db, oauth);
    // Simulate the state an earlier isolate left behind an hour ago.
    await getOAuthAccessTokenSeedRow(db, env, { refresh: 'r-1', access: 'a-1', expiresAt: Date.now() - 1000 });

    assert.equal(await getOAuthAccessToken(env), 'a-2');
    assert.equal(oauth.hits[0].params.refresh_token, 'r-1');
    assert.equal(db.prepare('SELECT refresh_token FROM self_update_oauth').get().refresh_token, 'r-2');
  } finally {
    oauth.server.close();
  }
});

/** Plant a persisted OAuth state row exactly as the worker writes it. */
async function getOAuthAccessTokenSeedRow(db, env, { refresh, access, expiresAt }) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.CF_OAUTH_REFRESH_TOKEN));
  const seedHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  db.exec(
    'CREATE TABLE IF NOT EXISTS self_update_oauth (id INTEGER PRIMARY KEY CHECK (id = 1), seed_sha256 TEXT NOT NULL, refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL)'
  );
  db.prepare('INSERT OR REPLACE INTO self_update_oauth (id, seed_sha256, refresh_token, access_token, expires_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)').run(
    seedHash,
    refresh,
    access,
    expiresAt,
    Date.now()
  );
}

test('re-provisioning (a NEW seed secret) orphans the old row instead of fighting it', async () => {
  const oauth = await oauthServer({ 'seed-refresh': { access_token: 'a-new', refresh_token: 'r-new', expires_in: 3600 } });
  const db = new DatabaseSync(':memory:');
  try {
    resetOAuthTokenCache();
    const env = oauthEnv(db, oauth);
    // A row from a PREVIOUS provisioning: different seed, still-live access token.
    await getOAuthAccessTokenSeedRow(db, { CF_OAUTH_REFRESH_TOKEN: 'old-seed' }, { refresh: 'r-old', access: 'a-old', expiresAt: Date.now() + 3600_000 });

    assert.equal(await getOAuthAccessToken(env), 'a-new', 'the fresh secret wins; the stale chain is ignored');
    assert.equal(oauth.hits[0].params.refresh_token, 'seed-refresh');
  } finally {
    oauth.server.close();
  }
});

test('losing a rotation race recovers by re-reading what the winner persisted', async () => {
  const db = new DatabaseSync(':memory:');
  // The token server plays the race: the first exchange (with the stale token)
  // simulates "another isolate already rotated" by planting the winner's row
  // mid-request and answering invalid_grant; the retry with the winner's token
  // succeeds. This is the real recovery path, exercised end to end.
  const hits = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    hits.push(Object.fromEntries(params));
    if (params.get('refresh_token') === 'seed-refresh') {
      await getOAuthAccessTokenSeedRow(db, { CF_OAUTH_REFRESH_TOKEN: 'seed-refresh' }, { refresh: 'r-winner', access: null, expiresAt: null });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_grant' }));
    }
    if (params.get('refresh_token') === 'r-winner') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'a-won', refresh_token: 'r-2', expires_in: 3600 }));
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/oauth/token`;
  try {
    resetOAuthTokenCache();
    const env = oauthEnv(db, { url });
    assert.equal(await getOAuthAccessToken(env), 'a-won');
    assert.deepEqual(
      hits.map((h) => h.refresh_token),
      ['seed-refresh', 'r-winner']
    );
  } finally {
    server.close();
  }
});

test('a genuinely dead session throws the re-provisioning instruction, for preflight to surface as the fault it is', async () => {
  const oauth = await oauthServer({});
  const db = new DatabaseSync(':memory:');
  try {
    resetOAuthTokenCache();
    await assert.rejects(() => getOAuthAccessToken(oauthEnv(db, oauth)), /--update --yes/);
  } finally {
    oauth.server.close();
  }
});

// ── The deploy target, driven by the OAuth credential ───────────────────────

test('an OAuth-provisioned deployment IS a deploy target, and its preflight presents the freshly exchanged bearer', async () => {
  const oauth = await oauthServer({ 'seed-refresh': { access_token: 'a-1', refresh_token: 'r-1', expires_in: 3600 } });
  const calls = [];
  const api = createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, result: {} }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const db = new DatabaseSync(':memory:');
  try {
    resetOAuthTokenCache();
    const env = oauthEnv(db, oauth, { CF_API_BASE: `http://127.0.0.1:${api.address().port}` });
    const target = cloudflareSelfDeploy(env);
    assert.equal(target.platform, 'cloudflare');
    assert.match(target.credential, /OAuth/);
    assert.match(target.credential, /short-lived/);

    const check = await target.preflight();
    assert.equal(check.ok, true);
    assert.equal(calls[0].auth, 'Bearer a-1');
    assert.match(calls[0].url, /\/accounts\/acct\/workers\/scripts\/acme\/settings$/);
  } finally {
    oauth.server.close();
    api.close();
  }
});

test('under workerd, the OAuth secret pair resolves a target exactly as a token pair does — and neither is a degraded state', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
  try {
    const oauth = resolveSelfDeploy({ BRAND: 'acme', CF_ACCOUNT_ID: 'acct', CF_OAUTH_REFRESH_TOKEN: 'r' });
    assert.ok(oauth.target, 'an OAuth-provisioned deployment has a working button');
    assert.equal(oauth.reason, '');

    const token = resolveSelfDeploy({ BRAND: 'acme', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 't' });
    assert.ok(token.target);

    // Both credentials present: the deliberately-issued narrow token wins.
    const both = resolveSelfDeploy({ BRAND: 'acme', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 't', CF_OAUTH_REFRESH_TOKEN: 'r' });
    assert.match(both.target.credential, /API token/);

    // Neither: the FAULT state, named as one, with the automatic repair —
    // never a command presented as the operator's path.
    const neither = resolveSelfDeploy({ BRAND: 'acme', CF_ACCOUNT_ID: 'acct' });
    assert.equal(neither.target, null);
    assert.match(neither.reason, /Self-update is disabled/);
    assert.match(neither.reason, /fault state/);
    assert.match(neither.reason, /--update --yes/);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  }
});

test('a full API-server install works end to end on the OAuth credential', async () => {
  // Compact version of engine-update.test.mjs's Cloudflare choreography, with
  // the bearer coming from a real refresh exchange instead of a static token.
  const oauth = await oauthServer({ 'seed-refresh': { access_token: 'a-1', refresh_token: 'r-1', expires_in: 3600 } });
  const calls = [];
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.endsWith('/settings')) {
      return json({ success: true, result: { compatibility_date: '2026-06-01', compatibility_flags: [], bindings: [{ name: 'BRAND', type: 'plain_text', text: 'acme' }, { name: 'ADMIN_KEY', type: 'secret_text' }] } });
    }
    if (req.url.endsWith('/assets-upload-session')) return json({ success: true, result: { jwt: 'SESSION-JWT', buckets: [] } });
    if (/\/workers\/scripts\/acme$/.test(req.url) && req.method === 'PUT') return json({ success: true, result: { id: 'acme' } });
    json({ success: false, errors: [{ message: `unexpected ${req.method} ${req.url}` }] }, 404);
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const db = new DatabaseSync(':memory:');
  try {
    resetOAuthTokenCache();
    const env = oauthEnv(db, oauth, {
      CF_API_BASE: `http://127.0.0.1:${api.address().port}`,
      ASSETS: {
        async fetch() {
          return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
        },
      },
    });
    const built = await buildEnginePackage({
      dist: new Map(
        Object.entries({
          'index.html': enc('<!doctype html><html><head><title data-storylark-title="app">S</title></head></html>'),
          'admin.html': enc('<!doctype html><html><head><title data-storylark-title="admin">A</title></head></html>'),
          'sw.js': enc('//'),
          'outputs.json': enc('{"formatVersion":1,"files":{}}'),
        })
      ),
      worker: enc('export default {};'),
      migrations: new Map([['0001_init.sql', enc('CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY);')]]),
      migrationsPostgres: new Map(),
      coreVersion: '9.9.9',
      workerVersion: '9.9.9',
      builtAt: '2026-08-17T00:00:00.000Z',
    });
    const pkg = await readEnginePackage(built.bytes);
    const log = [];
    const result = await cloudflareSelfDeploy(env).install(pkg, (l) => log.push(l));
    assert.match(result.note, /untouched/);

    // The migration really ran, through the same seam, before the swap.
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='widgets'").get());

    // Every Cloudflare call carried the exchanged bearer; only ONE exchange
    // happened for the whole install.
    const apiCalls = calls.filter((c) => c.auth);
    assert.ok(apiCalls.length >= 3);
    assert.ok(apiCalls.every((c) => c.auth === 'Bearer a-1'));
    assert.equal(oauth.hits.length, 1);
  } finally {
    oauth.server.close();
    api.close();
  }
});

// ── The portal contract: a command is reference, never the path ─────────────
//
// There is no DOM harness in `npm test` (deliberately — see
// theme-portal-ui.mjs), so the portal's side of "the button is always the
// answer" is held by source-level guards: cheap, honest about what they are,
// and they fail the moment someone reintroduces a command-first state.

const ADMIN_TSX = readFileSync(join(HERE, '..', '..', 'core', 'src', 'screens', 'Admin.tsx'), 'utf8');

test('the update card presents the command only inside the folded reference block', () => {
  const commandBlocks = ADMIN_TSX.match(/class="admin-command">\{command\}/g) ?? [];
  assert.equal(commandBlocks.length, 1, 'exactly one rendering of the update command');
  const updateSection = ADMIN_TSX.slice(ADMIN_TSX.indexOf('function UpdateSection'));
  const details = /<details class="admin-update-reference">([\s\S]*?)<\/details>/.exec(updateSection);
  assert.ok(details, 'the reference block exists');
  assert.match(details[1], /class="admin-command">\{command\}/, 'the command lives inside it');
  assert.match(details[1], /never need this/, 'and is introduced as reference, not instruction');
});

test('no branch of the card tells the operator to go run the command as their path', () => {
  assert.ok(!ADMIN_TSX.includes('You can also take it'), 'the old command-as-alternative copy is gone');
  assert.ok(!ADMIN_TSX.includes('To take it, run this'), 'the old command-as-path copy is gone');
});

test('the degraded state renders the worker\'s reason as a fault, not a routine difference', () => {
  assert.match(ADMIN_TSX, /degradedReason && \(\s*<p class="settings-note admin-error">\{degradedReason\}<\/p>/);
  assert.match(ADMIN_TSX, /fault state/, 'the client-side fallback wording names it a fault too');
});

test('no self-deploy reason presents the command as the way forward', () => {
  const selfDeploy = readFileSync(join(HERE, '..', 'src', 'lib', 'self-deploy.ts'), 'utf8');
  const azure = readFileSync(join(HERE, '..', '..', '..', 'platforms', 'azure', 'self-deploy.mjs'), 'utf8');
  for (const source of [selfDeploy, azure]) {
    assert.ok(!/command below/i.test(source), 'reasons must not point at the command block as the path');
  }
});
