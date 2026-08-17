/**
 * Installed engines: install, versions, rollback (AB#7418 — the platform-agnostic
 * half of "Update now").
 *
 * ── The problem this closes ─────────────────────────────────────────────────
 * The one-click update used to work by calling the PLATFORM's deploy API to
 * redeploy the whole site — which is why it diverged by platform: Azure could do
 * it with a managed identity and zero stored credentials, Cloudflare needed an
 * operator-minted API token stored as a Worker secret, and any future platform
 * would need its own answer. But the deploy API was only ever needed because the
 * engine's files lived in the immutable build. theme-store.ts already proved the
 * other way: write the files into the deployment's own ContentStore — the same
 * seam that binds R2 on Cloudflare and Azure Blob (or a local directory) on
 * Node — and have the serving path prefer them over the build. That path needs
 * no platform API, no credential, and is byte-for-byte the same code everywhere.
 *
 * So an engine release's frontend — the hashed bundle, the documents, the
 * service worker — installs exactly the way a theme package does. What this
 * CANNOT replace is the worker's own script: a running Cloudflare Worker
 * genuinely cannot swap its own code (no eval, no remote dynamic import — a
 * platform boundary, not a design choice), so a release that changes
 * storylark-worker still goes through the platform deployer in self-deploy.ts.
 * routes/admin.ts decides which mechanism a given release needs; this module is
 * the mechanism that works everywhere.
 *
 * ── Where an installed engine lives ─────────────────────────────────────────
 *     engine/active.json                 which version is being served (+ its file list)
 *     engine/index.json                  the version history
 *     engine/versions/<vid>/dist/<path>  the engine files, exactly as released
 *
 * The build's own assets remain the FALLBACK: with nothing installed, a
 * deployment behaves exactly as it did before this file existed, and the serving
 * path pays (nearly) nothing — see the negative-result cache in ../index.ts.
 *
 * ── Why the flip is atomic, and why versions are prefixed ───────────────────
 * The HTML references hashed asset filenames, so an engine update replaces BOTH
 * the documents and the assets and they must flip together. `active.json` is
 * that flip: it is written LAST, it names one version, and it carries that
 * version's complete file list inline — so a request resolves the version ONCE
 * (one storage read) and every file it serves comes from that version's prefix.
 * There is no state in which index.html comes from version N and the bundle from
 * version N-1, because nothing ever serves "the newest file"; everything serves
 * "the active version's file".
 *
 * A client that loaded version N-1's HTML just before the flip still requests
 * N-1's hashed assets afterwards. Versioned prefixes are why that works: the old
 * version's files stay readable until history evicts them, and the serving path
 * falls back to the history for a hashed asset the active version doesn't carry.
 *
 * ── Write order, so a bad install cannot half-apply ─────────────────────────
 * Version files first, then the index, then `active.json` LAST — the same rule
 * theme-store.ts and content.ts follow. Validation happens before any write, so
 * a package that fails is a pure no-op; a crash mid-write leaves an orphaned
 * version directory and a deployment still serving what it served.
 *
 * ── The hard safety rule, enforced by construction ──────────────────────────
 * An engine package must NEVER be able to write a deployment's own identity.
 * `readEnginePackage` (storylark-contracts/engine-package) already refuses a
 * package carrying brand.json, theme.css, presentation.json,
 * manifest.webmanifest or icons/ — and this module re-checks `isBrandOwned` on
 * every path it is about to write, so even a caller that skipped validation
 * cannot put a brand file into the engine prefix. Two fences, one rule, defined
 * once in the contracts package.
 */

import { isBrandOwned, EnginePackageError } from 'storylark-contracts/engine-package';
import type { Env } from '../types';
import type { EnginePackage } from './self-deploy';
import { contentTypeFor } from './self-deploy';
import { getJson, putJson, IMMUTABLE, type ContentStore } from './content-store';

/** Where an engine install came from. Mirrors ThemeSource. */
export type EngineSource = 'portal' | 'cli';

