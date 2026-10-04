/*
 * Turns the governing API Product into flow variables the order policies use.
 *
 * Input, in order of preference:
 *   productattrs.json        - cached by PC-ProductAttrs (LC-ProductAttrs hit)
 *   AccessEntity.AE-ApiProduct - the product entity (JSON) on a cache miss
 *
 * Attributes read (product level first, then the tools/call/placeOrder
 * operation, in case an older product still declares them there):
 *   maxOrderAmount        -> product.max_order_amount
 *   approvalThreshold     -> product.approval_threshold
 *   enforceOrderOwnership -> product.enforce_ownership
 * Missing attributes are left empty; checkOrderValue.js and
 * checkOrderOwnership.js then apply their own safe defaults (cap 100,
 * threshold 50, ownership ENFORCED).
 *
 * Also sets:
 *   productattrs.ok        - "false" when the product could not be loaded
 *                            (RF-Product-Unavailable, 503)
 *   productattrs.cacheable - "true" when freshly loaded (PC-ProductAttrs runs)
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
function attrsOf(o) {
  var out = {};
  asArray(getKey(o, 'attributes'), 'attribute').forEach(function (a) {
    var n = getKey(a, 'name'), v = getKey(a, 'value');
    if (n !== undefined && n !== null) out[String(n)] = (v === undefined || v === null) ? '' : String(v);
  });
  return out;
}
function operationAttrs(product, target) {
  var out = {};
  var group = getKey(product, 'payloadOperationGroup') || getKey(product, 'operationGroup');
  asArray(getKey(group, 'operationConfigs'), 'operationConfig').forEach(function (cfg) {
    var hit = asArray(getKey(cfg, 'operations'), 'operation').some(function (op) {
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

function publish(attrs) {
  context.setVariable('product.max_order_amount', attrs.maxOrderAmount || '');
  context.setVariable('product.approval_threshold', attrs.approvalThreshold || '');
  context.setVariable('product.enforce_ownership', attrs.enforceOrderOwnership || '');
}

context.setVariable('productattrs.ok', 'false');
context.setVariable('productattrs.cacheable', 'false');
try {
  var cached = context.getVariable('productattrs.json');
  var attrs = null;
  if (cached) {
    try { attrs = JSON.parse(String(cached)); } catch (e1) { attrs = null; }
  }
  if (attrs && typeof attrs === 'object') {
    context.setVariable('productattrs.source', 'cache');
  } else {
    var raw = context.getVariable('AccessEntity.AE-ApiProduct');
    var entity = raw ? JSON.parse(String(raw)) : null;
    var product = getKey(entity, 'ApiProduct') || getKey(entity, 'apiProduct') || entity;
    var name = product ? String(getKey(product, 'name') || '') : '';
    if (!product || typeof product !== 'object' || name !== String(context.getVariable('product.name'))) {
      throw new Error('product entity unavailable');
    }
    var p = attrsOf(product);
    var op = operationAttrs(product, 'tools/call/placeOrder');
    attrs = {
      product: name,
      maxOrderAmount: p.maxOrderAmount || op.maxOrderAmount || '',
      approvalThreshold: p.approvalThreshold || op.approvalThreshold || '',
      enforceOrderOwnership: p.enforceOrderOwnership || op.enforceOrderOwnership || ''
    };
    context.setVariable('productattrs.json', JSON.stringify(attrs));
    context.setVariable('productattrs.cacheable', 'true');
    context.setVariable('productattrs.source', 'accessentity');
  }
  publish(attrs);
  context.setVariable('productattrs.ok', 'true');
} catch (e) {
  context.setVariable('productattrs.ok', 'false');
  context.setVariable('productattrs.error', String(e));
}
