/**
 * OAuth popup callback (loaded synchronously in <head>, before the app).
 *
 * When Keycloak redirects the sign-in popup back to this page, hand the result
 * to the opener window and close. Messages go to this page's own origin only,
 * so a foreign opener can never receive the authorization code. The opener
 * verifies `state` (and exchanges the code with its PKCE verifier).
 */
(function () {
  try {
    if (!window.opener) return;
    var search = new URLSearchParams(window.location.search);
    var hash = new URLSearchParams(window.location.hash ? window.location.hash.substring(1) : '');
    var code = search.get('code') || hash.get('code');
    var error = search.get('error') || hash.get('error');
    var state = search.get('state') || hash.get('state');
    if (code || error) {
      window.opener.postMessage({
        type: 'KEYCLOAK_OAUTH_CALLBACK',
        authResponseUrl: window.location.href,
        code: code,
        error: error,
        state: state
      }, window.location.origin);
      window.close();
    } else if (search.has('logged_out') || state === 'logout') {
      window.opener.postMessage({ type: 'KEYCLOAK_LOGOUT_CALLBACK' }, window.location.origin);
      window.close();
    }
  } catch (e) {
    console.warn('OAuth popup callback:', e);
  }
})();
