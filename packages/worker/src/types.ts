import type { Database, ConflictInsert } from './db/types';

export interface Env {
  // Platform-agnostic seam (AB#7399): the Cloudflare Worker entry binds this
  // to the D1 reference driver; other platform entries (Azure, AWS) bind it
  // to the Postgres driver. Route code only ever sees this interface.
  DB: Database & ConflictInsert;
  CONTENT: R2Bucket;
  ASSETS: Fetcher;
  BRAND: string;
  APP_ORIGIN: string;
  CONTENT_ORIGIN: string;
  MAIL_FROM: string;
  APP_NAME: string;
  // Narration config (AB#7414). Optional, and read by nothing in the Worker —
  // they exist so the deployment contract injected into the documents is whole
  // (see lib/deployment.ts). The publish pipeline is what consumes narration
  // config today; deployment/<id>/deployment.json remains its source.
  TTS_VOICE?: string;
  TTS_RATE?: string;
  TTS_OUTPUT_FORMAT?: string;
  /** Comma-separated list of voice ids. */
  TTS_VOICES?: string;
  // secrets
  VAPID_PRIVATE_KEY: string;
  RESEND_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ADMIN_KEY: string;
  VAPID_PUBLIC_KEY: string;
  // Admin story upload (AB#7405): optional, and used by that one feature only
  // — POST /api/admin/publish-story commits the markdown to the site's repo
  // and dispatches publish.yml. GITHUB_REPO is "owner/repo"; GITHUB_DEPLOY_TOKEN
  // needs Contents:write + Actions:write on it (a fine-grained PAT scoped to
  // just this repo, not a broad token).
  //
  // Platform updates deliberately do NOT use these (AB#7403). An installed
  // reading app has no business holding a GitHub credential to update itself;
  // updates run from the operator's own machine via the installer's --update
  // mode, using the platform credentials they already have. See
  // docs/updating.md and GET /api/admin/update-status's updateCommand.
  GITHUB_REPO: string;
  GITHUB_DEPLOY_TOKEN: string;
  // Operator notifications (AB#7403/F2) — optional. Without both, the
  // scheduled check still runs but never emails; the in-portal check
  // (/api/admin/update-status) always works regardless.
  ADMIN_EMAIL: string;
}

export interface User {
  id: string;
  email: string;
  username: string | null;
  display_name: string | null;
  created_at: number;
  last_seen_at: number | null;
  /**
   * Operator flag (AB#7404), INTEGER 0/1 in both dialects — SQLite has no
   * BOOLEAN and the Database seam does no boolean marshalling, so this stays
   * a number all the way from the row to requireAdmin(). Legacy rows written
   * before 0007 can also read back null/undefined through a driver, so
   * always test it as truthy rather than `=== 1`.
   */
  is_admin: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
}

export interface ProgressRow {
  user_id: string;
  book_id: string;
  chapter_id: string;
  mode: 'read' | 'listen';
  char_offset: number;
  audio_ms: number;
  percent: number;
  updated_at: number;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    user: User;
    sessionId: string;
  };
};
