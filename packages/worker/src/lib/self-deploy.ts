/**
 * The one-click update seam (AB#7418 — plan §4 layer 3, §0d Phase 5).
 *
 * ── The thing this is not ───────────────────────────────────────────────────
 * It is not a way for StoryLark to deploy to a customer. Nothing here holds a
 * StoryLark credential, contacts a StoryLark service, or can be triggered from
 * outside the deployment. The button exists only where the OPERATOR has already
 * given this deployment permission to deploy ITSELF on the platform they chose,
 * and the click that starts it is an admin session's click. Where they have
 * not, `resolveSelfDeploy` returns null with a reason the portal reports as
 * the fault it now is — since AB#7418's revision the installer provisions
 * this permission as part of every normal --deploy/--update (and fails loudly
 * when it cannot), so "no permission" only happens to a deployment that
 * predates automatic setup or explicitly opted out. The operator stays in
 * charge either way: nothing here holds a credential they did not implicitly
 * or explicitly hand over, and --disable-one-click withdraws it.
 *
 * ── Why a seam rather than an if/else ───────────────────────────────────────
 * The same reason `Database` and `ContentStore` are seams: the two platforms
 * have nothing in common here. Cloudflare uploads an asset manifest and a
 * script over a REST API with an operator-issued token; Azure builds a zip of
 * its own site directory and POSTs it to its own Kudu endpoint with a token it
 * gets from a managed identity and never stores. Route code sees neither. It
 * sees `install()`.
 *
 * It also keeps the Node-only implementation out of the Worker bundle
 * entirely — platforms/azure/self-deploy.mjs needs `node:fs` and
 * `child_process`, which cannot be imported in workerd at all. The Azure entry
 * binds it the same way it already binds its content store.
 *
 * ── Migrate, then swap — and each target owns both ──────────────────────────
 * The order is migrate-then-swap because migrations are additive: new schema
 * under old code is a state the old code tolerates, and old schema under new
 * code is not. Both steps live inside `install()` rather than being sequenced
 * by the route, because the correct mechanism for each is platform knowledge —
 * on Azure the migration has to run AFTER the new storylark-worker is on disk
 * (platforms/azure/install.mjs has the scar tissue for that in a comment), and
 * on Cloudflare there is no CLI to run at all.
 */

import type { EngineManifest } from 'storylark-contracts/engine-package';
import type { Env } from '../types';

/** A validated engine package, as `readEnginePackage` returns it. */
export interface EnginePackage {
  manifest: EngineManifest;
  dist: Map<string, Uint8Array>;
  worker?: Uint8Array;
  migrations: Map<string, Uint8Array>;
  migrationsPostgres: Map<string, Uint8Array>;
}

/** Progress, as it happens. The route collects these and returns them; they are the receipt. */
export type DeployLog = (line: string) => void;

export interface SelfDeployTarget {
  /** Which mechanism this is, for the portal to name. */
  readonly platform: 'cloudflare' | 'azure-app-service';
  /**
   * What is doing the deploying, in the operator's terms. Shown in the portal
   * beside the button, because "what is allowed to change my site" is the
   * question an operator should be able to answer at a glance.
   */
  readonly credential: string;
  /**
   * Confirm the target is reachable and the permission is real, WITHOUT
   * changing anything. Called by GET /update-status, so the portal never offers
   * a button that would fail on the first click.
   */
  preflight(): Promise<{ ok: true; detail: string } | { ok: false; detail: string }>;
  /** Migrate, then swap. Resolves when the platform has accepted the new code. */
  install(pkg: EnginePackage, log: DeployLog): Promise<{ note: string }>;
}

/**
 * Which target — if any — this deployment is configured for.
 *
 * Deliberately returns a REASON when there is none. The portal shows it, because
 * "there is no button" and "there is no button because you have not enabled it,
 * here is how" are very different messages and only the second one is useful.
 */
