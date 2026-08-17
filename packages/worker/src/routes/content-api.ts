/**
 * The public content API — the PUSH door (AB#7412 — plan §8, items 1 and 3).
 *
 * ── Why this is a separate router at a separate prefix ──────────────────────
 * Everything under `/api/admin` is the portal's own surface: it moves when the
 * portal moves, its shapes are whatever the portal's screens need this week, and
 * it is authenticated with a browser session. That is the correct posture for a
 * UI's backend and the wrong one for something a publisher's release pipeline
 * pins against for years.
 *
 * So the push contract lives at `/api/content/v1` — a version IN THE PATH as
 * well as in the body, because a URL is what an integrator hard-codes and a
 * major version that only exists inside a JSON field is a version nobody can
 * route on. `/api/admin/content/*` keeps serving the portal, unchanged, and the
 * two share one implementation underneath (`lib/content.ts`'s `saveChapter`), so
 * they cannot drift.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * `X-Admin-Key`, or an admin session — the same two-door rule
 * `POST /api/admin/publish` and the theme import already use, and for the same
 * reason: the primary caller here is a headless process that cannot hold a
 * cookie. The session door exists so an operator can exercise the contract from
 * a browser without minting a key.
 *
 * ── Ownership ───────────────────────────────────────────────────────────────
 * Content pushed here is READ-ONLY IN THE PORTAL by default (`managed: true`),
 * which is plan §8's rule applied to the third arrival route: their system owns
 * it, so their system owns the edit button. And the same rule points back the
 * other way — this API refuses to write a book owned by a PULL connector, because
 * the next `sync.mjs` run would silently revert the push. Both refusals are the
 * same `409 managed_externally` the portal gives, with a message naming where
 * the edit belongs.
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext } from '../types';
import { requireAdmin } from '../lib/session';
import type { ContentStore } from '../lib/content-store';
import {
  ID_RE,
  announceVersionOf,
  findBook,
  findChapter,
  isPullManaged,
  managedExternallyMessage,
  readManifest,
  refreshSingle,
  syncSourceOf,
  writeManifest,
} from '../lib/content';
import {
  CONTENT_API_LIMITS,
  CONTENT_API_VERSION,
  ContentApiError,
  MIN_SUPPORTED_CONTENT_API_VERSION,
  assertContractVersion,
  booksFromArchive,
  catalogueOf,
  pushBooks,
  readBookPush,
  readChapterPush,
  readPolicy,
  type BookPush,
  type PushOutcome,
} from '../lib/content-api';
import { enqueue } from '../lib/narration';
import { recordPublish } from '../lib/notify';
import { unzip, ZipError } from 'storylark-contracts/zip';
import { sha256Hex } from '../lib/crypto';
import { providerOf } from '../lib/sync-providers';
import { readSyncState } from '../lib/sync-state';
import { runRepoSync } from '../lib/repo-sync';

export const contentApi = new Hono<AppContext>();

function hasAdminKey(c: Context<AppContext>): boolean {
  return !!c.env.ADMIN_KEY && c.req.header('x-admin-key') === c.env.ADMIN_KEY;
}

/**
 * The scoped-token door (wave 2, build step 10): `Authorization: Bearer sct_…`.
 * Content-API only by construction — the check exists solely on this router,
 * so a leaked token can push and read content and do NOTHING else: no admin
 * setup links, no updates, no theme writes. Only the token's SHA-256 is
 * stored; `last_used_at` is what makes a forgotten integration visible.
 */
async function bearerToken(c: Context<AppContext>): Promise<boolean> {
  const m = /^Bearer\s+(sct_[A-Za-z0-9_-]+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m) return false;
  try {
    const hash = await sha256Hex(m[1]);
    const row = await c.env.DB.prepare('SELECT id, name FROM content_api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .bind(hash)
      .first<{ id: string; name: string }>();
    if (!row) return false;
    c.set('contentToken', { id: row.id, name: row.name });
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE content_api_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), row.id).run()
    );
    return true;
  } catch {
    return false; // a database predating migration 0009 has no token table — the other two doors still work
  }
}

