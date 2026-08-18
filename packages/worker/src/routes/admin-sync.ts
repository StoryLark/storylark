/**
 * The Connections surface (content-management rework wave 2, AB#7420 —
 * design §4, §6, §7 / build steps 4, 5, 7, 10).
 *
 * Everything here is portal-only and session-gated, like adminContent: an
 * operator configuring where their content comes from is a person at a
 * browser, never a headless process. What headless callers get instead is the
 * webhook (signature-authenticated, in routes/content-api.ts) and the scoped
 * content-API tokens minted here.
 *
 * ── The three routes that matter, and their rules ───────────────────────────
 *   PUT  /content-source        the three-way choice (§4) + repo connection
 *                               (§6). Saving a repo connection DRY-RUNS it
 *                               first: a repo that does not validate cannot be
 *                               connected (§6.5). The token field goes to the
 *                               credential store, never into the config JSON.
 *   POST /content-source/sync   Sync now (§6.2): the same job the schedule
 *                               runs. Concurrent runs are collapsed — pressing
 *                               it during a sync attaches to the running one.
 *   POST /content-source/remove-missing
 *                               §10.1's one human click: the ordinary
 *                               recoverable delete of chapters the sync report
 *                               flagged `missing`. Nothing is ever unpublished
 *                               without this.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../types';
import { requireAdmin } from '../lib/session';
import { announceVersionOf, findBook, readManifest, refreshSingle, storeOf, writeManifest } from '../lib/content';
import { recordPublish } from '../lib/notify';
import { randomToken, sha256Hex } from '../lib/crypto';
import { SYNC_PROVIDERS, providerOf } from '../lib/sync-providers';
import {
  readSyncState,
  resolveSyncToken,
  writeRepoToken,
  writeSyncConfig,
  writeWebhookSecret,
  type ContentSourceConfig,
  type RepoConnection,
} from '../lib/sync-state';
import { runRepoSync, type SyncReport } from '../lib/repo-sync';

export const adminSync = new Hono<AppContext>();

adminSync.use('/content-source', requireAdmin());
adminSync.use('/content-source/*', requireAdmin());
adminSync.use('/content-tokens', requireAdmin());
adminSync.use('/content-tokens/*', requireAdmin());

function actor(c: Context<AppContext>): string {
  const user = c.get('user');
  return user?.username || user?.email || 'operator';
}

/**
 * GET /api/admin/content-source — the whole connection state in one read:
 * mode, the repo connection (never the token), where the credential lives,
 * whether the webhook is configured, the last sync report and when the next
 * scheduled pull lands. This IS the integration-health view (§7 item 3) for
 * the pull direction.
 */
adminSync.get('/content-source', async (c) => {
  const state = await readSyncState(c.env);
  if (state === null) {
    return c.json({
      available: false,
      message: 'This deployment’s database predates the content-connections migration (0009). Apply the migrations to configure a content source.',
    });
  }
  const config = state.config ?? { mode: 'portal' as const };
  const envToken = !!(c.env.CONTENT_SYNC_TOKEN ?? '').trim();
  return c.json({
    available: true,
    mode: config.mode,
    repo: config.repo ?? null,
    providers: Object.values(SYNC_PROVIDERS).map((p) => ({ id: p.id, label: p.label })),
    // Where the read credential lives — never its value.
    credential: envToken ? 'platform-secret' : state.repoTokenStored ? 'stored' : null,
    webhook: {
      configured: !!state.webhookSecret,
      url: `${(c.env.APP_ORIGIN ?? '').replace(/\/+$/, '')}/api/content/v1/sync/webhook`,
    },
    sync: {
      running: state.runningSince !== null,
      lastSyncAt: state.lastSyncAt,
      lastReport: state.lastSync ?? null,
      // §10.3: the existing daily cron, interval configurable per connection.
      schedule: config.mode === 'repo' && config.repo ? { cron: '0 13 * * *', intervalHours: config.repo.intervalHours } : null,
    },
  });
});

