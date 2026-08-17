import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { BRAND } from '../brand';
import { api, call, ApiError, type AuthUser } from '../lib/api';
import { ContentSection } from './admin/ContentSection';
import { NarrationSection } from './admin/NarrationSection';
import { ThemeSection } from './admin/ThemeSection';

// Admin portal (AB#7404). Gated by a real account in the app's own `users`
// table carrying the `is_admin` flag — the same email+password, the same
// session cookie, and the same emailed password reset any reader gets. The
// shared ADMIN_KEY this screen used to prompt for is gone from the UI
// entirely: it's now only a deployment-config credential, used by the
// installer to mint the first setup link (see docs/admin-guide.md).
//
// Auth here is deliberately modest, not high security theatre. The stories
// themselves are public; the only job is to stop someone who isn't the
// operator from editing content or triggering a platform update.

/** Same-origin, session-cookie fetch for this site's own /api/admin/* routes. */
function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return call<T>(`/admin${path}`, init);
}

/** Whatever prose the server sent, else a readable fallback. */
function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    if (err.detail) return err.detail;
    if (err.slug) return err.slug.replace(/_/g, ' ');
  }
  return fallback;
}

interface StatusResponse {
  brand: string;
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
  /**
   * These three arrived with the AB#7403 update rework and are optional on
   * purpose: the app bundle and the worker are separately versioned packages,
   * so a site can legitimately be running a newer UI against a worker that
   * predates them. Rendering "undefined" as the command an operator should
   * type would be worse than a sensible fallback.
   */
  platform?: 'cloudflare' | 'node';
  /** The command that actually performs the update, run by the operator on their own machine. */
  updateCommand?: string;
  updateDocsUrl?: string;
  /**
   * Layer 3 (AB#7418). Optional for the same reason as the three above — a
   * newer portal can be talking to an older worker — and `available: false`
   * with a reason is the NORMAL answer, not an error. The card below renders
   * the command in every case and adds a button only when this says it can.
   */
  oneClick?: {
    available: boolean;
    platform?: 'cloudflare' | 'azure-app-service';
    /** What is allowed to deploy this site, in the operator's terms. */
    credential?: string;
    /** Why there is no button, when there isn't one. */
    reason?: string;
    detail?: string;
  };
}

/** What POST /update-install answers with. */
interface UpdateInstallResponse {
  ok?: boolean;
  installed?: string;
  message?: string;
  error?: string;
  log?: string[];
}

type Phase =
  | { name: 'loading' }
  | { name: 'setup'; token: string }
  | { name: 'signin' }
  /** Signed in, but this account doesn't carry the operator flag. */
  | { name: 'not-admin'; user: AuthUser }
  | { name: 'dashboard' };

export function Admin(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  // An installer-printed setup link lands on /admin?setup=<token>. Take the
  // token, drop into the one-time account-creation form, and scrub it out of
  // the URL bar so a refresh or a shared screenshot can't replay it — the
  // same handling the reader-side reset link gets in Settings.tsx.
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('setup');
    if (token) {
      setPhase({ name: 'setup', token });
      history.replaceState(null, '', '/admin');
      return;
    }
    void checkSession();
  }, []);

  async function checkSession(): Promise<void> {
    try {
      const me = await api.me();
      setPhase(me.user.isAdmin ? { name: 'dashboard' } : { name: 'not-admin', user: me.user });
    } catch {
      // 401 (or anything else) means "not signed in as far as this screen
      // is concerned" — show the sign-in form rather than an error page.
      setPhase({ name: 'signin' });
    }
  }

  async function signOut(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // Already gone server-side, or offline — either way, land on sign-in.
    }
    setPhase({ name: 'signin' });
  }

  if (phase.name === 'loading') {
    return (
      <AdminShell>
        <p class="settings-note">Loading…</p>
      </AdminShell>
    );
  }

  if (phase.name === 'setup') {
    return (
      <AdminShell>
        <SetupForm token={phase.token} onDone={() => setPhase({ name: 'dashboard' })} onExpired={() => setPhase({ name: 'signin' })} />
      </AdminShell>
    );
  }

  if (phase.name === 'signin') {
    return (
      <AdminShell>
        <AdminSignIn onSignedIn={checkSession} />
      </AdminShell>
    );
  }

  if (phase.name === 'not-admin') {
    return (
      <AdminShell>
        <section class="settings-section">
          <h2>No admin access</h2>
          <p class="settings-note">
            You're signed in as <strong>{phase.user.username ?? phase.user.email}</strong>, but this account isn't an operator on
            this deployment, so there's nothing here for it.
          </p>
          <p class="settings-note">
            Sign in with the operator account instead, or — if this should be the operator account — have someone with access to
            this deployment's configuration mint a new setup link (see the admin guide).
          </p>
          <button class="btn" onClick={() => void signOut()}>
            Sign out
          </button>
        </section>
      </AdminShell>
    );
  }

  return <AdminDashboard onSignOut={() => void signOut()} />;
}

