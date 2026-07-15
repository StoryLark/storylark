import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { user, settings, saveSettings, manifest, pullPreferences } from '../lib/state';
import type { ConsumptionMode, DownloadRecord } from '../lib/types';
import { api, ApiError, type AuthUser, type PasskeySummary } from '../lib/api';
import { BRAND, NOUNS } from '../brand';
import { BUILD } from '../version';
import { navigate } from '../router';
import { pushSupported, needsInstallForPush, currentSubscription, subscribe, unsubscribe } from '../lib/push';
import { downloadStates, removeDownload, getDownloadRecords } from '../lib/downloads';
import { reconcileProgress, resetProgressPushMarker } from '../lib/progress-sync';
import { syncNow, setAutoDownloadBaseline } from '../lib/autosync';
import { passkeysSupported, addPasskey, PasskeyCanceledError } from '../lib/webauthn';

export function Settings(): JSX.Element {
  return (
    <div class="screen settings-screen">
      <header class="screen-header">
        <h1 class="screen-title">Settings</h1>
      </header>
      <AccountSection />
      <PlaybackSection />
      <TypographySection />
      <SyncSection />
      <NotificationsSection />
      <StorageSection />
      <footer class="settings-footer">
        <button class="btn-ghost settings-about-link" onClick={() => navigate('/about')}>
          About {BRAND.appName} →
        </button>
        <p class="settings-version">
          {BRAND.appName} · {BRAND.name} · v{BUILD.coreVersion} ({BUILD.commit}) · preview
        </p>
      </footer>
    </div>
  );
}

/** Narrator voice choice — only rendered when the library publishes 2+ voices. */
function NarratorPicker(): JSX.Element | null {
  const voices = manifest.value?.voices;
  if (!voices || Object.keys(voices).length < 2) return null;
  return (
    <>
      <label class="settings-row">
        <span>Narrator</span>
        <select
          value={settings.value.narratorVoice}
          onChange={(e) => void saveSettings({ narratorVoice: (e.target as HTMLSelectElement).value })}
        >
          <option value="">Default</option>
          {Object.entries(voices).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p class="settings-note">
        Who reads to you. Takes effect the next time a {NOUNS.unit} starts playing; downloads
        keep your chosen narrator available offline.
      </p>
    </>
  );
}

function PlaybackSection(): JSX.Element {
  const s = settings.value;
  return (
    <section class="settings-section">
      <h2>Playback</h2>
      <label class="settings-row">
        <span>Default mode</span>
        <select
          value={s.defaultMode}
          onChange={(e) => void saveSettings({ defaultMode: (e.target as HTMLSelectElement).value as ConsumptionMode })}
        >
          <option value="read">Read</option>
          <option value="listen">Listen</option>
          <option value="both">Read + Listen</option>
        </select>
      </label>
      <p class="settings-note">
        How items open when you tap them. You can still pick a different mode per {NOUNS.unit}.
        The app remembers your choice for each one.
      </p>
      <NarratorPicker />
      <label class="settings-row">
        <span>Read-along highlight</span>
        <select
          value={s.readAlong}
          onChange={(e) => void saveSettings({ readAlong: (e.target as HTMLSelectElement).value as 'word' | 'block' | 'off' })}
        >
          <option value="word">Word by word</option>
          <option value="block">Paragraph only</option>
          <option value="off">Off</option>
        </select>
      </label>
    </section>
  );
}

function TypographySection(): JSX.Element {
  const s = settings.value;
  return (
    <section class="settings-section">
      <h2>Reading</h2>
      <label class="settings-row">
        <span>Text size</span>
        <input
          type="range"
          min="0"
          max="4"
          step="1"
          value={s.fontScale}
          onInput={(e) => void saveSettings({ fontScale: Number((e.target as HTMLInputElement).value) })}
        />
      </label>
      <label class="settings-row">
        <span>Line spacing</span>
        <select
          value={String(s.lineHeight)}
          onChange={(e) => void saveSettings({ lineHeight: Number((e.target as HTMLSelectElement).value) })}
        >
          <option value="1.5">Compact</option>
          <option value="1.7">Comfortable</option>
          <option value="1.9">Airy</option>
        </select>
      </label>
      <label class="settings-row">
        <span>Theme</span>
        <select value={s.theme} onChange={(e) => void saveSettings({ theme: (e.target as HTMLSelectElement).value as 'dark' | 'light' | 'auto' })}>
          <option value="auto">Brand default</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
    </section>
  );
}

function SyncSection(): JSX.Element {
  const s = settings.value;
  const autoDownloadLabel =
    BRAND.layout === 'flat' ? `Auto-download new ${NOUNS.unitPlural} (incl. audio)` : `Keep the whole ${NOUNS.collection} downloaded (incl. audio)`;
  return (
    <section class="settings-section">
      <h2>Library & sync</h2>
      <label class="settings-row">
        <span>Check for new content automatically</span>
        <input
          type="checkbox"
          checked={s.autoSync}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            void saveSettings({ autoSync: on }).then(() => {
              if (on) void syncNow();
            });
          }}
        />
      </label>
      <p class="settings-note">When the app opens or comes back online, new {NOUNS.unitPlural} are fetched so they're ready to read.</p>
      <label class="settings-row">
        <span>{autoDownloadLabel}</span>
        <input
          type="checkbox"
          checked={s.autoDownload}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            void (async () => {
              if (on && BRAND.layout === 'flat') await setAutoDownloadBaseline();
              await saveSettings({ autoDownload: on });
              if (on) void syncNow();
            })();
          }}
        />
      </label>
      <p class="settings-note">
        {BRAND.layout === 'flat'
          ? `${NOUNS.UnitPlural} published from now on download automatically for offline reading and listening.`
          : `Every ${NOUNS.unit}, both text and narration, stays available offline, including new ones as they publish.`}
      </p>
    </section>
  );
}

