// Same-origin API client. Cookies ride along automatically; the custom
// header doubles as the CSRF token the worker requires on mutations.

import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/browser';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'storyreader',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''));
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  /** The server's `{error: "<slug>"}` code, when the body was JSON shaped that way. Empty string otherwise. */
  slug: string;
  constructor(public status: number, body: string) {
    super(`API ${status}: ${body}`);
    let slug = '';
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (typeof parsed.error === 'string') slug = parsed.error;
    } catch {
      // body wasn't JSON, leave slug empty
    }
    this.slug = slug;
  }
}

export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
}

export interface Me {
  user: AuthUser;
}

export interface PasskeySummary {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export const api = {
  me: () => call<Me>('/auth/me'),
  register: (email: string, username: string, password: string) =>
    call<{ ok: true; user: AuthUser }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, username, password }),
    }),
  login: (identifier: string, password: string) =>
    call<{ ok: true; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),
  requestMagicLink: (email: string) => call<{ ok: true }>('/auth/magic/request', { method: 'POST', body: JSON.stringify({ email }) }),
  verifyCode: (email: string, code: string) =>
    call<{ ok: true; user: AuthUser }>('/auth/code/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  forgotPassword: (email: string) =>
    call<{ ok: true }>('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (args: { token: string } | { email: string; code: string }, password: string) =>
    call<{ ok: true; user: AuthUser }>('/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify({ ...args, password }),
    }),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),
  passkeyRegisterOptions: () =>
    call<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>('/auth/passkey/register-options', { method: 'POST' }),
  passkeyRegisterVerify: (challengeId: string, response: RegistrationResponseJSON) =>
    call<{ ok: true }>('/auth/passkey/register-verify', { method: 'POST', body: JSON.stringify({ challengeId, response }) }),
  passkeyLoginOptions: () =>
    call<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>('/auth/passkey/login-options', { method: 'POST' }),
  passkeyLoginVerify: (challengeId: string, response: AuthenticationResponseJSON) =>
    call<{ ok: true; user: AuthUser }>('/auth/passkey/login-verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, response }),
    }),
  listPasskeys: () => call<{ passkeys: PasskeySummary[] }>('/auth/passkey/list'),
  removePasskey: (id: string) => call<{ ok: true }>(`/auth/passkey/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  libraryVersion: () => call<{ version: number; updatedAt: number }>('/library/version'),
  getProgress: () =>
    call<{ progress: { book_id: string; chapter_id: string; mode: 'read' | 'listen'; char_offset: number; audio_ms: number; percent: number; updated_at: number }[] }>(
      '/progress'
    ),
  putProgress: (bookId: string, chapterId: string, body: { mode: string; charOffset: number; audioMs: number; percent: number; updatedAt: number }) =>
    call<{ progress: unknown }>(`/progress/${encodeURIComponent(bookId)}/${encodeURIComponent(chapterId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  getPreferences: () => call<{ prefs: Record<string, unknown>; updatedAt: number | null }>('/preferences'),
  putPreferences: (prefs: Record<string, unknown>, updatedAt: number) =>
    call<{ ok: true }>('/preferences', { method: 'PUT', body: JSON.stringify({ prefs, updatedAt }) }),
  subscribePush: (sub: { endpoint: string; p256dh: string; auth: string }) =>
    call<{ ok: true }>('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }),
  unsubscribePush: (endpoint: string) => call<{ ok: true }>('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
};
