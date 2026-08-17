// Wrangler OAuth credential discovery + self-update provisioning (AB#7418).
//
// ── Why this file exists ─────────────────────────────────────────────────────
// The /admin "Update now" button needs a credential only for releases that
// change the Worker's own script — a running Worker cannot replace its own
// code. When the operator ran the installer with CLOUDFLARE_API_TOKEN set,
// install.mjs mints (or stores) an API token and the job is done. But most
// operators authenticate with `wrangler login`, which is OAuth: there is no
// API token anywhere to mint from or store, and the previous behaviour was to
// give up and tell the operator to run --enable-one-click by hand. That
// manual step is the hole this module closes: it reads the OAuth credentials
// wrangler itself persisted, and provisions self-update from them with zero
// operator action.
//
// ── What wrangler actually stores, verified against wrangler 4.107.0 ─────────
// (All of this was read out of node_modules/wrangler/wrangler-dist/cli.js —
// the shipped source — not assumed from docs or memory.)
//
//   * Config dir: `~/.wrangler` if that directory exists (legacy), otherwise
//     xdg-app-paths(".wrangler").config():
//       - Linux:   $XDG_CONFIG_HOME/.wrangler  or  ~/.config/.wrangler
//       - macOS:   $XDG_CONFIG_HOME/.wrangler  or  ~/Library/Preferences/.wrangler
//       - Windows: %XDG_CONFIG_HOME%\.wrangler or  %APPDATA%\xdg.config\.wrangler
//   * Auth file: `<configDir>/config/default.toml` — plaintext TOML with
//     `oauth_token`, `refresh_token`, `expiration_time`, `scopes`, and (for
//     ancient wrangler-v1 logins) `api_token`.
//   * Since wrangler's keyring feature (OPT-IN — `wrangler login --use-keyring`;
//     the default is the plaintext file, confirmed: `wantsKeyring = envOverride
//     ?? isKeyringEnabled() ?? false`), the file may instead be
//     `<configDir>/config/default.enc`: a JSON envelope
//     {v:1, alg:"AES-256-GCM", iv, tag, ciphertext} (base64 fields) whose key
//     lives in the OS keyring as JSON {v:1, key:<base64 32 bytes>} under
//     service "wrangler", account "default" (macOS `security`, Linux
//     `secret-tool`, Windows @napi-rs/keyring).
//   * Refresh: POST https://dash.cloudflare.com/oauth2/token, form-encoded,
//     grant_type=refresh_token + refresh_token + client_id, where client_id is
//     wrangler's public OAuth client 54d11594-84e4-41aa-b438-e81b8fa78ee7.
//     The response is {access_token, expires_in, refresh_token?, scope} — the
//     refresh token MAY rotate (wrangler keeps the old one when the response
//     omits it, and so does this module).
//
// ── Why the refresh token, not just the access token ─────────────────────────
// An OAuth access token expires in about an hour. Storing only that would
// produce a button that works today and silently breaks tomorrow — worse than
// the hole it replaces. So provisioning stores the REFRESH token, and the
// Worker's self-deploy path (packages/worker/src/lib/self-deploy.ts,
// getOAuthAccessToken) exchanges it for a fresh access token at the moment of
// use, persisting any rotation in the deployment's own database.
//
// ── Why minting a scoped API token from OAuth is attempted but expected to
//    fail ──────────────────────────────────────────────────────────────────
// The best outcome would be a narrow, stable, revocable API token. But
// POST /user/tokens requires the "API Tokens Write" permission, and wrangler's
// OAuth scope list (DefaultScopes in the shipped source: account:read,
// user:read, workers:write, workers_scripts:write, d1:write, …) contains no
// token-management scope at all — Cloudflare deliberately does not let a
// wrangler login manage API tokens. provisionSelfUpdateFromOAuth still TRIES
// the mint first: it costs one request, and if Cloudflare ever widens the
// scopes, deployments silently get the better credential. Until then the
// refresh-token handoff below is the real path. (Not verified against a live
// account from this change — the scope-list reasoning is from wrangler's own
// source; the attempt-then-fall-back order means either answer is handled.)
//
// ── The handoff, and its one visible side effect ─────────────────────────────
// Cloudflare may rotate the refresh token on every use, and a rotated-away
// token is dead. That means one OAuth session cannot be safely shared between
// the operator's wrangler CLI and the deployment: whichever refreshes first
// silently kills the other's copy — and "the operator's routine wrangler use
// silently kills the button" is exactly the failure this work exists to
// eliminate. So provisioning deliberately takes OWNERSHIP of the session: it
// performs one refresh (proving the session is live), gives the resulting
// chain to the deployment, and accepts that the operator's local wrangler may
// ask them to `wrangler login` again later — a normal, self-explaining prompt
// that creates a brand-new session and does not touch the deployment's. The
// installer says this out loud at provision time.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Wrangler's public OAuth client id, from its shipped source. Not a secret. */
export const WRANGLER_CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
export const WRANGLER_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const CF_API = 'https://api.cloudflare.com/client/v4';

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Every directory wrangler could be keeping its auth config in, in wrangler's
 * own preference order (legacy home dir first, exactly as
 * getGlobalWranglerConfigPath does — it prefers ~/.wrangler whenever that
 * directory exists).
 */
