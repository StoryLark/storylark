/**
 * The engine package — one prebuilt release, as a file (AB#7418 — plan §0d
 * Phase 5).
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Phase 5 wants an update to be "download a prebuilt bundle, keep your brand,
 * restart" instead of "rebuild the engine on your own machine". That needs a
 * thing to download. This is the format of that thing, and — exactly as
 * ./theme-package.mjs does for themes — it is ONE module used by both doors:
 * `npm run package-engine` BUILDS a package with it, and the deployment's
 * `POST /api/admin/update-install` READS a package with it. They cannot
 * disagree about what a valid engine package is, because neither of them
 * decides.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 *   engine.json          the manifest — versions, and a sha256 per file
 *   dist/**              the brand-free site build (`vite build --mode engine`)
 *   worker/index.js      the bundled Cloudflare Worker (wrangler --dry-run)
 *   migrations/*.sql     the D1 migration set, as packages/worker ships it
 *   migrations-postgres/*.sql  the Postgres set, likewise
 *
 * ── Why the migrations travel with it ───────────────────────────────────────
 * Because the order that matters is migrate-then-swap, and the migration set
 * that has to run is the NEW one. platforms/azure/install.mjs already carries a
 * long comment about the live bug this caused: a bumped package.json with no
 * install ran the OLD migration set, which truthfully reported "up to date"
 * against an incomplete schema. Shipping the SQL inside the same artifact as
 * the code it belongs to makes "the migrations that ran are the migrations for
 * this engine" true by construction rather than by sequencing.
 *
 * ── Why brand files are absent, not empty ───────────────────────────────────
 * `dist/` here holds no brand.json, presentation.json, theme.css,
 * manifest.webmanifest or icons/. They belong to the deployment. An update that
 * shipped a neutral brand.json would overwrite a customer's identity with
 * nothing, which is the single worst thing this feature could do — so the
 * format makes it impossible rather than merely discouraged: a package
 * CONTAINING one is invalid, and `readEnginePackage` rejects it.
 */

import { unzip, zip, ZipError } from './zip.mjs';

/** The `dist/` paths an engine package must never carry. Mirrors BRAND_OWNED_OUTPUTS in storylark-core/vite. */
export const BRAND_OWNED_OUTPUTS = ['brand.json', 'presentation.json', 'theme.css', 'manifest.webmanifest'];
export const BRAND_OWNED_PREFIXES = ['icons/'];

/** True for a path (relative to dist/) that belongs to the deployment, not the engine. */
export function isBrandOwned(path) {
  return BRAND_OWNED_OUTPUTS.includes(path) || BRAND_OWNED_PREFIXES.some((p) => path.startsWith(p));
}

export const ENGINE_PACKAGE_EXT = '.zip';

/**
 * Ceilings. Generous next to a theme's, because this genuinely is a whole
 * built site: ~220 files and ~4MB, most of it the six curated font families.
 * They exist to stop a mistake (or a hostile redirect) turning into unbounded
 * work inside a Worker, not to be tight.
 */
export const ENGINE_PACKAGE_LIMITS = {
  maxEntries: 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
};

/** Every problem found, not just the first — same contract as ThemePackageError. */
export class EnginePackageError extends Error {
  constructor(errors, warnings = []) {
    super(errors[0] ?? 'invalid engine package');
    this.name = 'EnginePackageError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

/** How this artifact is named on a GitHub release, for a given engine version. */
export function engineAssetName(version) {
  return `storylark-engine-${version}${ENGINE_PACKAGE_EXT}`;
}

/** The companion checksum asset. One line: "<sha256>  <filename>", `sha256sum` format. */
export function engineChecksumName(version) {
  return `${engineAssetName(version)}.sha256`;
}

/** sha256 of bytes, lowercase hex. WebCrypto, so this runs unchanged in a Worker. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? bytes.slice().buffer : bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a `.sha256` sidecar and return the digest it states for `filename`.
 *
 * `sha256sum` format: `<64 hex>  <name>`, one per line, two spaces (or ` *`
 * for binary mode). Tolerant of either, and of a bare digest with no filename —
 * a release step that wrote only the hash is still unambiguous.
 */
export function parseChecksumFile(text, filename) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-fA-F]{64})(?:\s+[*]?(.*))?$/.exec(trimmed);
    if (!match) continue;
    const [, digest, name] = match;
    if (!name || name === filename || name.endsWith(`/${filename}`)) return digest.toLowerCase();
  }
  return null;
}

/**
 * Build a package from an already-built engine tree.
 *
 * Deterministic: a fixed zip date and sorted entries, so the same inputs give
 * the same bytes. That is what lets a release be re-cut and compared, and what
 * makes the published `.sha256` a fact about the inputs rather than about the
 * moment the CI job ran.
 *
 * @param {object} args
 * @param {Map<string, Uint8Array>} args.dist            engine `dist/`, keyed by path relative to dist/
 * @param {Uint8Array} [args.worker]                     bundled Cloudflare Worker module
 * @param {Map<string, Uint8Array>} [args.migrations]    D1 SQL, keyed by file name
 * @param {Map<string, Uint8Array>} [args.migrationsPostgres]
 * @param {string} args.coreVersion
 * @param {string} args.workerVersion
 * @param {string} [args.commit]
 * @param {string} [args.builtAt]
 */
