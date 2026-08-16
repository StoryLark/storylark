/**
 * The admin portal's content manager (AB#7420 / AB#7421 — plan §3).
 *
 * Lives in the STANDALONE admin bundle, not the reader app. It imports exactly
 * two things from the reader side, both deliberate:
 *
 *   • `BlockRenderer` — a pure function of a block to markup, with no imports
 *     beyond types. Reusing it is what makes the preview show the real page
 *     rather than an approximation of it; copying it would guarantee they
 *     diverge, which is the whole failure mode a preview exists to prevent.
 *   • `PRESENTATION.layout` — one string, from the runtime presentation the
 *     deployment serves.
 *
 * Nothing here touches the router, the player, IndexedDB, the manifest loader
 * or the service worker, so the admin module graph stays separate (AB#7404).
 *
 * ── The two shapes, both first class (plan §3) ──────────────────────────────
 * A single work (one book, ordered chapters) and a growing set of short stories
 * (many books of one chapter each) are the same data model and a completely
 * different job to sit in front of. `layout` already distinguishes them, so the
 * portal reads it instead of showing one generic tree:
 *
 *   series → Books, then chapters inside the one you picked.
 *   flat   → Stories. One click opens the story's only chapter; the cover IS
 *            the title illustration, so it is offered on the story itself.
 *
 * ── The editing surface is plain markdown, on purpose ───────────────────────
 * No rich-text editor. A WYSIWYG needs a two-way markdown conversion, and that
 * conversion is a reliable source of silent content corruption. What is offered
 * instead: a textarea, a live preview of exactly what will publish, a download
 * of the current file, an insert-image action so nobody types a URL by hand,
 * and a revision history with one-click revert.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { call, ApiError } from '../../lib/api';
import type { Block, ContentOrigin, SyncSource } from '../../lib/types';
import { BlockRenderer } from '../../reader/BlockRenderer';
import { PRESENTATION } from '../../presentation';

function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return call<T>(`/admin${path}`, init);
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.detail) return err.detail;
    if (err.slug) return err.slug.replace(/_/g, ' ');
  }
  return fallback;
}

interface ChapterSummary {
  id: string;
  title?: string;
  label?: string;
  wordCount: number;
  readingTime?: string;
  hasAudio: boolean;
  audioStale: boolean;
  hasSource: boolean;
  contentHash: string;
  publishedAt?: string;
  /** Where this chapter came from (AB#7422). Older deployments omit it. */
  origin?: ContentOrigin;
  /** True for `sync`: managed externally, so this portal shows it and does not
   *  offer to edit it. The server enforces the same rule; this is what stops an
   *  operator finding out only after typing a paragraph. */
  readOnly?: boolean;
}

interface BookSummary {
  id: string;
  title?: string;
  author?: string;
  description?: string;
  cover?: string;
  chapterCount: number;
  chapters: ChapterSummary[];
  origin?: ContentOrigin;
  readOnly?: boolean;
  syncSource?: SyncSource;
}

interface LibraryResponse {
  storeAvailable: boolean;
  contentOrigin?: string;
  libraryVersion: number;
  announceVersion: number;
  revisionLimit: number;
  books: BookSummary[];
}

interface Revision {
  id: string;
  savedAt: number;
  savedBy: string;
  bytes: number;
  live: boolean;
  correction: boolean;
  revertedFrom?: string;
}

interface ChapterDetail {
  bookId: string;
  chapterId: string;
  title?: string;
  label?: string;
  markdown: string;
  reconstructed: boolean;
  hasAudio: boolean;
  audioStale: boolean;
  wordCount: number;
  readingTime?: string;
  contentHash: string;
  origin?: ContentOrigin;
  readOnly?: boolean;
  syncSource?: SyncSource;
  revisions: Revision[];
  revisionLimit: number;
}

interface PreviewResponse {
  title?: string;
  blocks: Block[];
  wordCount: number;
  charLength: number;
  readingTime: string;
  problem: string | null;
}

interface SaveResponse {
  ok: true;
  created: boolean;
  contentHash: string;
  wordCount: number;
  readingTime: string;
  audioStale: boolean;
  libraryVersion: number;
  announceVersion: number;
  correction: boolean;
  revisionCount: number;
  notified: { announced: boolean; subscriptions: number };
}