export function resolveSelfDeploy(env: Env): { target: SelfDeployTarget | null; reason: string } {
  if (env.SELF_DEPLOY) return { target: env.SELF_DEPLOY, reason: '' };
  if (isWorkerd()) {
    // Either credential shape works: an API token, or the OAuth session the
    // installer handed over when the operator had only `wrangler login`.
    // Since the installer provisions one of them automatically on every
    // --deploy and --update (and fails loudly when it cannot), having NEITHER
    // is a fault state — a deployment made before automatic setup existed and
    // never updated since, or an explicit --disable-one-click — and the
    // wording below treats it as one, not as a routine platform difference.
    if (!env.CF_ACCOUNT_ID || (!env.CF_API_TOKEN && !env.CF_OAUTH_REFRESH_TOKEN)) {
      return {
        target: null,
        // Since AB#7418's engine store, this only matters for releases that
        // change the API server itself — engine/frontend updates install
        // through the deployment's own storage with no credential at all.
        reason:
          'Self-update is disabled for this deployment — that is a fault state, not how StoryLark normally runs (either this site was deployed before automatic setup existed and has not taken an update since, or one-click updates were explicitly disabled). Re-enable it by running `node platforms/cloudflare/install.mjs --update --yes` from your copy of the site: a normal update provisions self-update automatically, whatever way you are logged in. Engine releases still install from this portal regardless.',
      };
    }
    return { target: cloudflareSelfDeploy(env), reason: '' };
  }
  return {
    target: null,
    // The Node entry knows exactly WHY it bound nothing (no App Service at all,
    // versus App Service with no managed identity) and passes that through. The
    // generic sentence is only for an entry that predates this feature.
    reason:
      env.SELF_DEPLOY_REASON ||
      'Self-update is disabled for this deployment — that is a fault state, not how StoryLark normally runs on Azure (the app is missing the managed identity a normal install provisions). Re-enable it by running `node platforms/azure/install.mjs --update --yes` (or `--enable-one-click --yes`) from your copy of the site; no credential is stored either way. Engine releases still install from this portal regardless.',
  };
}

