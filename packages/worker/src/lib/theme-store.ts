/**
 * Installed themes: import, versions, rollback (AB#7417 — plan §0c / §0d Phase 4).
 *
 * ── The problem this closes ─────────────────────────────────────────────────
 * Phases 2 and 3 made brand and presentation runtime DATA — `dist/brand.json`,
 * `dist/theme.css`, `dist/presentation.json`, re-read by the serving platform on
 * every request, so replacing one of those files changes a live site with no
 * rebuild. Proven, twice. But "replace the file" still meant an operator with
 * shell access to the deployment's static assets, which on Cloudflare does not
 * exist at all: `env.ASSETS` is an immutable snapshot of the build, and a Worker
 * cannot write to it. The swap was possible and nobody could perform it.
 *
 * ── Where an imported theme actually lives ──────────────────────────────────
 * In the deployment's own writable storage — the SAME `ContentStore` seam that
 * Phase §3's content editing already binds on both platforms (R2 on Cloudflare,
 * Azure Blob or a local directory on Node). No new binding, no new credential,
 * nothing platform-specific:
 *
 *     themes/active.json                     what this deployment is wearing
 *     themes/index.json                      the version history
 *     themes/versions/<vid>/package.json     the manifest, as imported
 *     themes/versions/<vid>/brand.json
 *     themes/versions/<vid>/theme.css
 *     themes/versions/<vid>/presentation.json  (when the package carried one)
 *     themes/versions/<vid>/icons/<name>
 *
 * The build's `dist/brand.json` etc. remain the FALLBACK: with nothing imported,
 * a deployment behaves exactly as it did before this file existed. That is what
 * makes this phase additive — an upgrade cannot change how an existing site
 * looks until somebody imports something.
 *
 * ── Why active.json carries the brand rather than pointing at it ────────────
 * `themes/active.json` is read on the way out of EVERY html and sw.js response,
 * so its cost is the hot path. Holding the (small, already-validated) brand and
 * presentation objects inline makes that one storage read; pointing at the
 * version directory would make it three. The version directory is not a second
 * source of truth — it is the archive rollback reads from, and both writers
 * here derive `active.json` from a version directory at the moment they write
 * it, so the two cannot drift.
 *
 * `theme.css` and the icons are NOT inlined: they are needed only by /theme.css
 * and /icons/*, which are their own requests, and putting 2KB of CSS plus 70KB
 * of PNG into every HTML response would be a strange way to save a lookup.
 *
 * ── Write order, so a bad import cannot half-apply ──────────────────────────
 * Version files first, then the index, then `active.json` LAST — the same rule
 * `content.ts` follows when it writes a chapter before the manifest that points
 * at it. Validation happens before any write at all, so a package that fails is
 * a pure no-op; a package that passes and then hits a storage error leaves an
 * orphaned version directory and a deployment still wearing what it wore. Both
 * failure modes are safe, and neither is "half a theme".
 *
 * ── One validator, three doors ──────────────────────────────────────────────
 * `storylark-contracts/theme-package` is the same module `npm run package-theme`
 * uses to BUILD a package. The portal upload, the CLI import and the packager
 * cannot disagree about what a valid theme is, because none of them decides.
 */

import {
  readThemePackage,
  buildThemePackage,
  ThemePackageError,
  REQUIRED_ICONS,
  OPTIONAL_ICONS,
  type ThemeManifest,
} from 'storylark-contracts/theme-package';
import type { Env } from '../types';
import { getJson, getText, putJson, IMMUTABLE, SHORT, type ContentStore } from './content-store';

/** Where a theme import came from. Recorded per version, shown in the portal. */
export type ThemeSource = 'portal' | 'cli' | 'form';

