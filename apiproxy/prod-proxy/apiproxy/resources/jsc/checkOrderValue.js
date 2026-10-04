/*
 * Prices a placeOrder request at the gateway and flags orders above the cap.
 *
 * WHY THIS EXISTS
 * The inbound POST /biscuit-coffee/orders body contains only item_id and
 * quantity -- no prices and no total. The Cloud Run backend computes
 * total_amount from the Firestore `menu` collection. To enforce a dollar limit
 * BEFORE the order is written, Apigee has to reproduce that calculation.
 *
 * The arithmetic below intentionally mirrors coffee-shop-backend/main.py:
 *   total += menu_dict.get(item_id, 3.50) * quantity
 * including the 3.50 fallback for unknown ids, so the gateway's total always
 * agrees with the backend's.
 *
 * WHERE THE LIMIT COMES FROM
 * The cap (`maxOrderAmount`) and approval threshold (`approvalThreshold`) are
 * custom attributes on the API Product that the caller's Keycloak client is
 * bound to. This proxy resolves that product itself from the VERIFIED JWT
 * `azp` claim (JS-ResolveProduct), reads it with AccessEntity and caches the
 * attributes for 60s (LC/AE/JS/PC-ProductAttrs). The result arrives here as
 * the flow variables product.max_order_amount / product.approval_threshold.
 *
 * Nothing is read from inbound headers: AM-StripInboundPolicyHeaders removes
 * the legacy X-Max-Order-Amount / X-Approval-Threshold / X-Policy-Signature
 * headers at the top of PreFlow, so a caller cannot lift its own cap.
 *
 * defaultMaxOrderAmount / defaultApprovalThreshold are only used if the
 * product does not carry the attribute. Changing the enforced limit means
 * editing the API Product, not this file.
 *
 * PRICING MUST BE REAL
 * If neither the cache nor the SC-GetMenu callout yields a usable menu, the
 * order is NOT priced with fallback prices (that would let a $500 order
 * through as $3.50 x n). order.pricing_unavailable=true makes the flow raise
 * RF-Pricing-Unavailable (503).
 *
 * Sets:
 *   menu.json            - price list (only when it came from a good callout)
 *   menu.cacheable       - "true" when PC-MenuCache should store menu.json
 *   order.pricing_unavailable - "true" when no trustworthy menu was available
 *   order.total          - computed total, 2dp
 *   order.total_display  - same, formatted for the customer message
 *   order.max_display    - the effective cap, formatted
 *   order.item_count     - total number of drinks
 *   order.exceeds_limit  - "true" when total >= cap (string, for the flow condition)
 *   order.requires_approval - "true" when approvalThreshold <= total < cap
 *   order.approval_threshold_display - the effective threshold, formatted
 *   order.limit_source   - product-attribute | proxy-default (for debugging)
 *   order.threshold_source - product-attribute | proxy-default (for debugging)
 *   order.pricing_source - cache | callout | unavailable (for debugging)
 */

// ----------------------------------------------------------------- the limit
var maxAmount = parseFloat(context.getVariable('product.max_order_amount'));
var limitSource = 'product-attribute';

if (isNaN(maxAmount) || maxAmount <= 0) {
    // Attribute missing on the product: fall back rather than letting an
    // unpriced order past.
    maxAmount = parseFloat(properties.defaultMaxOrderAmount || '100');
    limitSource = 'proxy-default';
}

var defaultPrice = parseFloat(properties.defaultItemPrice || '3.50');

// ---------------------------------------------------------------- menu prices
// Returns the parsed menu array, or null unless it is a non-empty array with
// at least one priced item.
function parseMenu(text) {
    if (!text) {
        return null;
    }
    try {
        var m = JSON.parse(text);
        if (!m || typeof m.length !== 'number' || m.length === 0) {
            return null;
        }
        for (var k = 0; k < m.length; k++) {
            if (m[k] && m[k].id !== undefined && !isNaN(parseFloat(m[k].price))) {
                return m;
            }
        }
    } catch (e) {
        // fall through
    }
    return null;
}

var source = 'cache';
var menu = parseMenu(context.getVariable('menu.json'));