/** Header + page chrome, shared by every phase so the title never flickers away. */
function AdminShell({ children, title, action }: { children: JSX.Element | JSX.Element[]; title?: string; action?: JSX.Element }): JSX.Element {
  return (
    <div class="screen admin-screen">
      <header class="screen-header">
        <h1 class="screen-title">Admin — {title ?? BRAND.appName}</h1>
        {action}
      </header>
      {children}
    </div>
  );
}

/**
 * One-time account creation from an installer-printed setup link. This is
 * the only way the first operator account comes into existence; afterwards
 * it's an ordinary email+password sign-in.
 */
function SetupForm({ token, onDone, onExpired }: { token: string; onDone: () => void; onExpired: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await api.adminSetupClaim(token, email.trim(), username.trim(), password);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.slug === 'invalid_or_expired') {
        setError('That setup link is no longer valid — it expired, or it has already been used. Mint a new one (see the admin guide) and try again.');
      } else {
        setError(errorText(err, 'Could not create the admin account. Check your details and try again.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings-section">
      <h2>Create your admin login</h2>
      <p class="settings-note">
        This link works once. Pick an email and password you'll use to sign in to this portal from now on — the same kind of
        account any reader has, just with operator access.
      </p>
      <form
        class="signin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="email"
          placeholder="Email"
          autoComplete="email"
          value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          required
        />
        <input
          type="text"
          placeholder="Username (optional)"
          autoComplete="username"
          maxLength={20}
          value={username}
          onInput={(e) => setUsername((e.target as HTMLInputElement).value.replace(/\s/g, ''))}
        />
        <input
          type="password"
          placeholder="Password"
          autoComplete="new-password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          required
        />
        <p class="settings-note">At least 8 characters.</p>
        {error && <p class="settings-note admin-error">{error}</p>}
        <button class="btn" type="submit" disabled={busy || !email || password.length < 8}>
          {busy ? 'Creating…' : 'Create admin account'}
        </button>
        <button type="button" class="btn-ghost signin-forgot-link" onClick={onExpired}>
          I already have an admin account
        </button>
      </form>
    </section>
  );
}

/**
 * Sign-in, plus the two ways back in when the password is gone:
 *   • "Forgot password?" hands off to the reader-side reset flow in
 *     /settings — the emailed code/link path already works for any account
 *     with a password, admin included, so there is deliberately no second
 *     copy of it here.
 *   • "Use a recovery code instead" opens the codes the installer printed at
 *     deploy time. This is the only place in the app that door exists, so it
 *     has to live on this form.
 */
function AdminSignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }): JSX.Element {
  const [mode, setMode] = useState<'signin' | 'recover'>('signin');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await api.login(identifier.trim(), password);
      await onSignedIn();
    } catch (err) {
      // One message for every failure, same as the reader sign-in form: a
      // failed attempt never reveals whether the account exists.
      if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Please wait a few minutes and try again.');
      else setError('That email or password is not right.');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'recover') return <RecoverForm onRecovered={onSignedIn} onBack={() => setMode('signin')} />;

  return (
    <section class="settings-section">
      <h2>Sign in</h2>
      <p class="settings-note">Sign in with your operator account to manage this deployment.</p>
      <form
        class="signin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="text"
          placeholder="Email or username"
          autoComplete="username"
          value={identifier}
          onInput={(e) => setIdentifier((e.target as HTMLInputElement).value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          required
        />
        {error && <p class="settings-note admin-error">{error}</p>}
        <button class="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {/* Hands off to the reader-side reset flow in Settings rather than
            duplicating it — ?forgot=1 drops straight into that form. A full
            document load, not a client-side navigate: the admin portal is its
            own page and its own bundle, and the reader app's router doesn't
            exist here (AB#7404). */}
        <button type="button" class="btn-ghost signin-forgot-link" onClick={() => location.assign('/settings?forgot=1')}>
          Forgot password?
        </button>
        <button type="button" class="btn-ghost signin-forgot-link" onClick={() => setMode('recover')}>
          Use a recovery code instead
        </button>
      </form>
    </section>
  );
}

/** Recovery codes: the door that still works when email delivery doesn't. */
function RecoverForm({ onRecovered, onBack }: { onRecovered: () => Promise<void>; onBack: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await api.adminRecover(email.trim(), code.trim(), password);
      await onRecovered();
    } catch (err) {
      if (err instanceof ApiError && err.slug === 'invalid_or_expired') {
        setError('That code and email combination is not right, or the code has already been used. Each code works once.');
      } else {
        setError(errorText(err, 'Could not use that recovery code. Try again.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings-section">
      <h2>Use a recovery code</h2>
      <p class="settings-note">
        These are the one-time codes printed when this site was deployed. Enter one along with your admin email and a new
        password. Each code works once.
      </p>
      <form
        class="signin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="email"
          placeholder="Admin email"
          autoComplete="email"
          value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          required
        />
        <input
          type="text"
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="one-time-code"
          spellcheck={false}
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())}
          required
        />
        <input
          type="password"
          placeholder="New password"
          autoComplete="new-password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          required
        />
        {error && <p class="settings-note admin-error">{error}</p>}
        <button class="btn" type="submit" disabled={busy || password.length < 8}>
          {busy ? 'Checking…' : 'Reset password and sign in'}
        </button>
        <button type="button" class="btn-ghost signin-forgot-link" onClick={onBack}>
          Back to sign in
        </button>
      </form>
    </section>
  );
}

function AdminDashboard({ onSignOut }: { onSignOut: () => void }): JSX.Element {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusResponse | null>(null);
  const [error, setError] = useState('');

  const refresh = () => {
    setError('');
    const statusP = adminFetch<StatusResponse>('/status')
      .then(setStatus)
      .catch((e) => setError(errorText(e, 'Could not load status.')));
    const updateP = adminFetch<UpdateStatusResponse>('/update-status')
      .then(setUpdateStatus)
      .catch((e) => setError(errorText(e, 'Could not check for updates.')));
    return Promise.all([statusP, updateP]).then(() => undefined);
  };
  useEffect(() => void refresh(), []);

  return (
    <div class="screen admin-screen">
      <header class="screen-header">
        <h1 class="screen-title">Admin — {BRAND.appName}</h1>
        <button class="btn-ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {error && <p class="settings-note admin-error">{error}</p>}

      <StatusSection status={status} />
      {/* Content management (AB#7420/AB#7421 — plan §3): list → open → edit →
          save → republish, against the source markdown the deployment now
          stores for itself. The GitHub-backed PublishSection below it is a
          different, narrower path and stays — see the note on its own
          component. */}
      <ContentSection />
      {/* Brand & themes (AB#7417 — plan §0c/§0d Phase 4): install a theme
          package, edit the brand's own details, see the version history, roll
          back. Above the platform update card on purpose — changing how the
          site looks is an everyday operator job; updating the engine is not. */}
      {/* Narration queue (AB#7412 — plan §8 item 4). Directly under the content
          card because it is the other half of the same job: editing or importing
          text is what puts work in this queue, and an operator who has just
          imported fifty stories should see what that costs without scrolling
          past the brand settings to find out. */}
      <NarrationSection />
      <ThemeSection />
      <UpdateSection updateStatus={updateStatus} onCheck={refresh} />
      <PublishSection onPublished={refresh} />
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

/**
 * Platform update (AB#7403, extended AB#7418). This card always tells you where
 * you stand and always hands you the command that does the work. What it adds
 * ON TOP, and only where the operator has deliberately enabled it, is the
 * button: layer 3, an in-portal update that downloads a prebuilt engine and
 * hands it to the platform this site already runs on.
 *
 * The command never goes away when the button appears, and that is deliberate.
 * The button depends on a permission that can be revoked, a release artifact
 * that might not exist for a given version, and a platform API that can be
 * having a bad day; the command depends on none of those. It is the floor, and
 * a card that hid it as soon as something fancier was configured would be
 * hiding the thing that always works.
 *
 * With one-click NOT configured — which is the default and the recommended
 * posture — this renders exactly what it rendered before AB#7418, plus one line
 * saying the feature exists and how to turn it on.
 */
const UPDATE_DOCS_URL = 'https://storylark.org/docs/updating.html';

function UpdateSection({
  updateStatus,
  onCheck,
}: {
  updateStatus: UpdateStatusResponse | null;
  onCheck: () => Promise<void>;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateInstallResponse | null>(null);
  const oneClick = updateStatus?.oneClick;

  async function check() {
    setChecking(true);
    try {
      await onCheck();
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    setInstalling(true);
    setConfirming(false);
    setResult(null);
    try {
      const res = await adminFetch<UpdateInstallResponse>('/update-install', { method: 'POST', body: JSON.stringify({}) });
      setResult(res);
    } catch (err) {
      setResult({ error: 'failed', message: errorText(err, 'The update could not be installed.') });
    } finally {
      setInstalling(false);
    }
  }
  // Falls back to the generic form when talking to a worker that predates
  // AB#7403's response fields — still a correct instruction, just without the
  // platform already filled in.
  const command = updateStatus?.updateCommand ?? 'node platforms/<cloudflare|azure>/install.mjs --update --yes';

  function copy(command: string) {
    // Clipboard access can be denied (insecure context, permissions) — the
    // command is on screen either way, so a failure just means no confirmation.
    navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  }

  return (
    <section class="settings-section">
      <h2>Platform update</h2>
      <button class="btn-ghost" disabled={checking} onClick={check}>
        {checking ? 'Checking…' : 'Check for updates'}
      </button>
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
          {/* Layer 3, when and only when the operator turned it on. */}
          {oneClick?.available && updateStatus.hasUpdate && !result && (
            <div class="admin-oneclick">
              {!confirming ? (
                <button class="btn" disabled={installing} onClick={() => setConfirming(true)}>
                  Install update
                </button>
              ) : (
                <>
                  <p class="settings-note">
                    This downloads the prebuilt <strong>{updateStatus.latest}</strong> engine, checks it against its published
                    checksum, applies any database migrations, and redeploys this site through {oneClick.credential}. Your brand,
                    your theme and your content are not touched.
                  </p>
                  <button class="btn" disabled={installing} onClick={install}>
                    {installing ? 'Installing…' : `Yes — install ${updateStatus.latest}`}
                  </button>{' '}
                  <button class="btn-ghost" disabled={installing} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </>
              )}
              {!confirming && <p class="settings-note">Deployed by {oneClick.credential}.</p>}
            </div>
          )}
          {result && (
            <div class="admin-oneclick">
              <p class={`settings-note${result.ok ? '' : ' admin-error'}`}>
                {result.ok ? `Installed ${result.installed}. ${result.message ?? ''}` : (result.message ?? 'The update failed.')}
              </p>
              {/* The log is the receipt. Shown on success as well as failure —
                  "what did that button just do to my site" deserves an answer
                  either way, not only when something went wrong. */}
              {result.log?.length ? <pre class="admin-command">{result.log.join('\n')}</pre> : null}
            </div>
          )}

          <p class="settings-note">
            {updateStatus.hasUpdate
              ? `${oneClick?.available ? 'You can also take it' : 'To take it'}, run this from your copy of the site, on the machine you deploy from:`
              : 'When there is one, you take it by running this from your copy of the site, on the machine you deploy from:'}
          </p>
          <pre class="admin-command">{command}</pre>
          <button class="btn-ghost" onClick={() => copy(command)}>
            {copied ? 'Copied' : 'Copy command'}
          </button>
          <p class="settings-note">
            It pulls the new engine, migrates, rebuilds with your brand untouched, and redeploys — using the platform login
            you already have.{' '}
            {oneClick?.available
              ? 'This works whether or not one-click updates are enabled, and needs nothing stored on the site.'
              : 'This site stores no credential that could update itself.'}{' '}
            <a href={updateStatus.updateDocsUrl ?? UPDATE_DOCS_URL} target="_blank" rel="noreferrer">
              How updating works
            </a>
          </p>
          {oneClick && !oneClick.available && oneClick.reason && <p class="settings-note">{oneClick.reason}</p>}
        </>
      )}
    </section>
  );
}

/**
 * Publish a new single-chapter story through the site's GitHub repo
 * (docs/design/admin-publish.md). Kept alongside the content manager above
 * rather than replaced by it, because it does one thing that path cannot: CI
 * can run the TTS model, so a story published here comes back narrated. The
 * content manager edits any chapter of any book instantly and needs no GitHub
 * at all, but a Worker can't generate speech — see plan §3's honest constraint.
 */
function PublishSection({ onPublished }: { onPublished: () => void }): JSX.Element {
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
      const res = await adminFetch<{ message: string }>('/publish-story', {
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
      setMessage(errorText(e, 'Could not publish that story.'));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section class="settings-section">
      <h2>Publish a story via GitHub</h2>
      <p class="settings-note">
        A second way in, separate from the <strong>{'Stories'}</strong> list above: this commits straight to your site's repo
        and publishes through CI, which is the only place this deployment can generate narration. Use the list above to edit
        instantly with no GitHub round trip — text publishes right away either way, but a story started there has no audio
        until something narrates it. Text publishes immediately here too; narration depends on whether this deployment has TTS
        credentials configured in CI — check the message after publishing.
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
