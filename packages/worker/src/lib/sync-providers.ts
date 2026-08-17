/**
 * The git-provider seam (content-management rework wave 2 — design §10.2).
 *
 * A provider costs exactly two things: an archive-URL builder and a webhook
 * signature verifier. That is a DRIVER — the same pattern the database seam
 * (db/types.ts) and the content-store seam (lib/content-store.ts) already ship
 * — so adding GitLab or Gitea later is an entry in PROVIDERS, not a refactor.
 *
 * §10.2's decision is GitHub alone at launch, with this seam in place from the
 * first commit: one provider proven end to end beats three shipped on
 * assumption.
 *
 * ── Why the archive is a ZIP, not the tarball the design sketch names ───────
 * §6.3 names GitHub's `/tarball/:ref`; this driver uses the sibling
 * `/zipball/:ref` — same endpoint family, same auth, same redirect-to-codeload
 * behaviour — because the repo already carries one tested, limit-enforcing
 * archive reader (`storylark-contracts/zip`, the theme-package and bulk-import
 * unzipper) and a tar+gzip reader would be a SECOND archive implementation for
 * no gain. Reuse beats format fidelity to a parenthetical.
 *
 * ── SSH does not appear here, on purpose ────────────────────────────────────
 * A Worker has no ssh client, no safe place for a private key, and no agent.
 * HTTPS + read token is the only transport, and the connection form says so in
 * words rather than offering a dead option (§6.1).
 */

/** What a provider driver knows how to do. Exactly two capabilities (§10.2). */
export interface SyncProviderDriver {
  id: string;
  label: string;
  /** Parse an `https://host/owner/repo[.git]` URL, or null when it isn't this provider's. */
  parseRepo(url: string): { owner: string; repo: string } | null;
  /** The credential-free (or token-authed) archive endpoint for one ref (§6.3). */
  archiveUrl(repo: { owner: string; repo: string }, ref: string, baseOverride?: string): string;
  archiveHeaders(token?: string): Record<string, string>;
  /** The request header carrying this provider's webhook signature (§6.2). */
  signatureHeaderName: string;
  /** The request header naming the event kind, and the value meaning "a push". */
  eventHeaderName: string;
  pushEventName: string;
  /**
   * Verify a webhook delivery's signature over the RAW body (§6.2). An
   * unverified webhook is rejected, never trusted — including "no signature
   * header at all", which is what a webhook configured without its secret sends.
   */
  verifyWebhook(args: { rawBody: string; signatureHeader: string | undefined; secret: string }): Promise<boolean>;
  /** The branch a verified push payload says it touched, e.g. "main". */
  pushedBranch(payload: unknown): string | undefined;
  /** Every path a verified push payload says it touched. Undefined = unknowable, sync anyway. */
  pushedPaths(payload: unknown): string[] | undefined;
}

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare — a signature check must not leak where it diverged. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const github: SyncProviderDriver = {
  id: 'github',
  label: 'GitHub',

  parseRepo(url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com')) return null;
    const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u.pathname);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  },

  archiveUrl(repo, ref, baseOverride) {
    // api.github.com answers a 302 to a short-lived codeload URL that carries
    // its own credential, so following the redirect needs no auth forwarding.
    const base = (baseOverride ?? 'https://api.github.com').replace(/\/+$/, '');
    return `${base}/repos/${repo.owner}/${repo.repo}/zipball/${encodeURIComponent(ref)}`;
  },

  archiveHeaders(token) {
    return {
      // GitHub's API refuses requests with no User-Agent.
      'User-Agent': 'storylark-sync',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  },

  signatureHeaderName: 'x-hub-signature-256',
  eventHeaderName: 'x-github-event',
  pushEventName: 'push',

  async verifyWebhook({ rawBody, signatureHeader, secret }) {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
    return timingSafeEqual(signatureHeader.trim(), expected);
  },

  pushedBranch(payload) {
    const ref = (payload as { ref?: unknown } | null)?.ref;
    if (typeof ref !== 'string') return undefined;
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
  },

  pushedPaths(payload) {
    const commits = (payload as { commits?: unknown } | null)?.commits;
    if (!Array.isArray(commits)) return undefined;
    const paths: string[] = [];
    for (const commit of commits) {
      for (const kind of ['added', 'modified', 'removed'] as const) {
        const list = (commit as Record<string, unknown>)?.[kind];
        if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') paths.push(p);
      }
    }
    return paths;
  },
};

/** The registry. GitHub only at launch (§10.2); a new provider is a new entry. */
export const SYNC_PROVIDERS: Record<string, SyncProviderDriver> = { github };

export function providerOf(id: unknown): SyncProviderDriver | undefined {
  return typeof id === 'string' ? SYNC_PROVIDERS[id] : undefined;
}