export async function buildEnginePackage(args) {
  const errors = [];
  for (const path of args.dist.keys()) {
    if (isBrandOwned(path)) errors.push(`dist/${path} belongs to the deployment, not to the engine — build with \`--mode engine\`.`);
  }
  if (!args.dist.has('index.html')) errors.push('dist/index.html is missing — that is not a site build.');
  if (!args.dist.has('sw.js')) errors.push('dist/sw.js is missing — that is not a site build.');
  if (errors.length) throw new EnginePackageError(errors);

  /** @type {{name: string, data: Uint8Array}[]} */
  const entries = [];
  const files = {};
  const add = async (name, data) => {
    entries.push({ name, data });
    files[name] = { sha256: await sha256Hex(data), size: data.byteLength };
  };

  for (const path of [...args.dist.keys()].sort()) await add(`dist/${path}`, args.dist.get(path));
  if (args.worker) await add('worker/index.js', args.worker);
  for (const [name, data] of sorted(args.migrations)) await add(`migrations/${name}`, data);
  for (const [name, data] of sorted(args.migrationsPostgres)) await add(`migrations-postgres/${name}`, data);

  const manifest = {
    formatVersion: 1,
    coreVersion: args.coreVersion,
    workerVersion: args.workerVersion,
    commit: args.commit ?? null,
    builtAt: args.builtAt ?? null,
    /** Absent from `dist/` on purpose; restated so a reader of the file knows it was deliberate. */
    brandOwned: [...BRAND_OWNED_OUTPUTS, ...BRAND_OWNED_PREFIXES],
    files,
  };
  entries.unshift({ name: 'engine.json', data: encode(`${JSON.stringify(manifest, null, 2)}\n`) });

  // A fixed date, for the same reason buildThemePackage uses one: a zip records
  // an mtime per entry, and a clock would make two identical builds differ.
  const bytes = await zip(entries, { date: new Date(0) });
  return { bytes, manifest };
}

/**
 * Read and validate a package. Nothing is applied; this only decides whether
 * the bytes are a package and, if so, hands back its contents.
 *
 * Every file is checked against the sha256 `engine.json` states for it. The zip
 * already carries a CRC32 per entry, which catches corruption — this catches
 * SUBSTITUTION, which is the failure that matters when the bytes arrived over
 * the network and are about to become the code serving a live site.
 */
export async function readEnginePackage(bytes, limits = {}) {
  let entries;
  try {
    entries = await unzip(bytes, { ...ENGINE_PACKAGE_LIMITS, ...limits });
  } catch (err) {
    throw new EnginePackageError([
      err instanceof ZipError ? `That file is not a readable zip: ${err.message}` : `That file could not be read: ${err.message}`,
    ]);
  }

  const errors = [];
  const warnings = [];
  const manifestBytes = entries.get('engine.json');
  if (!manifestBytes) throw new EnginePackageError(['engine.json is missing — that is not an engine package.']);

  let manifest;
  try {
    manifest = JSON.parse(decode(manifestBytes));
  } catch (err) {
    throw new EnginePackageError([`engine.json is not valid JSON (${err.message}).`]);
  }
  if (manifest.formatVersion !== 1) {
    throw new EnginePackageError([
      `engine.json formatVersion is ${JSON.stringify(manifest.formatVersion)}; this engine understands 1. The package was made for a different StoryLark.`,
    ]);
  }
  for (const key of ['coreVersion', 'workerVersion']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) errors.push(`engine.json ${key} is missing.`);
  }
  if (!manifest.files || typeof manifest.files !== 'object') errors.push('engine.json lists no files.');

  const dist = new Map();
  const migrations = new Map();
  const migrationsPostgres = new Map();
  let worker;

  for (const [name, data] of entries) {
    if (name === 'engine.json') continue;
    const stated = manifest.files?.[name];
    if (!stated) {
      errors.push(`${name} is in the package but not in engine.json — refusing a file nothing vouched for.`);
      continue;
    }
    const actual = await sha256Hex(data);
    if (actual !== stated.sha256) {
      errors.push(`${name} does not match the sha256 in engine.json (expected ${stated.sha256}, got ${actual}).`);
      continue;
    }
    if (name.startsWith('dist/')) {
      const path = name.slice(5);
      if (isBrandOwned(path)) {
        errors.push(`${name} belongs to the deployment, not to the engine — an update must never overwrite it.`);
        continue;
      }
      dist.set(path, data);
    } else if (name === 'worker/index.js') worker = data;
    else if (name.startsWith('migrations/')) migrations.set(name.slice(11), data);
    else if (name.startsWith('migrations-postgres/')) migrationsPostgres.set(name.slice(20), data);
    else warnings.push(`${name} is not part of the engine-package layout — ignoring it.`);
  }

  for (const name of Object.keys(manifest.files ?? {})) {
    if (!entries.has(name)) errors.push(`engine.json lists ${name} but the package does not contain it.`);
  }
  if (!dist.has('index.html')) errors.push('dist/index.html is missing — that is not a usable engine.');
  if (!dist.has('sw.js')) errors.push('dist/sw.js is missing — that is not a usable engine.');

  if (errors.length) throw new EnginePackageError(errors, warnings);
  return { manifest, dist, worker, migrations, migrationsPostgres, warnings };
}

function sorted(map) {
  return map ? [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) : [];
}

const encode = (s) => new TextEncoder().encode(s);
const decode = (b) => new TextDecoder().decode(b);