/** workerd sets this exact userAgent; the Azure entry is plain Node. Same test routes/admin.ts uses. */
export function isWorkerd(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

// ── Cloudflare ──────────────────────────────────────────────────────────────

const CF_API = 'https://api.cloudflare.com/client/v4';

// ── The OAuth credential path (AB#7418, revised) ────────────────────────────
//
// When the operator installed with `wrangler login` rather than an API token,
// the installer hands the deployment the OAuth session's REFRESH token
// (env.CF_OAUTH_REFRESH_TOKEN) — there is nothing else it could hand over:
// Cloudflare's wrangler OAuth scopes cannot mint API tokens (verified against
// wrangler's own shipped scope list; see platforms/cloudflare/
// wrangler-oauth.mjs for the full account), and an access token alone dies in
// an hour, which would be a button that silently breaks — worse than no
// button.
//
// A refresh token has its own failure mode: Cloudflare MAY rotate it on every
// exchange, and only the newest link of the chain stays alive. A rotated
// value cannot go back into the Worker secret from in here without redeploying
// the Worker (a secret write creates a new version — churn, and a race against
// concurrent isolates reading the old env). So the chain's CURRENT state lives
// in the deployment's own database instead — the `self_update_oauth` row —
// and the secret is only the chain's SEED. The row records a hash of the seed
// it grew from, so re-provisioning (a new secret from a fresh `--update`)
// automatically orphans the old row rather than fighting it.
//
// Security posture, stated rather than implied: this moves a live credential
// from a Worker secret into D1. Both are inside the same trust boundary (the
// operator's account and this Worker's bindings — anyone who can read this D1
// database holds the operator's own Cloudflare access already), and the row
// never leaves the deployment: no route serves it, and the update-status
// payloads carry only availability booleans. The credential's scope is
// whatever `wrangler login` grants — broader than the minted-token ideal, and
// the installer says so out loud at provision time.

/** Wrangler's public OAuth client id (embedded in its open-source CLI — not a secret). */
export const WRANGLER_OAUTH_CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';

/** Don't present a token that could expire mid-deploy: refresh inside this margin. */
const OAUTH_EXPIRY_MARGIN_MS = 60_000;

/**
 * Per-isolate cache so a preflight + install pair (or repeated portal loads
 * within the hour) costs one exchange, not one per call. Keyed by the seed so
 * tests (and re-provisioned deployments) never cross wires.
 */
let oauthMemory: { key: string; accessToken: string; expiresAt: number } | null = null;
export function resetOAuthTokenCache(): void {
  oauthMemory = null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface OAuthStateRow {
  seed_sha256: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: number | null;
}

async function readOAuthState(db: Env['DB']): Promise<OAuthStateRow | null> {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS self_update_oauth (id INTEGER PRIMARY KEY CHECK (id = 1), seed_sha256 TEXT NOT NULL, refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL)'
    )
    .run();
  const { results } = await db.prepare('SELECT seed_sha256, refresh_token, access_token, expires_at FROM self_update_oauth WHERE id = 1').all<OAuthStateRow>();
  return results[0] ?? null;
}

async function writeOAuthState(db: Env['DB'], seedHash: string, refreshToken: string, accessToken: string, expiresAt: number): Promise<void> {
  await db
    .prepare(
      'INSERT INTO self_update_oauth (id, seed_sha256, refresh_token, access_token, expires_at, updated_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seed_sha256 = excluded.seed_sha256, refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at'
    )
    .bind(seedHash, refreshToken, accessToken, expiresAt, Date.now())
    .run();
}

/** One refresh-token exchange. Throws with `oauthError` carrying the OAuth error code. */
async function exchangeRefreshToken(
  refreshToken: string,
  tokenUrl: string,
  clientId: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || body.error || !body.access_token) {
    const err = new Error(`Cloudflare OAuth refresh failed: ${body.error_description || body.error || `HTTP ${res.status}`}`) as Error & { oauthError?: string };
    err.oauthError = body.error;
    throw err;
  }
  return {
    accessToken: body.access_token,
    // Rotation is Cloudflare's call — keep the current token when the
    // response omits a new one (the same rule wrangler itself applies).
    refreshToken: body.refresh_token || refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

/**
 * A live access token for the deployment's OAuth session.
 *
 * Resolution order: per-isolate memory → the persisted state row (another
 * isolate may have refreshed an hour ago) → a fresh exchange, whose result —
 * including any rotated refresh token — is persisted BEFORE it is returned,
 * so a deploy that fails halfway can never have consumed the chain's only
 * live link without recording its successor.
 *
 * The one concurrency hazard is two isolates racing to exchange the same
 * refresh token while Cloudflare rotates: the loser gets `invalid_grant`. The
 * loser's recovery is to re-read the row — the winner persisted the fresh
 * chain there — and retry once with it. Only if that also fails is the
 * session genuinely dead (revoked, or superseded outside this deployment),
 * and the error says exactly what to run to re-provision; preflight() surfaces
 * it in the portal as the fault it is.
 */
export async function getOAuthAccessToken(env: Env, log?: DeployLog): Promise<string> {
  const seed = env.CF_OAUTH_REFRESH_TOKEN;
  if (!seed) throw new Error('no CF_OAUTH_REFRESH_TOKEN is configured');
  const tokenUrl = env.CF_OAUTH_TOKEN_URL || OAUTH_TOKEN_URL;
  const clientId = env.CF_OAUTH_CLIENT_ID || WRANGLER_OAUTH_CLIENT_ID;
  const seedHash = await sha256Hex(seed);
  const cacheKey = `${seedHash}:${tokenUrl}`;
  const now = Date.now();

  if (oauthMemory && oauthMemory.key === cacheKey && now + OAUTH_EXPIRY_MARGIN_MS < oauthMemory.expiresAt) {
    return oauthMemory.accessToken;
  }

  const row = await readOAuthState(env.DB);
  // A row grown from a DIFFERENT seed belongs to a previous provisioning —
  // the installer stored a fresh secret since. Start over from the new seed.
  const current = row && row.seed_sha256 === seedHash ? row : null;
  if (current?.access_token && current.expires_at && now + OAUTH_EXPIRY_MARGIN_MS < current.expires_at) {
    oauthMemory = { key: cacheKey, accessToken: current.access_token, expiresAt: current.expires_at };
    return current.access_token;
  }

  const tryExchange = async (refreshToken: string) => {
    const fresh = await exchangeRefreshToken(refreshToken, tokenUrl, clientId);
    await writeOAuthState(env.DB, seedHash, fresh.refreshToken, fresh.accessToken, fresh.expiresAt);
    oauthMemory = { key: cacheKey, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
    return fresh.accessToken;
  };

  const firstTry = current?.refresh_token ?? seed;
  try {
    return await tryExchange(firstTry);
  } catch (err) {
    if ((err as { oauthError?: string }).oauthError !== 'invalid_grant') throw err;
    const reread = await readOAuthState(env.DB);
    if (reread && reread.seed_sha256 === seedHash && reread.refresh_token !== firstTry) {
      log?.('OAuth refresh raced another instance — retrying with the newer session state.');
      return await tryExchange(reread.refresh_token);
    }
    throw new Error(
      'The Cloudflare session this deployment holds is no longer valid — it was revoked, or superseded outside this deployment. Re-provision it by running `node platforms/cloudflare/install.mjs --update --yes` from your copy of the site.'
    );
  }
}

/**
 * Redeploy this Worker, from inside this Worker, with the operator's own
 * credential — a Cloudflare API token, or (when the install only ever had a
 * `wrangler login`) the OAuth session the installer handed over, exchanged
 * for a short-lived access token per call by getOAuthAccessToken above.
 *
 * ── The API, as documented ──────────────────────────────────────────────────
 * Cloudflare's own three-phase direct-upload flow
 * (developers.cloudflare.com/workers/static-assets/direct-upload):
 *
 *   1. POST /accounts/:id/workers/scripts/:name/assets-upload-session
 *      with a manifest of every asset — `{ "/path": { hash, size } }` — and get
 *      back a JWT plus `buckets`: the hashes that are NOT already stored. On an
 *      engine update most of the bundle is the six curated font families, which
 *      do not change between releases, so most of it is not re-uploaded.
 *   2. POST /accounts/:id/workers/assets/upload?base64=true
 *      multipart, one part per hash, base64 bodies, bearer = that JWT. The last
 *      response carries a COMPLETION token.
 *   3. GET /accounts/:id/workers/scripts/:name/settings
 *      to read back this deployment's OWN bindings/vars/secrets and
 *      compatibility date/flags — see below for why this step exists.
 *   4. PUT /accounts/:id/workers/scripts/:name
 *      multipart: `metadata` naming the main module, the completion token, the
 *      bindings just read back, and the engine's own asset-routing contract;
 *      plus the module itself.
 *
 * ── CORRECTED LIVE, 2026-08-16: step 4 is NOT `/content` ────────────────────
 * An earlier version of this file used `/content` — "put script content
 * without touching config or metadata" — specifically to avoid steps 3 and 4
 * below: reconstructing bindings looked like the riskier path, so the design
 * chose the endpoint that could not need it. Confirmed live, against
 * app.storylark.dev, that endpoint does not exist for an asset-backed Worker:
 * `PUT .../content` returned "Assets cannot be provided on this endpoint. Use
 * the correct upload endpoint for asset-backed Workers." — the one open
 * question the original design flagged as unverified turned out to be answered
 * "no."
 *
 * The actual answer is the plain script-upload endpoint
 * (`PUT /accounts/:id/workers/scripts/:name`, no `/content`), which DOES
 * accept `assets.jwt` — but does replace the Worker's whole configuration with
 * whatever this request sends, so bindings genuinely have to be resupplied,
 * not avoided. That is what step 3 is for: `GET .../settings` returns the
 * live binding list — plain vars WITH their values, which get resent as-is.
 *
 * `secret_text` bindings are handled differently, and this was ALSO wrong on
 * the first real attempt: re-sending a `secret_text` binding by name with no
 * `text` field does not mean "keep the stored value" — Cloudflare's API
 * rejects it outright ("invalid or missing text property for binding
 * ADMIN_KEY", confirmed live). The actual rule, confirmed against Cloudflare's
 * own docs after that failure: a secret is a resource independent of the
 * script's bindings list, and "existing secrets not included in the upload
 * are preserved from the previous version" — so `secret_text` bindings are
 * filtered OUT of what gets resent entirely, not referenced. Two real,
 * different failures on two real attempts, both fixed by actually running
 * this against a live account rather than reasoning about the API from its
 * documentation alone.
 *
 * Routes and cron triggers are independent Cloudflare resources that
 * reference a script by name rather than living inside its content, so this
 * swap does not touch them regardless of which endpoint is used.
 *
 * The asset-routing contract (`not_found_handling`, `run_worker_first`) is
 * deliberately NOT read back the same way — it is not this deployment's own
 * state to preserve, it is the ENGINE's routing architecture (Phase 2/4's
 * "identical everywhere" requirement), so it comes from the same constants
 * `wrangler.jsonc` declares, not from whatever a previous deploy happened to
 * have.
 *
 * ── Verified live ────────────────────────────────────────────────────────────
 * The full flow — download, checksum, migrate, upload assets, read back
 * bindings, swap the script via the corrected endpoint — ran for real against
 * app.storylark.dev (the project's own demo deployment, not a customer's) on
 * 2026-08-16 and the site came back serving the new engine version with every
 * binding intact. See docs/design/update-flow.md for the full account.
 */
export function cloudflareSelfDeploy(env: Env): SelfDeployTarget {
  const account = env.CF_ACCOUNT_ID!;
  const script = env.CF_SCRIPT_NAME || env.BRAND;
  const api = env.CF_API_BASE || CF_API;
  // Two credential shapes, one deployer (AB#7418, revised): a static API
  // token, or the OAuth session handed over by an installer that had only
  // `wrangler login` to work with. The bearer is resolved per call — an OAuth
  // access token can expire between preflight and install, and
  // getOAuthAccessToken hides the refresh (and its rotation bookkeeping)
  // behind this one seam. CF_API_TOKEN wins when both exist: it is the
  // narrower, deliberately-issued credential.
  const bearer: () => Promise<string> = env.CF_API_TOKEN ? async () => env.CF_API_TOKEN! : () => getOAuthAccessToken(env);

  const call = async (path: string, init: RequestInit = {}) => {
    const auth = { authorization: `Bearer ${await bearer()}` };
    const res = await fetch(`${api}${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    const text = await res.text();
    let body: { success?: boolean; result?: unknown; errors?: { message?: string }[] } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // A non-JSON body from this API is itself the error worth reporting.
    }
    if (!res.ok || body.success === false) {
      const detail = body.errors?.map((e) => e.message).filter(Boolean).join('; ') || text.slice(0, 300) || `HTTP ${res.status}`;
      throw new Error(`Cloudflare API ${path}: ${detail}`);
    }
    return body.result as never;
  };

  return {
    platform: 'cloudflare',
    credential: env.CF_API_TOKEN
      ? `a Cloudflare API token you issued, scoped to the Worker "${script}"`
      : `the Cloudflare login session (wrangler OAuth) the installer handed to this deployment, exchanged for a short-lived token at the moment of use`,

    async preflight() {
      try {
        await call(`/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/settings`);
        return { ok: true, detail: `Cloudflare accepts this token for the Worker "${script}".` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },

    async install(pkg, log) {
      // 1. Migrate first. New schema under old code is safe; the reverse is not.
      const applied = await applyD1Migrations(env.DB, pkg.migrations, log);
      log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Database already up to date.');

      if (!pkg.worker) {
        throw new Error(
          'This engine artifact carries no Cloudflare Worker bundle (worker/index.js), so only half of it could be installed. Refusing to deploy a mismatched pair.'
        );
      }

      // 2. The COMPLETE asset set: the engine's files from the artifact, plus
      //    this deployment's own brand files read back off its current assets.
      //    Cloudflare's manifest is authoritative — anything left out of it is
      //    deleted from the site — so "keep your brand" has to be an explicit
      //    act here, not an omission.
      const assets = new Map(pkg.dist);
      const preserved = await readBrandOwnedAssets(env, log);
      for (const [path, bytes] of preserved) assets.set(path, bytes);
      log(`Uploading ${assets.size} assets (${pkg.dist.size} from the release, ${preserved.size} of yours preserved).`);

      const manifest: Record<string, { hash: string; size: number }> = {};
      const byHash = new Map<string, { path: string; bytes: Uint8Array }>();
      for (const [path, bytes] of assets) {
        const hash = await cloudflareAssetHash(path, bytes);
        manifest[`/${path}`] = { hash, size: bytes.byteLength };
        byHash.set(hash, { path, bytes });
      }

      const session = (await call(`/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/assets-upload-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest }),
      })) as { jwt: string; buckets?: string[][] };

      let completion = session.jwt;
      const buckets = session.buckets ?? [];
      if (!buckets.length) log('Cloudflare already holds every file — nothing to upload.');
      for (const [i, bucket] of buckets.entries()) {
        const form = new FormData();
        for (const hash of bucket) {
          const entry = byHash.get(hash);
          if (!entry) throw new Error(`Cloudflare asked for a file hash we did not send (${hash}).`);
          form.append(hash, new Blob([toBase64(entry.bytes)], { type: contentTypeFor(entry.path) }), hash);
        }
        const res = await fetch(`${api}/accounts/${account}/workers/assets/upload?base64=true`, {
          method: 'POST',
          // The SESSION jwt, not the account token: this endpoint is authorised
          // by the upload session, which is what scopes it to these files.
          headers: { authorization: `Bearer ${session.jwt}` },
          body: form,
        });
        const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { jwt?: string }; errors?: { message?: string }[] };
        if (!res.ok || body.success === false) {
          throw new Error(`Cloudflare asset upload failed: ${body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`}`);
        }
        if (body.result?.jwt) completion = body.result.jwt;
        log(`Uploaded batch ${i + 1} of ${buckets.length} (${bucket.length} files).`);
      }

      // 3. Read back this deployment's OWN bindings/vars/secrets and
      //    compatibility settings — the plain script-upload endpoint replaces
      //    the whole configuration with whatever this request sends, so
      //    "leave bindings alone" has to mean "resend exactly what is already
      //    there", the same principle step 2 already applies to brand assets.
      //
      //    CORRECTED LIVE, 2026-08-16: `secret_text` bindings do NOT come back
      //    by resending the name with no value — a real deploy against
      //    app.storylark.dev failed with "invalid or missing text property for
      //    binding ADMIN_KEY" the moment that assumption was tried. The actual
      //    Cloudflare behaviour (confirmed against their own docs after that
      //    failure) is simpler: secrets are a resource independent of the
      //    script's bindings list, and "existing secrets not included in the
      //    [uploaded bindings] are preserved from the previous version" — so
      //    the fix is to leave secret_text bindings OUT of what gets resent
      //    entirely, not to reference them. Every other binding type (plain
      //    vars, D1, R2, the ASSETS binding itself) has to be resent with its
      //    real value/config or it is genuinely dropped.
      const settings = (await call(`/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/settings`)) as {
        compatibility_date?: string;
        compatibility_flags?: string[];
        bindings?: { type?: string; name?: string }[];
      };
      const secretCount = (settings.bindings ?? []).filter((b) => b.type === 'secret_text').length;
      const nonSecretBindings = (settings.bindings ?? []).filter((b) => b.type !== 'secret_text');
      log(
        `Read back ${nonSecretBindings.length} binding(s) to carry forward unchanged` +
          (secretCount ? ` (${secretCount} secret(s) left untouched — omitted, not resent, per Cloudflare's own preserve-on-omit rule).` : '.')
      );

      // 4. Swap the code. Bindings above keep this deployment's D1/R2/vars/
      //    secrets exactly as they were; the asset-routing contract below is
      //    NOT read back the same way — it is the ENGINE's own routing
      //    architecture (Phase 2/4's "identical everywhere" requirement), so
      //    it comes from the same constants wrangler.jsonc declares, not from
      //    whatever a previous deploy happened to have.
      const form = new FormData();
      form.append(
        'metadata',
        JSON.stringify({
          main_module: 'index.js',
          bindings: nonSecretBindings,
          compatibility_date: settings.compatibility_date,
          compatibility_flags: settings.compatibility_flags ?? [],
          assets: {
            jwt: completion,
            // `/*` with no /assets/* exclusion since AB#7418: the installed-
            // engine store answers hashed assets out of the deployment's own
            // storage, so they have to reach the Worker. Matches wrangler.jsonc.
            config: { not_found_handling: 'single-page-application', run_worker_first: ['/*'] },
          },
        })
      );
      form.append('index.js', new Blob([pkg.worker], { type: 'application/javascript+module' }), 'index.js');
      await call(`/accounts/${account}/workers/scripts/${encodeURIComponent(script)}`, { method: 'PUT', body: form });

      log(`Deployed storylark-core ${pkg.manifest.coreVersion} to the Worker "${script}".`);
      return {
        note: 'Cloudflare rolls a new Worker version out globally within seconds. Your brand, your content and every binding were untouched.',
      };
    },
  };
}

