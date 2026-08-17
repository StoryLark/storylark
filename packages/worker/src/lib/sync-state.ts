/**
 * Runtime state for the content-source connection (wave 2 — design §4, §6).
 *
 * One row in the deployment's own database (migration 0009). The database
 * rather than `deployment.json` or the content store, for three reasons that
 * are each sufficient alone:
 *
 *   • The portal edits this at runtime, and `deployment.json` is a committed
 *     file on the operator's machine — the Worker cannot write it and must not
 *     want to. The pipeline-side `contentSource` block in deployment.json seeds
 *     `sync.mjs` (CLI pulls); THIS row is the deployment's own connection.
 *   • The webhook signing secret has to live somewhere the deployment can read
 *     and the public cannot: the content store's key space is served publicly
 *     on some platforms, the database never is.
 *   • Both platforms already share the Database seam and its migrations, so
 *     this is uniform by construction — no per-platform plumbing to hide.
 */

import type { Env } from '../types';

export interface RepoConnection {
  /** Provider id from lib/sync-providers.ts. GitHub only at launch (§10.2). */
  provider: string;
  /** `https://host/owner/repo` — the URL as configured, never with a credential in it. */
  url: string;
  visibility: 'public' | 'private';
  branch: string;
  /** Subdirectory that holds the content; '' = repo root. An optimisation, not a correctness requirement (§6.5). */
  path: string;
  /** Scheduled-pull interval. The cron itself stays daily (§10.3); a larger value skips runs. */
  intervalHours: number;
}

export interface ContentSourceConfig {
  mode: 'portal' | 'repo' | 'api';
  repo?: RepoConnection;
}

export interface SyncStateRow {
  config: ContentSourceConfig | null;
  repoTokenStored: boolean;
  repoToken: string | null;
  webhookSecret: string | null;
  runningSince: number | null;
  lastSyncAt: number | null;
  lastSync: unknown | null;
  updatedAt: number | null;
}

/** A claim older than this is a crashed run, and is taken over rather than waited on. */
export const SYNC_CLAIM_STALE_MS = 10 * 60 * 1000;

interface RawRow {
  config: string | null;
  repo_token: string | null;
  webhook_secret: string | null;
  running_since: number | null;
  last_sync_at: number | null;
  last_sync: string | null;
  updated_at: number | null;
}

function parse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Read the one state row. A deployment whose database predates migration 0009
 * reads as "nothing configured" rather than throwing — the same posture every
 * other optional table (the narration queue) takes.
 */
export async function readSyncState(env: Env): Promise<SyncStateRow | null> {
  let row: RawRow | null;
  try {
    row = await env.DB.prepare(
      'SELECT config, repo_token, webhook_secret, running_since, last_sync_at, last_sync, updated_at FROM content_sync WHERE id = 1'
    ).first<RawRow>();
  } catch {
    return null;
  }
  if (!row) {
    return {
      config: null,
      repoTokenStored: false,
      repoToken: null,
      webhookSecret: null,
      runningSince: null,
      lastSyncAt: null,
      lastSync: null,
      updatedAt: null,
    };
  }
  return {
    config: parse<ContentSourceConfig>(row.config),
    repoTokenStored: !!row.repo_token,
    repoToken: row.repo_token,
    webhookSecret: row.webhook_secret,
    runningSince: row.running_since,
    lastSyncAt: row.last_sync_at,
    lastSync: parse(row.last_sync),
    updatedAt: row.updated_at,
  };
}

async function ensureRow(env: Env): Promise<void> {
  await env.DB.insertIgnore('content_sync', ['id', 'updated_at'], [1, Date.now()], ['id']);
}

export async function writeSyncConfig(env: Env, config: ContentSourceConfig): Promise<void> {
  await ensureRow(env);
  await env.DB.prepare('UPDATE content_sync SET config = ?, updated_at = ? WHERE id = 1')
    .bind(JSON.stringify(config), Date.now())
    .run();
}

/** null clears a stored token. The env secret (CONTENT_SYNC_TOKEN) is untouched by this. */
export async function writeRepoToken(env: Env, token: string | null): Promise<void> {
  await ensureRow(env);
  await env.DB.prepare('UPDATE content_sync SET repo_token = ?, updated_at = ? WHERE id = 1').bind(token, Date.now()).run();
}

export async function writeWebhookSecret(env: Env, secret: string | null): Promise<void> {
  await ensureRow(env);
  await env.DB.prepare('UPDATE content_sync SET webhook_secret = ?, updated_at = ? WHERE id = 1').bind(secret, Date.now()).run();
}

/**
 * The read token, wherever it lives. The PLATFORM SECRET wins — that is the
 * installer's path and the recommended one — with the portal-stored value as
 * the fallback, per the precedent `self_update_oauth` set for credentials the
 * portal has to be able to accept at runtime. Never in deployment.json; never
 * echoed by any route.
 */
export function resolveSyncToken(env: Env, state: SyncStateRow | null): string | undefined {
  const fromEnv = (env.CONTENT_SYNC_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const stored = (state?.repoToken ?? '').trim();
  return stored || undefined;
}

/**
 * Claim the one running-sync slot, or report who holds it. A conditional
 * UPDATE, so two isolates racing get exactly one winner — the same discipline
 * the narration queue's job claim uses. Concurrent runs are COLLAPSED, not
 * queued (§6.2): the loser attaches to the running one by reporting it.
 */
export async function claimSyncRun(env: Env): Promise<{ claimed: boolean; runningSince?: number }> {
  await ensureRow(env);
  const now = Date.now();
  const updated = await env.DB.prepare(
    'UPDATE content_sync SET running_since = ? WHERE id = 1 AND (running_since IS NULL OR running_since < ?)'
  )
    .bind(now, now - SYNC_CLAIM_STALE_MS)
    .run();
  if ((updated.meta?.changes ?? 0) > 0) return { claimed: true };
  const row = await env.DB.prepare('SELECT running_since FROM content_sync WHERE id = 1').first<{ running_since: number | null }>();
  return { claimed: false, runningSince: row?.running_since ?? undefined };
}

export async function releaseSyncRun(env: Env, report: unknown | null): Promise<void> {
  const now = Date.now();
  if (report === null) {
    await env.DB.prepare('UPDATE content_sync SET running_since = NULL WHERE id = 1').run();
    return;
  }
  await env.DB.prepare(
    'UPDATE content_sync SET running_since = NULL, last_sync = ?, last_sync_at = ?, updated_at = ? WHERE id = 1'
  )
    .bind(JSON.stringify(report), now, now)
    .run();
}