export function wranglerConfigDirCandidates({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const dirs = [join(home, '.wrangler')];
  if (env.XDG_CONFIG_HOME) dirs.push(join(env.XDG_CONFIG_HOME, '.wrangler'));
  if (platform === 'win32') {
    dirs.push(join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'xdg.config', '.wrangler'));
  } else if (platform === 'darwin') {
    dirs.push(join(home, 'Library', 'Preferences', '.wrangler'));
  } else {
    dirs.push(join(home, '.config', '.wrangler'));
  }
  return dirs;
}

/**
 * Minimal TOML for wrangler's flat auth file: `key = "value"` lines. The
 * `scopes` array is deliberately ignored — nothing here needs it. Not a
 * general TOML parser and not trying to be one.
 */
export function parseWranglerAuthToml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)')\s*$/.exec(line);
    if (m) out[m[1]] = m[3] ?? m[4];
  }
  return {
    oauthToken: out.oauth_token,
    refreshToken: out.refresh_token,
    expirationTime: out.expiration_time,
    apiToken: out.api_token,
  };
}

/**
 * Decrypt wrangler's keyring-encrypted auth envelope
 * (`<configDir>/config/default.enc`) with the 32-byte key from the OS keyring.
 * Envelope and cipher exactly as wrangler's EncryptedFileCredentialStore
 * writes them: AES-256-GCM, base64 iv/tag/ciphertext, UTF-8 TOML plaintext.
 */