if (!menu) {
    // Cache miss (or an unusable cached value): use SC-GetMenu, but only a
    // 200 with a real menu. Anything else is "pricing unavailable".
    var status = String(context.getVariable('menuResponse.status.code') || '');
    var calloutText = context.getVariable('menuResponse.content');
    menu = (status === '200') ? parseMenu(calloutText) : null;
    if (menu) {
        source = 'callout';
        // Expose it so PC-MenuCache can persist it for later requests.
        context.setVariable('menu.json', calloutText);
        context.setVariable('menu.cacheable', 'true');
    } else {
        source = 'unavailable';
    }
}

context.setVariable('order.pricing_unavailable', menu ? 'false' : 'true');

var prices = {};
var names = {};
if (menu) {
    for (var i = 0; i < menu.length; i++) {
        if (menu[i] && menu[i].id !== undefined) {
            prices[menu[i].id] = parseFloat(menu[i].price);
            names[menu[i].id] = String(menu[i].name || menu[i].id) +
                (menu[i].size ? ' (' + menu[i].size + ')' : '');
        }
    }
}

// ---------------------------------------------------------------- order items
var items = [];
try {
    var body = JSON.parse(context.getVariable('request.content') || '{}');
    // The MCP tool schema nests the body under placeOrderBody; the managed MCP
    // service normally unwraps it before calling us. Handle both shapes.
    if (body.items) {
        items = body.items;
    } else if (body.placeOrderBody && body.placeOrderBody.items) {
        items = body.placeOrderBody.items;
    }
} catch (e2) {
    items = [];
}

// ---------------------------------------------------------------- total
var total = 0;
var count = 0;
var summary = [];

for (var j = 0; j < items.length; j++) {
    var item = items[j] || {};
    var qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty < 0) {
        qty = 0;
    }
    var price = prices[item.item_id];
    if (price === undefined || isNaN(price)) {
        price = defaultPrice;
    }
    total += price * qty;
    count += qty;
    if (qty > 0) {
        // Only menu names (or a fixed label for unknown ids) go into the
        // summary, so customer-supplied text cannot shape anything that reads
        // order.items_summary (trace / audit).
        summary.push(qty + ' x ' + (names[item.item_id] || 'unlisted item'));
    }
}

total = Math.round(total * 100) / 100;

// Render a whole-dollar cap as "100" rather than "100.00" so the customer
// message reads naturally, while still supporting values like 99.50.
function money(v) {
    return (v % 1 === 0) ? v.toFixed(0) : v.toFixed(2);
}
var maxDisplay = money(maxAmount);

// ------------------------------------------------------- approval threshold
// Orders from approvalThreshold up to (not including) the cap need a person
// to approve them (human in the loop). Same source as the cap: the product
// attribute resolved by this proxy, never an inbound header. A threshold of
// 0 or less, or one above the cap, turns approval off.
var approvalThreshold = parseFloat(context.getVariable('product.approval_threshold'));
var thresholdSource = 'product-attribute';
if (isNaN(approvalThreshold)) {
    approvalThreshold = parseFloat(properties.defaultApprovalThreshold || '50');
    thresholdSource = 'proxy-default';
}
// The cap is exclusive: online orders must total LESS than maxOrderAmount, so
// a total of exactly the cap (e.g. $100.00) is rejected with 422. Orders from
// approvalThreshold up to (not including) the cap become PENDING_APPROVAL.
var exceeds = total >= maxAmount;
var requiresApproval = !exceeds && approvalThreshold > 0 && total >= approvalThreshold;

context.setVariable('order.total', total);
context.setVariable('order.total_display', total.toFixed(2));
context.setVariable('order.max_display', maxDisplay);
context.setVariable('order.item_count', count);
context.setVariable('order.pricing_source', source);
context.setVariable('order.limit_source', limitSource);
context.setVariable('order.exceeds_limit', exceeds ? 'true' : 'false');
context.setVariable('order.requires_approval', requiresApproval ? 'true' : 'false');
context.setVariable('order.approval_threshold_display',
    isNaN(approvalThreshold) ? '' : money(approvalThreshold));
context.setVariable('order.threshold_source', thresholdSource);
context.setVariable('order.items_summary', summary.join(', '));