type View = { name: 'library' } | { name: 'book'; bookId: string } | { name: 'chapter'; bookId: string; chapterId: string; isNew?: boolean };

/**
 * "Managed externally — edit at source" (AB#7422 — plan §8).
 *
 * Shown wherever synced content is, INSTEAD of the editing controls rather than
 * beside them. The API refuses these writes anyway, but a portal that lets an
 * operator write a paragraph and only then says no has already wasted their
 * work and taught them not to trust it. The notice names the actual source and
 * links to it, because "edit at source" is not advice unless it says which one.
 */
function ManagedExternally({ source, what }: { source?: SyncSource; what: string }): JSX.Element {
  const href = source && /^https?:\/\//i.test(source.url) ? source.url : undefined;
  return (
    <p class="settings-note admin-notice">
      <strong>Managed externally.</strong> {what} is synced into this deployment from{' '}
      {source?.kind === 'git' ? 'a git repository' : source?.kind === 'feed' ? "the publisher's own system" : 'an external source'}
      {source ? (
        <>
          {' — '}
          {href ? (
            <a href={href} rel="noreferrer noopener" target="_blank">
              {source.url}
            </a>
          ) : (
            <code>{source.url}</code>
          )}
          {source.ref ? ` (branch ${source.ref})` : ''}
        </>
      ) : (
        ''
      )}
      . What you see here is a copy, so it can't be edited from the portal — a change saved here would be overwritten by the next
      sync. Edit it at the source and re-sync.
      {source?.syncedAt ? ` Last synced ${new Date(source.syncedAt).toLocaleString()}.` : ''}
    </p>
  );
}

/** The one-word label a row carries when its content isn't ours to edit. */
function OriginBadge({ readOnly }: { readOnly?: boolean }): JSX.Element | null {
  return readOnly ? <span class="admin-badge">synced</span> : null;
}

export function ContentSection(): JSX.Element {
  const flat = PRESENTATION.layout === 'flat';
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>({ name: 'library' });

  const reload = useCallback(() => {
    setError('');
    adminFetch<LibraryResponse>('/content/books')
      .then(setLibrary)
      .catch((e) => setError(errorText(e, 'Could not load the library.')));
  }, []);
  useEffect(reload, [reload]);

  if (error) {
    return (
      <section class="settings-section">
        <h2>{flat ? 'Stories' : 'Books'}</h2>
        <p class="settings-note admin-error">{error}</p>
      </section>
    );
  }
  if (!library) {
    return (
      <section class="settings-section">
        <h2>{flat ? 'Stories' : 'Books'}</h2>
        <p class="settings-note">Loading…</p>
      </section>
    );
  }
  if (!library.storeAvailable) {
    return (
      <section class="settings-section">
        <h2>{flat ? 'Stories' : 'Books'}</h2>
        <p class="settings-note">
          This deployment has no writable content storage bound, so its content can't be edited from here. On Cloudflare that
          means no R2 bucket is declared in <code>wrangler.jsonc</code>; on a Node host it means neither{' '}
          <code>AZURE_STORAGE_CONNECTION_STRING</code> nor <code>STORYLARK_LOCAL_CONTENT</code> is set. Publishing from the CLI
          still works exactly as before.
        </p>
      </section>
    );
  }

  if (view.name === 'chapter') {
    return (
      <ChapterEditor
        bookId={view.bookId}
        chapterId={view.chapterId}
        isNew={view.isNew === true}
        flat={flat}
        onBack={() => {
          reload();
          setView(flat ? { name: 'library' } : { name: 'book', bookId: view.bookId });
        }}
      />
    );
  }

  if (view.name === 'book') {
    const book = library.books.find((b) => b.id === view.bookId);
    if (!book) return <p class="settings-note admin-error">That book is no longer in the library.</p>;
    return (
      <BookView
        book={book}
        contentOrigin={library.contentOrigin}
        onBack={() => {
          reload();
          setView({ name: 'library' });
        }}
        onOpenChapter={(chapterId, isNew) => setView({ name: 'chapter', bookId: book.id, chapterId, isNew })}
        onChanged={reload}
      />
    );
  }

  return (
    <LibraryView
      library={library}
      flat={flat}
      onOpen={(bookId) => {
        const book = library.books.find((b) => b.id === bookId);
        // A flat library's story IS its one chapter, so opening a story opens
        // the editor directly rather than showing a one-item chapter list.
        if (flat && book && book.chapters.length === 1) {
          setView({ name: 'chapter', bookId, chapterId: book.chapters[0].id });
        } else {
          setView({ name: 'book', bookId });
        }
      }}
      onNew={(bookId, chapterId) => setView({ name: 'chapter', bookId, chapterId, isNew: true })}
    />
  );
}

