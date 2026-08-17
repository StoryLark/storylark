/**
 * Connections — where this deployment's content comes from (content-management
 * rework wave 2, AB#7420 — design §4, §6, §7).
 *
 * Three surfaces in one card, because they are one subject:
 *
 *   1. The content source — the explicit three-way choice (§4). A PRIMARY
 *      source, never a lock: per-item `origin` still governs every edit
 *      button, and switching mode never rewrites existing content.
 *   2. The repo connection (§6): provider / URL / visibility / branch / path /
 *      credential / interval, the dry-run gate, the webhook, Sync now, and the
 *      sync report — including §10.1's missing list with its one human click.
 *   3. Scoped content-API tokens (§7): named, revocable, last-used visible —
 *      so a third-party CMS is never handed ADMIN_KEY.
 *
 * Platform differences do not appear here, deliberately: both platforms run
 * the same sync on the same daily schedule through the same seams, so there is
 * nothing platform-shaped to say.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { call, ApiError } from '../../lib/api';

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

type Mode = 'portal' | 'repo' | 'api';

interface RepoConnection {
  provider: string;
  url: string;
  visibility: 'public' | 'private';
  branch: string;
  path: string;
  intervalHours: number;
}

interface SyncError {
  code: string;
  message: string;
  file?: string;
  line?: number;
}

interface SyncReport {
  ok: boolean;
  dryRun: boolean;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  ignored: number;
  candidates: number;
  books: number;
  chaptersWritten: number;
  chaptersUnchanged: number;
  chaptersWithheld: number;
  imagesIngested: number;
  errors: SyncError[];
  imageProblems: { file: string; reference: string; reason: string }[];
  missing: { bookId: string; chapterId: string; title?: string }[];
  failure?: string;
}

interface SourceState {
  available: boolean;
  message?: string;
  mode?: Mode;
  repo?: RepoConnection | null;
  providers?: { id: string; label: string }[];
  credential?: 'platform-secret' | 'stored' | null;
  webhook?: { configured: boolean; url: string };
  sync?: {
    running: boolean;
    lastSyncAt: number | null;
    lastReport: SyncReport | null;
    schedule: { cron: string; intervalHours: number } | null;
  };
}

interface TokenRow {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string | null;
  lastUsedAt: number | null;
  revoked: boolean;
}

export function ConnectionsSection(): JSX.Element {
  const [state, setState] = useState<SourceState | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    adminFetch<SourceState>('/content-source')
      .then(setState)
      .catch((e) => setError(errorText(e, 'Could not load the content-source settings.')));
  }, []);
  useEffect(reload, [reload]);

  if (error) {
    return (
      <section class="settings-section">
        <h2>Connections</h2>
        <p class="settings-note admin-error">{error}</p>
      </section>
    );
  }
  if (!state) {
    return (
      <section class="settings-section">
        <h2>Connections</h2>
        <p class="settings-note">Loading…</p>
      </section>
    );
  }
  if (!state.available) {
    return (
      <section class="settings-section">
        <h2>Connections</h2>
        <p class="settings-note">{state.message}</p>
      </section>
    );
  }

  return (
    <section class="settings-section">
      <h2>Connections</h2>
      <ModePicker state={state} onChanged={reload} />
      {state.mode === 'repo' && <RepoPanel state={state} onChanged={reload} />}
      {state.mode === 'api' && (
        <p class="settings-note">
          Content is pushed in by your own system over the content API (<code>/api/content/v1</code> — see{' '}
          <code>docs/content-api.md</code>). Pushed books are read-only here: whoever owns the content owns the edit button.
          Issue that system a scoped token below — never the admin key.
        </p>
      )}
      <TokensPanel />
    </section>
  );
}

const MODE_COPY: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'portal', label: 'Portal', hint: 'Write and edit here. This deployment is the source of truth.' },
  { mode: 'repo', label: 'Repo', hint: 'A git repository is the source of truth; the portal reads, the repo writes.' },
  { mode: 'api', label: 'CMS / API', hint: 'Your own system pushes over the content API when its editors publish.' },
];

function ModePicker({ state, onChanged }: { state: SourceState; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function setMode(mode: Mode): Promise<void> {
    if (mode === state.mode || busy) return;
    if (mode === 'repo' && !state.repo) {
      // Repo mode needs a connection; the form below saves both together.
      setMessage('Fill in the repository connection below — saving it switches the source to repo.');
      onChangedLocal(mode);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      await adminFetch('/content-source', { method: 'PUT', body: JSON.stringify({ mode }) });
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'Could not change the content source.'));
    } finally {
      setBusy(false);
    }
  }

  // Local optimistic switch so the repo form appears before it is saved.
  const [localMode, setLocalMode] = useState<Mode | null>(null);
  function onChangedLocal(mode: Mode): void {
    setLocalMode(mode);
  }
  const active = localMode ?? state.mode;
  useEffect(() => {
    if (localMode && state.mode === localMode) setLocalMode(null);
  }, [localMode, state.mode]);

  return (
    <>
      <p class="settings-note">
        Where content comes from. This sets what the create buttons do — it is a primary source, not a lock: every book and
        chapter keeps its own origin, and anything written here stays editable here whatever the mode.
      </p>
      <div class="admin-editor-actions" role="radiogroup" aria-label="Content source">
        {MODE_COPY.map((m) => (
          <button
            key={m.mode}
            class={active === m.mode ? 'btn' : 'btn-ghost'}
            aria-pressed={active === m.mode}
            disabled={busy}
            onClick={() => (m.mode === 'repo' && !state.repo ? onChangedLocal('repo') : void setMode(m.mode))}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p class="settings-note">{MODE_COPY.find((m) => m.mode === active)?.hint}</p>
      {active === 'repo' && state.mode !== 'repo' && <RepoPanel state={state} onChanged={onChanged} />}
      {message && <p class="settings-note admin-notice">{message}</p>}
    </>
  );
}

function RepoPanel({ state, onChanged }: { state: SourceState; onChanged: () => void }): JSX.Element {
  const repo = state.repo ?? null;
  const [provider, setProvider] = useState(repo?.provider ?? 'github');
  const [url, setUrl] = useState(repo?.url ?? '');
  const [visibility, setVisibility] = useState<'public' | 'private'>(repo?.visibility ?? 'public');
  const [branch, setBranch] = useState(repo?.branch ?? 'main');
  const [path, setPath] = useState(repo?.path ?? '');
  const [intervalHours, setIntervalHours] = useState(repo?.intervalHours ?? 24);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [report, setReport] = useState<SyncReport | null>(state.sync?.lastReport ?? null);
  const [webhookSecret, setWebhookSecret] = useState<{ secret: string; url: string; message: string } | null>(null);

  const connection = { provider, url: url.trim(), visibility, branch: branch.trim() || 'main', path: path.trim(), intervalHours };

  async function save(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const res = await adminFetch<{ ok: boolean; report: SyncReport }>('/content-source', {
        method: 'PUT',
        body: JSON.stringify({ mode: 'repo', repo: connection, ...(token ? { token } : {}) }),
      });
      setReport(res.report);
      setToken('');
      setMessage('Connected. The dry-run validated the repository; press "Sync now" to pull it in.');
      onChanged();
    } catch (e) {
      if (e instanceof ApiError) {
        try {
          const body = JSON.parse((e as ApiError & { message: string }).message.replace(/^API \d+: /, '')) as { report?: SyncReport };
          if (body.report) setReport(body.report);
        } catch {
          /* no report attached */
        }
      }
      setMessage(errorText(e, 'Could not connect that repository.'));
    } finally {
      setBusy(false);
    }
  }

  async function dryRun(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const res = await adminFetch<{ ok: boolean; report: SyncReport }>('/content-source/dry-run', {
        method: 'POST',
        body: JSON.stringify({ repo: connection, ...(token ? { token } : {}) }),
      });
      setReport(res.report);
      setMessage(res.ok ? 'The repository validates. Nothing was written — this was a dry run.' : 'The dry run found problems; each names its file below.');
    } catch (e) {
      setMessage(errorText(e, 'The dry run failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const res = await adminFetch<{ ok: boolean; attached?: boolean; message?: string; report?: SyncReport }>('/content-source/sync', {
        method: 'POST',
      });
      if (res.attached) {
        setMessage(res.message ?? 'A sync is already running — attached to it.');
      } else if (res.report) {
        setReport(res.report);
        setMessage(res.ok ? 'Synced.' : 'The sync finished with problems — see the report.');
      }
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'The sync failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function mintWebhookSecret(): Promise<void> {
    setBusy(true);
    try {
      setWebhookSecret(await adminFetch('/content-source/webhook-secret', { method: 'POST' }));
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'Could not generate a webhook secret.'));
    } finally {
      setBusy(false);
    }
  }

  const saved = state.mode === 'repo' && !!state.repo;

  return (
    <>
      <h3 class="admin-subhead">Repository connection</h3>
      <form
        class="signin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label class="settings-row">
          <span>Provider</span>
          <select value={provider} onChange={(e) => setProvider((e.target as HTMLSelectElement).value)}>
            {(state.providers ?? [{ id: 'github', label: 'GitHub' }]).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label class="settings-row">
          <span>Repository URL</span>
          <input placeholder="https://github.com/owner/repo" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        </label>
        <label class="settings-row">
          <span>Visibility</span>
          <select value={visibility} onChange={(e) => setVisibility((e.target as HTMLSelectElement).value as 'public' | 'private')}>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
        <label class="settings-row">
          <span>Branch</span>
          <input placeholder="main" value={branch} onInput={(e) => setBranch((e.target as HTMLInputElement).value)} />
        </label>
        <label class="settings-row">
          <span>Path within the repo</span>
          <input placeholder="content/ (empty = repository root)" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
        </label>
        <label class="settings-row">
          <span>Pull interval (hours)</span>
          <input
            type="number"
            min={1}
            max={720}
            value={intervalHours}
            onInput={(e) => setIntervalHours(Number((e.target as HTMLInputElement).value) || 24)}
          />
        </label>
        <label class="settings-row">
          <span>Read token</span>
          <input
            type="password"
            placeholder={state.credential ? '•••••• (configured — leave empty to keep it)' : visibility === 'private' ? 'required for a private repo' : 'recommended even for public'}
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            autocomplete="off"
          />
        </label>
        <p class="settings-note">
          HTTPS with a read-only token is the only supported transport — <strong>SSH is not an option here</strong>: this
          deployment has no ssh client and no safe place for a private key, so if your repo access is SSH-only, create a
          read-only token instead (GitHub: a fine-grained PAT with <em>Contents: Read</em> on just this repo). A public repo
          works without one, but a token is still recommended: unauthenticated GitHub requests are rate-limited per source IP,
          and this deployment shares its outbound IPs with strangers.
          {state.credential === 'platform-secret' && ' A token is configured as the CONTENT_SYNC_TOKEN platform secret and will be used.'}
        </p>
        <div class="admin-editor-actions">
          <button class="btn" type="submit" disabled={busy || !url.trim()}>
            {busy ? 'Working…' : saved ? 'Save and re-validate' : 'Validate and connect'}
          </button>
          <button class="btn-ghost" type="button" disabled={busy || !url.trim()} onClick={() => void dryRun()}>
            Dry run
          </button>
          {saved && (
            <button class="btn-ghost" type="button" disabled={busy} onClick={() => void syncNow()}>
              Sync now
            </button>
          )}
        </div>
        <p class="settings-note">
          Connecting validates the whole repository first — a repo that does not validate cannot be connected, and every
          failure names its file and line. Text syncs into the library immediately;{' '}
          <strong>audio does not sync itself</strong> — narration is produced by the worker you already run for publishing
          (<code>node packages/pipeline/narrate.mjs</code>), which drains the queue this sync fills.
        </p>
      </form>

      {saved && state.sync && (
        <>
          <h3 class="admin-subhead">Sync status</h3>
          <p class="settings-note">
            {state.sync.running ? 'A sync is running now. ' : ''}
            {state.sync.lastSyncAt ? `Last sync: ${new Date(state.sync.lastSyncAt).toLocaleString()}. ` : 'Never synced yet. '}
            {state.sync.schedule
              ? `Scheduled pull: daily (13:00 UTC, the deployment's existing schedule), honouring the ${state.sync.schedule.intervalHours}h interval. `
              : ''}
            A push webhook makes changes appear within seconds; the daily pull is the safety net that catches anything the
            webhook missed; Sync now is for right now.
          </p>

          <h3 class="admin-subhead">Push webhook</h3>
          {webhookSecret ? (
            <div class="settings-note admin-notice">
              <p>
                <strong>Copy these now — the secret is shown only once.</strong>
              </p>
              <p>
                Payload URL: <code>{webhookSecret.url}</code>
                <br />
                Secret: <code>{webhookSecret.secret}</code>
              </p>
              <p>{webhookSecret.message}</p>
            </div>
          ) : (
            <p class="settings-note">
              {state.webhook?.configured
                ? 'Configured. Pushes to the connected branch sync within seconds. Generating a new secret invalidates the old one.'
                : 'Not configured. Generate a signing secret and paste it, with the payload URL, into the repository’s webhook settings; unsigned or mis-signed deliveries are rejected.'}
            </p>
          )}
          <div class="admin-editor-actions">
            <button class="btn-ghost" disabled={busy} onClick={() => void mintWebhookSecret()}>
              {state.webhook?.configured ? 'Rotate webhook secret' : 'Generate webhook secret'}
            </button>
          </div>
        </>
      )}

      {report && <SyncReportView report={report} onChanged={onChanged} onReport={setReport} />}
      {message && <p class="settings-note">{message}</p>}
    </>
  );
}