function requireAdminOrKey() {
  return async (c: Context<AppContext>, next: Next) => {
    if (hasAdminKey(c)) return next();
    if (await bearerToken(c)) return next();
    return requireAdmin()(c, next);
  };
}

/**
 * POST /api/content/v1/sync/webhook — the push trigger (wave 2, design §6.2).
 *
 * Registered BEFORE the auth middleware, deliberately: its credential is the
 * provider's signature over the raw body, verified with the secret the portal
 * generated — a caller with no signature or a forged one is rejected, never
 * trusted, and no session or key can substitute. The handler confirms the push
 * touched the configured branch and path, then runs the sync in the background:
 * the provider's delivery timeout is seconds, a sync may not be.
 */
contentApi.post('/v1/sync/webhook', async (c) => {
  const state = await readSyncState(c.env);
  if (!state?.webhookSecret) {
    return c.json({ error: 'webhook_not_configured', message: 'This deployment has no webhook secret. Generate one in the portal’s Connections section first.' }, 404);
  }
  const repo = state.config?.mode === 'repo' ? state.config.repo : undefined;
  const provider = repo ? providerOf(repo.provider) : undefined;
  if (!repo || !provider) {
    return c.json({ error: 'no_repo_connection', message: 'The content source is not a repo, so a push has nothing to sync.' }, 409);
  }

  const rawBody = await c.req.text();
  const verified = await provider.verifyWebhook({
    rawBody,
    signatureHeader: c.req.header(provider.signatureHeaderName),
    secret: state.webhookSecret,
  });
  if (!verified) {
    return c.json({ error: 'invalid_signature', message: 'The webhook signature does not verify. An unverified webhook is rejected, never trusted — check the secret pasted into the repository’s webhook settings.' }, 401);
  }

  const event = c.req.header(provider.eventHeaderName) ?? provider.pushEventName;
  if (event === 'ping') return c.json({ ok: true, pong: true });
  if (event !== provider.pushEventName) return c.json({ ok: true, synced: false, reason: `"${event}" events are ignored; only pushes sync.` });

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    /* a verified but unparseable payload still syncs — the repo is the truth, not the notification */
  }
  const branch = provider.pushedBranch(payload);
  if (branch !== undefined && branch !== repo.branch) {
    return c.json({ ok: true, synced: false, reason: `The push was to "${branch}"; this connection follows "${repo.branch}".` });
  }
  const paths = provider.pushedPaths(payload);
  if (repo.path && paths !== undefined && paths.length > 0 && !paths.some((p) => p === repo.path || p.startsWith(`${repo.path}/`))) {
    return c.json({ ok: true, synced: false, reason: `The push touched nothing under "${repo.path}".` });
  }

  c.executionCtx.waitUntil(
    runRepoSync(c.env, { trigger: 'webhook', actor: 'webhook', waitUntil: (p) => c.executionCtx.waitUntil(p) }).catch((err) =>
      console.error(`storylark: webhook-triggered sync failed: ${(err as Error).message}`)
    )
  );
  return c.json({ ok: true, queued: true, message: 'Sync queued. Watch it in the portal’s Connections section.' }, 202);
});

contentApi.use('/v1', requireAdminOrKey());
contentApi.use('/v1/*', requireAdminOrKey());

function storeOf(c: Context<AppContext>): ContentStore | null {
  return c.env.CONTENT_STORE ?? null;
}

function noStore(c: Context<AppContext>) {
  return c.json(
    {
      contractVersion: CONTENT_API_VERSION,
      error: 'no_content_store',
      message:
        'This deployment has no writable content storage bound, so content cannot be pushed into it. Bind an R2 bucket (Cloudflare) or set AZURE_STORAGE_CONNECTION_STRING / STORYLARK_LOCAL_CONTENT (Node). See docs/content-api.md.',
    },
    501
  );
}

