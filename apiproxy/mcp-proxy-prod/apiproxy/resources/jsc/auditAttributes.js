/**
 * auditAttributes.js - AUDIT LOGGING helper (shared by mcp-proxy and Biscuit-Coffee-Shop).
 *
 * Generic enumeration of CUSTOM ATTRIBUTES from AccessEntity results, so new
 * attributes on the app / product appear in the audit log with no code change.
 *
 * Properties (from the Javascript policy):
 *   stage        "prepare" | "final"            (default "final")
 *   appVar       AccessEntity output var for the app       (e.g. AccessEntity.AE-AuditApp)
 *   productVar   AccessEntity output var for the product   (e.g. AccessEntity.AE-AuditProduct)
 *   developerVar AccessEntity output var for the developer (optional)
 *
 * stage=prepare (Biscuit-Coffee-Shop only):
 *   From the app entity, list the products bound to the caller's key
 *   (audit.client_id) and pick audit.product: the X-Audit-Product hint is
 *   accepted ONLY if it is one of those products, otherwise the first product.
 *
 * stage=final:
 *   Writes audit.attributes_json = {"app":{..},"product":{..},"operation":{..}}
 *   and fills audit.app / audit.developer_email when still empty.
 *
 * Never throws: any failure leaves the pre-seeded "{}" in place.
 */
function getKey(o, k) {
  if (!o || typeof o !== 'object') return undefined;
  var lk = k.toLowerCase();
  for (var p in o) { if (o.hasOwnProperty(p) && p.toLowerCase() === lk) return o[p]; }
  return undefined;
}
function asArray(v, innerName) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v;
  var inner = innerName ? getKey(v, innerName) : undefined;
  if (inner !== undefined) return Array.isArray(inner) ? inner : [inner];
  return [v];
}
function parseEntity(varName, rootNames) {
  if (!varName) return null;
  var raw = context.getVariable(varName);
  if (!raw) return null;
  var o;
  try { o = JSON.parse(String(raw)); } catch (e) { return null; }
  for (var i = 0; i < rootNames.length; i++) {
    var r = getKey(o, rootNames[i]);
    if (r && typeof r === 'object') return r;
  }
  return o;
}
function attrsOf(o) {
  var out = {};
  asArray(getKey(o, 'attributes'), 'attribute').forEach(function (a) {
    var n = getKey(a, 'name'), v = getKey(a, 'value');
    if (n !== undefined && n !== null) out[String(n)] = (v === undefined || v === null) ? '' : String(v);
  });
  return out;
}
function credentialsOf(app) {
  return asArray(getKey(app, 'credentials'), 'credential');
}
function productNamesOf(cred) {
  return asArray(getKey(cred, 'apiProducts'), 'apiProduct').map(function (p) {
    return typeof p === 'string' ? p : String(getKey(p, 'apiproduct') || getKey(p, 'name') || '');
  }).filter(function (n) { return n; });
}
function operationAttrs(product, tool) {
  var out = {};
  if (!product || !tool) return out;
  var target = 'tools/call/' + tool;
  var group = getKey(product, 'payloadOperationGroup') || getKey(product, 'operationGroup');
  asArray(getKey(group, 'operationConfigs'), 'operationConfig').forEach(function (cfg) {
    var ops = asArray(getKey(cfg, 'operations'), 'operation');
    var hit = ops.some(function (op) {
      var name = typeof op === 'string' ? op : (getKey(op, 'operation') || getKey(op, 'resource'));
      return String(name) === target;
    });
    if (hit) {
      var a = attrsOf(cfg);
      for (var k in a) { if (a.hasOwnProperty(k)) out[k] = a[k]; }
    }
  });
  return out;
}

try {
  var stage = String(properties.stage || 'final');
  var app = parseEntity(properties.appVar, ['App', 'app']);
  var clientId = String(context.getVariable('audit.client_id') || '');

  if (stage === 'prepare') {
    var products = [];
    credentialsOf(app).forEach(function (c) {
      if (String(getKey(c, 'consumerKey') || '') === clientId) products = products.concat(productNamesOf(c));
    });
    var hint = String(context.getVariable('request.header.X-Audit-Product') || '');
    var chosen = (hint && products.indexOf(hint) >= 0) ? hint : (products[0] || '');
    context.setVariable('audit.products', products.join(','));
    context.setVariable('audit.product', chosen);
  } else {
    var product = parseEntity(properties.productVar, ['ApiProduct', 'apiProduct', 'Product']);
    var developer = parseEntity(properties.developerVar, ['Developer', 'developer']);
    var tool = String(context.getVariable('mcpaudit.tool') || properties.tool || '');

    var opAttrs = operationAttrs(product, tool);
    // Fallback for operation attributes that the product entity may not expose.
    var maxOrder = context.getVariable('verifyapikey.VA-VerifyKey.apiproduct.operation.payload.attributes.maxOrderAmount') ||
                   context.getVariable('verifyapikey.VA-VerifyKey-Header.apiproduct.operation.payload.attributes.maxOrderAmount');
    if (maxOrder && opAttrs.maxOrderAmount === undefined) opAttrs.maxOrderAmount = String(maxOrder);

    context.setVariable('audit.attributes_json', JSON.stringify({
      app: attrsOf(app),
      product: attrsOf(product),
      operation: opAttrs
    }));
    if (app && !context.getVariable('audit.app')) {
      context.setVariable('audit.app', String(getKey(app, 'name') || ''));
    }
    if (developer && !context.getVariable('audit.developer_email')) {
      context.setVariable('audit.developer_email', String(getKey(developer, 'email') || ''));
    }
  }
} catch (e) {
  context.setVariable('audit.attributes_error', String(e));
}