/** One entry in `engine/index.json`. Shaped after ThemeVersion on purpose. */
export interface EngineVersion {
  /** Monotonic id, also the storage prefix: engine/versions/<id>/ */
  id: string;
  /** storylark-core's version — the release identity. */
  coreVersion: string;
  /** The storylark-worker version this engine was released with. */
  workerVersion: string;
  installedAt: number;
  installedBy: string;
  source: EngineSource;
  /** sha256 of the artifact this version was installed from. */
  sha256: string;
  /** Artifact size in bytes, for the portal to show. */
  bytes: number;
  /** True for the version currently being served. Pinned: never aged out. */
  live: boolean;
  /** Every dist-relative path this version carries. The serving path's map. */
  files: string[];
}

export interface EngineIndex {
  schemaVersion: 1;
  versions: EngineVersion[];
}

/**
 * `engine/active.json` — the record the serving path reads, once per request.
 *
 * Carries the file list inline for the same reason ActiveTheme carries the
 * brand inline: this key is the hot path, and "is /assets/x.js one of ours" has
 * to be answerable from the one read that resolved the version.
 */
export interface ActiveEngine {
  schemaVersion: 1;
  versionId: string;
  coreVersion: string;
  workerVersion: string;
  installedAt: number;
  installedBy: string;
  sha256: string;
  files: string[];
}

export const ENGINE_ACTIVE_KEY = 'engine/active.json';
export const ENGINE_INDEX_KEY = 'engine/index.json';

export const engineKey = {
  version: (id: string) => `engine/versions/${id}`,
  file: (id: string, path: string) => `engine/versions/${id}/dist/${path}`,
};

/**
 * How many engine versions to keep. Five, deliberately the same number as the
 * theme store's five versions and §3's five text revisions — one safety-net
 * convention, learnt once. `ENGINE_VERSIONS` in the environment overrides it.
 *
 * An engine is ~4MB, so five of them is ~20MB of storage. The ceiling exists to
 * stop an accident, not to save money — and the floor of 2 (not 1) is
 * load-bearing: a client that loaded the previous version's HTML mid-update
 * needs that version's assets to stay readable until it reloads.
 */
export const DEFAULT_ENGINE_VERSIONS = 5;

export function engineVersionLimit(env: Env): number {
  const raw = Number(env.ENGINE_VERSIONS);
  if (!Number.isFinite(raw) || raw < 2) return DEFAULT_ENGINE_VERSIONS;
  return Math.min(Math.floor(raw), 20);
}

export async function readActiveEngine(store: ContentStore): Promise<ActiveEngine | null> {
  const doc = await getJson<ActiveEngine>(store, ENGINE_ACTIVE_KEY);
  if (!doc || typeof doc !== 'object' || typeof doc.versionId !== 'string' || !Array.isArray(doc.files)) return null;
  return doc;
}

/**
 * How long "no engine installed" may be believed without re-asking storage.
 *
 * A POSITIVE answer is never cached — an install or rollback takes effect on
 * the next request, same per-request rule the theme store lives by. The
 * NEGATIVE is cached briefly because `run_worker_first` now routes /assets/*
 * through the Worker, putting this check on every asset request, and a
 * deployment with nothing installed (the default, and day-one state of every
 * deployment) should not pay a storage read per font file for a feature it is
 * not using.
 *
 * The cache lives HERE, beside the writers, so an install / rollback / clear
 * in this isolate resets it in the same breath (see the reset calls below) —
 * the operator who clicked the button sees the flip immediately. Another
 * isolate discovers it within the TTL for documents, and immediately for
 * hashed assets, via the fresh re-check the serving path performs before
 * answering an asset request the build cannot satisfy.
 */
export const NO_ENGINE_TTL_MS = 10_000;
let noEngineUntil = 0;

/** Forget any cached "no engine" answer. Called by every writer here. */
export function resetEngineCache(): void {
  noEngineUntil = 0;
}

/** readActiveEngine with the negative-result cache. `fresh` bypasses it. */
export async function readActiveEngineCached(
  store: ContentStore,
  opts: { fresh?: boolean } = {}
): Promise<ActiveEngine | null> {
  if (!opts.fresh && Date.now() < noEngineUntil) return null;
  const active = await readActiveEngine(store);
  noEngineUntil = active ? 0 : Date.now() + NO_ENGINE_TTL_MS;
  return active;
}