/** Who to record on the revisions this push creates. A scoped token names itself. */
function actor(c: Context<AppContext>): string {
  const token = c.get('contentToken');
  if (token) return `token:${token.name}`;
  const user = c.get('user');
  return user?.email || user?.username || 'content-api';
}

function apiError(c: Context<AppContext>, err: unknown) {
  if (err instanceof ContentApiError) {
    return c.json(
      {
        contractVersion: CONTENT_API_VERSION,
        error: err.code,
        message: err.message,
        // The content gate's full structured list — same codes, same messages,
        // same lines the portal shows inline and a sync report would print.
        ...(err.errors ? { errors: err.errors } : {}),
      },
      err.status
    );
  }
  throw err;
}

/**
 * GET /api/content/v1 — the contract, described by the deployment that serves it.
 *
 * An integrator's first call. It exists so a client can discover which versions
 * this deployment speaks and what its ceilings are, instead of hard-coding
 * numbers from a document that may describe a different release. Same job the
 * theme API's `expects` block does.
 */
contentApi.get('/v1', (c) => {
  return c.json({
    contractVersion: CONTENT_API_VERSION,
    supported: { min: MIN_SUPPORTED_CONTENT_API_VERSION, max: CONTENT_API_VERSION },
    storeAvailable: !!storeOf(c),
    // '' = same-origin content (AB#7395): published objects are public on the
    // deployment's own origin at root-relative paths (/manifest.json, /books/*).
    contentOrigin: c.env.CONTENT_ORIGIN ?? '',
    limits: CONTENT_API_LIMITS,
    /** What arrives with content pushed here, unless `managed: false` is sent. */
    defaults: { managed: true, origin: 'sync', policy: 'best-effort', narrate: true },
    documentation: 'https://storylark.org/docs/content-api.html',
    endpoints: [
      'GET    /api/content/v1',
      'GET    /api/content/v1/catalogue',
      'PUT    /api/content/v1/books/:bookId',
      'PUT    /api/content/v1/books/:bookId/chapters/:chapterId',
      'DELETE /api/content/v1/books/:bookId/chapters/:chapterId',
      'DELETE /api/content/v1/books/:bookId',
      'POST   /api/content/v1/books',
      'POST   /api/content/v1/import',
      'POST   /api/content/v1/sync/webhook',
    ],
  });
});

/**
 * GET /api/content/v1/catalogue — what this deployment currently holds.
 *
 * The change-detection endpoint: every book and chapter with its content hash,
 * so a publisher's system pushes only what moved instead of re-uploading a
 * catalogue every release. Answered from `manifest.json` alone, so a thousand
 * short stories cost one storage read.
 */
contentApi.get('/v1/catalogue', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const manifest = await readManifest(store);
  return c.json({ contractVersion: CONTENT_API_VERSION, ...catalogueOf(manifest) });
});

/** PUT one book (metadata, and optionally its chapters in the same call). */
contentApi.put('/v1/books/:bookId', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const bookId = c.req.param('bookId');
  const body = await c.req.json().catch(() => null);
  try {
    assertContractVersion(body);
    const raw = (body as Record<string, unknown>).book ?? body;
    const book = readBookPush({ ...(raw as object), id: (raw as { id?: unknown }).id ?? bookId }, `books/${bookId}`);
    if (book.id !== bookId) {
      throw new ContentApiError(
        'bad_request',
        `The body says book "${book.id}" but the URL says "${bookId}". They have to agree.`
      );
    }
    return await runPush(c, [book], {
      policy: 'all-or-nothing',
      narrate: (body as { narrate?: unknown }).narrate,
      label: `content API: ${bookId}`,
    });
  } catch (err) {
    return apiError(c, err);
  }
});