function NotificationsSection(): JSX.Element {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pushSupported()) {
      setSubscribed(null);
      return;
    }
    void currentSubscription().then((s) => setSubscribed(!!s));
  }, []);

  if (!pushSupported()) {
    return (
      <section class="settings-section">
        <h2>Notifications</h2>
        <p class="settings-note">This browser doesn't support notifications.</p>
      </section>
    );
  }
  if (needsInstallForPush()) {
    return (
      <section class="settings-section">
        <h2>Notifications</h2>
        <p class="settings-note">
          To get notified about new {NOUNS.unitPlural} on iPhone or iPad, first install the app: tap <strong>Share</strong> →{' '}
          <strong>Add to Home Screen</strong>, then enable notifications here.
        </p>
      </section>
    );
  }
  return (
    <section class="settings-section">
      <h2>Notifications</h2>
      <label class="settings-row">
        <span>New content alerts</span>
        <input
          type="checkbox"
          checked={subscribed === true}
          disabled={subscribed === null}
          onChange={async (e) => {
            const on = (e.target as HTMLInputElement).checked;
            if (on) setSubscribed(await subscribe());
            else {
              await unsubscribe();
              setSubscribed(false);
            }
          }}
        />
      </label>
    </section>
  );
}

/**
 * Status-only view of downloaded content: what's on this device, how big it
 * is, per-item remove, and Clear all. Downloads are started from the Library.
 */
