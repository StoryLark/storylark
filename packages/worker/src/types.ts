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
  // secrets
  VAPID_PRIVATE_KEY: string;
  RESEND_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ADMIN_KEY: string;
  VAPID_PUBLIC_KEY: string;
  // Self-update (AB#7403): optional — the admin portal's update card degrades
  // to "check-only" without these. GITHUB_REPO is "owner/repo" for the
  // site's own deployment repo; GITHUB_DEPLOY_TOKEN needs Actions:write on
  // it (a fine-grained PAT scoped to just this repo, not a broad token).
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