/** PUT one chapter — the smallest possible integration: "we corrected a typo". */
contentApi.put('/v1/books/:bookId/chapters/:chapterId', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const bookId = c.req.param('bookId');
  const chapterId = c.req.param('chapterId');
  const body = await c.req.json().catch(() => null);
  try {
    assertContractVersion(body);
    if (!ID_RE.test(bookId)) {
      throw new ContentApiError('invalid_book_id', `"${bookId}" is not a usable book id.`);
    }
    const o = body as Record<string, unknown>;
    const chapter = readChapterPush({ ...o, id: chapterId }, `books/${bookId}/chapters/${chapterId}`, bookId);
    const book: BookPush = {
      id: bookId,
      chapters: [chapter],
      managed: o.managed === undefined ? true : o.managed === true,
      source:
        o.source && typeof o.source === 'object' && !Array.isArray(o.source)
          ? { url: (o.source as { url?: string }).url, system: (o.source as { system?: string }).system }
          : undefined,
    };
    return await runPush(c, [book], {
      policy: 'all-or-nothing',
      narrate: o.narrate,
      label: `content API: ${bookId}/${chapterId}`,
    });
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * POST /api/content/v1/books — the batch door (plan §8, item 3).
 *
 * The whole catalogue, or as much of it as fits in one request. `policy`
 * defaults to `best-effort` here — and only here — because this is the
 * onboarding endpoint: see the long note on `pushBooks()` for why one bad book
 * in fifty must not cost the other forty-nine.
 */
contentApi.post('/v1/books', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const body = await c.req.json().catch(() => null);
  try {
    assertContractVersion(body);
    const o = body as Record<string, unknown>;
    if (!Array.isArray(o.books)) {
      throw new ContentApiError('bad_request', 'A batch push needs a `books` array. To push one book, PUT /api/content/v1/books/<id>.');
    }
    const books = o.books.map((b, i) => readBookPush(b, `books[${i}]`));
    return await runPush(c, books, {
      policy: readPolicy(o.policy),
      narrate: o.narrate,
      label: `content API batch: ${books.length} book${books.length === 1 ? '' : 's'}`,
    });
  } catch (err) {
    return apiError(c, err);
  }
});

/**
 * POST /api/content/v1/import — a zip of the markdown-folder layout.
 *
 * "Onboarding day", as a file. The operator (or the publisher's own export job)
 * hands over the same `books/` tree the CLI reads off disk, and it lands through
 * exactly the same `pushBooks()` the JSON batch uses — the archive is unpacked
 * into book pushes and nothing else about the path differs. `best-effort` by
 * default for the same reason.
 *
 * Accepts either a `multipart/form-data` upload with a `file` part (what a
 * browser form sends) or a raw `application/zip` body (what `curl --data-binary`
 * sends), matching the theme import's two doors exactly.
 */
contentApi.post('/v1/import', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);

  let bytes: ArrayBuffer;
  let managed = true;
  let policy: 'best-effort' | 'all-or-nothing' = 'best-effort';
  let narrate: unknown = undefined;
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const candidate = form.get('file') as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
      if (!candidate || typeof candidate === 'string' || typeof candidate.arrayBuffer !== 'function') {
        throw new ContentApiError('bad_request', 'No archive was attached. Send a `file` part holding a .zip.');
      }
      bytes = await candidate.arrayBuffer();
      managed = String(form.get('managed') ?? 'true') !== 'false';
      policy = readPolicy(form.get('policy') === null ? undefined : String(form.get('policy')));
      narrate = form.get('narrate') === null ? undefined : String(form.get('narrate')) !== 'false';
    } else {
      bytes = await c.req.arrayBuffer();
      managed = c.req.query('managed') !== 'false';
      policy = readPolicy(c.req.query('policy'));
      narrate = c.req.query('narrate') === undefined ? undefined : c.req.query('narrate') !== 'false';
    }
  } catch (err) {
    return apiError(c, err);
  }

  if (bytes.byteLength === 0) {
    return c.json({ contractVersion: CONTENT_API_VERSION, error: 'bad_request', message: 'The request carried no archive.' }, 400);
  }
  if (bytes.byteLength > CONTENT_API_LIMITS.maxImportBytes) {
    return c.json(
      {
        contractVersion: CONTENT_API_VERSION,
        error: 'too_large',
        message: `That archive is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; the limit is ${Math.round(CONTENT_API_LIMITS.maxImportBytes / 1024 / 1024)}MB. Split the catalogue and import it in parts — each import is independent.`,
      },
      413
    );
  }

  let entries: Map<string, Uint8Array>;
  try {
    entries = await unzip(new Uint8Array(bytes), {
      maxEntries: CONTENT_API_LIMITS.maxImportEntries,
      maxEntryBytes: CONTENT_API_LIMITS.maxChapterBytes,
      maxTotalBytes: CONTENT_API_LIMITS.maxImportBytes,
    });
  } catch (err) {
    if (err instanceof ZipError) {
      return c.json({ contractVersion: CONTENT_API_VERSION, error: 'invalid_archive', message: err.message }, 422);
    }
    throw err;
  }

  const { books: found, ignored } = booksFromArchive(entries);
  if (found.length === 0) {
    return c.json(
      {
        contractVersion: CONTENT_API_VERSION,
        error: 'empty_import',
        message:
          'That archive holds no books in the layout this understands: `books/<book-id>/NN-chapter.md` for a multi-chapter book, or `books/<book-id>.md` for a single-chapter one. See docs/authoring-stories.md.',
        ignored,
      },
      422
    );
  }
  try {
    return await runPush(
      c,
      found.map((b) => ({ ...b, managed })),
      { policy, narrate, label: `bulk import: ${found.length} book${found.length === 1 ? '' : 's'}`, ignored }
    );
  } catch (err) {
    return apiError(c, err);
  }
});

