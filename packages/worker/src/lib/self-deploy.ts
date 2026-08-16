/**
 * The one-click update seam (AB#7418 — plan §4 layer 3, §0d Phase 5).
 *
 * ── The thing this is not ───────────────────────────────────────────────────
 * It is not a way for StoryLark to deploy to a customer. Nothing here holds a
 * StoryLark credential, contacts a StoryLark service, or can be triggered from
 * outside the deployment. The button exists only where the OPERATOR has already
 * given this deployment permission to deploy ITSELF on the platform they chose,
 * and the click that starts it is an admin session's click. Where they have
 * not, `resolveSelfDeploy` returns null, the portal shows the layer-2 command
 * exactly as it does today, and this file may as well not exist. That "off by
 * default and off unless you did something deliberate" property is the whole
 * design; everything below is subordinate to it.
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
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      return {
        target: null,
        reason:
          'One-click updates are off. To turn them on, run `node platforms/cloudflare/install.mjs --enable-one-click --yes` from your copy of the site — it asks you for a Cloudflare API token scoped to this Worker and stores it as a Worker secret. Until then, updates run from your machine with the command below.',
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
      'One-click updates are off. On Azure App Service they need this app to have a managed identity with permission to deploy itself — run `node platforms/azure/install.mjs --enable-one-click --yes` to grant it. No credential is stored either way. Until then, updates run from your machine with the command below.',
  };
}

/** workerd sets this exact userAgent; the Azure entry is plain Node. Same test routes/admin.ts uses. */
export function isWorkerd(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

// ── Cloudflare ──────────────────────────────────────────────────────────────

const CF_API = 'https://api.cloudflare.com/client/v4';

/**
 * Redeploy this Worker, from inside this Worker, with the operator's own
 * Cloudflare API token.
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
 *   3. PUT /accounts/:id/workers/scripts/:name/content
 *      multipart: `metadata` naming the main module and carrying the completion
 *      token, plus the module itself.
 *
 * Step 3 uses `/content` — "put script content without touching config or
 * metadata" — rather than the full script-upload endpoint ON PURPOSE. The full
 * endpoint replaces the Worker's configuration with whatever the request says,
 * which means an update would have to reconstruct every binding, var, secret,
 * route and cron trigger from the outside and would silently drop anything it
 * failed to reconstruct. `/content` leaves all of it alone. The deployment's D1
 * binding, R2 bucket, custom domain and ADMIN_KEY are not this feature's
 * business and it should not be able to touch them.
 *
 * ── What is unverified, stated plainly ──────────────────────────────────────
 * This flow has NOT been executed against a real Cloudflare account: doing so
 * requires a token able to redeploy a live Worker, and creating one to test with
 * is precisely the risk this comment exists to be honest about. It is written
 * against the published contract and is exercised end to end against a local
 * server that implements that contract (packages/worker/test/self-deploy.test.mjs),
 * which proves the choreography, the payload shapes and the bytes — not
 * Cloudflare's agreement. The specific open question is whether `/content`
 * honours `assets.jwt`; the documented metadata shape says `assets` belongs to
 * "script, version and Workers-for-Platforms upload endpoints", and `/content`
 * is the fourth. If it does not, the first real run fails cleanly with the
 * API's own error and nothing is deployed — the failure mode is a 4xx in the
 * portal, not a broken site. See docs/design/update-flow.md.
 */
export function cloudflareSelfDeploy(env: Env): SelfDeployTarget {
  const account = env.CF_ACCOUNT_ID!;
  const token = env.CF_API_TOKEN!;
  const script = env.CF_SCRIPT_NAME || env.BRAND;
  const api = env.CF_API_BASE || CF_API;
  const auth = { authorization: `Bearer ${token}` };

  const call = async (path: string, init: RequestInit = {}) => {
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
    credential: `a Cloudflare API token you issued, scoped to the Worker "${script}"`,

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

      // 3. Swap the code. `/content` so bindings, vars, secrets, routes and
      //    cron triggers are untouched.
      const form = new FormData();
      form.append('metadata', JSON.stringify({ main_module: 'index.js', assets: { jwt: completion } }));
      form.append('index.js', new Blob([pkg.worker], { type: 'application/javascript+module' }), 'index.js');
      await call(`/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/content`, { method: 'PUT', body: form });

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