/** Validate the wire shape of a repo connection. Never accepts a credential inline. */
function readRepoConnection(raw: unknown): RepoConnection | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: 'A `repo` object is required for repo mode.' };
  const o = raw as Record<string, unknown>;
  for (const forbidden of ['token', 'password', 'secret', 'accessToken']) {
    if (o[forbidden] !== undefined) {
      // The same hard line sync.mjs draws for deployment.json: config and
      // credential never travel in one object, so a config dump can never be a leak.
      return { error: `\`repo.${forbidden}\` is not accepted. Send the credential in the top-level \`token\` field — it is stored separately and never echoed.` };
    }
  }
  const provider = providerOf(o.provider);
  if (!provider) return { error: `\`repo.provider\` must be one of: ${Object.keys(SYNC_PROVIDERS).join(', ')}. Other providers are drivers to come, not options to guess at.` };
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  if (!provider.parseRepo(url)) return { error: `\`repo.url\` must be an https ${provider.label} repository URL, e.g. https://github.com/owner/repo. SSH URLs are not supported — a Worker has no ssh client; use HTTPS with a read-only token instead.` };
  const visibility = o.visibility === 'private' ? 'private' : o.visibility === 'public' ? 'public' : null;
  if (!visibility) return { error: '`repo.visibility` must be "public" or "private".' };
  const branch = typeof o.branch === 'string' && o.branch.trim() !== '' ? o.branch.trim() : 'main';
  if (/[\s~^:?*[\\\]]/.test(branch)) return { error: `"${branch}" is not a usable branch name.` };
  const path = typeof o.path === 'string' ? o.path.trim().replace(/^\/+|\/+$/g, '') : '';
  const intervalHours = Number(o.intervalHours ?? 24);
  if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 24 * 30) {
    return { error: '`repo.intervalHours` must be between 1 and 720. The daily cron is the floor in practice (§10.3); a webhook is the instant tier.' };
  }
  return {
    provider: provider.id,
    url,
    visibility,
    branch,
    path,
    intervalHours: Math.round(intervalHours),
    ...(o.adoptMatchingExisting === true ? { adoptMatchingExisting: true } : {}),
  };
}

/**
 * PUT /api/admin/content-source — set the mode, and for repo mode the
 * connection. A repo connection is DRY-RUN before it is saved (§6.5): fetch,
 * unpack, judge every candidate through the gate — and refuse to connect on
 * any error, with the full report so each failure names its file and line.
 */
adminSync.put('/content-source', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: 'bad_request', message: 'A JSON body is required.' }, 400);
  const mode = body.mode;
  if (mode !== 'portal' && mode !== 'repo' && mode !== 'api') {
    return c.json({ error: 'bad_request', message: '`mode` must be "portal", "repo" or "api".' }, 400);
  }

  const state = await readSyncState(c.env);
  if (state === null) {
    return c.json({ error: 'unavailable', message: 'Apply database migration 0009 to configure a content source.' }, 501);
  }

  if (mode !== 'repo') {
    // Switching mode never rewrites existing content's origin (§4) — this only
    // changes what the create buttons do. The repo connection, token and
    // webhook are kept, so switching back is not a re-setup.
    const config: ContentSourceConfig = { mode, ...(state.config?.repo ? { repo: state.config.repo } : {}) };
    await writeSyncConfig(c.env, config);
    return c.json({ ok: true, mode });
  }

  const repo = readRepoConnection(body.repo);
  if ('error' in repo) return c.json({ error: 'bad_request', message: repo.error }, 400);

  const token = typeof body.token === 'string' && body.token.trim() !== '' ? body.token.trim() : undefined;
  const effectiveToken = token ?? resolveSyncToken(c.env, state);
  if (repo.visibility === 'private' && !effectiveToken) {
    return c.json(
      {
        error: 'credential_required',
        message:
          'A private repository needs a read-only token (GitHub: a fine-grained PAT with Contents: Read on that one repo). ' +
          'Set it as the CONTENT_SYNC_TOKEN platform secret, or enter it in the form. SSH keys are not an option here — HTTPS + token is the only supported transport.',
      },
      422
    );
  }

  // The connection gate (§6.5): a repo that does not validate cannot be connected.
  const outcome = await runRepoSync(c.env, { trigger: 'connect', dryRun: true, actor: actor(c), connection: repo, token: effectiveToken });
  if ('alreadyRunning' in outcome) return c.json({ error: 'sync_running', message: 'A sync is currently running; try again when it finishes.' }, 409);
  const report = outcome.report;
  if (report.failure !== undefined || report.errors.length > 0) {
    return c.json(
      {
        error: 'repo_invalid',
        message:
          report.failure ??
          `${report.errors.length} file(s) failed validation — a repo that does not validate cannot be connected. Every failure below names its file and what to change.`,
        report,
      },
      422
    );
  }
  if (report.candidates === 0) {
    return c.json(
      {
        error: 'repo_empty',
        message:
          `The connection works, but nothing under ${repo.path ? `"${repo.path}"` : 'the repository root'} carries a \`storylark:\` block, so nothing would sync. ` +
          'StoryLark content is opt-in: add the block to each file you want ingested (see docs/authoring-stories.md), then connect.',
        report,
      },
      422
    );
  }

  if (token !== undefined) await writeRepoToken(c.env, token);
  await writeSyncConfig(c.env, { mode: 'repo', repo });
  return c.json({ ok: true, mode: 'repo', repo, report });
});