export async function readEngineIndex(store: ContentStore): Promise<EngineIndex> {
  const doc = await getJson<EngineIndex>(store, ENGINE_INDEX_KEY);
  if (!doc || !Array.isArray(doc.versions)) return { schemaVersion: 1, versions: [] };
  return doc;
}

/** Newest first — the order the portal lists them in. */
export async function listEngineVersions(store: ContentStore): Promise<EngineVersion[]> {
  const index = await readEngineIndex(store);
  return index.versions.slice().sort((a, b) => b.installedAt - a.installedAt);
}

export interface EngineInstallArgs {
  store: ContentStore;
  env: Env;
  /** A package `readEnginePackage` has already validated. */
  pkg: EnginePackage;
  /** The artifact's verified sha256, recorded so the history states provenance. */
  sha256: string;
  /** Artifact size in bytes. */
  bytes: number;
  installedBy: string;
  source: EngineSource;
}

/**
 * Write a validated engine package into the store and make it the live engine.
 *
 * Nothing about this call touches a platform API: it is storage writes and one
 * pointer flip, identical on every platform that binds a ContentStore — which
 * is every platform that supports content editing at all.
 */
export async function installEngineVersion(args: EngineInstallArgs): Promise<{ version: EngineVersion; active: ActiveEngine }> {
  const { store, env, pkg, sha256, bytes, installedBy, source } = args;

  // The hard rule, enforced at the point of writing and not only at
  // validation: no path that belongs to the deployment may enter the engine
  // prefix, ever, regardless of how the package got here.
  const trespassing = [...pkg.dist.keys()].filter((path) => isBrandOwned(path));
  if (trespassing.length) {
    throw new EnginePackageError(
      trespassing.map((path) => `dist/${path} belongs to the deployment, not to the engine — refusing to install it.`)
    );
  }
  if (!pkg.dist.has('index.html')) {
    throw new EnginePackageError(['dist/index.html is missing — that is not a servable engine.']);
  }

  const index = await readEngineIndex(store);
  const id = nextVersionId(index.versions);
  const version: EngineVersion = {
    id,
    coreVersion: pkg.manifest.coreVersion,
    workerVersion: pkg.manifest.workerVersion,
    installedAt: Date.now(),
    installedBy,
    source,
    sha256,
    bytes,
    live: true,
    files: [...pkg.dist.keys()].sort(),
  };

  // 1. The version directory. Immutable caching is safe and correct: the id is
  //    unique per install, so these keys are never rewritten.
  for (const [path, data] of pkg.dist) {
    await store.put(engineKey.file(id, path), data, { contentType: contentTypeFor(path), cacheControl: IMMUTABLE });
  }

  // 2. Index, then active — in that order, so a crash between them leaves a
  //    recorded version that simply isn't live yet.
  await writeIndexWithLive(store, env, index, version);
  const active = await activate(store, version);
  resetEngineCache();
  return { version, active };
}

/**
 * Roll back to a version already in the history — one click, same as themes.
 *
 * Verifies the archived files are actually there (index.html is the canary)
 * before re-pointing, so a rollback to an evicted version is a clean refusal
 * rather than a site serving a shell whose assets are gone.
 */
export async function activateEngineVersion(
  store: ContentStore,
  env: Env,
  versionId: string
): Promise<{ version: EngineVersion; active: ActiveEngine } | null> {
  const index = await readEngineIndex(store);
  const entry = index.versions.find((v) => v.id === versionId);
  if (!entry) return null;
  const canary = await store.get(engineKey.file(versionId, 'index.html'));
  if (!canary) return null; // the archive is gone; the index entry is a tombstone

  await writeIndexWithLive(store, env, index, entry);
  const active = await activate(store, entry);
  resetEngineCache();
  return { version: entry, active };
}

