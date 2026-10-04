/*
 * Builds the customer-facing order confirmation sentence.
 *
 * WHY THIS IS A SCRIPT AND NOT MESSAGE TEMPLATING
 * JSON has no decimal type, so a total of 3.50 arrives from the backend
 * serialised as `3.5`. Interpolating that straight into a sentence would show
 * the customer "$3.5". toFixed(2) is the whole reason this step exists.
 *
 * THE GATEWAY OWNS THIS WORDING
 * The backend supplies the number; the sentence itself is defined here so the
 * customer-facing language lives with the API policy rather than the service.
 * The agent is instructed to relay it verbatim.
 *
 * FAILS SAFE
 * If total_amount is missing or unparseable -- for instance if this proxy is
 * ever deployed ahead of the backend change that added the field -- we leave
 * the response untouched rather than emit "$undefined" or "$NaN".
 *
 * Sets:
 *   order.confirmation_ok      - "true" / "false", gates AM-OrderConfirmation
 *   order.confirmation_message - the sentence to return to the customer
 *                                (pending-approval wording when
 *                                order.requires_approval is "true")
 *   order.confirmation_status  - "CONFIRMED" / "PENDING_APPROVAL" (machine-readable)
 */

var orderId = context.getVariable('orderres.order_id');
var rawTotal = context.getVariable('orderres.total_amount');
var total = parseFloat(rawTotal);
// Set by checkOrderValue.js on the request side. When true the backend saved
// the order as PENDING_APPROVAL and an approval request is sent to the store.
var pending = String(context.getVariable('order.requires_approval')) === 'true';

if (!orderId || rawTotal === null || rawTotal === undefined ||
    rawTotal === '' || isNaN(total)) {
    // Not enough information to quote a price - leave the response as-is.
    context.setVariable('order.confirmation_ok', 'false');
} else if (pending) {
    context.setVariable('order.confirmation_ok', 'true');
    // Machine-readable status for clients (the Web UI shows a PENDING badge and
    // starts watching the order). Clients must key on this, not the sentence.
    context.setVariable('order.confirmation_status', 'PENDING_APPROVAL');
    context.setVariable(
        'order.confirmation_message',
        'Thanks! Your order ' + orderId + ' for $' + total.toFixed(2) +
        ' has been placed and is now pending approval. Orders of $' +
        (context.getVariable('order.approval_threshold_display') || '50') +
        ' or more need a quick sign-off from the staff, and your order has been sent to them. ' +
        "We'll let you know as soon as the staff responds.");
} else {
    context.setVariable('order.confirmation_ok', 'true');
    context.setVariable('order.confirmation_status', 'CONFIRMED');
    context.setVariable(
        'order.confirmation_message',
        'Your order is confirmed. Your order ID is ' + orderId +
        ' and the total is $' + total.toFixed(2) + '.');
}
