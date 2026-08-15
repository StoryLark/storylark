import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { BRAND } from '../brand';

// Admin portal (AB#7404). Deliberately separate from the reader-facing
// session/cookie auth in lib/api.ts — this is the operator's surface, gated
// by the x-admin-key header the worker's /api/admin/* routes already check.
// The key lives in localStorage on the operator's own device only; it is
// never sent anywhere except this site's own /api/admin/* endpoints.

const KEY_STORAGE = 'storylark-admin-key';

async function adminFetch<T>(path: string, adminKey: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body;
}

interface StatusResponse {
  brand: string;
  appName: string;
  engineVersion: string;
  bookCount: number | null;
  chapterCount: number | null;
  pushSubscriptions: number | null;
}

interface UpdateStatusResponse {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseNotesUrl: string;
  selfUpdateConfigured: boolean;
}

export function Admin(): JSX.Element {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '');
  const [keyInput, setKeyInput] = useState('');

  if (!adminKey) {
    return (
      <div class="screen admin-screen">
        <header class="screen-header">
          <h1 class="screen-title">Admin — {BRAND.appName}</h1>
        </header>
        <section class="settings-section">
          <p class="settings-note">Enter this deployment's admin key to continue. Set with the ADMIN_KEY secret.</p>
          <label class="settings-row">
            <span>Admin key</span>
            <input type="password" value={keyInput} onInput={(e) => setKeyInput((e.target as HTMLInputElement).value)} />
          </label>
          <button
            class="btn"
            onClick={() => {
              localStorage.setItem(KEY_STORAGE, keyInput);
              setAdminKey(keyInput);
            }}
          >
            Continue
          </button>
        </section>
      </div>
    );
  }

  return <AdminDashboard adminKey={adminKey} onSignOut={() => { localStorage.removeItem(KEY_STORAGE); setAdminKey(''); }} />;
}

function AdminDashboard({ adminKey, onSignOut }: { adminKey: string; onSignOut: () => void }): JSX.Element {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusResponse | null>(null);
  const [error, setError] = useState('');

  const refresh = () => {
    setError('');
    adminFetch<StatusResponse>('/status', adminKey).then(setStatus).catch((e) => setError(String(e.message ?? e)));
    adminFetch<UpdateStatusResponse>('/update-status', adminKey).then(setUpdateStatus).catch((e) => setError(String(e.message ?? e)));
  };
  useEffect(refresh, [adminKey]);

  return (
    <div class="screen admin-screen">
      <header class="screen-header">
        <h1 class="screen-title">Admin — {status?.appName ?? BRAND.appName}</h1>
        <button class="btn-ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {error && <p class="settings-note admin-error">{error}</p>}

      <StatusSection status={status} />
      <UpdateSection adminKey={adminKey} updateStatus={updateStatus} onChanged={refresh} />
      <PublishSection adminKey={adminKey} onPublished={refresh} />
    </div>
  );
}

function StatusSection({ status }: { status: StatusResponse | null }): JSX.Element {
  return (
    <section class="settings-section">
      <h2>Status</h2>
      {!status ? (
        <p class="settings-note">Loading…</p>
      ) : (
        <ul class="admin-status-list">
          <li>Brand: {status.brand}</li>
          <li>Engine version: {status.engineVersion}</li>
          <li>Books: {status.bookCount ?? '—'}</li>
          <li>Chapters: {status.chapterCount ?? '—'}</li>
          <li>Push subscribers: {status.pushSubscriptions ?? '—'}</li>
        </ul>
      )}
    </section>
  );
}

function UpdateSection({
  adminKey,
  updateStatus,
  onChanged,
}: {
  adminKey: string;
  updateStatus: UpdateStatusResponse | null;
  onChanged: () => void;
}): JSX.Element {
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState('');

  async function install() {
    setInstalling(true);
    setMessage('');
    try {
      const res = await adminFetch<{ message: string }>('/update-install', adminKey, { method: 'POST' });
      setMessage(res.message);
      onChanged();
    } catch (e) {
      setMessage(String((e as Error).message ?? e));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <section class="settings-section">
      <h2>Platform update</h2>
      {!updateStatus ? (
        <p class="settings-note">Loading…</p>
      ) : (
        <>
          <p class="settings-note">
            Running <strong>{updateStatus.current}</strong>
            {updateStatus.hasUpdate ? (
              <>
                {' '}
                — <strong>{updateStatus.latest}</strong> is available.{' '}
                <a href={updateStatus.releaseNotesUrl} target="_blank" rel="noreferrer">
                  Release notes
                </a>
              </>
            ) : (
              ' — up to date.'
            )}
          </p>
          {updateStatus.hasUpdate && !updateStatus.selfUpdateConfigured && (
            <p class="settings-note">
              Self-update isn't configured on this deployment yet — set the GITHUB_REPO and GITHUB_DEPLOY_TOKEN secrets to enable
              the Install button. See docs/updating.md.
            </p>
          )}
          {updateStatus.hasUpdate && updateStatus.selfUpdateConfigured && (
            <button class="btn" onClick={install} disabled={installing}>
              {installing ? 'Starting…' : 'Install update'}
            </button>
          )}
          {message && <p class="settings-note">{message}</p>}
        </>
      )}
    </section>
  );
}

function PublishSection({ adminKey, onPublished }: { adminKey: string; onPublished: () => void }): JSX.Element {
  const [bookId, setBookId] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState('');

  async function publish() {
    setPublishing(true);
    setMessage('');
    try {
      const res = await adminFetch<{ message: string }>('/publish-story', adminKey, {
        method: 'POST',
        body: JSON.stringify({ bookId, title, author, markdown }),
      });
      setMessage(res.message);
      setBookId('');
      setTitle('');
      setAuthor('');
      setMarkdown('');
      onPublished();
    } catch (e) {
      setMessage(String((e as Error).message ?? e));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section class="settings-section">
      <h2>Publish a story</h2>
      <p class="settings-note">
        Text publishes immediately. Narration depends on whether this deployment has TTS credentials configured — check the
        message after publishing.
      </p>
      <label class="settings-row">
        <span>Book id</span>
        <input placeholder="my-story" value={bookId} onInput={(e) => setBookId((e.target as HTMLInputElement).value)} />
      </label>
      <label class="settings-row">
        <span>Title</span>
        <input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </label>
      <label class="settings-row">
        <span>Author</span>
        <input value={author} onInput={(e) => setAuthor((e.target as HTMLInputElement).value)} />
      </label>
      <textarea
        class="admin-markdown-input"
        placeholder="Once upon a time..."
        rows={10}
        value={markdown}
        onInput={(e) => setMarkdown((e.target as HTMLTextAreaElement).value)}
      />
      <button class="btn" onClick={publish} disabled={publishing || !bookId || !title || !markdown}>
        {publishing ? 'Publishing…' : 'Publish'}
      </button>
      {message && <p class="settings-note">{message}</p>}
    </section>
  );
}
