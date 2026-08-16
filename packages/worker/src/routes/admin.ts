import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext } from '../types';
import type { Database } from '../db/types';
import { sendPush } from '../lib/vapid';
import { INIT_SCHEMA } from '../lib/schema';
import { requireAdmin } from '../lib/session';
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
admin.use('/update-install', requireAdmin());
admin.use('/status', requireAdmin());
admin.use('/publish-story', requireAdmin());

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
 * Self-update, part 1: what's running vs what's published. `current` is this
 * exact deployment's installed storylark-worker version (its own
 * package.json — reflects what's *actually* deployed, not an assumption).
 * `hasUpdate` compares against the live npm registry.
 */
admin.get('/update-status', async (c) => {
  try {
    const res = await fetch('https://registry.npmjs.org/storylark-worker/latest');
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const { version: latest } = (await res.json()) as { version: string };
    return c.json({
      current: workerPkg.version,
      latest,
      hasUpdate: latest !== workerPkg.version,
      releaseNotesUrl: 'https://storylark.org/docs/changelog.html',
      selfUpdateConfigured: Boolean(c.env.GITHUB_REPO && c.env.GITHUB_DEPLOY_TOKEN),
    });
  } catch {
    return c.json({ error: 'check_failed' }, 502);
  }
});

/**
 * Self-update, part 2: the click is the approval. A Worker has no
 * filesystem or build tooling to rebuild/redeploy itself — the real update
 * work (bump the pinned version, migrate, build, deploy) runs in the site's
 * own GitHub Actions (self-update.yml, provisioned by the installer/scaffold
 * — see create-storylark/template and docs/updating.md). This endpoint's
 * entire job is: confirm the caller is a signed-in operator (requireAdmin,
 * above), then dispatch that workflow.
 */
admin.post('/update-install', async (c) => {
  if (!c.env.GITHUB_REPO || !c.env.GITHUB_DEPLOY_TOKEN) {
    return c.json(
      {
        error: 'not_configured',
        message: 'Self-update needs the GITHUB_REPO and GITHUB_DEPLOY_TOKEN secrets set. See docs/updating.md.',
      },
      501
    );
  }
  const res = await fetch(
    `https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/workflows/self-update.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.GITHUB_DEPLOY_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'storylark-admin-portal',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );
  if (!res.ok) {
    return c.json({ error: 'dispatch_failed', status: res.status, detail: await res.text() }, 502);
  }
  return c.json({ ok: true, message: 'Update started. This rebuilds, migrates, and redeploys in the background — check back in a few minutes.' });
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
 * Called by tools/publish.mjs after a successful upload: bumps the library
 * version and wakes every push subscription (payload-less — the service
 * worker fetches the new manifest itself and composes the notification).
 */
admin.post('/publish', async (c) => {
  const body = await c.req.json<{ version?: number }>().catch(() => null);
  if (!body || typeof body.version !== 'number') return c.json({ error: 'bad_request' }, 400);

  await c.env.DB.prepare('UPDATE library_state SET manifest_version = ?, updated_at = ? WHERE id = 1')
    .bind(body.version, Date.now())
    .run();

  const { results } = await c.env.DB.prepare('SELECT endpoint, failed_count FROM push_subscriptions').all<{
    endpoint: string;
    failed_count: number;
  }>();

  // VAPID contact subject — derived from the app origin's registrable domain
  // (app.example.com → example.com) so it stays brand-neutral.
  const subject = `mailto:noreply@${new URL(c.env.APP_ORIGIN).hostname.replace(/^app\./, '')}`;
  c.executionCtx.waitUntil(fanOut(c.env, results, subject));
  return c.json({ ok: true, version: body.version, subscriptions: results.length });
});

async function fanOut(
  env: AppContext['Bindings'],
  subs: { endpoint: string; failed_count: number }[],
  subject: string
): Promise<void> {
  const BATCH = 50;
  for (let i = 0; i < subs.length; i += BATCH) {
    await Promise.all(
      subs.slice(i, i + BATCH).map(async (s) => {
        try {
          const status = await sendPush(s.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, subject);
          if (status === 404 || status === 410) {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run();
          } else if (status >= 400) {
            await bumpFailure(env.DB, s.endpoint, s.failed_count);
          }
        } catch {
          await bumpFailure(env.DB, s.endpoint, s.failed_count);
        }
      })
    );
  }
}

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
    const res = await fetch(`${c.env.CONTENT_ORIGIN}/manifest.json`);
    if (res.ok) {
      const manifest = (await res.json()) as { books?: { chapters?: unknown[] }[] };
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
    appName: c.env.APP_NAME,
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

async function bumpFailure(db: Database, endpoint: string, current: number): Promise<void> {
  if (current + 1 >= 5) {
    await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  } else {
    await db.prepare('UPDATE push_subscriptions SET failed_count = failed_count + 1 WHERE endpoint = ?').bind(endpoint).run();
  }
}
