/**
 * The admin portal's Brand & Themes card (AB#7417 — plan §0c / §0d Phase 4).
 *
 * ── Both doors, deliberately, in one card ───────────────────────────────────
 * §0c's decision is "portal form AND package, not either/or":
 *
 *   Tweak    — change a colour, a tagline, a font. No clone, no tool, no zip.
 *   Package  — install, version, roll back, and move a whole look between
 *              deployments; install something from the gallery.
 *
 * They are not two systems. The form writes a version exactly as an import
 * does, it appears in the same history, it rolls back the same way, and it can
 * be DOWNLOADED as a package — which is what makes "I tweaked a colour on the
 * staging site" something you can carry to production instead of retype.
 *
 * ── What this card does not pretend ─────────────────────────────────────────
 * There is no live preview of a theme before installing it. A theme is a
 * stylesheet for the whole app; the honest preview is the app, and installing
 * one is instant and one click to undo. A fake preview pane would be a second,
 * always-slightly-wrong renderer — the same reason §3's editor previews with
 * the real BlockRenderer rather than an approximation.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { call, ApiError } from '../../lib/api';

function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return call<T>(`/admin${path}`, init);
}

/** Roles a brand may set a font for. Mirrors FONT_ROLES in the worker + vite. */
const FONT_ROLES = ['display', 'headers', 'body', 'mono'] as const;
type FontRole = (typeof FONT_ROLES)[number];

interface BrandIdentity {
  contractVersion?: number;
  id?: string;
  name?: string;
  appName?: string;
  shortName?: string;
  tagline?: string;
  author?: string;
  themeColor?: string;
  backgroundColor?: string;
  defaultTheme?: 'light' | 'dark';
  fonts?: Partial<Record<FontRole, string>>;
}

interface ThemeVersion {
  id: string;
  themeId: string;
  name: string;
  version: string;
  importedAt: number;
  importedBy: string;
  source: 'portal' | 'cli' | 'form';
  live: boolean;
  bytes: number;
  hasPresentation: boolean;
  icons: string[];
  engine?: string;
}

interface ThemesResponse {
  storeAvailable: boolean;
  active: {
    versionId: string;
    themeId: string;
    name: string;
    version: string;
    importedAt: number;
    importedBy: string;
    source: 'portal' | 'cli' | 'form';
    hasPresentation: boolean;
    icons: string[];
    brand: BrandIdentity;
  } | null;
  builtIn: { id: string; appName: string };
  versions: ThemeVersion[];
  versionLimit: number;
  expects: { extension: string; icons: string[]; maxBytes: number };
}

/** dist/fonts.json — the curated set the build shipped. */
interface FontRegistryFile {
  families?: Record<string, { name: string; stack: string; category: string }>;
}

