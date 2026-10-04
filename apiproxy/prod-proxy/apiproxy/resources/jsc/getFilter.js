// Validates the optional ?filter=key:value query parameter.
//
// SECURITY: the previous version called context.setVariable(key, value) with
// a caller-chosen key, letting any client overwrite arbitrary flow variables
// (e.g. jwt.*, order.*, request.header.*). This version never derives a
// variable NAME from user input. It only accepts keys the backend's
// GET /orders filter supports, and flags anything else so the PreFlow can
// reject the request with 400 (RF-Invalid-Filter).
//
// Outputs:
//   orderfilter.key, orderfilter.value  - parsed, validated filter (only when valid)
//   orderfilter.invalid = "true"   - request must be rejected
//   orderfilter.error              - fixed, non-reflective error message
var ALLOWED_KEYS = { email: true, name: true, loyalty_id: true, status: true };

function reject(msg) {
    context.setVariable("orderfilter.invalid", "true");
    context.setVariable("orderfilter.error", msg);
}

var count = parseInt(context.getVariable("request.queryparam.filter.values.count") || "0", 10);
if (count > 1) {
    // EV/JS would see the first value but the backend may use another one.
    reject("Only one filter parameter is allowed.");
} else if (count === 1) {
    var filterRaw = String(context.getVariable("request.queryparam.filter") || "");
    var separatorIndex = filterRaw.indexOf(":");
    if (separatorIndex === -1) {
        reject("Filter must use the format key:value.");
    } else {
        var key = filterRaw.substring(0, separatorIndex).trim();  // case-sensitive, as in the backend
        var value = filterRaw.substring(separatorIndex + 1).trim();
        if (!ALLOWED_KEYS.hasOwnProperty(key)) {
            reject("Unsupported filter key. Supported keys: email, name, loyalty_id, status.");
        } else if (value.length === 0 || value.length > 200) {
            reject("Filter value must be 1-200 characters.");
        } else {
            context.setVariable("orderfilter.key", key);
            context.setVariable("orderfilter.value", value);
        }
    }
}