/** POST /api/admin/content-source/dry-run — judge without saving or writing. */
adminSync.post('/content-source/dry-run', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  let connection: RepoConnection | undefined;
  if (body && body.repo !== undefined) {
    const repo = readRepoConnection(body.repo);
    if ('error' in repo) return c.json({ error: 'bad_request', message: repo.error }, 400);
    connection = repo;
  }
  const token = body && typeof body.token === 'string' && body.token.trim() !== '' ? body.token.trim() : undefined;
  const outcome = await runRepoSync(c.env, { trigger: 'dry-run', dryRun: true, actor: actor(c), connection, token });
  if ('alreadyRunning' in outcome) return c.json({ error: 'sync_running', message: 'A sync is currently running; try again when it finishes.' }, 409);
  return c.json({ ok: outcome.report.ok, report: outcome.report });
});

/**
 * POST /api/admin/content-source/sync — Sync now (§6.2). Exists for the two
 * cases a schedule cannot serve: "I just pushed and I do not want to wait,"
 * and "something looks wrong and I want to watch it run."
 */
adminSync.post('/content-source/sync', async (c) => {
  const outcome = await runRepoSync(c.env, {
    trigger: 'manual',
    actor: actor(c),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
  if ('alreadyRunning' in outcome) {
    return c.json({
      ok: true,
      attached: true,
      message: 'A sync is already running — this request attached to it. The report below refreshes when it finishes.',
      runningSince: outcome.runningSince ?? null,
    });
  }
  return c.json({ ok: outcome.report.ok, report: outcome.report });
});

/**
 * POST /api/admin/content-source/remove-missing — §10.1's human click.
 * Runs the ORDINARY recoverable delete over chapters the last sync reported
 * `missing`: manifest entries go, content objects, source and revision history
 * stay. Only chapters actually in the last report qualify — this route cannot
 * be used as a general-purpose delete of synced content.
 */
adminSync.post('/content-source/remove-missing', async (c) => {
  const store = storeOf(c);
  if (!store) return c.json({ error: 'no_content_store', message: 'This deployment has no writable content storage bound.' }, 501);
  const body = await c.req.json<{ chapters?: { bookId?: string; chapterId?: string }[] }>().catch(() => null);
  if (!body || !Array.isArray(body.chapters) || body.chapters.length === 0) {
    return c.json({ error: 'bad_request', message: 'A `chapters` array of { bookId, chapterId } is required.' }, 400);
  }

  const state = await readSyncState(c.env);
  const lastReport = (state?.lastSync ?? null) as SyncReport | null;
  const flagged = new Set((lastReport?.missing ?? []).map((m) => `${m.bookId}/${m.chapterId}`));
  const asked = body.chapters
    .map((ch) => ({ bookId: String(ch.bookId ?? ''), chapterId: String(ch.chapterId ?? '') }))
    .filter((ch) => ch.bookId && ch.chapterId);
  const notFlagged = asked.filter((ch) => !flagged.has(`${ch.bookId}/${ch.chapterId}`));
  if (notFlagged.length > 0) {
    return c.json(
      {
        error: 'not_flagged',
        message: `${notFlagged.map((ch) => `"${ch.bookId}/${ch.chapterId}"`).join(', ')} ${notFlagged.length === 1 ? 'is' : 'are'} not in the last sync report's missing list. Run a sync first — removal is only ever offered for what a sync actually reported absent.`,
      },
      409
    );
  }

  const manifest = await readManifest(store);
  if (!manifest) return c.json({ error: 'not_found', message: 'This library holds no content.' }, 404);
  const removed: { bookId: string; chapterId: string }[] = [];
  for (const { bookId, chapterId } of asked) {
    const book = findBook(manifest, bookId);
    if (!book) continue;
    const before = book.chapters?.length ?? 0;
    book.chapters = (book.chapters ?? []).filter((ch) => ch.id !== chapterId);
    if ((book.chapters?.length ?? 0) < before) {
      removed.push({ bookId, chapterId });
      refreshSingle(book);
    }
  }
  // A book the removals emptied leaves the shelf too — an empty synced book is
  // exactly the "renamed folder" case §10.1 is careful about, and its source
  // and history stay in storage like any other delete.
  manifest.books = (manifest.books ?? []).filter((b) => (b.chapters?.length ?? 0) > 0 || removed.every((r) => r.bookId !== b.id));

  manifest.libraryVersion = (manifest.libraryVersion ?? 0) + 1;
  (manifest as { announceVersion?: number }).announceVersion = announceVersionOf(manifest);
  manifest.generatedAt = new Date().toISOString();
  await writeManifest(store, manifest);
  await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), manifest.libraryVersion, false);
  return c.json({ ok: true, removed, libraryVersion: manifest.libraryVersion });
});