function SyncReportView({
  report,
  onChanged,
  onReport,
}: {
  report: SyncReport;
  onChanged: () => void;
  onReport: (r: SyncReport) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function removeMissing(): Promise<void> {
    if (!confirm(`Remove ${report.missing.length} chapter(s) from the library? Their source and history stay in storage; readers stop seeing them.`)) return;
    setBusy(true);
    setMessage('');
    try {
      await adminFetch('/content-source/remove-missing', { method: 'POST', body: JSON.stringify({ chapters: report.missing }) });
      onReport({ ...report, missing: [] });
      setMessage('Removed. A re-sync of the repository would bring them back if the files return.');
      onChanged();
    } catch (e) {
      setMessage(errorText(e, 'Could not remove those chapters.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 class="admin-subhead">{report.dryRun ? 'Dry-run report' : 'Sync report'}</h3>
      <p class="settings-note">
        {new Date(report.finishedAt).toLocaleString()} · {report.trigger} · {report.books} book(s), {report.chaptersWritten}{' '}
        written, {report.chaptersUnchanged} unchanged
        {report.chaptersWithheld > 0 ? `, ${report.chaptersWithheld} withheld (publish: false)` : ''}
        {report.imagesIngested > 0 ? `, ${report.imagesIngested} image(s) ingested` : ''} · {report.ignored} file(s) without a{' '}
        <code>storylark:</code> block ignored
      </p>
      {report.failure && <p class="settings-note admin-error">{report.failure}</p>}
      {report.errors.length > 0 && (
        <div class="settings-note admin-error">
          <p>
            <strong>
              {report.errors.length} file(s) were skipped and reported — the rest of the sync proceeded.
            </strong>
          </p>
          <ul>
            {report.errors.map((e, i) => (
              <li key={`${e.code}-${i}`}>
                {e.file ? <code>{e.file}</code> : null}
                {e.line ? ` (line ${e.line})` : ''}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.imageProblems.length > 0 && (
        <div class="settings-note admin-notice">
          <ul>
            {report.imageProblems.map((p, i) => (
              <li key={i}>
                <code>{p.file}</code> → <code>{p.reference}</code>: {p.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.missing.length > 0 && (
        <div class="settings-note admin-notice">
          <p>
            <strong>
              {report.missing.length} published chapter(s) were not in this sync.
            </strong>{' '}
            A missing file is not treated as a deletion — it could be a rename, a branch switch or a fetch hiccup — so nothing
            was unpublished. If the removal is intentional, remove them here; the delete is the ordinary recoverable one.
          </p>
          <ul>
            {report.missing.map((m) => (
              <li key={`${m.bookId}/${m.chapterId}`}>
                <code>
                  {m.bookId}/{m.chapterId}
                </code>
                {m.title ? ` — ${m.title}` : ''}
              </li>
            ))}
          </ul>
          <button class="btn" disabled={busy} onClick={() => void removeMissing()}>
            {busy ? 'Removing…' : `Remove these ${report.missing.length} chapter(s)`}
          </button>
        </div>
      )}
      {message && <p class="settings-note">{message}</p>}
    </>
  );
}

function TokensPanel(): JSX.Element {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<{ name: string; token: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reload = useCallback(() => {
    adminFetch<{ available: boolean; tokens: TokenRow[] }>('/content-tokens')
      .then((res) => {
        setAvailable(res.available);
        setTokens(res.tokens);
      })
      .catch(() => setTokens([]));
  }, []);
  useEffect(reload, [reload]);

  async function mint(e: Event): Promise<void> {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await adminFetch<{ name: string; token: string; message: string }>('/content-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setMinted(res);
      setName('');
      reload();
    } catch (err) {
      setMessage(errorText(err, 'Could not create that token.'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    if (!confirm('Revoke this token? The system holding it loses content-API access on its next request.')) return;
    try {
      await adminFetch(`/content-tokens/${id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setMessage(errorText(err, 'Could not revoke that token.'));
    }
  }

  return (
    <>
      <h3 class="admin-subhead">Content-API tokens</h3>
      <p class="settings-note">
        Scoped credentials for systems that push content over <code>/api/content/v1</code> (send{' '}
        <code>Authorization: Bearer …</code>). A token can read and write content and nothing else — unlike the admin key, it
        cannot mint admin logins or trigger updates, which is exactly why the admin key is never handed to a third party.
      </p>
      {!available && <p class="settings-note">{`Apply database migration 0009 to use scoped tokens.`}</p>}
      {minted && (
        <div class="settings-note admin-notice">
          <p>
            <strong>Copy it now — this token is shown only once.</strong>
          </p>
          <p>
            {minted.name}: <code>{minted.token}</code>
          </p>
          <p>{minted.message}</p>
        </div>
      )}
      {tokens && tokens.length > 0 && (
        <ul class="admin-content-list">
          {tokens.map((t) => (
            <li key={t.id}>
              <span class="admin-content-row-main">
                <strong>{t.name}</strong>
                <span class="admin-content-row-meta">
                  created {new Date(t.createdAt).toLocaleDateString()}
                  {t.createdBy ? ` by ${t.createdBy}` : ''} ·{' '}
                  {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}
                </span>
              </span>
              {t.revoked ? (
                <span class="admin-badge">revoked</span>
              ) : (
                <button class="btn-ghost admin-row-action" disabled={busy} onClick={() => void revoke(t.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {available && (
        <form class="signin-form" onSubmit={(e) => void mint(e)}>
          <label class="settings-row">
            <span>New token name</span>
            <input placeholder="acme-cms" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <button class="btn" type="submit" disabled={!name.trim() || busy}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </form>
      )}
      {message && <p class="settings-note admin-error">{message}</p>}
    </>
  );
}