export function decryptWranglerEnvelope(envelopeJsonText, keyBytes) {
  const envelope = JSON.parse(envelopeJsonText);
  if (envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') {
    throw new Error(`unsupported wrangler credential envelope (v=${envelope.v}, alg=${envelope.alg})`);
  }
  const decipher = createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * The AES key for the envelope above, from the OS keyring — the same three
 * backends wrangler itself uses (service "wrangler", account "default"; the
 * stored secret is JSON {v:1, key:<base64>}). Returns undefined when the
 * backend or the entry is missing; the caller treats that as "no credentials
 * found" and fails loudly with instructions, never silently.
 */
export function readWranglerKeyringKey({ platform = process.platform, exec = execFileSync, requireImpl } = {}) {
  let raw;
  try {
    if (platform === 'darwin') {
      raw = exec('security', ['find-generic-password', '-s', 'wrangler', '-a', 'default', '-w'], { encoding: 'utf8' });
    } else if (platform === 'linux') {
      raw = exec('secret-tool', ['lookup', 'service', 'wrangler', 'account', 'default'], { encoding: 'utf8' });
    } else if (platform === 'win32') {
      // Wrangler installs @napi-rs/keyring globally for this; resolve it from
      // wherever Node can see it. No CLI equivalent exists on Windows.
      const req = requireImpl ?? createRequire(import.meta.url);
      const { Entry } = req('@napi-rs/keyring');
      raw = new Entry('wrangler', 'default').getPassword();
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(String(raw).trim());
    if (parsed?.v === 1 && typeof parsed.key === 'string') return Buffer.from(parsed.key, 'base64');
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Find and read whatever credentials `wrangler login` left on this machine.
 *
 * Returns one of:
 *   { source, oauth: { accessToken, refreshToken, expiresAt } }
 *   { source, apiToken }        — a wrangler-v1 `config` era api_token
 *   null                        — nothing found (or found but undecryptable)
 */
export function discoverWranglerAuth({ dirs, env = process.env, home, platform = process.platform, exec, requireImpl } = {}) {
  const candidates = dirs ?? wranglerConfigDirCandidates({ env, home, platform });
  for (const dir of candidates) {
    const tomlPath = join(dir, 'config', 'default.toml');
    const encPath = join(dir, 'config', 'default.enc');
    let text;
    let source;
    if (existsSync(tomlPath)) {
      text = readFileSync(tomlPath, 'utf8');
      source = tomlPath;
    } else if (existsSync(encPath)) {
      const key = readWranglerKeyringKey({ platform, exec, requireImpl });
      if (!key) continue; // encrypted but the key is unreachable — keep looking, report nothing found
      try {
        text = decryptWranglerEnvelope(readFileSync(encPath, 'utf8'), key);
      } catch {
        continue;
      }
      source = encPath;
    } else {
      continue;
    }
    const parsed = parseWranglerAuthToml(text);
    if (parsed.oauthToken) {
      return {
        source,
        oauth: {
          accessToken: parsed.oauthToken,
          refreshToken: parsed.refreshToken ?? '',
          // Same rule as wrangler's readStoredAuthState: no expiry recorded
          // means "treat as already expired" and refresh before use.
          expiresAt: parsed.expirationTime ? Date.parse(parsed.expirationTime) : 0,
        },
      };
    }
    if (parsed.apiToken) return { source, apiToken: parsed.apiToken };
  }
  return null;
}

// ── The OAuth token exchange ─────────────────────────────────────────────────

/**
 * Exchange a refresh token for a fresh access token (and possibly a rotated
 * refresh token). Throws on failure with `oauthError` set to the OAuth error
 * code (`invalid_grant` = the session is dead: revoked, or rotated away by
 * another holder).
 */
export async function refreshOAuthToken(refreshToken, { tokenUrl = WRANGLER_TOKEN_URL, clientId = WRANGLER_CLIENT_ID, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || !body.access_token) {
    const err = new Error(
      `Cloudflare OAuth token refresh failed: ${body.error_description || body.error || `HTTP ${res.status}`}`
    );
    err.oauthError = body.error;
    throw err;
  }
  return {
    accessToken: body.access_token,
    // Rotation is Cloudflare's call: keep ours when the response omits one.
    refreshToken: body.refresh_token || refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

// ── Cloudflare API helpers shared by both provisioning paths ─────────────────

const apiErrorText = (body, status) =>
  body?.errors?.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${status}`;

/**
 * Mint a token scoped to Account | Workers Scripts | Edit on this one account,
 * authenticated with `bearer` — an operator API token or an OAuth access
 * token. Throws with the API's own words when the credential cannot create
 * tokens (a common restriction for API tokens, and — per the header comment —
 * the expected answer for OAuth sessions).
 */
export async function mintScopedToken(bearer, accountId, tokenName, { apiBase = CF_API, fetchImpl = fetch } = {}) {
  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
  // Permission-group ids are not guessable constants — ask the API for the one
  // that means "Workers Scripts Write".
  const groupsRes = await fetchImpl(`${apiBase}/user/tokens/permission_groups`, { headers });
  const groups = await groupsRes.json().catch(() => ({}));
  if (!groupsRes.ok || groups.success === false) throw new Error(apiErrorText(groups, groupsRes.status));
  const group = (groups.result ?? []).find((g) => g.name === 'Workers Scripts Write');
  if (!group) throw new Error('the API did not list a "Workers Scripts Write" permission group');

  const res = await fetchImpl(`${apiBase}/user/tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: tokenName,
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
          permission_groups: [{ id: group.id }],
        },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false || !body.result?.value) throw new Error(apiErrorText(body, res.status));
  return body.result.value;
}

/**
 * Store one Worker secret over the REST API rather than `wrangler secret put`.
 * The OAuth provisioning path MUST use this: the moment it refreshes, the
 * operator's stored wrangler session may be rotated stale, so shelling out to
 * wrangler mid-provisioning could fail on its own auth. The access token in
 * hand is the one credential guaranteed live at that moment.
 */
export async function putWorkerSecret(bearer, accountId, scriptName, name, text, { apiBase = CF_API, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${apiBase}/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, text, type: 'secret_text' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`storing the ${name} secret failed: ${apiErrorText(body, res.status)}`);
  }
}

// ── Provisioning from an OAuth session ───────────────────────────────────────

/**
 * Provision self-update on a Worker from a `wrangler login` OAuth session.
 *
 * Order of preference, per the header comment:
 *   1. Mint a narrow API token with the OAuth access token (expected to be
 *      refused — wrangler's scopes cannot manage tokens — but attempted so a
 *      future scope widening upgrades deployments automatically). Success
 *      stores CF_API_TOKEN + CF_ACCOUNT_ID, the same posture as a token-based
 *      install.
 *   2. Hand the OAuth session itself to the deployment: refresh once (taking
 *      ownership of the rotation chain), store CF_OAUTH_REFRESH_TOKEN +
 *      CF_ACCOUNT_ID. The Worker refreshes at the moment of use and persists
 *      rotation in its own database.
 *
 * Returns { mode, notes } — notes are printed verbatim by the installer, and
 * they are the transparency contract: what was stored, how broad it is, how to
 * revoke it. Throws when the session is unusable; the CALLER decides that a
 * deploy without self-update is a loud failure, not this module.
 */
export async function provisionSelfUpdateFromOAuth({
  creds,
  accountId,
  scriptName,
  tokenName,
  apiBase = CF_API,
  tokenUrl = WRANGLER_TOKEN_URL,
  clientId = WRANGLER_CLIENT_ID,
  fetchImpl = fetch,
}) {
  let { accessToken, refreshToken, expiresAt } = creds;
  let rotated = false;
  const takeOwnership = async () => {
    ({ accessToken, refreshToken, expiresAt } = await refreshOAuthToken(refreshToken, { tokenUrl, clientId, fetchImpl }));
    rotated = true;
  };
  // A stored access token near expiry is useless for the calls below; refresh
  // up front. 60s of margin, same as the Worker side uses.
  if (!accessToken || Date.now() + 60_000 >= expiresAt) await takeOwnership();

  try {
    const minted = await mintScopedToken(accessToken, accountId, tokenName, { apiBase, fetchImpl });
    await putWorkerSecret(accessToken, accountId, scriptName, 'CF_API_TOKEN', minted, { apiBase, fetchImpl });
    await putWorkerSecret(accessToken, accountId, scriptName, 'CF_ACCOUNT_ID', accountId, { apiBase, fetchImpl });
    return {
      mode: 'minted-token',
      notes: [
        `✓ Minted a NEW API token "${tokenName}", scoped to Account | Workers`,
        '  Scripts | Edit on this account only, and stored it as a Worker secret.',
        '  Your wrangler login itself was NOT stored on the deployment.',
        '  Revoke it anytime at https://dash.cloudflare.com/profile/api-tokens.',
        ...(rotated
          ? ['  (Your wrangler session was refreshed to do this — if wrangler asks you', '  to log in again later, that is why, and it is harmless.)']
          : []),
      ],
    };
  } catch (mintErr) {
    // The expected path for OAuth (see header): fall through to the handoff.
    // Take ownership of the chain NOW if the mint ran on the still-valid
    // stored access token — sharing one rotating chain with the operator's
    // CLI is how the button silently dies later.
    if (!rotated) await takeOwnership();
    await putWorkerSecret(accessToken, accountId, scriptName, 'CF_OAUTH_REFRESH_TOKEN', refreshToken, { apiBase, fetchImpl });
    await putWorkerSecret(accessToken, accountId, scriptName, 'CF_ACCOUNT_ID', accountId, { apiBase, fetchImpl });
    return {
      mode: 'oauth-refresh',
      notes: [
        '✓ Handed your Cloudflare login session (wrangler OAuth) to the deployment',
        '  and stored its refresh token as a Worker secret. Scope: exactly what',
        `  \`wrangler login\` grants (Workers scripts, KV, D1, R2 on your account) —`,
        '  broader than the ideal, because Cloudflare does not let a wrangler',
        `  session mint narrower API tokens (the attempt was refused: ${mintErr.message}).`,
        '  The deployment exchanges it for a short-lived token only at the moment',
        '  an API-server release is installed from /admin.',
        '  Revoke it anytime: run --disable-one-click, or log the session out from',
        '  the Cloudflare dashboard (My Profile → Session and login management).',
        '  NOTE: your local wrangler may ask you to `wrangler login` again later —',
        '  this handoff took over the session\'s refresh chain on purpose, so that',
        '  routine wrangler use on this machine cannot silently break the button.',
      ],
    };
  }
}