/**
 * The files an update must carry across rather than replace.
 *
 * Read back through `env.ASSETS` — the deployment's CURRENT assets — because
 * that is the only copy of them that exists: the artifact deliberately has none,
 * and a Worker cannot write to its own asset bundle. WHICH files is the
 * interesting part: `env.ASSETS` can fetch a known path but has no list API, and
 * icon names come from `brands/<id>/assets/icons/` and are a brand's business.
 * So the build now writes `dist/outputs.json` (an inventory of everything it
 * emitted, with `brandOwned` marked) and this reads it. A site built before that
 * existed falls back to the standard names, which is every icon the shipped
 * brands and the theme-package format use — stated, so the gap is known rather
 * than discovered.
 */
export async function readBrandOwnedAssets(env: Env, log: DeployLog): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const paths = await brandOwnedPaths(env, log);
  for (const path of paths) {
    const res = await env.ASSETS.fetch(new Request(`https://assets.invalid/${path}`, { headers: { accept: '*/*' } }));
    if (!res.ok) continue;
    // `not_found_handling: single-page-application` answers a missing asset with
    // the app shell rather than a 404, so an HTML body means "not there".
    if ((res.headers.get('content-type') ?? '').includes('text/html') && !path.endsWith('.html')) continue;
    out.set(path, new Uint8Array(await res.arrayBuffer()));
  }
  return out;
}

