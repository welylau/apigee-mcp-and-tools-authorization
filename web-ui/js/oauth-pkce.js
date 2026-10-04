/**
 * OAuth 2.0 authorization-code helpers: state + PKCE (RFC 7636, S256).
 *
 * The state and code_verifier for an in-flight sign-in live in sessionStorage
 * (this tab only) and are consumed exactly once when the popup reports back.
 */

const STORAGE_KEY = 'biscuit_oauth_pending';

function randomUrlSafe(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

function base64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Starts a sign-in: -> { state, codeVerifier, codeChallenge }. */
export async function beginAuthRequest() {
  const state = randomUrlSafe(24);
  const codeVerifier = randomUrlSafe(48);       // 64 chars, within 43..128
  const codeChallenge = await pkceChallenge(codeVerifier);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ state, codeVerifier, at: Date.now() }));
  } catch (e) { /* storage disabled: the in-memory values below still work */ }
  return { state, codeVerifier, codeChallenge };
}

/**
 * Checks the popup's callback URL against the pending request.
 * -> { code, codeVerifier } or throws.
 */
export function completeAuthRequest(authResponseUrl, expected) {
  let stored = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) { stored = null; }
  const pending = expected || stored;
  if (!pending || !pending.state || !pending.codeVerifier) {
    throw new Error('No sign-in is in progress. Please try again.');
  }
  const u = new URL(authResponseUrl);
  if (u.origin !== window.location.origin) throw new Error('Unexpected sign-in callback origin.');
  const params = u.searchParams;
  if (params.get('state') !== pending.state) {
    throw new Error('Sign-in response did not match this request (state mismatch). Please try again.');
  }
  if (params.get('error')) {
    throw new Error(`Keycloak sign-in failed: ${params.get('error_description') || params.get('error')}`);
  }
  const code = params.get('code');
  if (!code) throw new Error('Keycloak completed without providing an authorization code.');
  return { code, codeVerifier: pending.codeVerifier };
}