export function ThemeSection(): JSX.Element {
  const [state, setState] = useState<ThemesResponse | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [tweaking, setTweaking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await adminFetch<ThemesResponse>('/themes'));
      setUnavailable('');
    } catch (err) {
      // 404 = an engine from before theme packages; 501 = no writable storage.
      // Both are "this card can't work here", and both are worth saying rather
      // than showing an empty box.
      setUnavailable(
        err instanceof ApiError && err.status === 404
          ? 'This deployment is running an engine from before theme packages. Update it to install or roll back a brand from here.'
          : err instanceof ApiError && err.detail
            ? err.detail
            : 'Could not read the installed theme.'
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  function reset(): void {
    setMessage('');
    setProblems([]);
    setWarnings([]);
  }

  /** The one place an upload happens; `validateOnly` is the dry run. */
  async function send(file: File, validateOnly: boolean): Promise<void> {
    reset();
    setBusy(validateOnly ? 'Checking…' : 'Installing…');
    try {
      const body = new FormData();
      body.set('file', file);
      // Not through call(): that sets a JSON content type, and a multipart body
      // must be allowed to set its own boundary. Same as ContentSection's
      // image upload; the CSRF header still rides along.
      const res = await fetch(`/api/admin/themes/${validateOnly ? 'validate' : 'import'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'storylark' },
        body,
      });
      const payload = (await res.json().catch(() => ({}))) as {
        errors?: string[];
        warnings?: string[];
        message?: string;
        manifest?: { name: string; version: string };
        active?: { name: string };
      };
      if (!res.ok) {
        setProblems(payload.errors?.length ? payload.errors : [payload.message ?? `Upload failed (${res.status}).`]);
        setWarnings(payload.warnings ?? []);
        setMessage(
          `${file.name} was not installed. This deployment is still wearing ${describeActive(state)} — a package that fails is never applied in part.`
        );
        return;
      }
      setWarnings(payload.warnings ?? []);
      setMessage(
        validateOnly
          ? `${file.name} is valid — "${payload.manifest?.name}" v${payload.manifest?.version}. Nothing was installed.`
          : `Installed. This site is now wearing "${payload.active?.name}". Reload any open reader tab to see it.`
      );
      if (!validateOnly) await refresh();
    } catch {
      setProblems([`Could not reach the server to ${validateOnly ? 'check' : 'install'} that file.`]);
    } finally {
      setBusy('');
    }
  }

  async function rollback(versionId: string): Promise<void> {
    reset();
    setBusy('Rolling back…');
    try {
      const res = await adminFetch<{ active: { name: string } }>(`/themes/versions/${encodeURIComponent(versionId)}/activate`, {
        method: 'POST',
      });
      setMessage(`Rolled back. This site is now wearing "${res.active.name}".`);
      await refresh();
    } catch (err) {
      setProblems([err instanceof ApiError && err.detail ? err.detail : 'Roll back failed.']);
    } finally {
      setBusy('');
    }
  }

  async function revert(): Promise<void> {
    reset();
    setBusy('Reverting…');
    try {
      await adminFetch('/themes/active', { method: 'DELETE' });
      setMessage('Back to the brand this build shipped with. The version history is untouched — you can roll forward again.');
      await refresh();
    } catch (err) {
      setProblems([err instanceof ApiError && err.detail ? err.detail : 'Revert failed.']);
    } finally {
      setBusy('');
    }
  }

  if (unavailable) {
    return (
      <section class="settings-section">
        <h2>Brand &amp; themes</h2>
        <p class="settings-note">{unavailable}</p>
      </section>
    );
  }

  return (
    <section class="settings-section">
      <h2>Brand &amp; themes</h2>

      <CurrentBrand state={state} />

      {message && <p class="settings-note">{message}</p>}
      {problems.length > 0 && (
        <ul class="admin-error admin-status-list">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul class="settings-note admin-status-list">
          {warnings.map((w) => (
            <li key={w}>Warning: {w}</li>
          ))}
        </ul>
      )}

      <ImportPackage state={state} busy={busy} onSend={send} />

      <div class="admin-row">
        <button class="btn-ghost" disabled={!!busy} onClick={() => setTweaking((t) => !t)}>
          {tweaking ? 'Close brand details' : 'Edit brand details'}
        </button>
        {state?.active && (
          <button class="btn-ghost" disabled={!!busy} onClick={() => void revert()}>
            Revert to the built-in brand
          </button>
        )}
      </div>

      {tweaking && (
        <BrandForm
          brand={state?.active?.brand}
          onSaved={async (name) => {
            reset();
            setMessage(`Saved. This site is now wearing "${name}".`);
            setTweaking(false);
            await refresh();
          }}
          onError={(errors) => {
            reset();
            setProblems(errors);
          }}
        />
      )}

      <VersionHistory state={state} busy={busy} onRollback={rollback} />
    </section>
  );
}

function describeActive(state: ThemesResponse | null): string {
  if (!state?.active) return `the brand this build shipped with (${state?.builtIn.appName ?? 'unknown'})`;
  return `"${state.active.brand.appName ?? state.active.name}"`;
}

function CurrentBrand({ state }: { state: ThemesResponse | null }): JSX.Element {
  if (!state) return <p class="settings-note">Loading…</p>;
  const brand = state.active?.brand;
  return (
    <ul class="admin-status-list">
      <li>
        Wearing: <strong>{brand?.appName ?? state.builtIn.appName}</strong>{' '}
        {state.active ? (
          <>
            — installed {new Date(state.active.importedAt).toLocaleString()} by {state.active.importedBy} (
            {state.active.source === 'form' ? 'edited here' : state.active.source === 'cli' ? 'command line' : 'uploaded here'})
          </>
        ) : (
          '— the brand this build shipped with. Nothing is installed.'
        )}
      </li>
      {brand?.name && <li>Library name: {brand.name}</li>}
      {brand?.tagline && <li>Tagline: {brand.tagline}</li>}
      {brand?.author && <li>By: {brand.author}</li>}
      {state.active && (
        <li>
          Theme id: {state.active.themeId} v{state.active.version} · {state.active.icons.length} icons ·{' '}
          {state.active.hasPresentation ? 'sets the screen arrangement too' : 'colours and identity only'}
        </li>
      )}
      {/* The one caveat worth surfacing at the moment somebody changes a brand,
          per the plan's own list: a device that has installed the PWA holds the
          manifest and its icons until it reinstalls. */}
      {state.active && (
        <li class="settings-note">
          Anyone who has installed this site to their home screen keeps the previous name and icon until they reinstall it — the
          browser caches the app manifest with the installed app.
        </li>
      )}
    </ul>
  );
}

function ImportPackage({
  state,
  busy,
  onSend,
}: {
  state: ThemesResponse | null;
  busy: string;
  onSend: (file: File, validateOnly: boolean) => Promise<void>;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const ext = state?.expects.extension ?? '.zip';
  return (
    <div class="admin-upload">
      <h3>Install a theme package</h3>
      <p class="settings-note">
        A <code>{ext}</code> holding <code>brand.json</code>, <code>theme.css</code>, <code>icons/</code> and optionally{' '}
        <code>presentation.json</code>. Make one with <code>npm run package-theme</code>, or take one from the gallery. It is
        checked completely before anything changes — a package with a problem is never applied in part.
      </p>
      <input
        type="file"
        accept=".zip,application/zip"
        disabled={!!busy}
        onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
      />
      <div class="admin-row">
        <button class="btn-primary" disabled={!file || !!busy} onClick={() => file && void onSend(file, false)}>
          {busy || 'Install'}
        </button>
        <button class="btn-ghost" disabled={!file || !!busy} onClick={() => file && void onSend(file, true)}>
          Check it first
        </button>
      </div>
    </div>
  );
}

function VersionHistory({
  state,
  busy,
  onRollback,
}: {
  state: ThemesResponse | null;
  busy: string;
  onRollback: (versionId: string) => Promise<void>;
}): JSX.Element | null {
  if (!state || state.versions.length === 0) return null;
  return (
    <div class="admin-revisions">
      <h3>Version history</h3>
      <p class="settings-note">
        The last {state.versionLimit} are kept, and whichever one is live is never aged out. Rolling back restores exactly the
        bytes that were installed.
      </p>
      <ul class="admin-status-list">
        {state.versions.map((v) => (
          <li key={v.id}>
            {v.live ? '● ' : '○ '}
            <strong>{v.name}</strong> v{v.version} — {new Date(v.importedAt).toLocaleString()} by {v.importedBy}{' '}
            <span class="settings-note">
              ({v.source === 'form' ? 'edited here' : v.source === 'cli' ? 'command line' : 'uploaded here'})
            </span>{' '}
            {!v.live && (
              <button class="btn-ghost" disabled={!!busy} onClick={() => void onRollback(v.id)}>
                Roll back to this
              </button>
            )}{' '}
            <a class="btn-ghost" href={`/api/admin/themes/versions/${encodeURIComponent(v.id)}/package`} download>
              Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The tweak form (plan §0c's "portal form" door).
 *
 * Only the fields brand.json actually has — no invented ones — and fonts are a
 * SELECT drawn from the curated set the build shipped (`/fonts.json`), not a
 * text box: a font whose files were never shipped renders as the browser
 * default and looks like the theme is broken, so offering to type one would be
 * offering to break the site.
 *
 * `theme.css` and the icons are deliberately not editable here. Those are the
 * package's job — this is the "change a colour without cloning a repo" door,
 * and it inherits whatever stylesheet and icons are already installed.
 */
function BrandForm({
  brand,
  onSaved,
  onError,
}: {
  brand: BrandIdentity | undefined;
  onSaved: (name: string) => Promise<void>;
  onError: (errors: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<BrandIdentity>(() => ({ ...(brand ?? {}) }));
  const [families, setFamilies] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft({ ...(brand ?? {}) });
  }, [brand]);

  useEffect(() => {
    // The curated set is a build output the deployment serves (Phase 2); read
    // it rather than hard-coding a list that could fall behind the engine.
    fetch('/fonts.json')
      .then((r) => (r.ok ? (r.json() as Promise<FontRegistryFile>) : null))
      .then((doc) => setFamilies(Object.values(doc?.families ?? {}).map((f) => f.name)))
      .catch(() => setFamilies([]));
  }, []);

  const set = (key: keyof BrandIdentity) => (e: Event) => {
    const value = (e.target as HTMLInputElement | HTMLSelectElement).value;
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const setFont = (role: FontRole) => (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    setDraft((d) => ({ ...d, fonts: { ...(d.fonts ?? {}), [role]: value || undefined } }));
  };

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const body: BrandIdentity = { ...draft, contractVersion: draft.contractVersion ?? 1 };
      // An absent optional key means "this brand doesn't state it" (contract
      // rule 1). An empty text box has to become absent rather than "", or the
      // form would quietly write empty strings over the build's values.
      for (const key of Object.keys(body) as (keyof BrandIdentity)[]) {
        if (body[key] === '' || body[key] === undefined) delete body[key];
      }
      if (body.fonts) {
        for (const role of FONT_ROLES) if (!body.fonts[role]) delete body.fonts[role];
        if (Object.keys(body.fonts).length === 0) delete body.fonts;
      }
      const res = await adminFetch<{ active: { brand: BrandIdentity } }>('/themes/brand', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      await onSaved(res.active.brand.appName ?? res.active.brand.name ?? 'this brand');
    } catch (err) {
      onError([err instanceof ApiError && err.detail ? err.detail : 'Could not save those brand details.']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="admin-brand-form">
      <h3>Brand details</h3>
      <p class="settings-note">
        Saved as a new version, exactly like an installed package — so it shows up in the history below, rolls back the same way,
        and can be downloaded as a package to move to another site. The stylesheet and icons stay as they are.
      </p>
      <label>
        Brand id
        <input value={draft.id ?? ''} onInput={set('id')} placeholder="my-library" disabled={saving} />
      </label>
      <label>
        App name
        <input value={draft.appName ?? ''} onInput={set('appName')} placeholder="Shown in the tab and on the home screen" disabled={saving} />
      </label>
      <label>
        Library name
        <input value={draft.name ?? ''} onInput={set('name')} disabled={saving} />
      </label>
      <label>
        Short name
        <input value={draft.shortName ?? ''} onInput={set('shortName')} placeholder="Home-screen label" disabled={saving} />
      </label>
      <label>
        Tagline
        <input value={draft.tagline ?? ''} onInput={set('tagline')} disabled={saving} />
      </label>
      <label>
        Author or publisher
        <input value={draft.author ?? ''} onInput={set('author')} disabled={saving} />
      </label>
      <label>
        Theme colour
        <input type="color" value={draft.themeColor ?? '#ffffff'} onInput={set('themeColor')} disabled={saving} />
      </label>
      <label>
        Background colour
        <input type="color" value={draft.backgroundColor ?? '#ffffff'} onInput={set('backgroundColor')} disabled={saving} />
      </label>
      <label>
        Default theme
        <select value={draft.defaultTheme ?? 'light'} onChange={set('defaultTheme')} disabled={saving}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      {FONT_ROLES.map((role) => (
        <label key={role}>
          {role[0].toUpperCase() + role.slice(1)} font
          <select value={draft.fonts?.[role] ?? ''} onChange={setFont(role)} disabled={saving || families.length === 0}>
            <option value="">Whatever the stylesheet sets</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p class="settings-note">
        Only these families ship with the build, so only these can be selected. Custom font upload is a later phase.
      </p>
      <button class="btn-primary" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save brand details'}
      </button>
    </div>
  );
}