/** One entry in `themes/index.json`. Shaped after RevisionEntry (plan §3) on purpose. */
export interface ThemeVersion {
  /** Monotonic id, also the storage prefix: themes/versions/<id>/ */
  id: string;
  /** The theme's own id — `brand.json.id`. */
  themeId: string;
  name: string;
  /** The package's stated version, from its package.json. */
  version: string;
  importedAt: number;
  /** Email or username of whoever imported it; 'cli' for a key-authenticated import. */
  importedBy: string;
  source: ThemeSource;
  /** True for the version currently being served. Pinned: never aged out. */
  live: boolean;
  /** Size of the package as imported, in bytes. */
  bytes: number;
  hasPresentation: boolean;
  /** Bare icon file names carried by this version. Empty for a form edit. */
  icons: string[];
  /** storylark-core version the package was built against, when it said. */
  engine?: string;
}

export interface ThemeIndex {
  schemaVersion: 1;
  versions: ThemeVersion[];
}

/** `themes/active.json` — the record the serving path reads. */
export interface ActiveTheme {
  schemaVersion: 1;
  versionId: string;
  themeId: string;
  name: string;
  version: string;
  importedAt: number;
  importedBy: string;
  source: ThemeSource;
  /** The validated brand identity, ready to inject. */
  brand: Record<string, unknown>;
  /** The validated presentation, or null when the package carried none. */
  presentation: Record<string, unknown> | null;
  /** Bare icon names this version overrides. */
  icons: string[];
}

export const ACTIVE_KEY = 'themes/active.json';
export const INDEX_KEY = 'themes/index.json';

export const themeKey = {
  version: (id: string) => `themes/versions/${id}`,
  manifest: (id: string) => `themes/versions/${id}/package.json`,
  brand: (id: string) => `themes/versions/${id}/brand.json`,
  presentation: (id: string) => `themes/versions/${id}/presentation.json`,
  css: (id: string) => `themes/versions/${id}/theme.css`,
  icon: (id: string, name: string) => `themes/versions/${id}/icons/${name}`,
};

/**
 * How many theme versions to keep. Five by default, deliberately the same
 * number and the same shape as the five text revisions §3 keeps per chapter —
 * an operator who has learnt one safety net should not have to learn a second.
 * `THEME_VERSIONS` in the deployment's environment overrides it.
 *
 * A theme is ~70KB, so five of them is a third of a megabyte. The ceiling
 * exists to stop an accident, not to save money.
 */
export const DEFAULT_THEME_VERSIONS = 5;