function StorageSection(): JSX.Element {
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [quota, setQuota] = useState<{ usage: number; total: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    void getDownloadRecords().then(setRecords);
  }, [downloadStates.value]);
  useEffect(() => {
    if (navigator.storage?.estimate) {
      void navigator.storage.estimate().then((e) => {
        if (e.usage !== undefined && e.quota !== undefined) setQuota({ usage: e.usage, total: e.quota });
      });
    }
  }, [downloadStates.value]);

  const m = manifest.value;
  const bytes = records.reduce((sum, r) => sum + r.bytes, 0);
  const inProgress = [...downloadStates.value.entries()].filter(([, s]) => s === 'downloading').map(([k]) => k);
  const itemsWord = NOUNS.UnitPlural;

  function nameFor(bookId: string, chapterId: string): string {
    const book = m?.books.find((b) => b.id === bookId);
    if (!book) return `${bookId}: ${chapterId}`;
    const ch = book.chapters.find((c) => c.id === chapterId);
    if (!ch || book.chapters.length <= 1) return book.title;
    return `${book.title}: ${ch.label ?? ch.title}`;
  }

  async function clearAll(): Promise<void> {
    setClearing(true);
    try {
      for (const r of records) await removeDownload(r.bookId, r.chapterId);
    } finally {
      setClearing(false);
    }
  }

  return (
    <section class="settings-section">
      <h2>Storage & downloads</h2>
      <p class="settings-note">
        Downloads: {(bytes / 1024 / 1024).toFixed(1)} MB
        {quota && ` · App storage: ${(quota.usage / 1024 / 1024).toFixed(1)} MB of ${(quota.total / 1024 / 1024 / 1024).toFixed(1)} GB available`}
      </p>
      <p class="settings-note">{itemsWord} are downloaded from the Library. This list shows what's stored on this device.</p>
      {records.length === 0 && inProgress.length === 0 && <p class="settings-note">Nothing downloaded yet.</p>}
      {records.length > 0 && (
        <button class="btn btn-small" disabled={clearing} onClick={() => void clearAll()}>
          {clearing ? 'Clearing…' : 'Clear all downloads'}
        </button>
      )}
      {inProgress.map((k) => {
        const [bookId, chapterId] = k.split('/');
        return (
          <div class="settings-row" key={k}>
            <span>{nameFor(bookId, chapterId)}</span>
            <span class="settings-note">Downloading…</span>
          </div>
        );
      })}
      {records.map((r) => (
        <div class="settings-row" key={`${r.bookId}/${r.chapterId}`}>
          <span>
            {nameFor(r.bookId, r.chapterId)}
            <span class="settings-note settings-dl-size"> · {(r.bytes / 1024 / 1024).toFixed(1)} MB</span>
          </span>
          <button class="btn btn-small" onClick={() => void removeDownload(r.bookId, r.chapterId)}>
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}

/**
 * Account and profile. Rendered FIRST on the Settings screen (not buried
 * after five other sections) and in its own raised card, so signed-in state
 * is the one thing on this screen you can't miss.
 */
function AccountSection(): JSX.Element {
  const u = user.value;
  return (
    <section class="settings-section settings-account-card">
      <h2>Account</h2>
      {u ? <SignedIn email={u.email} username={u.username} displayName={u.displayName} /> : <SignIn />}
    </section>
  );
}

function SignedIn({
  email,
  username,
  displayName,
}: {
  email: string;
  username: string | null;
  displayName: string | null;
}): JSX.Element {
  return (
    <>
      <p class="settings-note">
        Signed in as <strong>{username ?? displayName ?? email}</strong>. Your reading position syncs across devices.
      </p>
      <div class="settings-row">
        <span class="settings-note">Email</span>
        <span>{email}</span>
      </div>
      {username && (
        <div class="settings-row">
          <span class="settings-note">Username</span>
          <span>{username}</span>
        </div>
      )}
      <PasskeyManager />
      <button
        class="btn-ghost account-signout"
        onClick={async () => {
          await api.logout();
          await resetProgressPushMarker();
          user.value = null;
        }}
      >
        Sign out
      </button>
    </>
  );
}

/** Signed-in passkey list: add, remove, and a nudge to add a first one. */
function PasskeyManager(): JSX.Element | null {
  const [list, setList] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh(): Promise<void> {
    try {
      const res = await api.listPasskeys();
      setList(res.passkeys);
    } catch {
      setList([]);
    }
  }

  useEffect(() => {
    if (passkeysSupported()) void refresh();
  }, []);

  if (!passkeysSupported()) return null;

  async function handleAdd(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await addPasskey();
      await refresh();
    } catch (err) {
      if (!(err instanceof PasskeyCanceledError)) setError(err instanceof Error ? err.message : 'Could not add a passkey.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await api.removePasskey(id);
      await refresh();
    } catch {
      setError('Could not remove that passkey. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="account-passkeys">
      <h3 class="account-passkeys-title">Passkeys</h3>
      {list === null && <p class="settings-note">Loading…</p>}
      {list !== null && list.length === 0 && (
        <div class="account-passkey-nudge">
          <p class="settings-note">
            Add a passkey to this device so you can sign in faster next time, with Face ID, Touch ID, or Windows Hello
            instead of typing your password.
          </p>
        </div>
      )}
      {list !== null && list.length > 0 && (
        <ul class="account-passkey-list">
          {list.map((p) => (
            <li class="account-passkey-row" key={p.id}>
              <span>
                {p.label}
                <span class="settings-note account-passkey-meta">
                  {' '}
                  · Added {new Date(p.createdAt).toLocaleDateString()}
                  {p.lastUsedAt ? `, last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ''}
                </span>
              </span>
              <button class="btn btn-small" disabled={busy} onClick={() => void handleRemove(p.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p class="settings-note signin-error">{error}</p>}
      <button class="btn btn-small" type="button" disabled={busy} onClick={() => void handleAdd()}>
        {busy ? 'Working…' : list && list.length > 0 ? 'Add another passkey' : 'Add a passkey to this device'}
      </button>
    </div>
  );
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;

/**
 * Signed-out: one simple card, two forms (Create account / Sign in), toggled
 * by a segmented control (the same pattern as the Read/Listen mode toggle in
 * the Reader). Passkeys and magic-link/code still work at the API level,
 * see PasskeyManager above for the one place passkeys still show up, inside
 * an already-signed-in account, but neither is featured on this screen.
 */
function SignIn(): JSX.Element {
  const [mode, setMode] = useState<'register' | 'signin' | 'forgot'>('register');
  const [resetToken, setResetToken] = useState<string | undefined>(undefined);

  // An emailed "Reset password" link lands on /settings?reset=<token>. Pick the
  // token up, drop straight into the reset form, and scrub it out of the URL
  // bar so a later refresh or share doesn't leak or replay it.
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('reset');
    if (t) {
      setResetToken(t);
      setMode('forgot');
      history.replaceState(null, '', '/settings');
    }
  }, []);

  async function afterSignIn(res: AuthUser): Promise<void> {
    user.value = res;
    // Now that the session cookie is set in THIS context, sync immediately:
    // push any signed-out local progress up, then pull the server's view.
    await reconcileProgress();
    await pullPreferences();
  }

  if (mode === 'forgot') {
    return <ForgotPassword onSignedIn={afterSignIn} onBack={() => setMode('signin')} initialToken={resetToken} />;
  }

  return (
    <>
      <p class="settings-note">Create a free account, or sign in, to sync your reading position across devices.</p>
      <div class="mode-seg account-auth-seg" role="group" aria-label="Create account or sign in">
        <button type="button" class={`mode-seg-btn${mode === 'register' ? ' active' : ''}`} onClick={() => setMode('register')}>
          Create account
        </button>
        <button type="button" class={`mode-seg-btn${mode === 'signin' ? ' active' : ''}`} onClick={() => setMode('signin')}>
          Sign in
        </button>
      </div>
      {mode === 'register' ? (
        <RegisterForm onSignedIn={afterSignIn} />
      ) : (
        <SignInForm onSignedIn={afterSignIn} onForgot={() => setMode('forgot')} />
      )}
    </>
  );
}

/** Create account: email, username, password. Nothing else required. */
function RegisterForm({ onSignedIn }: { onSignedIn: (res: AuthUser) => Promise<void> }): JSX.Element {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function validate(): string {
    if (!EMAIL_RE.test(email.trim())) return 'Enter a valid email address.';
    if (!USERNAME_RE.test(username.trim())) return 'Username should be 3 to 20 letters, numbers, or underscores.';
    if (password.length < 8) return 'Password should be at least 8 characters.';
    return '';
  }

  async function submit(): Promise<void> {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.register(email.trim(), username.trim(), password);
      await onSignedIn(res.user);
    } catch (err) {
      setError(registerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="signin-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input type="email" placeholder="Email" autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />
      <input
        type="text"
        placeholder="Username"
        autoComplete="username"
        maxLength={20}
        value={username}
        onInput={(e) => setUsername((e.target as HTMLInputElement).value.replace(/\s/g, ''))}
        required
      />
      <PasswordField
        value={password}
        onInput={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
        autoComplete="new-password"
        placeholder="Password"
      />
      <p class="settings-note">At least 8 characters. That's it.</p>
      {error && <p class="settings-note signin-error">{error}</p>}
      <button class="btn" type="submit" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}

function registerErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    switch (err.slug) {
      case 'username_taken':
        return 'That username is already taken. Try another.';
      case 'email_taken':
        return 'That email already has a password on it. Try signing in instead.';
      case 'invalid_email':
        return 'Enter a valid email address.';
      case 'invalid_username':
        return 'Username should be 3 to 20 letters, numbers, or underscores.';
      case 'invalid_password':
        return 'Password should be at least 8 characters.';
      default:
        break;
    }
  }
  return 'Could not create your account. Check your details and try again.';
}

/** Sign in with either the email or the username, plus the password. */
function SignInForm({
  onSignedIn,
  onForgot,
}: {
  onSignedIn: (res: AuthUser) => Promise<void>;
  onForgot: () => void;
}): JSX.Element {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!identifier.trim() || !password) {
      setError('Enter your email or username and your password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.login(identifier.trim(), password);
      await onSignedIn(res.user);
    } catch (err) {
      // Deliberately the same message for every kind of failure, so a failed
      // attempt never reveals whether the account exists.
      if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Please wait a few minutes and try again.');
      else setError('That email or password is not right.');
    } finally {
      setBusy(false);
    }
  }

  return (
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
      <PasswordField
        value={password}
        onInput={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
        autoComplete="current-password"
        placeholder="Password"
      />
      {error && <p class="settings-note signin-error">{error}</p>}
      <button class="btn" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <button type="button" class="btn-ghost signin-forgot-link" onClick={onForgot}>
        Forgot password?
      </button>
    </form>
  );
}

/**
 * Forgot / reset password. Two ways in, one shared last step:
 *   • email step  → POST /password/forgot → we email a 6-digit code + a link,
 *     then the user types the code plus a new password here (all in this one
 *     browser context, so the session cookie the reset sets actually sticks).
 *   • token step  → reached from the emailed link (/settings?reset=…); the user
 *     just picks a new password, no code needed.
 * On success the user is signed in immediately.
 */
function ForgotPassword({
  onSignedIn,
  onBack,
  initialToken,
}: {
  onSignedIn: (res: AuthUser) => Promise<void>;
  onBack: () => void;
  initialToken?: string;
}): JSX.Element {
  const [step, setStep] = useState<'email' | 'code' | 'token'>(initialToken ? 'token' : 'email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function requestCode(): Promise<void> {
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.forgotPassword(email.trim());
    } catch {
      // Swallow: the endpoint is deliberately uniform, so advance regardless.
    } finally {
      setBusy(false);
    }
    // Always move on, whether or not that email has an account, so this screen
    // can't be used to find out which emails are registered.
    setStep('code');
  }

  async function doReset(): Promise<void> {
    if (password.length < 8) {
      setError('New password should be at least 8 characters.');
      return;
    }
    if (step === 'code' && !/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res =
        step === 'token'
          ? await api.resetPassword({ token: initialToken ?? '' }, password)
          : await api.resetPassword({ email: email.trim(), code: code.trim() }, password);
      await onSignedIn(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Please wait a few minutes and try again.');
      } else if (err instanceof ApiError && err.slug === 'invalid_or_expired') {
        setError('That code or link is wrong or has expired. Request a new one.');
      } else if (err instanceof ApiError && err.slug === 'invalid_password') {
        setError('New password should be at least 8 characters.');
      } else {
        setError('Could not reset your password. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p class="settings-note">
        {step === 'email' && 'Enter your account email and we will send you a reset code.'}
        {step === 'code' && 'If an account exists for that email, a 6-digit code is on its way. Enter it below with your new password.'}
        {step === 'token' && 'Choose a new password for your account.'}
      </p>
      <form
        class="signin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'email') void requestCode();
          else void doReset();
        }}
      >
        {step === 'email' && (
          <input
            type="email"
            placeholder="Email"
            autoComplete="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            required
          />
        )}
        {step === 'code' && (
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="6-digit code"
            autoComplete="one-time-code"
            value={code}
            onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
            required
          />
        )}
        {step !== 'email' && (
          <PasswordField
            value={password}
            onInput={setPassword}
            show={showPassword}
            onToggleShow={() => setShowPassword((s) => !s)}
            autoComplete="new-password"
            placeholder="New password"
          />
        )}
        {error && <p class="settings-note signin-error">{error}</p>}
        <button class="btn" type="submit" disabled={busy}>
          {step === 'email'
            ? busy
              ? 'Sending…'
              : 'Send reset code'
            : busy
              ? 'Resetting…'
              : 'Reset password'}
        </button>
        <button type="button" class="btn-ghost signin-forgot-link" onClick={step === 'code' ? () => setStep('email') : onBack}>
          {step === 'code' ? 'Use a different email' : 'Back to sign in'}
        </button>
      </form>
    </>
  );
}

/** Password input with a plain-text show/hide toggle, shared by both forms above. */
function PasswordField({
  value,
  onInput,
  show,
  onToggleShow,
  autoComplete,
  placeholder,
}: {
  value: string;
  onInput: (value: string) => void;
  show: boolean;
  onToggleShow: () => void;
  autoComplete: string;
  placeholder: string;
}): JSX.Element {
  return (
    <div class="signin-password-wrap">
      <input
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        autoComplete={autoComplete}
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        required
      />
      <button type="button" class="signin-password-toggle" onClick={onToggleShow} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
