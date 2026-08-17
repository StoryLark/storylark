import { signal, computed } from '@preact/signals';
import type { ConsumptionMode, LibraryManifest, Progress, Settings } from './types';
import { BRAND, contentUrl } from '../brand';
import { PRESENTATION, readerDefaultMode } from '../presentation';
import { BRAND_LOOK, applyReaderTheme, resolveReaderTheme, resolveVariant } from './reader-themes';
import { idb } from './db';
import { api, type AuthUser } from './api';

export const user = signal<AuthUser | null>(null);
/**
 * Has the "who is signed in?" question been ANSWERED yet (AB#7416)?
 *
 * Only matters for `auth.required`: `user` is null both before the session
 * check has run and after it has come back empty, and a gate that cannot tell
 * those apart flashes a sign-in form at every already-signed-in reader on every
 * cold start.
 */
export const authChecked = signal(false);
export const manifest = signal<LibraryManifest | null>(null);
export const progressMap = signal<Map<string, Progress>>(new Map());
export const online = signal(navigator.onLine);
export const lastSeenLibraryVersion = signal(0);

export const settings = signal<Settings>({
  fontScale: 2,
  lineHeight: 1.7,
  theme: 'auto',
  // '' — this library's own theme.css (AB#7412). The DEPLOYMENT can force a
  // different one via presentation `readerTheme.forced`, which applyTheme()
  // honours over whatever is saved here; it is not merged into this default,
  // because a forced look must keep winning if the admin changes it later.
  readerTheme: BRAND_LOOK,
  readAlong: 'word',
  // The DEPLOYMENT's default, from presentation `reader.defaultMode`
  // (AB#7416) — not an override. Anything saved in IndexedDB or synced from
  // the account wins over it in bootstrap() below, so a reader who has already
  // chosen a mode keeps their choice when the deployment changes its default.
  defaultMode: readerDefaultMode(),
  autoSync: true,
  autoDownload: false,
  narratorVoice: '',
  keepAwake: true,
  autoPlayNextStory: false,
});

/** Per-item consumption-mode overrides (key: bookId/chapterId). */
export const itemModes = signal<Record<string, ConsumptionMode>>({});

export async function setItemMode(bookId: string, chapterId: string, mode: ConsumptionMode): Promise<void> {
  itemModes.value = { ...itemModes.value, [progressKey(bookId, chapterId)]: mode };
  await idb.put('kv', itemModes.value, 'itemModes');
}

export function modeFor(bookId: string, chapterId: string): ConsumptionMode {
  return itemModes.value[progressKey(bookId, chapterId)] ?? settings.value.defaultMode;
}

/**
 * The version a reader is TOLD about, as distinct from the one that makes the
 * app re-fetch (AB#7420 — plan §3).
 *
 * `libraryVersion` moves on every change to the library, corrections included,
 * because it is what `/api/library/version` is compared against and therefore
 * the only thing that makes a corrected chapter reach anyone at all.
 * `announceVersion` moves only for a genuine publication. Fixing a typo must
 * not badge the library as having new content the way a new chapter does.
 *
 * Absent on a manifest written before this existed, and then this is exactly
 * the old behaviour — which is also why `markLibrarySeen` records the same
 * derived value rather than `libraryVersion` directly.
 */
export function announceVersionOf(m: LibraryManifest | null): number {
  const v = (m as { announceVersion?: unknown } | null)?.announceVersion;
  return typeof v === 'number' ? v : (m?.libraryVersion ?? 0);
}

export const hasNewContent = computed(
  () => announceVersionOf(manifest.value) > lastSeenLibraryVersion.value && lastSeenLibraryVersion.value > 0
);

export function progressKey(bookId: string, chapterId: string): string {
  return `${bookId}/${chapterId}`;
}

/**
 * Apply an ADMIN-FORCED look before anything has been read from storage
 * (AB#7412).
 *
 * bootstrap() is async — it opens IndexedDB before it can call applyTheme() —
 * so without this a deployment that forces Wireless would paint its own palette
 * first and repaint a beat later. A forced look is the one case that needs no
 * stored state to resolve, so it can be applied during module evaluation, from
 * the presentation the document was served with.
 *
 * The variant is the look's own default here rather than the reader's, which is
 * not yet known; applyTheme() corrects it moments later. That leaves at worst
 * the light/dark flash the app already has, instead of adding a palette flash
 * on top of it. A no-op when nothing is forced — an unforced look depends on a
 * saved preference and genuinely cannot be known this early.
 */
export function preapplyForcedReaderTheme(): void {
  const resolved = resolveReaderTheme(PRESENTATION.readerTheme, undefined);
  if (!resolved.forced || !resolved.active) return;
  document.documentElement.dataset.theme = resolved.active.defaultVariant;
  applyReaderTheme(document.documentElement, resolved.active, resolved.active.defaultVariant);
}

