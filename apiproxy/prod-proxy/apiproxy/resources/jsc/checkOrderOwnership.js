/*
 * Object-level authorisation for /orders and /orders/{id}.
 *
 * ONE script, three modes, selected by the `mode` property on the calling
 * Javascript policy. Keeping them together means the identity rules, the
 * manager bypass and the enforcement toggle are defined exactly once and
 * cannot drift between the read path, the delete path and the list path.
 *
 *   flags     - compute identity/toggle only. Cheap, runs first on every
 *               protected flow, and decides whether a lookup is needed at all.
 *   lookup    - DELETE. Inspect the SC-GetOrderOwner pre-flight callout and
 *               decide before the backend is ever called.
 *   response  - GET /orders/{id}. Inspect the target's own response, so
 *               ownership costs zero extra backend calls.
 *
 * FAIL CLOSED
 * Opposite of checkOrderValue.js, which deliberately fails open. Refusing a
 * legitimate cancellation is recoverable; deleting someone else's order is
 * not. Every unexpected condition therefore denies, and the whole body is
 * wrapped so that even a thrown exception denies rather than 500s.
 */
function run() {
  // String() is load-bearing, not decoration. Apigee's Rhino engine hands back
  // policy properties as java.lang.String, which is never === to a JS string
  // primitive, so `properties.mode === "flags"` silently evaluates false and
  // every request falls through to the wrong branch. The same applies to
  // anything returned by context.getVariable(), which is why the reads below
  // are wrapped too.
  var mode = String(properties.mode || "flags");


  // ---- Enforcement toggle -------------------------------------------------
  // The `enforceOrderOwnership` custom attribute of the API Product that the
  // caller's Keycloak client (VERIFIED JWT azp) is bound to. This proxy
  // resolves and reads that product itself (JS-ResolveProduct, AE-ApiProduct,
  // JS-ProductAttrs, cached 60s) and publishes it as product.enforce_ownership.
  //
  // Inbound headers are never consulted: AM-StripInboundPolicyHeaders removes
  // the legacy X-Enforce-Order-Ownership / X-Policy-Signature headers at the
  // top of PreFlow, so a customer cannot turn the control off.
  //
  // Only the exact string "false" disables the check. Absent, empty or
  // unrecognised all mean ENFORCE, so a misconfigured product stays protected.
  // The demo "before" state is produced by setting the product attribute to
  // false, which is a change only an operator can make.
  var flag = context.getVariable("product.enforce_ownership");
  var enforce = !(flag && String(flag).toLowerCase() === "false");


  // ---- Caller identity ----------------------------------------------------
  var scope = context.getVariable("jwt.JWT-VerifyToken.claim.scope") || "";
  var isManager = /\bbiscuit_coffee_manager\b/.test(String(scope));
  var callerEmail = String(
    context.getVariable("jwt.JWT-VerifyToken.claim.email") || ""
  ).trim().toLowerCase();

  context.setVariable("order.enforce_ownership", enforce ? "true" : "false");
  context.setVariable("order.is_manager", isManager ? "true" : "false");
  context.setVariable("order.caller_email", callerEmail);

  // ---- List pinning (mode=flags, GET /orders) -----------------------------
  // The backend treats X-User-Email as a default rather than a constraint: a
  // caller-supplied ?filter= / ?email= / ?name= / ?loyalty_id= matches an
  // earlier branch of its elif chain and wins. We therefore overwrite the
  // filter at the gateway instead of trusting the backend to ignore it.
  //
  // The sentinel matters. If the token carried no email we must still emit a
  // NON-EMPTY filter value, because the backend's `if filter_key and
  // filter_val:` treats an empty value as "no filter at all" and streams the
  // entire collection. A value that cannot match any document fails closed.
  var pin = enforce && !isManager;
  context.setVariable("order.pin_filter", pin ? "true" : "false");
  context.setVariable(
    "order.list_filter", "email:" + (callerEmail || "__no_identity__")
  );

  // ---- Order id, taken from the path, not from EV-GetId -------------------
  // Derived here so SC-GetOrderOwner has it before any other policy runs, and
  // so the callout URL cannot be steered by a crafted path segment.
  var suffix = String(context.getVariable("proxy.pathsuffix") || "");
  var m = /^\/orders\/([^\/?#]+)/.exec(suffix);
  var orderId = m ? m[1] : "";
  var idIsSafe = /^[A-Za-z0-9_-]{1,64}$/.test(orderId);
  context.setVariable("order.id", orderId);

  if (mode === "flags") {
    // Decide up front whether the per-order check is needed. Managers and the
    // disabled state skip it, which also avoids a pointless backend call.
    var needsLookup = enforce && !isManager;

    if (!needsLookup) {
      context.setVariable("order.needs_lookup", "false");
      context.setVariable("order.ownership_ok", "true");
      context.setVariable(
        "order.ownership_reason",
        isManager ? "manager_bypass" : "enforcement_disabled"
      );
      return;
    }

    if (orderId && !idIsSafe) {
      // Refuse outright rather than interpolating it into the callout path.
      context.setVariable("order.needs_lookup", "false");
      context.setVariable("order.ownership_ok", "false");
      context.setVariable("order.ownership_reason", "invalid_order_id");
      return;
    }

    // Deny until proven otherwise: if the lookup step is somehow skipped,
    // the RaiseFault still fires.
    context.setVariable("order.needs_lookup", "true");
    context.setVariable("order.ownership_ok", "false");
    context.setVariable("order.ownership_reason", "lookup_pending");
    return;
  }

  // ---- Ownership comparison (mode=lookup | response) ----------------------
  var source = (mode === "lookup") ? "ownerResponse" : "response";
  var status = context.getVariable(source + ".status.code");
  var body = context.getVariable(source + ".content");

  if (String(status) !== "200") {
    // Covers a genuine 404 and any backend failure. Both deny, and both
    // produce the same 404 to the caller, so the response cannot be used to
    // discover whether an order exists.
    context.setVariable("order.ownership_ok", "false");
    context.setVariable(
      "order.ownership_reason",
      String(status) === "404" ? "not_found" : "lookup_failed"
    );
    return;
  }

  var owner = "";
  try {
    owner = String((JSON.parse(body) || {}).email || "").trim().toLowerCase();
  } catch (e) {
    context.setVariable("order.ownership_ok", "false");
    context.setVariable("order.ownership_reason", "unparseable");
    return;
  }

  if (!callerEmail) {
    context.setVariable("order.ownership_ok", "false");
    context.setVariable("order.ownership_reason", "no_caller_identity");
    return;
  }

  if (!owner || owner !== callerEmail) {
    context.setVariable("order.ownership_ok", "false");
    context.setVariable("order.ownership_reason", "not_owner");
    return;
  }

  context.setVariable("order.ownership_ok", "true");
  context.setVariable("order.ownership_reason", "owner_match");
}

try {
  run();
} catch (err) {
  // Never let a scripting error turn into an allow.
  context.setVariable("order.ownership_ok", "false");
  context.setVariable("order.ownership_reason", "script_error");
  context.setVariable("order.pin_filter", "true");
  context.setVariable("order.list_filter", "email:__no_identity__");
}