const FALLBACK_BRAND_ASSETS = [
  'brand.json',
  'presentation.json',
  'theme.css',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/favicon.ico',
  'icons/favicon-32.png',
  'icons/favicon-180.png',
  'icons/logo.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

async function brandOwnedPaths(env: Env, log: DeployLog): Promise<string[]> {
  const res = await env.ASSETS.fetch(new Request('https://assets.invalid/outputs.json', { headers: { accept: '*/*' } }));
  if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) {
    try {
      const doc = (await res.json()) as { files?: Record<string, { brandOwned?: boolean }> };
      const listed = Object.entries(doc.files ?? {})
        .filter(([, meta]) => meta?.brandOwned)
        .map(([path]) => path);
      if (listed.length) return listed;
    } catch {
      // fall through to the fallback list
    }
  }
  log('This site was built before dist/outputs.json existed — preserving the standard brand files by name.');
  return FALLBACK_BRAND_ASSETS;
}

/**
 * Cloudflare's asset hash: sha256 of the base64 body concatenated with the
 * extension (no dot), truncated to 32 hex characters. Not a hash of the file —
 * theirs, exactly as their own example client computes it, because the manifest
 * is only useful if both ends compute it the same way.
 */
export async function cloudflareAssetHash(path: string, bytes: Uint8Array): Promise<string> {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const ext = dot > slash ? path.slice(dot + 1) : '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(toBase64(bytes) + ext));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** Chunked so a multi-megabyte font does not blow the argument limit of String.fromCharCode. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const CONTENT_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// ── D1 migrations, from inside the Worker ───────────────────────────────────

/**
 * Apply the artifact's D1 migration set through the deployment's own binding.
 *
 * This is the one place StoryLark applies D1 migrations without
 * `wrangler d1 migrations apply`, and it is not a preference: wrangler is a CLI
 * on an operator's machine, and there is no machine here. What it deliberately
 * is NOT is a second bookkeeping scheme — it reads and writes `d1_migrations`,
 * the same table with the same columns and the same `name` values wrangler uses,
 * so a later `wrangler d1 migrations apply` agrees with what the portal did
 * instead of trying to re-run it. That compatibility is the whole reason the
 * table shape is spelled out here rather than invented.
 *
 * One statement at a time, in file order, skipping anything already recorded.
 * D1 has no interactive transaction across statements, so a migration that
 * fails half way leaves the earlier statements applied and the file unrecorded —
 * exactly what `wrangler d1 migrations apply` does, and the reason migrations
 * are written to be re-runnable (`CREATE TABLE IF NOT EXISTS`, `INSERT OR
 * IGNORE`). The error is surfaced, the code swap does not happen, and the
 * deployment keeps serving the engine it was serving.
 */
export async function applyD1Migrations(
  db: Env['DB'],
  migrations: Map<string, Uint8Array>,
  log: DeployLog
): Promise<string[]> {
  if (!migrations.size) return [];
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    )
    .run();
  const { results } = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const done = new Set(results.map((r) => r.name));

  const applied: string[] = [];
  const decoder = new TextDecoder();
  for (const name of [...migrations.keys()].sort()) {
    if (done.has(name)) continue;
    log(`Applying migration ${name}…`);
    for (const statement of splitStatements(decoder.decode(migrations.get(name)!))) {
      await db.prepare(statement).run();
    }
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    applied.push(name);
  }
  return applied;
}

