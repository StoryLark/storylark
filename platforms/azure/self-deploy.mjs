// One-click updates for the Node/App Service entry (AB#7418 — plan §4 layer 3,
// §0d Phase 5).
//
// ── The best part of this file is what it does not contain ─────────────────
// A credential. §4's layer 3 was written as "the installer stores that
// platform's own deploy credential as a deployment secret", and on Cloudflare
// that is unavoidable — a Worker has no ambient identity. On Azure App Service
// it is avoidable, and storing one anyway would be strictly worse. The platform
// already gives a running site a way to prove who it is:
//
//   IDENTITY_ENDPOINT + IDENTITY_HEADER   injected when a managed identity is
//                                         enabled on the Web App
//   GET <IDENTITY_ENDPOINT>?resource=https://management.azure.com/&api-version=2019-08-01
//   X-IDENTITY-HEADER: <IDENTITY_HEADER>  -> a short-lived ARM bearer token
//
// and Kudu — App Service's own deployment engine — accepts exactly that token:
//
//   POST https://<site>.scm.azurewebsites.net/api/publish?type=zip
//   Authorization: Bearer <ARM token>
//
// (learn.microsoft.com/azure/app-service/deploy-zip, "Microsoft Entra
// authentication".) So the whole permission is a role assignment the operator
// makes on their own resource, visible in the portal, revocable in one click,
// and auditable in the activity log. There is no secret to leak, no secret to
// rotate, and no secret for this codebase to be trusted with. Turning the
// feature off is `az webapp identity remove` or deleting the role assignment;
// this file then simply finds no IDENTITY_ENDPOINT and reports that the feature
// is unavailable.
//
// ── What gets deployed ─────────────────────────────────────────────────────
// Kudu's zip deploy replaces /home/site/wwwroot. So the zip has to be the WHOLE
// site, not just the new engine — which is fine, because this process is
// running out of that directory and can read it:
//
//   everything currently in wwwroot     except app/dist and package.json
//   app/dist/<engine files>             from the artifact
//   app/dist/<brand files>              KEPT from the current deployment
//   package.json                        with storylark-worker pinned to the
//                                       artifact's version, so the Oryx build
//                                       that runs on deploy installs it
//
// SCM_DO_BUILD_DURING_DEPLOYMENT is already `true` in infra.bicep, which is what
// makes that last line work: Kudu runs `npm install` against the deployed
// package.json before starting the new process.
//
// ── Migrations ─────────────────────────────────────────────────────────────
// Run by literally the same script the installer runs —
// `storylark-worker/migrate-postgres.mjs` — pointed at the migration set that
// came out of the artifact via its `--dir` flag. That flag exists so this can
// reuse the script rather than reimplement it: the alternative is a second
// migration runner with a second idea of what `schema_migrations` means, and
// platforms/azure/install.mjs already carries a long comment about what happens
// when the migration set and the code disagree.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { zip } from 'storylark-contracts/zip';

/**
 * Which files this update must preserve — read from the ARTIFACT rather than
 * imported from a shared constant.
 *
 * Deliberate. This entry runs whatever `storylark-contracts` its own
 * `npm install` resolved, which mid-update is legitimately the version that
 * shipped with the OLD engine — the same reason server.mjs imports every
 * `storylark-worker/lib/*` dynamically and degrades instead of refusing to
 * boot. Taking the list from `engine.json` means the package being installed
 * says what it will not overwrite, which is both self-describing and immune to
 * a version skew between this file and the contracts package next to it.
 * Entries ending in `/` are prefixes; the rest are exact names.
 */