/**
 * POST /api/admin/content-source/webhook-secret — generate (or rotate) the
 * webhook signing secret. Shown ONCE, in this response; only its presence is
 * ever reported afterwards. Rotation invalidates the previous secret
 * immediately, which is the point of rotating.
 */
adminSync.post('/content-source/webhook-secret', async (c) => {
  const state = await readSyncState(c.env);
  if (state === null) return c.json({ error: 'unavailable', message: 'Apply database migration 0009 first.' }, 501);
  const secret = randomToken(32);
  await writeWebhookSecret(c.env, secret);
  return c.json({
    ok: true,
    secret,
    url: `${(c.env.APP_ORIGIN ?? '').replace(/\/+$/, '')}/api/content/v1/sync/webhook`,
    message:
      'Paste the URL and this secret into the repository’s webhook settings (GitHub: Settings → Webhooks, content type application/json, push events). The secret is shown this once.',
  });
});

adminSync.delete('/content-source/webhook-secret', async (c) => {
  await writeWebhookSecret(c.env, null);
  return c.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Scoped content-API tokens (design §7 / build step 10)
 *
 * Named, individually revocable, content-API-only. The single most important
 * addition in §7: a third-party CMS is never handed ADMIN_KEY — the key that
 * also mints admin setup links. Only the SHA-256 of a token is stored; the
 * plaintext exists exactly once, in the creation response.
 * ──────────────────────────────────────────────────────────────────────────── */

const TOKEN_PREFIX = 'sct_';

adminSync.get('/content-tokens', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, created_at, created_by, last_used_at, revoked_at FROM content_api_tokens ORDER BY created_at DESC'
    ).all<{ id: string; name: string; created_at: number; created_by: string | null; last_used_at: number | null; revoked_at: number | null }>();
    return c.json({
      available: true,
      tokens: results.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.created_at,
        createdBy: t.created_by,
        lastUsedAt: t.last_used_at,
        revoked: t.revoked_at !== null,
      })),
    });
  } catch {
    return c.json({ available: false, tokens: [], message: 'Apply database migration 0009 to use scoped content-API tokens.' });
  }
});

adminSync.post('/content-tokens', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) return c.json({ error: 'bad_request', message: 'A `name` is required — it is how you will recognise this token to revoke it.' }, 400);
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare('INSERT INTO content_api_tokens (id, name, token_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, await sha256Hex(token), Date.now(), actor(c))
      .run();
  } catch {
    return c.json({ error: 'unavailable', message: 'Apply database migration 0009 to use scoped content-API tokens.' }, 501);
  }
  return c.json({
    ok: true,
    id,
    name,
    token,
    message:
      'This token is shown once. It authenticates the content API only (Authorization: Bearer …) — it cannot mint admin logins, trigger updates, or read anything the content API does not serve.',
  });
});

adminSync.delete('/content-tokens/:id', async (c) => {
  const id = c.req.param('id');
  const updated = await c.env.DB.prepare('UPDATE content_api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(Date.now(), id)
    .run()
    .catch(() => ({ meta: { changes: 0 } }));
  if ((updated.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found', message: 'No live token with that id.' }, 404);
  return c.json({ ok: true, revoked: id });
});