// ── Postgres migrations, from inside the process (AB#7418) ──────────────────

/**
 * Apply the artifact's Postgres migration set through the deployment's own
 * Database seam — the Node/Azure counterpart of applyD1Migrations above, for
 * the engine-store update path that installs a release WITHOUT a platform
 * redeploy and therefore has no moment where migrate-postgres.mjs could run.
 *
 * Same bookkeeping as migrate-postgres.mjs, on purpose: the `schema_migrations`
 * table, the same column names, the same `name` values — so an in-portal update
 * and a later CLI `--update` agree about what has run instead of re-running it.
 *
 * Each file executes as ONE statement string. Postgres's simple query protocol
 * runs a multi-statement string inside an implicit transaction, which is the
 * same all-or-nothing guarantee migrate-postgres.mjs gets from its explicit
 * BEGIN/COMMIT — and an explicit transaction is not available here, because the
 * seam's pooled driver may hand consecutive prepare() calls different
 * connections. (One known limit, stated rather than discovered: the Postgres
 * driver translates `?` to positional parameters, so a migration file
 * containing a literal `?` would mis-parse. None does; the D1 set has the same
 * property for the same reason.)
 */
export async function applyPostgresMigrations(
  db: Env['DB'],
  migrations: Map<string, Uint8Array>,
  log: DeployLog
): Promise<string[]> {
  if (!migrations.size) return [];
  await db
    .prepare('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
    .run();
  const { results } = await db.prepare('SELECT name FROM schema_migrations').all<{ name: string }>();
  const done = new Set(results.map((r) => r.name));

  const applied: string[] = [];
  const decoder = new TextDecoder();
  for (const name of [...migrations.keys()].sort()) {
    if (done.has(name)) continue;
    log(`Applying migration ${name}…`);
    await db.prepare(decoder.decode(migrations.get(name)!)).run();
    await db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').bind(name).run();
    applied.push(name);
  }
  return applied;
}

/**
 * Split a migration file into statements.
 *
 * Semicolon-separated, ignoring semicolons inside string literals and `--`
 * comments. Same job routes/admin.ts's /setup does for INIT_SCHEMA, but done
 * properly rather than with a bare `split(';')`, because these files are not
 * written by this repo's own hand every time — an artifact's migration set
 * comes from whatever release is being installed.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          current += sql[++i]; // doubled quote — an escaped one, not the end
        } else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      current += '\n';
      continue;
    }
    if (ch === ';') {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