export async function bootstrap(): Promise<void> {
  window.addEventListener('online', () => (online.value = true));
  window.addEventListener('offline', () => (online.value = false));

  const savedSettings = await idb.get<Settings>('kv', 'settings');
  if (savedSettings) settings.value = { ...settings.value, ...savedSettings };
  applyTheme();

  const savedModes = await idb.get<Record<string, ConsumptionMode>>('kv', 'itemModes');
  if (savedModes) itemModes.value = savedModes;

  const savedVersion = await idb.get<number>('kv', 'lastSeenLibraryVersion');
  if (savedVersion) lastSeenLibraryVersion.value = savedVersion;

  const local = await idb.getAll<Progress>('progress');
  progressMap.value = new Map(local.map((p) => [progressKey(p.bookId, p.chapterId), p]));

  await Promise.all([loadManifest(), loadUser()]);
}

const SYNCED_PREF_KEYS = [
  'defaultMode',
  'readAlong',
  'theme',
  // The chosen LOOK syncs for the same reason light/dark does: it is how this
  // reader wants to read, and a second device that showed them a different
  // palette would be a bug. It is still only ever a preference — the resolver
  // ignores it wherever the deployment has forced a look.
  'readerTheme',
  'fontScale',
  'lineHeight',
  'narratorVoice',
  'keepAwake',
  'autoPlayNextStory',
] as const;

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  settings.value = { ...settings.value, ...patch };
  await idb.put('kv', settings.value, 'settings');
  applyTheme();
  // Mirror the account-synced settings subset to the server when signed in.
  if (user.value && Object.keys(patch).some((k) => (SYNCED_PREF_KEYS as readonly string[]).includes(k))) {
    void pushPreferences();
  }
}

/** Push the account-synced settings subset to the server (no-op when signed out). */
export async function pushPreferences(): Promise<void> {
  if (!user.value) return;
  try {
    await api.putPreferences(
      {
        defaultMode: settings.value.defaultMode,
        readAlong: settings.value.readAlong,
        theme: settings.value.theme,
        readerTheme: settings.value.readerTheme,
        fontScale: settings.value.fontScale,
        lineHeight: settings.value.lineHeight,
        keepAwake: settings.value.keepAwake,
        autoPlayNextStory: settings.value.autoPlayNextStory,
      },
      Date.now()
    );
  } catch {
    // offline or transient; the next settings change retries
  }
}

/** Pull account preferences and apply the synced subset over local settings. */
export async function pullPreferences(): Promise<void> {
  if (!user.value) return;
  try {
    const { prefs } = await api.getPreferences();
    if (prefs && Object.keys(prefs).length > 0) {
      const patch: Partial<Settings> = {};
      for (const k of SYNCED_PREF_KEYS) {
        if (k in prefs) (patch as Record<string, unknown>)[k] = prefs[k];
      }
      settings.value = { ...settings.value, ...patch };
      await idb.put('kv', settings.value, 'settings');
      applyTheme();
    }
  } catch {
    // offline or no server preferences yet
  }
}

/**
 * Put the reader's display preferences onto `<html>` — the LOOK, then light or
 * dark within it, then the reading measurements.
 *
 * Order matters between the first two only in the sense that both are read from
 * the same resolution: `data-theme` and the inline token block have to agree, or
 * the stylesheet's `:root[data-theme="dark"]` rules and the look's inline values
 * would describe two different themes at once. Resolving once and applying both
 * from that one answer is what keeps them honest.
 *
 * The single call site for every change (bootstrap, saveSettings,
 * pullPreferences) is deliberate: a forced look has to be applied to a reader
 * whose saved preference says otherwise, and the moments that reader's settings
 * arrive are exactly these three.
 */
function applyTheme(): void {
  const resolved = resolveReaderTheme(PRESENTATION.readerTheme, settings.value.readerTheme);
  const variant = resolveVariant(settings.value.theme, resolved.active, BRAND.defaultTheme);
  document.documentElement.dataset.theme = variant;
  applyReaderTheme(document.documentElement, resolved.active, variant);
  document.documentElement.style.setProperty('--reader-font-scale', String([0.85, 0.95, 1, 1.15, 1.3][settings.value.fontScale] ?? 1));
  document.documentElement.style.setProperty('--reader-line-height', String(settings.value.lineHeight));
}

export async function loadManifest(): Promise<void> {
  try {
    const res = await fetch(contentUrl('manifest.json'), { cache: 'no-cache' });
    if (res.ok) {
      const m = (await res.json()) as LibraryManifest;
      manifest.value = m;
      await idb.put('kv', m, 'manifest');
      return;
    }
  } catch {
    // offline — fall through to cache
  }
  const cached = await idb.get<LibraryManifest>('kv', 'manifest');
  if (cached) manifest.value = cached;
}

export async function markLibrarySeen(): Promise<void> {
  const v = announceVersionOf(manifest.value);
  lastSeenLibraryVersion.value = v;
  await idb.put('kv', v, 'lastSeenLibraryVersion');
}

async function loadUser(): Promise<void> {
  try {
    const me = await api.me();
    user.value = me.user;
    void pullPreferences();
  } catch {
    user.value = null;
  } finally {
    authChecked.value = true;
  }
}
