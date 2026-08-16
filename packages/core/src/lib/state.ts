import { signal, computed } from '@preact/signals';
import type { ConsumptionMode, LibraryManifest, Progress, Settings } from './types';
import { BRAND, contentUrl } from '../brand';
import { readerDefaultMode } from '../presentation';
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

export const hasNewContent = computed(
  () => (manifest.value?.libraryVersion ?? 0) > lastSeenLibraryVersion.value && lastSeenLibraryVersion.value > 0
);

export function progressKey(bookId: string, chapterId: string): string {
  return `${bookId}/${chapterId}`;
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

const SYNCED_PREF_KEYS = ['defaultMode', 'readAlong', 'theme', 'fontScale', 'lineHeight', 'narratorVoice', 'keepAwake', 'autoPlayNextStory'] as const;

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

function applyTheme(): void {
  const t = settings.value.theme === 'auto' ? BRAND.defaultTheme : settings.value.theme;
  document.documentElement.dataset.theme = t;
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
  const v = manifest.value?.libraryVersion ?? 0;
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
