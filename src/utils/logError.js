function noop() {}

var map = Array.prototype.map;
var global = Function('return this;')();

/**
 * @typesign (...msg);
 */
function logError() {
	var console = global.console;

	(console && console.error || noop).call(console || global, map.call(arguments, function(part) {
		return part === Object(part) && part.stack || part;
	}).join(' '));
}

module.exports = logError;
