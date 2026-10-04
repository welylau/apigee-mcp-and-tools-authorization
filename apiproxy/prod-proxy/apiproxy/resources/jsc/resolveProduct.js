/*
 * Runs right after JWT-VerifyToken succeeds. Works out who the caller is and
 * which API Product governs the request, using only VERIFIED token claims.
 *
 * Sets:
 *   product.name   - API Product for (environment, azp) from the azp-products
 *                    property set; empty when there is no mapping
 *   product.known  - "true" | "false" (false => RF-Client-Not-Allowed, 403)
 *   caller.id      - per-user key for SpikeArrest / Quota: sub, else email,
 *                    else azp (never empty for a verified token)
 *   caller.raw_token - the caller's own JWT without the "Bearer " prefix, sent
 *                    to the backend as X-User-Token (AM-SetBackendHeaders),
 *                    because the target's Authorization header is replaced by
 *                    Apigee's Google ID token
 *
 * Fails closed: any error leaves product.known = "false".
 */
function sanitize(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '_');
}

context.setVariable('product.known', 'false');
try {
  var env = String(context.getVariable('environment.name') || '');
  var azp = String(context.getVariable('jwt.JWT-VerifyToken.claim.azp') || '');
  var name = '';
  if (env && azp) {
    name = String(context.getVariable('propertyset.azp-products.' + sanitize(env) + '__' + sanitize(azp)) || '');
  }
  if (name === 'null' || name === 'undefined') {
    name = '';
  }
  context.setVariable('product.azp', azp);
  context.setVariable('product.name', name);
  context.setVariable('product.known', name ? 'true' : 'false');

  var sub = String(context.getVariable('jwt.JWT-VerifyToken.claim.subject') || '');
  var email = String(context.getVariable('jwt.JWT-VerifyToken.claim.email') || '');
  context.setVariable('caller.id', sub || email || ('azp:' + azp));

  var auth = String(context.getVariable('request.header.authorization') || '');
  var m = /^\s*Bearer\s+(\S+)\s*$/i.exec(auth);
  context.setVariable('caller.raw_token', m ? m[1] : '');
} catch (e) {
  context.setVariable('product.known', 'false');
  context.setVariable('product.error', String(e));
}
