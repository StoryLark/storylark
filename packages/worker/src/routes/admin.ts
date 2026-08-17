import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext } from '../types';
import { INIT_SCHEMA } from '../lib/schema';
import { requireAdmin } from '../lib/session';
import { recordPublish } from '../lib/notify';
import { readManifest } from '../lib/content';
import { resolveSelfDeploy } from '../lib/self-deploy';
import { downloadEngineArtifact, findEngineRelease, EngineReleaseError } from '../lib/engine-release';
import { readEnginePackage, EnginePackageError } from 'storylark-contracts/engine-package';
import workerPkg from '../../package.json';

export const admin = new Hono<AppContext>();

function requireAdminKey(c: { req: { header(name: string): string | undefined }; env: { ADMIN_KEY: string } }): boolean {
  return !!c.env.ADMIN_KEY && c.req.header('x-admin-key') === c.env.ADMIN_KEY;
}

/**
 * Operator-facing routes (AB#7404) are gated by a real account with
 * `is_admin = 1` — a session cookie, not the shared ADMIN_KEY header the
 * portal used to prompt for. Attached the same way requireAuth() is in
 * progress.ts/preferences.ts/bookmarks.ts. ADMIN_KEY survives only where a
 * human at a browser genuinely can't be involved: POST /setup (runs before
 * any user can exist) and POST /publish (see requireAdminOrKey below).
 */
admin.use('/update-status', requireAdmin());
admin.use('/status', requireAdmin());
admin.use('/publish-story', requireAdmin());
/**
 * Session only, and deliberately NOT requireAdminOrKey (AB#7418 — plan §4
 * layer 3). The GitHub-dispatch version this replaces accepted ADMIN_KEY so a
 * headless CI job could trigger it. This one must not: §4's rule is that "the
 * click IS the approval", and a shared header key that lives in an installer's
 * environment file is not a click. An operator who wants an update from CI
 * already has a better tool for it — the installer's own `--update` command,
 * run with their own credentials, on their own runner.
 */
admin.use('/update-install', requireAdmin());

/**
 * The one deliberate exception to the session rule. POST /publish is called
 * by packages/pipeline/publish.mjs (and by the publish.yml workflow that
 * wraps it) as the final step of a content publish — a headless CI process
 * that has no browser and cannot hold a session cookie. Locking it to
 * sessions would break the content pipeline outright.
 *
 * So: a valid ADMIN_KEY still gets in here, and an admin session also does
 * (the CSRF header is enforced on that path only — it's meaningless for the
 * key path, which isn't cookie-authenticated and so isn't forgeable by a
 * third-party site in the first place).
 */
function requireAdminOrKey() {
  return async (c: Context<AppContext>, next: Next) => {
    if (requireAdminKey(c)) return next();
    return requireAdmin()(c, next);
  };
}

admin.use('/publish', requireAdminOrKey());

/**
 * Which installer the operator should reach for. Detected from the runtime,
 * not from configuration: workerd sets navigator.userAgent to
 * 'Cloudflare-Workers', and every other supported host today is the Node
 * server in platforms/azure/server.mjs. Deliberately NOT a new env var — an
 * update instruction that only works if someone remembered to set a variable
 * is worse than useless.
 */
function detectPlatform(): 'cloudflare' | 'node' {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers' ? 'cloudflare' : 'node';
}

const UPDATE_COMMANDS = {
  cloudflare: 'node platforms/cloudflare/install.mjs --update --yes',
  node: 'node platforms/azure/install.mjs --update --yes',
} as const;

/**
 * Update status (AB#7403) — the notify half, and the only half that lives in
 * the deployment at all.
 *
 * `current` is this exact deployment's installed storylark-worker version (its
 * own package.json — reflects what's *actually* deployed, not an assumption);
 * `hasUpdate` compares it against the live npm registry, unauthenticated and
 * read-only.
 *
 * Installing is deliberately NOT something this deployment can do. It hands
 * back `updateCommand`: the installer command the operator runs from their own
 * machine, with the platform credentials they already hold. A deployment that
 * could update itself would have to hold a standing deploy credential, and
 * that credential — a GitHub PAT, in the version this replaced — is exactly
 * what a reading app has no business storing. See docs/updating.md.
 */