function LibraryView({
  library,
  flat,
  onOpen,
  onNew,
}: {
  library: LibraryResponse;
  flat: boolean;
  onOpen: (bookId: string) => void;
  onNew: (bookId: string, chapterId: string) => void;
}): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState('');

  const noun = flat ? 'story' : 'book';
  return (
    <section class="settings-section">
      <h2>{flat ? 'Stories' : 'Books'}</h2>
      <p class="settings-note">
        {library.books.length} {library.books.length === 1 ? noun : `${noun}s`} · library version {library.libraryVersion}
        {library.announceVersion !== library.libraryVersion ? ` (announced ${library.announceVersion})` : ''} ·{' '}
        {library.revisionLimit} revisions kept per chapter
      </p>
      {library.books.some((b) => b.readOnly) && (
        <p class="settings-note">
          Some of this library is synced from an external source of truth and is read-only here — those rows are marked{' '}
          <span class="admin-badge">synced</span>. Everything else is edited normally. See <code>docs/content-sync.md</code>.
        </p>
      )}

      <ul class="admin-content-list">
        {library.books.map((b) => {
          const stale = b.chapters.some((ch) => ch.audioStale);
          return (
            <li key={b.id}>
              <button class="admin-content-row" onClick={() => onOpen(b.id)}>
                <span class="admin-content-row-main">
                  <strong>{b.title ?? b.id}</strong>
                  <span class="admin-content-row-meta">
                    {b.author ? `${b.author} · ` : ''}
                    {flat ? `${b.chapters[0]?.wordCount ?? 0} words` : `${b.chapterCount} chapter${b.chapterCount === 1 ? '' : 's'}`}
                    {b.cover ? ' · cover' : ''}
                  </span>
                </span>
                <OriginBadge readOnly={b.readOnly} />
                {stale && <span class="admin-badge admin-badge-warn">audio out of date</span>}
              </button>
            </li>
          );
        })}
      </ul>

      {creating ? (
        <form
          class="signin-form"
          onSubmit={(e) => {
            e.preventDefault();
            const id = slug(newId);
            if (id) onNew(id, flat ? 'full' : 'chapter-1');
          }}
        >
          <label class="settings-row">
            <span>{flat ? 'Story id' : 'Book id'}</span>
            <input placeholder="a-short-title" value={newId} onInput={(e) => setNewId((e.target as HTMLInputElement).value)} />
          </label>
          <p class="settings-note">
            Lowercase letters, digits and hyphens. This becomes the {noun}'s address and its folder in storage, so it's worth
            getting right the first time — it isn't renameable from here.
          </p>
          <button class="btn" type="submit" disabled={!slug(newId)}>
            Start writing
          </button>
          <button type="button" class="btn-ghost" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button class="btn" onClick={() => setCreating(true)}>
          New {noun}
        </button>
      )}
    </section>
  );
}

