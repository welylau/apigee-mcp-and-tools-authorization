// See policies/JS-JsonRpcId.xml. Stores the JSON-RPC id JSON-encoded in
// jsonrpc.id (7 -> 7, "abc" -> "\"abc\""), falling back to 0.
var encoded = '0';
var raw = '';
try {
    var body = JSON.parse(context.getVariable('request.content') || '');
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        var id = body.id;
        if (typeof id === 'number' && isFinite(id)) {
            encoded = String(id);
            raw = String(id);
        } else if (typeof id === 'string') {
            encoded = JSON.stringify(id);
            raw = id;
        }
    }
} catch (e) {
    // Not JSON (e.g. an SSE GET): keep the fallback.
}
context.setVariable('jsonrpc.id', encoded);
context.setVariable('mcpreq.id', raw);
