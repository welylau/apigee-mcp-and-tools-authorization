// 1. Retrieve the 'filter' flow variable
var filterRaw = context.getVariable("filter");

if (filterRaw) {
    // 2. Locate the first colon to separate key and value
    // We use indexOf instead of split(':') in case the value itself contains a colon
    var separatorIndex = filterRaw.indexOf(':');
    
    if (separatorIndex !== -1) {
        var key = filterRaw.substring(0, separatorIndex).trim();
        var value = filterRaw.substring(separatorIndex + 1).trim();
        
        // 3. Create the new flow variable
        if (key.length > 0) {
            context.setVariable(key, value);
        }
    }
}