/** DELETE one chapter. The stored objects stay, exactly as the portal's delete does. */
contentApi.delete('/v1/books/:bookId/chapters/:chapterId', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const bookId = c.req.param('bookId');
  const chapterId = c.req.param('chapterId');
  const manifest = await readManifest(store);
  const book = manifest ? findBook(manifest, bookId) : undefined;
  if (!manifest || !book) return c.json({ contractVersion: CONTENT_API_VERSION, error: 'not_found' }, 404);
  const refusal = refusePullManaged(c, book, bookId, `"${bookId}/${chapterId}"`);
  if (refusal) return refusal;
  if (!findChapter(book, chapterId)) return c.json({ contractVersion: CONTENT_API_VERSION, error: 'not_found' }, 404);

  book.chapters = book.chapters.filter((ch) => ch.id !== chapterId);
  refreshSingle(book);
  const libraryVersion = await bumpManifest(store, manifest);
  await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), libraryVersion, false);
  return c.json({ contractVersion: CONTENT_API_VERSION, ok: true, deleted: chapterId, libraryVersion });
});

/** DELETE a whole book. Same rule: the manifest entry goes, the objects stay. */
contentApi.delete('/v1/books/:bookId', async (c) => {
  const store = storeOf(c);
  if (!store) return noStore(c);
  const bookId = c.req.param('bookId');
  const manifest = await readManifest(store);
  const book = manifest ? findBook(manifest, bookId) : undefined;
  if (!manifest || !book) return c.json({ contractVersion: CONTENT_API_VERSION, error: 'not_found' }, 404);
  const refusal = refusePullManaged(c, book, bookId, `"${bookId}"`);
  if (refusal) return refusal;

  manifest.books = (manifest.books ?? []).filter((b) => b.id !== bookId);
  const libraryVersion = await bumpManifest(store, manifest);
  await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), libraryVersion, false);
  return c.json({ contractVersion: CONTENT_API_VERSION, ok: true, deleted: bookId, libraryVersion });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Shared tail
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run a push, record the publish, and queue the narration it just made stale.
 *
 * The narration queue is wired in HERE rather than left to the caller because a
 * bulk import that returns instantly with no audio and no visible work is the
 * exact failure plan §8 names: "an import that appears to finish instantly and
 * then quietly has no audio for a week". Every push that changes text enqueues
 * jobs for what it changed, and the response says how many — so the very first
 * thing an integrator sees is that the audio has not happened yet and where to
 * watch it.
 *
 * `narrate: false` opts out, for a caller pushing text it will never narrate.
 */
