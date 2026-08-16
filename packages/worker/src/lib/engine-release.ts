/**
 * Finding, fetching and checking a prebuilt engine release (AB#7418 — plan §0d
 * Phase 5, and §4's layer 3).
 *
 * ── The one thing this module guarantees ────────────────────────────────────
 * That the bytes about to become the code serving a live site are the bytes the
 * StoryLark release said they would be. Everything else here is plumbing around
 * that: locate the release, read its published checksum, download the artifact,
 * compare, and only then hand it on. A mismatch is a hard failure with nothing
 * applied — there is no "probably fine" path.
 *
 * ── Why GitHub is acceptable HERE and was not acceptable before ─────────────
 * §4 rejected GitHub because the old update path needed a GitHub CREDENTIAL
 * stored in the deployment — an Actions:write token, in a reading app, so that
 * the app could make GitHub rebuild it. None of that is true of this. A release
 * asset on a public repository is downloadable with no authentication at all;
 * this module sends no Authorization header and cannot, because there is
 * nothing to send. GitHub is a CDN here, and a deployment that would rather use
 * a different one sets ENGINE_RELEASE_BASE (see below) — the artifact is
 * checksum-verified either way, so where it came from is not what makes it
 * trustworthy.
 *
 * ── Why the version comes from npm and the bytes come from GitHub ───────────
 * Layer 1 (routes/admin.ts's GET /update-status) already asks the npm registry
 * what the latest engine is, and that answer is the one the portal shows. Asking
 * a second source what "latest" means would let the two disagree and leave an
 * operator looking at a version number that is not the version they would get.
 * So: npm decides WHICH version, this module fetches THAT version's artifact by
 * exact tag, and refuses anything else.
 */

import { engineAssetName, engineChecksumName, parseChecksumFile, sha256Hex } from 'storylark-contracts/engine-package';

/** The repository the engine is released from. Overridable per deployment; see Env. */
export const DEFAULT_RELEASE_REPO = 'StoryLark/storylark';

/** Changesets tags a release `<package>@<version>`; this is the engine's. */
export function releaseTag(version: string): string {
  return `storylark-core@${version}`;
}

export interface EngineReleaseAssets {
  version: string;
  tag: string;
  /** Where the .zip lives. */
  artifactUrl: string;
  /** Where the .zip.sha256 lives. */
  checksumUrl: string;
  releaseUrl: string;
}

/** What went wrong, in a sentence an operator can act on. Never leaks a URL with a token in it. */
export class EngineReleaseError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'no_release'
      | 'no_artifact'
      | 'no_checksum'
      | 'download_failed'
      | 'checksum_mismatch'
      | 'too_large'
  ) {
    super(message);
    this.name = 'EngineReleaseError';
  }
}

/**
 * Locate the two assets for an exact version.
 *
 * Two shapes are supported, and the second exists because "the update path must
 * not depend on one company" is a fair thing for an operator to want:
 *
 *   ENGINE_RELEASE_BASE unset  → GitHub's own release-download URL convention,
 *                                constructed directly, for ENGINE_RELEASE_REPO
 *   ENGINE_RELEASE_BASE set    → `<base>/<tag>/<asset>`, a plain static host
 *
 * Neither sends credentials, and — confirmed live, this is why the shape
 * changed from an earlier version that called the Releases REST API first —
 * neither touches api.github.com at all. That API is rate-limited per source
 * IP, and a Cloudflare Worker's outbound IP is shared across an unrelated
 * pool of other Cloudflare tenants' traffic: a real deployment hit a real
 * 429 from that shared pool on its very first live one-click update, despite
 * a normal developer machine's own IP showing a fully-reset quota moments
 * later — proof the failure was about the shared IP, not this deployment's
 * own usage. `github.com/<repo>/releases/download/<tag>/<asset>` is GitHub's
 * documented direct-download convention: it 302s to a separate,
 * non-api.github.com asset host (release-assets.githubusercontent.com as of
 * this writing) that isn't part of that same rate-limit bucket. A 404 on
 * that redirect is exactly as informative as the API's 404 was, so nothing
 * about error reporting gets worse for losing the API call — only a
 * possible-failure gets removed.
 */