admin.get('/update-status', async (c) => {
  try {
    const res = await fetch('https://registry.npmjs.org/storylark-worker/latest');
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const { version: latest } = (await res.json()) as { version: string };
    const platform = detectPlatform();
    return c.json({
      current: workerPkg.version,
      latest,
      hasUpdate: latest !== workerPkg.version,
      releaseNotesUrl: 'https://storylark.org/docs/changelog.html',
      platform,
      updateCommand: UPDATE_COMMANDS[platform],
      updateDocsUrl: 'https://storylark.org/docs/updating.html',
      // Layer 3 (AB#7418). ALWAYS present, and `available: false` with a reason
      // is the normal answer — the portal renders the layer-2 command either
      // way and adds a button only on top of it. Whether it is available is a
      // live question, not a stored flag: the preflight below actually asks the
      // platform, so a token that was revoked yesterday stops offering a button
      // today rather than failing on the click.
      oneClick: await oneClickStatus(c.env),
    });
  } catch {
    return c.json({ error: 'check_failed' }, 502);
  }
});

/** `available` means "there is a target AND it answers". Anything else carries a reason. */
async function oneClickStatus(env: Parameters<typeof resolveSelfDeploy>[0]) {
  const { target, reason } = resolveSelfDeploy(env);
  if (!target) return { available: false, reason };
  const check = await target.preflight().catch((err: Error) => ({ ok: false as const, detail: err.message }));
  if (!check.ok) {
    return {
      available: false,
      platform: target.platform,
      credential: target.credential,
      reason: `One-click updates are configured, but the deployment could not use them right now: ${check.detail}`,
    };
  }
  return { available: true, platform: target.platform, credential: target.credential, detail: check.detail };
}

/**
 * POST /api/admin/update-install — the button (AB#7418 — plan §4 layer 3, §0d
 * Phase 5).
 *
 * ── Why this is honest now and was not before ───────────────────────────────
 * A route with this name existed once and was removed outright, because what it
 * did was ask GitHub Actions to rebuild the site — which meant a GitHub account,
 * a fork, and an Actions:write credential stored in a reading app. This one
 * downloads a PREBUILT artifact and hands it to the platform the operator is
 * already paying for, with a permission the operator granted to their own
 * deployment. Phases 2-4 are what made a prebuilt artifact possible at all: with
 * the brand compiled into the bundle there was no such thing as an engine build
 * that was correct for more than one customer.
 *
 * ── The order, and why every step is where it is ────────────────────────────
 *   1. Is there a target?      501 if not. No target, no button, no surprise.
 *   2. Which version?          storylark-core's own npm registry entry — NOT
 *                              storylark-worker's (see the note on the fetch
 *                              below; found live, 2026-08-16, the two are not
 *                              always the same number).
 *   3. Find + verify + read.   Checksum before unzip, manifest sha256 per file,
 *                              and a package carrying a brand.json is rejected
 *                              outright. Nothing has touched the deployment yet.
 *   4. Migrate, then swap.     Inside the target, because the right mechanism
 *                              for each is platform knowledge.
 *
 * Steps 1-3 cannot change anything, by construction: the first call that can is
 * inside `install()`. So every way this fails except a platform failure is a
 * pure no-op, which is the same guarantee the theme import gives and for the
 * same reason.
 */
