import type { Database, ConflictInsert } from './db/types';
import type { ContentStore } from './lib/content-store';
import type { SelfDeployTarget } from './lib/self-deploy';

export interface Env {
  // Platform-agnostic seam (AB#7399): the Cloudflare Worker entry binds this
  // to the D1 reference driver; other platform entries (Azure, AWS) bind it
  // to the Postgres driver. Route code only ever sees this interface.
  DB: Database & ConflictInsert;
  CONTENT: R2Bucket;
  /**
   * Writable content storage, platform-agnostic (AB#7420). The Cloudflare entry
   * binds it from the CONTENT R2 bucket; platforms/azure/server.mjs binds an
   * Azure Blob or local-directory driver. Optional: a deployment without one
   * serves content perfectly well and simply cannot be edited from the portal,
   * which the content routes report as a 501 with an explanation rather than a
   * confusing failure.
   */
  CONTENT_STORE?: ContentStore;
  /** Text revisions kept per chapter (plan §3). Default 5; see lib/content.ts. */
  CONTENT_REVISIONS?: string;
  /** Ceiling for a portal image upload, in bytes. Default 8MB. */
  CONTENT_MAX_UPLOAD_BYTES?: string;
  /** Theme versions kept for rollback (AB#7417 — plan §0c). Default 5; see lib/theme-store.ts. */
  THEME_VERSIONS?: string;
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

  // ── One-click updates (AB#7418 — plan §4 layer 3) ─────────────────────────
  //
  // Every one of these is optional, and a deployment with none of them set
  // behaves exactly as it did before this feature existed: /update-status
  // reports `oneClick.available: false` with a reason, the portal shows the
  // installer command, and POST /update-install answers 501. That is the
  // DEFAULT and the recommended posture — the deployment holds no standing
  // permission to deploy anything.
  //
  // CF_API_TOKEN is a Cloudflare API token the OPERATOR issued, scoped to their
  // own Worker, stored as a Worker secret by
  // `platforms/cloudflare/install.mjs --enable-one-click`. It is deliberately
  // NOT in deployment/<id>/deployment.json with the origins and the VAPID public
  // key: that file is committed to a repository and holds public values, and a
  // credential that can redeploy a live site does not belong in the same
  // category, let alone the same file. Revoke it in the Cloudflare dashboard and
  // the button is gone on the next request; nothing else changes.
  //
  // Azure needs NO equivalent. The Node entry gets a short-lived token from the
  // App Service managed identity at the moment of use and never stores one —
  // see platforms/azure/self-deploy.mjs.
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** Defaults to BRAND, which is what the installer names the Worker. */
  CF_SCRIPT_NAME?: string;
  /** Test seam only — points the Cloudflare client at a local server. Never set in production. */
  CF_API_BASE?: string;
  /** Where prebuilt engine artifacts are published. Defaults to StoryLark/storylark. */
  ENGINE_RELEASE_REPO?: string;
  /** A plain static host for artifacts, instead of the GitHub Releases API. */
  ENGINE_RELEASE_BASE?: string;
  /**
   * The platform-native deployer, bound by the platform entry (AB#7418).
   * Cloudflare builds it from CF_API_TOKEN in-process; platforms/azure/server.mjs
   * binds its own Node implementation. Absent = no one-click updates, which is
   * the default and is a perfectly good state to be in.
   */
  SELF_DEPLOY?: SelfDeployTarget;
  /** Why SELF_DEPLOY is absent, in the platform entry's own words. Shown in the portal. */
  SELF_DEPLOY_REASON?: string;
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