export async function findEngineRelease(
  version: string,
  opts: { repo?: string; base?: string; fetchImpl?: typeof fetch } = {}
): Promise<EngineReleaseAssets> {
  const tag = releaseTag(version);
  const asset = engineAssetName(version);
  const checksum = engineChecksumName(version);

  if (opts.base) {
    const base = opts.base.replace(/\/+$/, '');
    return {
      version,
      tag,
      artifactUrl: `${base}/${encodeURIComponent(tag)}/${asset}`,
      checksumUrl: `${base}/${encodeURIComponent(tag)}/${checksum}`,
      releaseUrl: `${base}/${encodeURIComponent(tag)}/`,
    };
  }

  // `||`, not `??`: Azure's server.mjs sets ENGINE_RELEASE_REPO to
  // `process.env.ENGINE_RELEASE_REPO ?? ''` (an empty string when unset, not
  // undefined — Node env vars don't distinguish "absent" the way a Cloudflare
  // Workers binding does). `??` only falls back on null/undefined, so an
  // empty string reached here unchanged and produced a real, reproducible
  // "https://github.com//releases/..." — a genuine GitHub 404, but from a
  // malformed URL, not a missing release. Found live against Azure dev,
  // 2026-08-16 (see the temporary [diag: landed=...] detail this fix makes
  // unnecessary — remove that once this ships). opts.base above already used
  // a truthy check for the same reason; this matches it.
  const repo = opts.repo || DEFAULT_RELEASE_REPO;
  const releaseUrl = `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
  const download = (name: string) => `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
  return { version, tag, artifactUrl: download(asset), checksumUrl: download(checksum), releaseUrl };
}

/** Hard ceiling on what will be pulled into memory. A real artifact is ~3.5MB. */
export const MAX_ARTIFACT_BYTES = 48 * 1024 * 1024;

/**
 * Download the artifact and prove it is the published one.
 *
 * The checksum is fetched FIRST and from its own URL. Sequencing matters: an
 * attacker who can replace the artifact can usually replace a checksum served
 * from the same place, so this is not a defence against a compromised release —
 * it is a defence against the failures that actually happen, which are a
 * truncated download, a proxy that helpfully returned an HTML error page with a
 * 200, and a stale CDN copy of a re-cut release. Those are exactly the failures
 * that would otherwise be discovered by a site that no longer boots.
 */
export async function downloadEngineArtifact(
  release: EngineReleaseAssets,
  opts: { fetchImpl?: typeof fetch; maxBytes?: number } = {}
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_ARTIFACT_BYTES;

  const sumRes = await doFetch(release.checksumUrl, { headers: { 'user-agent': 'storylark-update' } });
  if (!sumRes.ok) {
    // A 404 here almost always means the release itself doesn't have a
    // prebuilt artifact (cut before Phase 5, or its build step failed) —
    // there's no separate existence check anymore now that findEngineRelease
    // constructs the URL directly instead of asking GitHub's API first.
    if (sumRes.status === 404) {
      throw new EngineReleaseError(
        `There is no published prebuilt engine for "${release.tag}". That release was cut before prebuilt artifacts existed, its build step failed, or the version doesn't exist — take this update with the installer command instead.`,
        'no_release'
      );
    }
    throw new EngineReleaseError(`Could not download the checksum for ${release.tag} (HTTP ${sumRes.status}).`, 'no_checksum');
  }
  const expected = parseChecksumFile(await sumRes.text(), engineAssetName(release.version));
  if (!expected) {
    throw new EngineReleaseError(`The published checksum for ${release.tag} is not readable — refusing to install.`, 'no_checksum');
  }

  const res = await doFetch(release.artifactUrl, { headers: { 'user-agent': 'storylark-update' } });
  if (!res.ok) {
    throw new EngineReleaseError(`Could not download the engine artifact for ${release.tag} (HTTP ${res.status}).`, 'download_failed');
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new EngineReleaseError(`The engine artifact for ${release.tag} is ${Math.round(declared / 1024 / 1024)}MB — refusing to load it.`, 'too_large');
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new EngineReleaseError(`The engine artifact for ${release.tag} is larger than ${Math.round(maxBytes / 1024 / 1024)}MB — refusing to load it.`, 'too_large');
  }

  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new EngineReleaseError(
      `The downloaded engine artifact does not match its published checksum (expected ${expected}, got ${actual}). Nothing was installed.`,
      'checksum_mismatch'
    );
  }
  return { bytes, sha256: actual };
}