/**
 * Stop overriding: serve whatever the BUILD ships.
 *
 * Deletes only the pointer; the history stays, so this is as reversible as
 * every other move here. It is also what a platform-level deploy calls after
 * replacing the build's assets wholesale — the freshly deployed build IS the
 * newest engine at that point, and an installed one left active would shadow it.
 */
export async function clearActiveEngine(store: ContentStore): Promise<void> {
  const index = await readEngineIndex(store);
  let changed = false;
  for (const v of index.versions) {
    if (v.live) {
      v.live = false;
      changed = true;
    }
  }
  if (changed) await putJson(store, ENGINE_INDEX_KEY, index, false);
  await store.delete(ENGINE_ACTIVE_KEY);
  resetEngineCache();
}

/** One file out of a stored engine version, or null when it isn't there. */
export async function readEngineFile(
  store: ContentStore,
  versionId: string,
  path: string
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const obj = await store.get(engineKey.file(versionId, path));
  if (!obj) return null;
  return { body: obj.body, contentType: obj.contentType ?? contentTypeFor(path) };
}

/**
 * A hashed asset from ANY stored version, newest first — the mid-update net.
 *
 * A client that loaded the previous version's HTML seconds before the flip
 * still asks for that version's assets; they live under their own prefix until
 * history evicts them, and this is the lookup that finds them. Only consulted
 * on an active-version miss, so its cost (one index read + one file read) is
 * paid by the rare straggler, not the hot path.
 */
export async function findEngineAsset(
  store: ContentStore,
  path: string
): Promise<{ versionId: string; body: ArrayBuffer; contentType: string } | null> {
  const versions = await listEngineVersions(store);
  for (const v of versions) {
    if (!v.files.includes(path)) continue;
    const file = await readEngineFile(store, v.id, path);
    if (file) return { versionId: v.id, ...file };
  }
  return null;
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * Mark exactly one version live, then prune to the limit. Pruning never removes
 * the live version — same belt-and-braces rule as theme-store.ts, and here it
 * additionally protects the mid-update net above: the just-superseded version
 * is the one straggling clients still need, and it is also the newest non-live
 * entry, so age-ordered pruning takes the oldest archives first.
 */
async function writeIndexWithLive(store: ContentStore, env: Env, index: EngineIndex, entry: EngineVersion): Promise<void> {
  for (const v of index.versions) v.live = false;
  const existing = index.versions.findIndex((v) => v.id === entry.id);
  if (existing >= 0) index.versions[existing] = { ...entry, live: true };
  else index.versions.push({ ...entry, live: true });

  const limit = engineVersionLimit(env);
  const byAge = () => index.versions.filter((v) => !v.live).sort((a, b) => a.installedAt - b.installedAt)[0];
  while (index.versions.length > limit) {
    const victim = byAge();
    if (!victim) break;
    index.versions.splice(index.versions.indexOf(victim), 1);
    await deleteVersionFiles(store, victim);
  }
  await putJson(store, ENGINE_INDEX_KEY, index, false);
}

async function deleteVersionFiles(store: ContentStore, v: EngineVersion): Promise<void> {
  for (const path of v.files) await store.delete(engineKey.file(v.id, path));
}

/** Write `engine/active.json` — the LAST write of every path that changes what is served. */
async function activate(store: ContentStore, version: EngineVersion): Promise<ActiveEngine> {
  const active: ActiveEngine = {
    schemaVersion: 1,
    versionId: version.id,
    coreVersion: version.coreVersion,
    workerVersion: version.workerVersion,
    installedAt: version.installedAt,
    installedBy: version.installedBy,
    sha256: version.sha256,
    files: version.files,
  };
  // SHORT, not IMMUTABLE: this is the one key here that is rewritten in place,
  // and it is read on the serving path. Same policy as themes/active.json.
  await putJson(store, ENGINE_ACTIVE_KEY, active, false);
  return active;
}

/** Sortable, collision-free within a millisecond. Mirrors theme-store.ts. */
function nextVersionId(existing: EngineVersion[]): string {
  let candidate = String(Date.now());
  let n = 0;
  while (existing.some((v) => v.id === candidate)) candidate = `${Date.now()}-${++n}`;
  return candidate;
}
