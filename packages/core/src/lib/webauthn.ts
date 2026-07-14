// Thin wrapper around @simplewebauthn/browser: feature detection, the two
// ceremonies (add a passkey to this account; sign in with one), and friendly,
// non-technical error text for the Settings UI to show directly.

import { startRegistration, startAuthentication, browserSupportsWebAuthn, WebAuthnError } from '@simplewebauthn/browser';
import { api } from './api';

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

/** The user dismissed the platform's Face ID / Touch ID / Windows Hello prompt — not a real error. */
export class PasskeyCanceledError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'PasskeyCanceledError';
  }
}

/**
 * Attach a new passkey to the signed-in account. Must be called directly from
 * a click handler (no intervening await before this call) so the browser
 * still sees the user gesture the ceremony requires, especially on iOS.
 */
export async function addPasskey(): Promise<void> {
  try {
    const { options, challengeId } = await api.passkeyRegisterOptions();
    const response = await startRegistration({ optionsJSON: options });
    await api.passkeyRegisterVerify(challengeId, response);
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Usernameless sign-in: the platform's own passkey picker decides who's signing in. */
export async function signInWithPasskey(): Promise<{ id: string; email: string; displayName: string | null }> {
  try {
    const { options, challengeId } = await api.passkeyLoginOptions();
    const response = await startAuthentication({ optionsJSON: options });
    const res = await api.passkeyLoginVerify(challengeId, response);
    return res.user;
  } catch (err) {
    throw normalizeError(err);
  }
}

function normalizeError(err: unknown): Error {
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_CEREMONY_ABORTED') return new PasskeyCanceledError();
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
      return new Error('This device already has a passkey for your account.');
    }
    if (
      err.code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT' ||
      err.code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT'
    ) {
      return new Error('This device cannot create a passkey. Use email sign-in instead.');
    }
  }
  return new Error('Could not complete that. Try again, or use email sign-in instead.');
}