admin.post('/update-install', async (c) => {
  const { target, reason } = resolveSelfDeploy(c.env);
  if (!target) {
    return c.json(
      {
        error: 'not_configured',
        message: reason,
        updateCommand: UPDATE_COMMANDS[detectPlatform()],
      },
      501
    );
  }

  const body = await c.req.json<{ version?: string }>().catch(() => ({}) as { version?: string });
  let version = body.version;
  if (!version) {
    // storylark-core, not storylark-worker: a GitHub release is tagged and its
    // engine artifact attached by CORE's version (releaseTag() below builds
    // `storylark-core@<version>`), and release.yml re-attaches that artifact
    // — always built from the current commit, so always carrying whatever
    // worker code most recently shipped — on EVERY publish, not only ones
    // that bump core. So core's latest npm version always names a real,
    // current release; worker's latest does not, whenever a worker-only
    // changeset (e.g. a worker bugfix) leaves core's version behind. Found
    // live, 2026-08-16: this deployment's own worker-only self-deploy fix
    // (0.15.1) shipped with core still at 0.15.0, and the admin portal's
    // "Install update" button — which always POSTs an empty body, so this is
    // the only path it takes — 404'd looking for a nonexistent
    // "storylark-core@0.15.1" release until this fix.
    try {
      const res = await fetch('https://registry.npmjs.org/storylark-core/latest');
      if (!res.ok) throw new Error(`registry ${res.status}`);
      version = ((await res.json()) as { version: string }).version;
    } catch {
      return c.json({ error: 'check_failed', message: 'Could not ask the npm registry which version is current.' }, 502);
    }
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return c.json({ error: 'bad_request', message: `"${version}" is not a version number.` }, 400);
  }

  const log: string[] = [];
  const push = (line: string) => {
    log.push(line);
    console.log(`storylark update: ${line}`);
  };

  try {
    push(`Looking for the prebuilt engine ${version}…`);
    const release = await findEngineRelease(version, {
      repo: c.env.ENGINE_RELEASE_REPO,
      base: c.env.ENGINE_RELEASE_BASE,
    });
    const { bytes, sha256 } = await downloadEngineArtifact(release);
    push(`Downloaded ${Math.round(bytes.byteLength / 1024)}KB and verified sha256 ${sha256.slice(0, 16)}….`);

    const pkg = await readEnginePackage(bytes);
    push(`Package reads clean: storylark-core ${pkg.manifest.coreVersion}, ${pkg.dist.size} engine files.`);

    const result = await target.install(pkg, push);
    return c.json({
      ok: true,
      installed: pkg.manifest.coreVersion,
      workerVersion: pkg.manifest.workerVersion,
      platform: target.platform,
      sha256,
      releaseUrl: release.releaseUrl,
      log,
      message: result.note,
    });
  } catch (err) {
    if (err instanceof EngineReleaseError) {
      return c.json({ error: err.code, message: err.message, applied: false, log }, err.code === 'no_release' ? 404 : 502);
    }
    if (err instanceof EnginePackageError) {
      return c.json({ error: 'invalid_package', message: err.errors[0], errors: err.errors, applied: false, log }, 502);
    }
    // Anything from here on happened INSIDE the platform call, so "applied" is
    // genuinely unknown — say so rather than claim a clean rollback that this
    // code cannot perform.
    console.error(err);
    return c.json(
      {
        error: 'deploy_failed',
        message: `${(err as Error).message} — check the log below, then take the update with the installer command if it persists.`,
        updateCommand: UPDATE_COMMANDS[detectPlatform()],
        log,
      },
      502
    );
  }
});

/**
 * One-shot database bootstrap through the worker's own D1 binding, for when
 * API-token D1 access is unavailable. Idempotent: no-ops if the schema exists.
 */
admin.post('/setup', async (c) => {
  if (c.req.header('x-admin-key') !== c.env.ADMIN_KEY || !c.env.ADMIN_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const existing = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  ).first();
  if (existing) return c.json({ ok: true, alreadySetUp: true });

  const statements = INIT_SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of statements) {
    await c.env.DB.prepare(sql).run();
  }
  return c.json({ ok: true, statements: statements.length });
});

/**
 * Called by packages/pipeline/publish.mjs after a successful upload: bumps the
 * library version and wakes every push subscription (payload-less — the service
 * worker fetches the new manifest itself and composes the notification).
 *
 * `announce` (AB#7420, default true) is the correction switch. The pipeline
 * always announces; the admin portal's editing routes call the same
 * `recordPublish()` with `announce: false` when the operator ticked "this is a
 * correction", which records the version so readers still receive the fix but
 * doesn't ring anyone's phone over a typo.
 */
admin.post('/publish', async (c) => {
  const body = await c.req.json<{ version?: number; announce?: boolean }>().catch(() => null);
  if (!body || typeof body.version !== 'number') return c.json({ error: 'bad_request' }, 400);

  const result = await recordPublish(
    c.env,
    (p) => c.executionCtx.waitUntil(p),
    body.version,
    body.announce !== false
  );
  return c.json({ ok: true, version: result.version, announced: result.announced, subscriptions: result.subscriptions });
});

/**
 * Admin portal status view: engine identity, library size (from the public
 * manifest — books/chapters live in storage, not D1), and push subscriber
 * count (D1). Best-effort: a manifest fetch failure doesn't fail the whole
 * status response, it just reports null counts.
 */