function brandOwnedMatcher(manifest) {
  const patterns = Array.isArray(manifest?.brandOwned) && manifest.brandOwned.length
    ? manifest.brandOwned
    : ['brand.json', 'presentation.json', 'theme.css', 'manifest.webmanifest', 'icons/'];
  return (path) => patterns.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

const ARM_RESOURCE = 'https://management.azure.com/';

/**
 * Build the deployer, or return null with the reason it is unavailable.
 *
 * Never throws and never asks the network: this runs at startup, and a site
 * whose managed identity is not set up must boot exactly as it does today.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{siteRoot?: string, staticRoot?: string, fetchImpl?: typeof fetch}} [opts]
 */
export function azureSelfDeploy(env, opts = {}) {
  const identityEndpoint = env.IDENTITY_ENDPOINT;
  const identityHeader = env.IDENTITY_HEADER;
  const siteName = env.WEBSITE_SITE_NAME;

  if (!siteName) {
    return {
      target: null,
      reason:
        'Redeploying this app from the portal is an Azure App Service feature and this process is not running on App Service (no WEBSITE_SITE_NAME). Releases that change the API server run from your own machine with the installer command; engine releases update from the portal regardless.',
    };
  }
  if (!identityEndpoint || !identityHeader) {
    return {
      target: null,
      reason:
        'Self-update is off for releases that change the API server: it needs a managed identity on this Web App with permission to deploy it — run `node platforms/azure/install.mjs --enable-one-click --yes` from your copy of the site (a normal --deploy/--update sets this up automatically now). It grants the app that permission and stores no credential anywhere. Engine releases update from the portal regardless.',
    };
  }

  // Kudu's host is the site's, with `.scm` inserted. WEBSITE_HOSTNAME carries
  // any custom domain, which is NOT what Kudu answers on, so the SCM host is
  // derived from the site NAME instead. AZURE_SCM_HOST overrides it for sovereign
  // clouds and App Service Environments, where the suffix differs.
  const scmHost = env.AZURE_SCM_HOST || `${siteName}.scm.azurewebsites.net`;
  const siteRoot = opts.siteRoot ?? env.STORYLARK_SITE_ROOT ?? process.cwd();
  const staticRoot = opts.staticRoot ?? env.STATIC_ROOT ?? join(siteRoot, 'app', 'dist');
  const doFetch = opts.fetchImpl ?? fetch;

  async function armToken() {
    const url = `${identityEndpoint}${identityEndpoint.includes('?') ? '&' : '?'}resource=${encodeURIComponent(ARM_RESOURCE)}&api-version=2019-08-01`;
    const res = await doFetch(url, { headers: { 'X-IDENTITY-HEADER': identityHeader } });
    if (!res.ok) {
      throw new Error(
        `The managed identity would not issue a token (HTTP ${res.status}). Check that a system-assigned identity is enabled on this Web App.`
      );
    }
    const body = await res.json();
    if (!body.access_token) throw new Error('The managed identity returned no access_token.');
    return body.access_token;
  }

  return {
    target: {
      platform: 'azure-app-service',
      credential: `this Web App's own managed identity (no credential is stored; it deploys "${siteName}" and nothing else)`,

      async preflight() {
        try {
          const token = await armToken();
          // A read against Kudu proves three things at once and changes
          // nothing: the identity issues tokens, Kudu accepts them, and the
          // role assignment actually reaches this site. A token that mints
          // fine but has no role fails HERE, in a status check, instead of
          // half way through a deploy.
          const res = await doFetch(`https://${scmHost}/api/deployments`, {
            headers: { authorization: `Bearer ${token}` },
          });
          if (res.status === 401 || res.status === 403) {
            return {
              ok: false,
              detail: `Kudu rejected this app's managed identity (HTTP ${res.status}). It needs a role with Microsoft.Web/sites/publish/Action on this site — "Website Contributor" is the usual one. Run \`node platforms/azure/install.mjs --enable-one-click --yes\`.`,
            };
          }
          if (!res.ok) return { ok: false, detail: `Kudu answered HTTP ${res.status} at https://${scmHost}/api/deployments.` };
          return { ok: true, detail: `This app's managed identity can deploy "${siteName}" through Kudu.` };
        } catch (err) {
          return { ok: false, detail: err.message };
        }
      },

      async install(pkg, log) {
        // 1. Migrate, with the artifact's own SQL, through the installer's own
        //    script. Before the swap, because new schema under old code is safe.
        migrate(pkg, log, env);

        // 2. Stage the whole site: what is here now, with the engine replaced.
        const stage = mkdtempSync(join(tmpdir(), 'storylark-update-'));
        try {
          const kept = stageSite({ stage, siteRoot, staticRoot, pkg, log });
          log(`Staged ${kept.engine} engine files and kept ${kept.brand} of your own.`);

          const entries = readTree(stage);
          log(`Packing ${entries.length} files for App Service…`);
          const bytes = await zip(
            entries.map(([name, data]) => ({ name, data })),
            { date: new Date(0) }
          );

          // 3. Hand it to Kudu. It writes wwwroot, runs the Oryx build (npm
          //    install picks up the pinned storylark-worker), and restarts the
          //    app — which is why this process may not live to see the response.
          const token = await armToken();
          log(`Deploying ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB to ${scmHost}…`);
          const res = await doFetch(`https://${scmHost}/api/publish?type=zip`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
            body: bytes,
          });
          if (!res.ok) {
            const detail = (await res.text().catch(() => '')).slice(0, 400);
            throw new Error(`Kudu refused the deployment (HTTP ${res.status}). ${detail}`);
          }
          log(`App Service accepted storylark-core ${pkg.manifest.coreVersion}.`);
          return {
            note: 'App Service is installing dependencies and restarting. The site keeps serving the old process until the new one is ready; give it a minute, then reload /admin to confirm the version.',
          };
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
      },
    },
    reason: '',
  };
}

/**
 * Run the installer's own migrate-postgres.mjs against the artifact's SQL.
 *
 * Synchronous on purpose: this is the step that must have finished before
 * anything is deployed, and a failure here has to stop the update rather than
 * race it.
 */
function migrate(pkg, log, env) {
  if (!pkg.migrationsPostgres?.size) {
    log('The artifact carries no Postgres migrations — nothing to apply.');
    return;
  }
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set, so migrations cannot run. Refusing to deploy code that expects a newer schema.');

  let script;
  try {
    script = createRequire(import.meta.url).resolve('storylark-worker/migrate-postgres.mjs');
  } catch {
    script = null;
  }
  if (!script || !existsSync(script)) {
    throw new Error('Could not find storylark-worker/migrate-postgres.mjs — refusing to deploy without migrating.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'storylark-migrations-'));
  try {
    for (const [name, data] of pkg.migrationsPostgres) writeFileSync(join(dir, name), Buffer.from(data));
    log(`Applying ${pkg.migrationsPostgres.size} migration file(s) from the artifact…`);
    const result = spawnSync(process.execPath, [script, `--connection-string=${url}`, `--dir=${dir}`], { encoding: 'utf8' });
    if (result.stdout) for (const line of result.stdout.trim().split('\n')) log(line);
    if (result.status !== 0) {
      throw new Error(`Migrations failed: ${(result.stderr || '').trim().split('\n').slice(-3).join(' ') || `exit ${result.status}`}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy the running site into `stage`, swapping in the artifact's engine.
 *
 * The rule: the deployment's files win everywhere except the engine's own. So
 * `app/dist` is rebuilt from the artifact PLUS whatever brand-owned files are
 * on disk now, and everything else in wwwroot — server.mjs and its siblings,
 * package-lock.json, node_modules if it is there — is copied across untouched.
 * package.json is the one file rewritten, to pin the engine version the artifact
 * belongs to.
 */
function stageSite({ stage, siteRoot, staticRoot, pkg, log }) {
  const distRel = relative(siteRoot, staticRoot).split(sep).join('/');
  for (const entry of readdirSync(siteRoot, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const from = join(siteRoot, entry.name);
    // The dist tree is rebuilt below; package.json is rewritten below.
    if (entry.name === 'package.json') continue;
    if (relative(from, staticRoot) === '' || distRel.split('/')[0] === entry.name) continue;
    cpSync(from, join(stage, entry.name), { recursive: true });
  }

  const outDist = join(stage, ...distRel.split('/'));
  mkdirSync(outDist, { recursive: true });
  let engine = 0;
  for (const [path, data] of pkg.dist) {
    const target = join(outDist, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(data));
    engine++;
  }

  let brand = 0;
  const isBrandOwned = brandOwnedMatcher(pkg.manifest);
  if (existsSync(staticRoot)) {
    for (const [path] of readTreeMap(staticRoot)) {
      if (!isBrandOwned(path)) continue;
      const target = join(outDist, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(staticRoot, ...path.split('/')), target);
      brand++;
    }
  }

  const pkgPath = join(siteRoot, 'package.json');
  const sitePkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { name: 'storylark-site', private: true };
  sitePkg.dependencies = { ...sitePkg.dependencies, 'storylark-worker': pkg.manifest.workerVersion };
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(sitePkg, null, 2)}\n`);
  log(`Pinned storylark-worker ${pkg.manifest.workerVersion} for the App Service build step.`);

  return { engine, brand };
}

/** [relativePath, bytes] for every file under `dir`, sorted, forward slashes. */
function readTree(dir) {
  return [...readTreeMap(dir)].map(([path, full]) => [path, new Uint8Array(readFileSync(full))]);
}

/** [relativePath, absolutePath] for every file under `dir`, sorted. */
function readTreeMap(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) out.push([relative(dir, full).split(sep).join('/'), full]);
    }
  };
  walk(resolve(dir));
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