async function runPush(
  c: Context<AppContext>,
  books: BookPush[],
  opts: { policy: 'best-effort' | 'all-or-nothing'; narrate: unknown; label: string; ignored?: { name: string; reason: string }[] }
): Promise<Response> {
  const store = storeOf(c);
  if (!store) return noStore(c);

  const outcome: PushOutcome = await pushBooks({
    store,
    env: c.env,
    books,
    policy: opts.policy,
    actor: actor(c),
  });

  // The library version always moves (see the correction rule in docs/api.md);
  // a push is a publication, so it announces — unless every chapter in it was
  // flagged a correction, in which case nothing announced and there is nothing
  // to wake a phone for.
  const announce = outcome.summary.chaptersSucceeded > 0 && outcome.announceVersion === outcome.libraryVersion;
  const notified =
    outcome.summary.chaptersSucceeded > 0 || outcome.summary.booksSucceeded > 0
      ? await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), outcome.libraryVersion, announce)
      : null;

  let narration: { queued: number; batchId: string | null; message: string } = {
    queued: 0,
    batchId: null,
    message: 'Narration was not requested for this push.',
  };
  if (opts.narrate !== false && outcome.written.length > 0) {
    try {
      const result = await enqueue(
        c.env,
        outcome.written.map((w) => ({
          bookId: w.bookId,
          chapterId: w.chapterId,
          contentHash: w.contentHash,
          charLength: w.charLength,
        })),
        { requestedBy: actor(c), label: opts.label }
      );
      narration = {
        queued: result.total,
        batchId: result.batchId,
        message: `${result.total} chapter${result.total === 1 ? '' : 's'} queued for narration. No StoryLark deployment can run the narration model — a worker drains this queue: \`node packages/pipeline/narrate.mjs --brand <id>\`. Watch it at GET /api/admin/narration.`,
      };
    } catch (err) {
      // A deployment whose database predates migration 0008 has no queue. The
      // text is already published and that must not be reported as a failure.
      narration = {
        queued: 0,
        batchId: null,
        message: `The text was published, but narration could not be queued: ${(err as Error).message}. Apply the database migrations and re-queue from /admin.`,
      };
    }
  }

  const partial = outcome.summary.booksFailed > 0;
  return c.json(
    {
      contractVersion: CONTENT_API_VERSION,
      ok: !partial,
      policy: opts.policy,
      summary: outcome.summary,
      results: outcome.results,
      // Archive entries that were not books, each with the reason. Present only
      // for an import, and empty on a clean one — an operator whose catalogue
      // came back with 41 of 42 books needs to know which file was skipped and
      // why, not to go looking for it.
      ...(opts.ignored ? { ignored: opts.ignored } : {}),
      libraryVersion: outcome.libraryVersion,
      announceVersion: outcome.announceVersion,
      notified,
      narration,
    },
    // 207 for a best-effort batch that partly succeeded: the request was
    // processed, and pretending a partial result is a plain 200 would let a
    // caller's error handling miss the books that did not land.
    partial ? 207 : 200
  );
}

function refusePullManaged(c: Context<AppContext>, book: unknown, bookId: string, what: string): Response | null {
  if (!isPullManaged(book as never)) return null;
  const source = syncSourceOf(book as never);
  return c.json(
    {
      contractVersion: CONTENT_API_VERSION,
      error: 'managed_externally',
      message: managedExternallyMessage(bookId, source, what),
      origin: 'sync',
      syncSource: source,
    },
    409
  );
}

async function bumpManifest(store: ContentStore, manifest: Parameters<typeof writeManifest>[1]): Promise<number> {
  const libraryVersion = (manifest.libraryVersion ?? 0) + 1;
  manifest.libraryVersion = libraryVersion;
  (manifest as { announceVersion?: number }).announceVersion = announceVersionOf(manifest);
  manifest.generatedAt = new Date().toISOString();
  await writeManifest(store, manifest);
  return libraryVersion;
}
