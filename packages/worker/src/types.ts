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
