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
 * The cap is declared as a custom attribute (`maxOrderAmount`) on the
 * `tools/call/placeOrder` operation of the biscuit-coffee-agent API Product,
 * alongside that operation's quota. Product attributes only materialise as
 * flow variables in the proxy that ran VerifyAPIKey -- that is mcp-proxy-prod,
 * not this proxy -- so mcp-proxy-prod reads the attribute and forwards it as
 * the X-Max-Order-Amount header (see its AM-MaxOrderAmount policy).
 *
 * defaultMaxOrderAmount is only a safety net for callers that arrive without
 * that header, i.e. direct REST clients that never passed through the MCP
 * server. Changing the enforced limit for the agent means editing the API
 * Product, not this file.
 *
 * Sets:
 *   menu.json            - price list (so PC-MenuCache can store it)
 *   order.total          - computed total, 2dp
 *   order.total_display  - same, formatted for the customer message
 *   order.max_display    - the effective cap, formatted
 *   order.item_count     - total number of drinks
 *   order.exceeds_limit  - "true" / "false" (string, for the flow condition)
 *   order.limit_source   - product-attribute | proxy-default (for debugging)
 *   order.pricing_source - cache | callout | fallback (for debugging)
 */

// ----------------------------------------------------------------- the limit
// The header is only trusted when it carries the signature that
// mcp-proxy-prod attaches. This proxy is directly reachable with an ordinary
// customer token, so an unsigned inbound header is attacker-controlled: without
// this check a customer could send `X-Max-Order-Amount: 999999` and lift their
// own spending cap. An unsigned or spoofed header now simply falls through to
// defaultMaxOrderAmount below, which is the safe direction.
//
// Must stay in step with POLICY_SIGNATURE in checkOrderOwnership.js and with
// AM-OwnershipFlag in mcp-proxy-prod. In production this belongs in a KVM.
var POLICY_SIGNATURE = 'bcs-gw-policy-9d41f7a2c6be4815';
var signature = String(context.getVariable('request.header.X-Policy-Signature') || '');
var trusted = (signature === POLICY_SIGNATURE);

var maxAmount = trusted
    ? parseFloat(context.getVariable('request.header.X-Max-Order-Amount'))
    : NaN;
var limitSource = 'product-attribute';

if (isNaN(maxAmount) || maxAmount <= 0) {
    // No usable trusted header: a direct REST caller, an unsigned/spoofed
    // header, or the attribute is not set on the product. Fall back rather
    // than letting an unpriced order past.
    maxAmount = parseFloat(properties.defaultMaxOrderAmount || '100');
    limitSource = 'proxy-default';
}


var defaultPrice = parseFloat(properties.defaultItemPrice || '3.50');

// ---------------------------------------------------------------- menu prices
var menuJson = context.getVariable('menu.json');
var source = 'cache';

if (!menuJson) {
    // Cache miss: use whatever SC-GetMenu returned.
    menuJson = context.getVariable('menuResponse.content');
    source = menuJson ? 'callout' : 'fallback';
    if (menuJson) {
        // Expose it so PC-MenuCache can persist it for later requests.
        context.setVariable('menu.json', menuJson);
    }
}

var prices = {};
if (menuJson) {
    try {
        var menu = JSON.parse(menuJson);
        if (menu && menu.length) {
            for (var i = 0; i < menu.length; i++) {
                if (menu[i] && menu[i].id !== undefined) {
                    prices[menu[i].id] = parseFloat(menu[i].price);
                }
            }
        }
    } catch (e) {
        // Malformed menu: fall through to defaultPrice for every item.
        source = 'fallback';
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
}

total = Math.round(total * 100) / 100;

// Render a whole-dollar cap as "100" rather than "100.00" so the customer
// message reads naturally, while still supporting values like 99.50.
var maxDisplay = (maxAmount % 1 === 0)
    ? maxAmount.toFixed(0)
    : maxAmount.toFixed(2);

context.setVariable('order.total', total);
context.setVariable('order.total_display', total.toFixed(2));
context.setVariable('order.max_display', maxDisplay);
context.setVariable('order.item_count', count);
context.setVariable('order.pricing_source', source);
context.setVariable('order.limit_source', limitSource);
context.setVariable('order.exceeds_limit', total > maxAmount ? 'true' : 'false');