admin.get('/status', async (c) => {
  let bookCount: number | null = null;
  let chapterCount: number | null = null;
  try {
    // The bound content store first (AB#7395): it is the manifest's actual
    // home, it works when CONTENT_ORIGIN is unset (same-origin content — a
    // Worker cannot fetch() a root-relative URL), and it saves an HTTP hop on
    // deployments that do have a content domain. The public-origin fetch
    // survives as the fallback for a deployment serving content it cannot
    // read as storage (no store bound, content published elsewhere).
    const manifest: { books?: { chapters?: unknown[] }[] } | null = c.env.CONTENT_STORE
      ? await readManifest(c.env.CONTENT_STORE)
      : c.env.CONTENT_ORIGIN
        ? await fetch(`${c.env.CONTENT_ORIGIN}/manifest.json`).then((res) => (res.ok ? res.json() : null))
        : null;
    if (manifest) {
      bookCount = manifest.books?.length ?? 0;
      chapterCount = manifest.books?.reduce((n, b) => n + (b.chapters?.length ?? 0), 0) ?? 0;
    }
  } catch {
    // manifest unreachable — leave counts null rather than fail the request
  }

  let pushSubscriptions: number | null = null;
  try {
    const subs = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>();
    pushSubscriptions = subs?.n ?? 0;
  } catch {
    // database unreachable — leave null rather than fail the whole status view
  }

  return c.json({
    brand: c.env.BRAND,
    engineVersion: workerPkg.version,
    bookCount,
    chapterCount,
    pushSubscriptions,
  });
});

/**
 * Admin portal story upload, text-only single-chapter shorthand (the
 * "<book-id>.md" convention in docs/authoring-stories.md). Deliberately does
 * NOT reimplement publish.mjs's manifest/TTS/hashing logic inside the
 * Worker — that would drift from the canonical CLI path. Instead: commit
 * the markdown via the GitHub Contents API, then dispatch publish.yml,
 * which runs the real, unchanged pipeline. Narration status is whatever
 * that workflow's AZURE_SPEECH_KEY secret allows — reported honestly to the
 * caller, never implied to already exist.
 */
admin.post('/publish-story', async (c) => {
  if (!c.env.GITHUB_REPO || !c.env.GITHUB_DEPLOY_TOKEN) {
    return c.json(
      { error: 'not_configured', message: 'Story upload needs GITHUB_REPO and GITHUB_DEPLOY_TOKEN secrets. See docs/admin-guide.md.' },
      501
    );
  }

  const body = await c.req.json<{ bookId?: string; title?: string; author?: string; description?: string; markdown?: string }>();
  if (!body.bookId || !/^[a-z0-9-]{2,64}$/.test(body.bookId)) {
    return c.json({ error: 'invalid_book_id', message: 'bookId must be 2-64 lowercase letters, digits, or hyphens.' }, 400);
  }
  if (!body.title || !body.markdown) {
    return c.json({ error: 'missing_fields', message: 'title and markdown are required.' }, 400);
  }

  const frontmatter = [
    '---',
    `title: ${body.title}`,
    body.author ? `author: ${body.author}` : null,
    body.description ? `description: ${body.description}` : null,
    'label: Read',
    '---',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
  const fileContent = frontmatter + body.markdown;
  const path = `content/books/${body.bookId}.md`;

  const ghHeaders = {
    Authorization: `Bearer ${c.env.GITHUB_DEPLOY_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'storylark-admin-portal',
  };

  // GitHub's Contents API needs the existing file's blob sha to update it;
  // a 404 here correctly means "creating a new story."
  let sha: string | undefined;
  const existing = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/${path}`, { headers: ghHeaders });
  if (existing.ok) sha = ((await existing.json()) as { sha: string }).sha;

  const commitRes = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `content: publish "${body.title}" via admin portal`,
      content: btoa(unescape(encodeURIComponent(fileContent))),
      sha,
    }),
  });
  if (!commitRes.ok) {
    return c.json({ error: 'commit_failed', status: commitRes.status, detail: await commitRes.text() }, 502);
  }

  const dispatchRes = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/workflows/publish.yml/dispatches`, {
    method: 'POST',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!dispatchRes.ok) {
    return c.json(
      { ok: true, committed: true, published: false, message: 'Story committed but publishing failed to start — check the repo\'s Actions tab.' },
      207
    );
  }

  return c.json({
    ok: true,
    committed: true,
    published: true,
    message: 'Story committed and publishing started — check back in a few minutes. Narration depends on whether TTS credentials are configured in the repo.',
  });
});