export function themeVersionLimit(env: Env): number {
  const raw = Number(env.THEME_VERSIONS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_THEME_VERSIONS;
  return Math.min(Math.floor(raw), 50);
}

/** The icon names an import may override, for the portal to show and the CLI to explain. */
export const KNOWN_ICONS = [...Object.keys(REQUIRED_ICONS), ...Object.keys(OPTIONAL_ICONS)];

export async function readActiveTheme(store: ContentStore): Promise<ActiveTheme | null> {
  const doc = await getJson<ActiveTheme>(store, ACTIVE_KEY);
  if (!doc || typeof doc !== 'object' || typeof doc.versionId !== 'string') return null;
  return doc;
}

export async function readThemeIndex(store: ContentStore): Promise<ThemeIndex> {
  const doc = await getJson<ThemeIndex>(store, INDEX_KEY);
  if (!doc || !Array.isArray(doc.versions)) return { schemaVersion: 1, versions: [] };
  return doc;
}

/** Newest first — the order the portal lists them in. */
export async function listThemeVersions(store: ContentStore): Promise<ThemeVersion[]> {
  const index = await readThemeIndex(store);
  return index.versions.slice().sort((a, b) => b.importedAt - a.importedAt);
}

export interface ImportResult {
  version: ThemeVersion;
  warnings: string[];
  /** What the deployment is wearing now — the portal echoes it back to prove the swap. */
  active: ActiveTheme;
}

export interface ImportArgs {
  store: ContentStore;
  env: Env;
  /** The uploaded archive. */
  bytes: Uint8Array;
  importedBy: string;
  source: ThemeSource;
  /** The curated font set, when the caller has one to check the brand against. */
  fontFamilies?: string[];
}

/**
 * Validate a package and, only if it is completely valid, make it the live
 * theme.
 *
 * Throws `ThemePackageError` — carrying every problem, not just the first — for
 * anything wrong with the package. Nothing has been written when it throws.
 */
export async function importThemePackage(args: ImportArgs): Promise<ImportResult> {
  const { store, env, bytes, importedBy, source } = args;

  // 1. Validate. Before this returns, no storage call has been made.
  const pkg = await readThemePackage(bytes, { fontFamilies: args.fontFamilies });

  const index = await readThemeIndex(store);
  const id = nextVersionId(index.versions);
  const version: ThemeVersion = {
    id,
    themeId: String(pkg.brand.id ?? pkg.manifest.id ?? 'theme'),
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    importedAt: Date.now(),
    importedBy,
    source,
    live: true,
    bytes: bytes.length,
    hasPresentation: pkg.presentation !== undefined,
    icons: [...pkg.icons.keys()].sort(),
    ...(pkg.manifest.engine ? { engine: pkg.manifest.engine } : {}),
  };

  // 2. The version directory. Immutable caching is safe and correct: the id is
  //    unique per import, so these keys are never rewritten.
  await putJson(store, themeKey.manifest(id), pkg.manifest, true);
  await putJson(store, themeKey.brand(id), pkg.brand, true);
  if (pkg.presentation !== undefined) await putJson(store, themeKey.presentation(id), pkg.presentation, true);
  await store.put(themeKey.css(id), pkg.themeCss, { contentType: 'text/css; charset=utf-8', cacheControl: IMMUTABLE });
  for (const [name, data] of pkg.icons) {
    await store.put(themeKey.icon(id, name), data, { contentType: iconContentType(name), cacheControl: IMMUTABLE });
  }

  // 3. Index, then active — in that order, so a crash between them leaves a
  //    recorded version that simply isn't live yet.
  await writeIndexWithLive(store, env, index, version);
  const active = await activate(store, version, pkg.brand, pkg.presentation ?? null);

  return { version, warnings: pkg.warnings, active };
}

/**
 * Roll back to a version already in the history — the one-click part of §0c's
 * "versioned, with one-click rollback".
 *
 * Re-reads the stored version's own files rather than trusting the index entry,
 * so a rollback restores exactly the bytes that were imported. Returns null when
 * the version is gone (aged out, or never existed).
 */
export async function activateThemeVersion(
  store: ContentStore,
  env: Env,
  versionId: string
): Promise<{ version: ThemeVersion; active: ActiveTheme } | null> {
  const index = await readThemeIndex(store);
  const entry = index.versions.find((v) => v.id === versionId);
  if (!entry) return null;

  const brand = await getJson<Record<string, unknown>>(store, themeKey.brand(versionId));
  if (!brand) return null; // the archive is gone; the index entry is a tombstone
  const presentation = entry.hasPresentation
    ? await getJson<Record<string, unknown>>(store, themeKey.presentation(versionId))
    : null;

  await writeIndexWithLive(store, env, index, entry);
  const active = await activate(store, entry, brand, presentation ?? null);
  return { version: entry, active };
}

/**
 * Stop overriding: go back to whatever the BUILD ships.
 *
 * Deliberately deletes only the pointer. The version history stays, so
 * "uninstall" is as reversible as every other move here — which matters, because
 * on a deployment with no shell the alternative to a mistake being reversible is
 * a rebuild.
 */
export async function clearActiveTheme(store: ContentStore): Promise<void> {
  const index = await readThemeIndex(store);
  let changed = false;
  for (const v of index.versions) {
    if (v.live) {
      v.live = false;
      changed = true;
    }
  }
  if (changed) await putJson(store, INDEX_KEY, index, false);
  await store.delete(ACTIVE_KEY);
}

/**
 * Save a brand edited in the portal's form (plan §0c: "portal form AND package,
 * not either/or").
 *
 * A form edit is a VERSION like any other, so it appears in the same history,
 * rolls back the same way, and can be exported as a package. What it is not is a
 * second storage mechanism with its own rules.
 *
 * It inherits the current version's stylesheet, icons and presentation by
 * reference — a colour change must not silently drop the icons that were
 * imported alongside them. With nothing imported yet, it inherits nothing and
 * the deployment keeps serving the BUILD's theme.css and icons, overriding only
 * the identity: which is exactly what "change a colour without cloning a repo"
 * should mean.
 */
export async function saveBrandForm(args: {
  store: ContentStore;
  env: Env;
  brand: Record<string, unknown>;
  savedBy: string;
}): Promise<{ version: ThemeVersion; active: ActiveTheme }> {
  const { store, env, brand, savedBy } = args;
  const current = await readActiveTheme(store);
  const index = await readThemeIndex(store);
  const id = nextVersionId(index.versions);

  // Inherit the look from whatever is live. Copied, not linked: a version has to
  // be self-contained or rolling back to it after the version it borrowed from
  // aged out would restore a theme with no stylesheet.
  const inheritedCss = current ? await getText(store, themeKey.css(current.versionId)) : null;
  const inheritedIcons: [string, Uint8Array][] = [];
  if (current) {
    for (const name of current.icons) {
      const obj = await store.get(themeKey.icon(current.versionId, name));
      if (obj) inheritedIcons.push([name, new Uint8Array(obj.body)]);
    }
  }
  const presentation = current?.presentation ?? null;

  const manifest: ThemeManifest = {
    formatVersion: 1,
    id: String(brand.id ?? current?.themeId ?? 'brand'),
    name: String(brand.appName ?? brand.name ?? current?.name ?? 'Brand'),
    version: bumpForm(current?.version),
    contractVersion: typeof brand.contractVersion === 'number' ? brand.contractVersion : 1,
    hasPresentation: presentation !== null,
  };

  await putJson(store, themeKey.manifest(id), manifest, true);
  await putJson(store, themeKey.brand(id), brand, true);
  if (presentation) await putJson(store, themeKey.presentation(id), presentation, true);
  if (inheritedCss !== null) {
    await store.put(themeKey.css(id), inheritedCss, { contentType: 'text/css; charset=utf-8', cacheControl: IMMUTABLE });
  }
  for (const [name, data] of inheritedIcons) {
    await store.put(themeKey.icon(id, name), data, { contentType: iconContentType(name), cacheControl: IMMUTABLE });
  }

  const version: ThemeVersion = {
    id,
    themeId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    importedAt: Date.now(),
    importedBy: savedBy,
    source: 'form',
    live: true,
    bytes: 0,
    hasPresentation: presentation !== null,
    icons: inheritedIcons.map(([n]) => n).sort(),
  };

  await writeIndexWithLive(store, env, index, version);
  const active = await activate(store, version, brand, presentation);
  return { version, active };
}

/**
 * Save a presentation edited in the portal (AB#7412).
 *
 * The mirror image of saveBrandForm above, and for the same reason: the portal
 * needed a way to change ONE presentation key — which reader themes are offered,
 * and whether one is forced — on a deployment whose static assets nobody can
 * reach. It writes a normal version, so it lands in the same history, rolls back
 * with the same button, and exports as the same package.
 *
 * ── Why the caller sends the WHOLE presentation ─────────────────────────────
 * `themes/active.json`'s presentation, when it is set, REPLACES the deployment's
 * own dist/presentation.json on the serving path — a theme package states a
 * whole arrangement, not a patch (see livePresentation in ../index.ts). So
 * storing `{readerTheme: …}` alone would silently delete this library's nouns,
 * its tab order and its empty-state copy the moment an operator flipped a
 * theme switch. The obvious fix — read the asset here and merge — is not
 * available: `env.ASSETS` exists only on Cloudflare, and the Node/Azure entry
 * serves those files off its own disk with no binding this module can reach.
 *
 * The portal, on the other hand, has the live presentation already: it is
 * injected into admin.html and it is exactly what the reader app resolves
 * against. So the client sends the whole stated document with its one key
 * changed, and this function stores it whole. One source, no merge, and no
 * platform-specific read.
 *
 * Brand, stylesheet and icons are inherited from the live version by copy, for
 * the reason saveBrandForm spells out: a version has to be self-contained or a
 * rollback to it after its neighbour aged out would restore half a theme.
 */
export async function savePresentationForm(args: {
  store: ContentStore;
  env: Env;
  presentation: Record<string, unknown>;
  savedBy: string;
  /** The brand to record when nothing is installed yet — the build's own. */
  fallbackBrand?: Record<string, unknown>;
}): Promise<{ version: ThemeVersion; active: ActiveTheme }> {
  const { store, env, presentation, savedBy } = args;
  const current = await readActiveTheme(store);
  const index = await readThemeIndex(store);
  const id = nextVersionId(index.versions);

  const brand = current?.brand ?? args.fallbackBrand ?? {};
  const inheritedCss = current ? await getText(store, themeKey.css(current.versionId)) : null;
  const inheritedIcons: [string, Uint8Array][] = [];
  if (current) {
    for (const name of current.icons) {
      const obj = await store.get(themeKey.icon(current.versionId, name));
      if (obj) inheritedIcons.push([name, new Uint8Array(obj.body)]);
    }
  }

  const manifest: ThemeManifest = {
    formatVersion: 1,
    id: String(brand.id ?? current?.themeId ?? 'brand'),
    name: String(brand.appName ?? brand.name ?? current?.name ?? 'Brand'),
    version: bumpForm(current?.version),
    contractVersion: typeof brand.contractVersion === 'number' ? brand.contractVersion : 1,
    hasPresentation: true,
  };

  await putJson(store, themeKey.manifest(id), manifest, true);
  await putJson(store, themeKey.brand(id), brand, true);
  await putJson(store, themeKey.presentation(id), presentation, true);
  if (inheritedCss !== null) {
    await store.put(themeKey.css(id), inheritedCss, { contentType: 'text/css; charset=utf-8', cacheControl: IMMUTABLE });
  }
  for (const [name, data] of inheritedIcons) {
    await store.put(themeKey.icon(id, name), data, { contentType: iconContentType(name), cacheControl: IMMUTABLE });
  }

  const version: ThemeVersion = {
    id,
    themeId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    importedAt: Date.now(),
    importedBy: savedBy,
    source: 'form',
    live: true,
    bytes: 0,
    hasPresentation: true,
    icons: inheritedIcons.map(([n]) => n).sort(),
  };

  await writeIndexWithLive(store, env, index, version);
  const active = await activate(store, version, brand, presentation);
  return { version, active };
}

/**
 * Rebuild a stored version as a downloadable package.
 *
 * Rebuilt rather than kept: `buildThemePackage` is deterministic, so the bytes
 * are the bytes, and the alternative — storing the uploaded archive alongside
 * its own contents — would double the storage for a file that can be recreated
 * exactly. It also means a download is guaranteed to be a package that passes
 * validation, including for the version a portal FORM produced, which never had
 * an archive in the first place. That is what turns "tweak a colour in the
 * portal" into something you can move to another deployment.
 */
export async function exportThemeVersion(
  store: ContentStore,
  versionId: string
): Promise<{ bytes: Uint8Array; version: ThemeVersion } | null> {
  const index = await readThemeIndex(store);
  const entry = index.versions.find((v) => v.id === versionId);
  if (!entry) return null;
  const brand = await getJson<Record<string, unknown>>(store, themeKey.brand(versionId));
  const themeCss = await getText(store, themeKey.css(versionId));
  if (!brand || themeCss === null) return null;
  const presentation = entry.hasPresentation
    ? ((await getJson<Record<string, unknown>>(store, themeKey.presentation(versionId))) ?? undefined)
    : undefined;
  const icons = new Map<string, Uint8Array>();
  for (const name of entry.icons) {
    const obj = await store.get(themeKey.icon(versionId, name));
    if (obj) icons.set(name, new Uint8Array(obj.body));
  }
  const built = await buildThemePackage({ brand, presentation, themeCss, icons, version: entry.version, engine: entry.engine });
  return { bytes: built.bytes, version: entry };
}

/** Read one icon out of the live theme, or null when it doesn't override that name. */
export async function readActiveIcon(
  store: ContentStore,
  active: ActiveTheme,
  name: string
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  if (!active.icons.includes(name)) return null;
  const obj = await store.get(themeKey.icon(active.versionId, name));
  if (!obj) return null;
  return { body: obj.body, contentType: obj.contentType ?? iconContentType(name) };
}

/** The live theme's stylesheet, or null when it doesn't override one. */
export async function readActiveCss(store: ContentStore, active: ActiveTheme): Promise<string | null> {
  return getText(store, themeKey.css(active.versionId));
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * Mark exactly one version live, then prune to the limit.
 *
 * Pruning never removes the live version. Belt and braces (the live one is
 * always the newest at this point), but written as an explicit rule for the
 * same reason content.ts writes it: rollback re-points what "live" means, and a
 * future change to the ordering must not be able to delete the only copy of
 * what a site is currently wearing.
 */
async function writeIndexWithLive(store: ContentStore, env: Env, index: ThemeIndex, entry: ThemeVersion): Promise<void> {
  for (const v of index.versions) v.live = false;
  const existing = index.versions.findIndex((v) => v.id === entry.id);
  if (existing >= 0) index.versions[existing] = { ...entry, live: true };
  else index.versions.push({ ...entry, live: true });

  const limit = themeVersionLimit(env);
  const byAge = () => index.versions.filter((v) => !v.live).sort((a, b) => a.importedAt - b.importedAt)[0];
  while (index.versions.length > limit) {
    const victim = byAge();
    if (!victim) break;
    index.versions.splice(index.versions.indexOf(victim), 1);
    await deleteVersionFiles(store, victim);
  }
  await putJson(store, INDEX_KEY, index, false);
}

async function deleteVersionFiles(store: ContentStore, v: ThemeVersion): Promise<void> {
  await store.delete(themeKey.manifest(v.id));
  await store.delete(themeKey.brand(v.id));
  await store.delete(themeKey.css(v.id));
  if (v.hasPresentation) await store.delete(themeKey.presentation(v.id));
  for (const name of v.icons) await store.delete(themeKey.icon(v.id, name));
}

/** Write `themes/active.json` — the last write of every path that changes the look. */
async function activate(
  store: ContentStore,
  version: ThemeVersion,
  brand: Record<string, unknown>,
  presentation: Record<string, unknown> | null
): Promise<ActiveTheme> {
  const active: ActiveTheme = {
    schemaVersion: 1,
    versionId: version.id,
    themeId: version.themeId,
    name: version.name,
    version: version.version,
    importedAt: version.importedAt,
    importedBy: version.importedBy,
    source: version.source,
    brand,
    presentation,
    icons: version.icons,
  };
  // SHORT, not IMMUTABLE: this is the one key here that is rewritten in place,
  // and it is read on the serving path. Same policy as the content manifest.
  await putJson(store, ACTIVE_KEY, active, false);
  return active;
}

/** Sortable, collision-free within a millisecond. Mirrors revisionId in content.ts. */
function nextVersionId(existing: ThemeVersion[]): string {
  let candidate = String(Date.now());
  let n = 0;
  while (existing.some((v) => v.id === candidate)) candidate = `${Date.now()}-${++n}`;
  return candidate;
}

/** A form edit gets `<base>+n` so the history reads in order without pretending to be semver. */
function bumpForm(current: string | undefined): string {
  const match = /^(.*?)\+(\d+)$/.exec(current ?? '');
  if (match) return `${match[1]}+${Number(match[2]) + 1}`;
  return `${current && current !== '0.0.0' ? current : '1.0.0'}+1`;
}

function iconContentType(name: string): string {
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

export { ThemePackageError, SHORT };