function BookView({
  book,
  contentOrigin,
  onBack,
  onOpenChapter,
  onChanged,
}: {
  book: BookSummary;
  contentOrigin?: string;
  onBack: () => void;
  onOpenChapter: (chapterId: string, isNew?: boolean) => void;
  onChanged: () => void;
}): JSX.Element {
  const [newId, setNewId] = useState('');
  const [message, setMessage] = useState('');
  /**
   * A pending reorder (AB#7412 — plan §3's "add, reorder, delete"). Null means
   * "untouched, showing the library's order".
   *
   * Buttons rather than drag: the rows are already buttons that open a chapter,
   * a drag handle inside one is a reliable way to open a chapter you meant to
   * move, and drag-and-drop has no keyboard or screen-reader story worth having
   * without a great deal more code. Up/Down is the same interaction the Delete
   * control next to it already uses.
   *
   * Held locally and saved explicitly, because a request per click on a
   * fifteen-chapter book is fifteen manifest rewrites to move one chapter to
   * the end.
   */
  const [order, setOrder] = useState<string[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const liveOrder = book.chapters.map((ch) => ch.id);
  const shown = order ? (order.map((id) => book.chapters.find((ch) => ch.id === id)).filter(Boolean) as ChapterSummary[]) : book.chapters;
  const orderDirty = order !== null && order.join(',') !== liveOrder.join(',');

  function move(index: number, by: -1 | 1): void {
    const next = shown.map((ch) => ch.id);
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  async function saveOrder(): Promise<void> {
    if (!order) return;
    setSavingOrder(true);
    setMessage('');
    try {
      await adminFetch(`/content/books/${book.id}/chapter-order`, { method: 'PUT', body: JSON.stringify({ order }) });
      setOrder(null);
      setMessage('Chapter order saved.');
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'Could not save that order.'));
    } finally {
      setSavingOrder(false);
    }
  }

  async function remove(chapterId: string): Promise<void> {
    if (!confirm(`Delete chapter "${chapterId}"? Its source and history stay in storage, but it leaves the library.`)) return;
    try {
      await adminFetch(`/content/books/${book.id}/chapters/${chapterId}`, { method: 'DELETE' });
      setOrder(null); // the list it was a permutation of no longer exists
      setMessage(`Deleted ${chapterId}.`);
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'Could not delete that chapter.'));
    }
  }

  return (
    <section class="settings-section">
      <button class="btn-ghost" onClick={onBack}>
        ← All books
      </button>
      <h2>{book.title ?? book.id}</h2>
      {book.readOnly ? (
        <ManagedExternally source={book.syncSource} what={`"${book.title ?? book.id}"`} />
      ) : (
        <BookDetails book={book} contentOrigin={contentOrigin} onChanged={onChanged} />
      )}

      <h3 class="admin-subhead">Chapters</h3>
      <ul class="admin-content-list">
        {shown.map((ch, i) => (
          <li key={ch.id}>
            <button class="admin-content-row" onClick={() => onOpenChapter(ch.id)}>
              <span class="admin-content-row-main">
                <strong>{ch.title ?? ch.id}</strong>
                <span class="admin-content-row-meta">
                  {ch.wordCount} words{ch.readingTime ? ` · ${ch.readingTime}` : ''}
                  {ch.hasAudio ? ' · narrated' : ' · text only'}
                  {ch.hasSource ? '' : ' · no source'}
                </span>
              </span>
              <OriginBadge readOnly={ch.readOnly} />
              {ch.audioStale && <span class="admin-badge admin-badge-warn">audio out of date</span>}
            </button>
            {/* Reordering a synced book would be undone by the next sync, and
                the whole book moves together, so it is offered only when the
                book itself is ours to change. */}
            {!book.readOnly && shown.length > 1 && (
              <>
                <button
                  class="btn-ghost admin-row-action"
                  aria-label={`Move ${ch.title ?? ch.id} up`}
                  disabled={i === 0 || savingOrder}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  class="btn-ghost admin-row-action"
                  aria-label={`Move ${ch.title ?? ch.id} down`}
                  disabled={i === shown.length - 1 || savingOrder}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </>
            )}
            {/* Deleting a synced chapter would only make it reappear on the next
                sync, so the control isn't offered rather than offered and refused. */}
            {!ch.readOnly && (
              <button class="btn-ghost admin-row-action" disabled={orderDirty} onClick={() => void remove(ch.id)}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>

      {orderDirty && (
        <div class="admin-editor-actions">
          <button class="btn" disabled={savingOrder} onClick={() => void saveOrder()}>
            {savingOrder ? 'Saving order…' : 'Save chapter order'}
          </button>
          <button class="btn-ghost" disabled={savingOrder} onClick={() => setOrder(null)}>
            Cancel
          </button>
          <p class="settings-note">
            Readers see this order as soon as it's saved. The publish pipeline takes chapter order from the numeric prefixes on
            the markdown filenames (<code>02-the-long-dark.md</code>), so rename those to match or the next{' '}
            <code>npm run publish</code> puts the file order back — it will warn you before it does.
          </p>
        </div>
      )}

      {!book.readOnly && (
        <form
          class="signin-form"
          onSubmit={(e) => {
            e.preventDefault();
            const id = slug(newId);
            if (id) onOpenChapter(id, true);
          }}
        >
          <label class="settings-row">
            <span>New chapter id</span>
            <input placeholder="the-long-dark" value={newId} onInput={(e) => setNewId((e.target as HTMLInputElement).value)} />
          </label>
          <button class="btn" type="submit" disabled={!slug(newId)}>
            Add chapter
          </button>
        </form>
      )}
      {message && <p class="settings-note">{message}</p>}
    </section>
  );
}

/** Book-level metadata plus the cover, on the same surface as the chapters. */
function BookDetails({ book, contentOrigin, onChanged }: { book: BookSummary; contentOrigin?: string; onChanged: () => void }): JSX.Element {
  const [title, setTitle] = useState(book.title ?? '');
  const [author, setAuthor] = useState(book.author ?? '');
  const [description, setDescription] = useState(book.description ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function save(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      await adminFetch(`/content/books/${book.id}`, { method: 'PUT', body: JSON.stringify({ title, author, description }) });
      setMessage('Saved.');
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'Could not save those details.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label class="settings-row">
        <span>Title</span>
        <input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </label>
      <label class="settings-row">
        <span>Author</span>
        <input value={author} onInput={(e) => setAuthor((e.target as HTMLInputElement).value)} />
      </label>
      <label class="settings-row">
        <span>Description</span>
        <input value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn" onClick={() => void save()} disabled={busy}>
        {busy ? 'Saving…' : 'Save details'}
      </button>
      <CoverUpload book={book} contentOrigin={contentOrigin} onChanged={onChanged} />
      {message && <p class="settings-note">{message}</p>}
    </>
  );
}

/**
 * The cover / title illustration. For a flat library this is the story's title
 * art, which is why it sits on the work itself rather than inside a chapter.
 */
function CoverUpload({ book, contentOrigin, onChanged }: { book: BookSummary; contentOrigin?: string; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const res = await uploadImage(file, book.id, 'cover');
      setMessage(`Cover updated (${Math.round(res.bytes / 1024)}KB).`);
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'Could not upload that cover.'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div class="admin-cover">
      {book.cover && contentOrigin && (
        <img class="admin-cover-thumb" src={`${contentOrigin.replace(/\/+$/, '')}/${book.cover}`} alt={`Cover of ${book.title ?? book.id}`} />
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        disabled={busy}
        onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) void upload(file);
        }}
      />
      <p class="settings-note">{busy ? 'Uploading…' : message || 'PNG, JPEG, WebP, GIF or AVIF. Replaces the current cover.'}</p>
    </div>
  );
}

async function uploadImage(file: File, bookId: string, kind: 'cover' | 'inline', alt = ''): Promise<{ url: string; markdown?: string; bytes: number }> {
  const form = new FormData();
  form.set('file', file);
  form.set('bookId', bookId);
  form.set('kind', kind);
  if (alt) form.set('alt', alt);
  // Not through call(): that sets a JSON content type, and a multipart body
  // must be allowed to set its own boundary. The CSRF header still rides along.
  const res = await fetch('/api/admin/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'storylark' },
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''));
  return res.json() as Promise<{ url: string; markdown?: string; bytes: number }>;
}

function ChapterEditor({
  bookId,
  chapterId,
  isNew,
  flat,
  onBack,
}: {
  bookId: string;
  chapterId: string;
  isNew: boolean;
  flat: boolean;
  onBack: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<ChapterDetail | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [dirty, setDirty] = useState(false);
  /** Defaults per plan §3: an edit to existing content is a correction unless
   *  told otherwise; genuinely new content is not. */
  const [correction, setCorrection] = useState(!isNew);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  /**
   * A refused save (AB#7412 — plan §3's conflict detection). Set when the
   * server answers 409 `stale_edit`: the chapter moved on after this editor
   * opened it, so saving would discard someone else's newer text — another tab,
   * or a `publish.mjs` run that landed while this one was being typed.
   *
   * Nothing is thrown away when this happens: the draft stays in the textarea,
   * so it can still be downloaded, copied out, or forced through.
   */
  const [conflict, setConflict] = useState<{ message: string; liveContentHash?: string } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mdInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (isNew) {
      const starter = `---\ntitle: ${chapterId.replace(/-/g, ' ')}\nlabel: ${flat ? 'Read' : 'Chapter'}\n---\n\n`;
      setMarkdown(starter);
      setDetail(null);
      setRevisions([]);
      return;
    }
    adminFetch<ChapterDetail>(`/content/books/${bookId}/chapters/${chapterId}`)
      .then((d) => {
        setDetail(d);
        setMarkdown(d.markdown);
        setRevisions(d.revisions);
        setDirty(false);
      })
      .catch((e) => setError(errorText(e, 'Could not open that chapter.')));
  }, [bookId, chapterId, isNew, flat]);
  useEffect(load, [load]);

  // Debounced live preview. Parsed by the server with the same code that
  // publishes, so what is on screen is what will land — not a second markdown
  // implementation's opinion of it.
  useEffect(() => {
    if (!showPreview || !markdown) return;
    const t = setTimeout(() => {
      adminFetch<PreviewResponse>('/content/preview', { method: 'POST', body: JSON.stringify({ markdown }) })
        .then(setPreview)
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [markdown, showPreview]);

  async function save(force = false): Promise<void> {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const res = await adminFetch<SaveResponse>(`/content/books/${bookId}/chapters/${chapterId}`, {
        method: 'PUT',
        body: JSON.stringify({
          markdown,
          correction,
          // The version this editor opened. The server refuses if the live
          // chapter has moved past it — which is the only way a portal edit and
          // a CLI publish racing each other can be noticed at all, since the
          // manifest afterwards records only the winner.
          baseContentHash: detail?.contentHash,
          ...(force ? { force: true } : {}),
        }),
      });
      setConflict(null);
      setDirty(false);
      setMessage(
        [
          res.created ? 'Published.' : 'Saved.',
          `${res.wordCount} words, ${res.readingTime}.`,
          res.correction
            ? 'Filed as a correction — readers get the new text, nobody was notified.'
            : `Announced as new content${res.notified.subscriptions > 0 ? ` to ${res.notified.subscriptions} subscriber${res.notified.subscriptions === 1 ? '' : 's'}` : ' (no push subscribers yet)'}.`,
          res.audioStale ? 'The narration no longer matches the words — re-run the publish pipeline to bring the audio back in line.' : '',
        ]
          .filter(Boolean)
          .join(' ')
      );
      const fresh = await adminFetch<ChapterDetail>(`/content/books/${bookId}/chapters/${chapterId}`);
      setDetail(fresh);
      setRevisions(fresh.revisions);
    } catch (e) {
      if (e instanceof ApiError && e.slug === 'stale_edit') {
        setConflict({ message: e.detail || 'This chapter changed after you opened it.' });
      } else {
        setError(errorText(e, 'Could not save that chapter.'));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Throw the draft away and take what is actually live. */
  async function reloadLive(): Promise<void> {
    setBusy(true);
    try {
      const fresh = await adminFetch<ChapterDetail>(`/content/books/${bookId}/chapters/${chapterId}`);
      setDetail(fresh);
      setMarkdown(fresh.markdown);
      setRevisions(fresh.revisions);
      setConflict(null);
      setDirty(false);
      setMessage('Loaded the live version. Your draft is gone from the editor — the history has every saved version.');
    } catch (e) {
      setError(errorText(e, 'Could not reload that chapter.'));
    } finally {
      setBusy(false);
    }
  }

  async function revert(revisionId: string): Promise<void> {
    if (!confirm('Put this revision back as the live text? The current text is kept in the history, so this is undoable.')) return;
    setBusy(true);
    setMessage('');
    try {
      await adminFetch<SaveResponse>(`/content/books/${bookId}/chapters/${chapterId}/revisions/${revisionId}/revert`, {
        method: 'POST',
        body: JSON.stringify({ correction: true }),
      });
      const fresh = await adminFetch<ChapterDetail>(`/content/books/${bookId}/chapters/${chapterId}`);
      setDetail(fresh);
      setMarkdown(fresh.markdown);
      setRevisions(fresh.revisions);
      setDirty(false);
      setMessage(
        fresh.hasAudio
          ? 'Reverted. The text is live now; the narration still matches the version just replaced, so it is marked out of date until the pipeline re-runs.'
          : 'Reverted. The text is live now.'
      );
    } catch (e) {
      setError(errorText(e, 'Could not revert to that revision.'));
    } finally {
      setBusy(false);
    }
  }

  function insertAtCursor(text: string): void {
    const el = textarea.current;
    if (!el) {
      setMarkdown((m) => `${m}\n\n${text}\n`);
      setDirty(true);
      return;
    }
    const start = el.selectionStart ?? markdown.length;
    const end = el.selectionEnd ?? markdown.length;
    const next = `${markdown.slice(0, start)}\n\n${text}\n\n${markdown.slice(end)}`;
    setMarkdown(next);
    setDirty(true);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + text.length + 4;
      el.setSelectionRange(caret, caret);
    });
  }

  async function insertImage(file: File): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const alt = prompt('Describe the image for readers who can\'t see it (this becomes its alt text):') ?? '';
      const res = await uploadImage(file, bookId, 'inline', alt);
      // The author never types a URL: the endpoint hands back the exact
      // markdown, and it goes in at the cursor.
      insertAtCursor(res.markdown ?? `![${alt}](${res.url})`);
      setMessage(`Image uploaded (${Math.round(res.bytes / 1024)}KB) and inserted.`);
    } catch (e) {
      setError(errorText(e, 'Could not upload that image.'));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function download(): void {
    // Straight off the current editor contents, so what downloads is what is on
    // screen even with unsaved changes — the escape hatch has to work when the
    // browser textarea turned out to be the wrong tool for the job in hand.
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${chapterId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const problem = preview?.problem ?? null;
  /** Synced content opens as a reader, not an editor (AB#7422). Everything that
   *  writes is withheld; everything that reads — the text, the preview, the
   *  download, the history — stays, because seeing your whole library in one
   *  place is the point and only the edit button is somebody else's. */
  const readOnly = detail?.readOnly === true;

  return (
    <section class="settings-section">
      <button class="btn-ghost" onClick={onBack}>
        ← {flat ? 'All stories' : 'Back to book'}
      </button>
      <h2>
        {detail?.title ?? chapterId}
        {readOnly && <span class="admin-badge">synced</span>}
        {dirty && !readOnly && <span class="admin-badge">unsaved</span>}
      </h2>
      <p class="settings-note">
        <code>
          {bookId}/{chapterId}
        </code>
        {detail ? ` · ${detail.wordCount} words${detail.readingTime ? ` · ${detail.readingTime}` : ''}` : ' · new'}
        {detail?.hasAudio ? ' · narrated' : ''}
      </p>

      {readOnly && <ManagedExternally source={detail?.syncSource} what="This chapter" />}
      {detail?.audioStale && (
        <p class="settings-note admin-notice">
          <strong>Audio out of date.</strong> The words changed and the narration didn't. Text is live for readers now; run the
          publish pipeline (<code>npm run publish -- --pull</code>) to re-narrate. This deployment can't generate speech itself.
        </p>
      )}
      {detail?.reconstructed && (
        <p class="settings-note admin-notice">
          This chapter was published before source markdown was stored, so what's below was rebuilt from the published text. It
          reads correctly but it isn't byte-for-byte the file you wrote — line wrapping and any front matter beyond the title are
          gone. Saving adopts this as the new source of truth.
        </p>
      )}

      <div class="admin-editor-actions">
        <button class="btn-ghost" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? 'Hide preview' : 'Show preview'}
        </button>
        <button class="btn-ghost" onClick={download}>
          Download .md
        </button>
        {!readOnly && (
          <>
            <button class="btn-ghost" onClick={() => mdInput.current?.click()}>
              Upload .md
            </button>
            <button class="btn-ghost" onClick={() => fileInput.current?.click()} disabled={busy}>
              Insert image
            </button>
          </>
        )}
      </div>
      <input
        ref={mdInput}
        type="file"
        accept=".md,text/markdown,text/plain"
        class="admin-hidden-input"
        onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;
          void file.text().then((t) => {
            setMarkdown(t);
            setDirty(true);
          });
          (e.target as HTMLInputElement).value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        class="admin-hidden-input"
        onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) void insertImage(file);
        }}
      />

      <div class={showPreview ? 'admin-editor admin-editor-split' : 'admin-editor'}>
        <textarea
          ref={textarea}
          class="admin-markdown-input admin-editor-pane"
          rows={24}
          spellcheck
          readOnly={readOnly}
          value={markdown}
          onInput={(e) => {
            setMarkdown((e.target as HTMLTextAreaElement).value);
            setDirty(true);
          }}
        />
        {showPreview && (
          <div class="admin-editor-pane admin-preview">
            {preview ? (
              preview.blocks.map((b, i) => <BlockRenderer key={b.id} block={b} first={i === 0} />)
            ) : (
              <p class="settings-note">Preview…</p>
            )}
          </div>
        )}
      </div>

      {problem && !readOnly && <p class="settings-note admin-error">{problem}</p>}

      {readOnly ? (
        <p class="settings-note">
          Read-only. To change these words, change them where they live and run the sync again — the next sync republishes this
          chapter, narration and all.
        </p>
      ) : (
        <>
      <label class="settings-row admin-correction">
        <span>
          This is a correction
          <span class="admin-correction-hint">
            Readers get the new text either way. Ticked, nobody is notified — untick it only when this is genuinely new writing
            worth waking a phone for.
          </span>
        </span>
        <input type="checkbox" checked={correction} onChange={(e) => setCorrection((e.target as HTMLInputElement).checked)} />
      </label>

      {conflict && (
        <div class="settings-note admin-notice">
          <p>
            <strong>Not saved — this chapter changed while you were editing.</strong> {conflict.message}
          </p>
          <div class="admin-editor-actions">
            <button class="btn-ghost" onClick={download}>
              Download my draft
            </button>
            <button class="btn-ghost" disabled={busy} onClick={() => void reloadLive()}>
              Discard mine, load the live version
            </button>
            <button class="btn-ghost" disabled={busy} onClick={() => void save(true)}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}

      <button class="btn" onClick={() => void save()} disabled={busy || !markdown || problem !== null}>
        {busy ? 'Saving…' : correction ? 'Save correction' : 'Publish'}
      </button>
        </>
      )}
      {message && <p class="settings-note">{message}</p>}
      {error && <p class="settings-note admin-error">{error}</p>}

      <RevisionList
        revisions={revisions}
        limit={detail?.revisionLimit ?? 5}
        busy={busy}
        readOnly={readOnly}
        onRevert={(id) => void revert(id)}
        onLoad={async (id) => {
          const res = await adminFetch<{ markdown: string }>(`/content/books/${bookId}/chapters/${chapterId}/revisions/${id}`);
          setMarkdown(res.markdown);
          setDirty(true);
          setMessage('Loaded into the editor — nothing is live until you save.');
        }}
      />
    </section>
  );
}

function RevisionList({
  revisions,
  limit,
  busy,
  readOnly,
  onRevert,
  onLoad,
}: {
  revisions: Revision[];
  limit: number;
  busy: boolean;
  /** Synced content: the history is still worth seeing (a sync that pulled the
   *  wrong thing is exactly when you want it), but reverting to an older copy
   *  would diverge from the source, so only "Open" is offered. */
  readOnly: boolean;
  onRevert: (id: string) => void;
  onLoad: (id: string) => Promise<void>;
}): JSX.Element {
  return (
    <>
      <h3 class="admin-subhead">History</h3>
      {revisions.length === 0 ? (
        <p class="settings-note">No revisions yet — the first save starts the history.</p>
      ) : (
        <>
          <p class="settings-note">
            The last {limit} versions of the text are kept; the live one is never dropped. Audio isn't versioned — it's always
            regenerable from the words.
          </p>
          <ul class="admin-content-list">
            {revisions.map((r) => (
              <li key={r.id}>
                <span class="admin-content-row-main">
                  <strong>{new Date(r.savedAt).toLocaleString()}</strong>
                  <span class="admin-content-row-meta">
                    {r.savedBy} · {Math.max(1, Math.round(r.bytes / 1024))}KB
                    {r.correction ? ' · correction' : ''}
                    {r.revertedFrom ? ' · a revert' : ''}
                  </span>
                </span>
                {r.live ? (
                  <span class="admin-badge">live</span>
                ) : (
                  <>
                    <button class="btn-ghost admin-row-action" disabled={busy} onClick={() => void onLoad(r.id)}>
                      Open
                    </button>
                    {!readOnly && (
                      <button class="btn-ghost admin-row-action" disabled={busy} onClick={() => onRevert(r.id)}>
                        Revert
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** The id rule the API enforces, applied while typing so it can't be a surprise. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
