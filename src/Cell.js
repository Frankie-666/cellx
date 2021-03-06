var EventEmitter = require('./EventEmitter');
var is = require('./js/is');
var nextTick = require('./utils/nextTick');

var slice = Array.prototype.slice;

var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || 0x1fffffffffffff;
var KEY_INNER = EventEmitter.KEY_INNER;

var pushingIndexCounter = 0;

var releasePlan = [];

var releasePlanIndex = MAX_SAFE_INTEGER;
var releasePlanToIndex = -1;

var releasePlanned = false;
var currentlyRelease = false;

var releaseVersion = 1;

var afterReleaseCallbacks;

function release() {
	if (!releasePlanned) {
		return;
	}

	releasePlanned = false;
	currentlyRelease = true;

	var queue = releasePlan[releasePlanIndex];

	for (;;) {
		var cell = (queue || []).shift();

		if (!cell) {
			if (++releasePlanIndex > releasePlanToIndex) {
				break;
			}

			queue = releasePlan[releasePlanIndex];
			continue;
		}

		var oldReleasePlanIndex = releasePlanIndex;

		var level = cell._level;
		var changeEvent = cell._changeEvent;

		if (!changeEvent) {
			if (level > releasePlanIndex || cell._levelInRelease == -1) {
				if (!queue.length) {
					if (++releasePlanIndex > releasePlanToIndex) {
						break;
					}

					queue = releasePlan[releasePlanIndex];
				}

				continue;
			}

			cell.pull();

			level = cell._level;
			changeEvent = cell._changeEvent;

			if (releasePlanIndex == oldReleasePlanIndex) {
				if (level > releasePlanIndex) {
					if (!queue.length) {
						queue = releasePlan[++releasePlanIndex];
					}

					continue;
				}
			} else {
				if (changeEvent) {
					queue.unshift(cell);
				} else if (level <= oldReleasePlanIndex) {
					cell._levelInRelease = -1;
				}

				queue = releasePlan[releasePlanIndex];
				continue;
			}
		}

		cell._levelInRelease = -1;

		if (changeEvent) {
			cell._fixedValue = cell._value;
			cell._changeEvent = null;

			if (cell._events.change) {
				cell._handleEvent(changeEvent);
			}

			var pushingIndex = cell._pushingIndex;
			var slaves = cell._slaves;

			for (var i = 0, l = slaves.length; i < l; i++) {
				var slave = slaves[i];

				if (slave._level <= level) {
					slave._level = level + 1;
				}

				if (pushingIndex > slave._pushingIndex) {
					slave._pushingIndex = pushingIndex;
					slave._changeEvent = null;

					slave._addToRelease();
				}
			}
		}

		if (releasePlanIndex == oldReleasePlanIndex) {
			if (queue.length) {
				continue;
			}

			if (++releasePlanIndex > releasePlanToIndex) {
				break;
			}
		}

		queue = releasePlan[releasePlanIndex];
	}

	releasePlanIndex = MAX_SAFE_INTEGER;
	releasePlanToIndex = -1;

	currentlyRelease = false;

	releaseVersion++;

	if (afterReleaseCallbacks) {
		var callbacks = afterReleaseCallbacks;

		afterReleaseCallbacks = null;

		for (var j = 0, m = callbacks.length; j < m; j++) {
			callbacks[j]();
		}
	}
}

var currentCell = null;
var error = {
	original: null
};

/**
 * @typesign (value);
 */
function defaultPut(value, push) {
	push(value);
}

/**
 * @class cellx.Cell
 * @extends {cellx.EventEmitter}
 *
 * @example
 * var a = new Cell(1);
 * var b = new Cell(2);
 * var c = new Cell(function() {
 *     return a.get() + b.get();
 * });
 *
 * c.on('change', function() {
 *     console.log('c = ' + c.get());
 * });
 *
 * console.log(c.get());
 * // => 3
 *
 * a.set(5);
 * b.set(10);
 * // => 'c = 15'
 *
 * @typesign new Cell(value?, opts?: {
 *     debugKey?: string,
 *     owner?: Object,
 *     get?: (value) -> *,
 *     validate?: (value, oldValue),
 *     merge: (value, oldValue) -> *,
 *     onChange?: (evt: cellx~Event) -> ?boolean,
 *     onError?: (evt: cellx~Event) -> ?boolean
 * }) -> cellx.Cell;
 *
 * @typesign new Cell(pull: (push: (value), fail: (err), oldValue) -> *, opts?: {
 *     debugKey?: string,
 *     owner?: Object,
 *     get?: (value) -> *,
 *     validate?: (value, oldValue),
 *     merge: (value, oldValue) -> *,
 *     put?: (value, push: (value), fail: (err), oldValue),
 *     reap?: (),
 *     onChange?: (evt: cellx~Event) -> ?boolean,
 *     onError?: (evt: cellx~Event) -> ?boolean
 * }) -> cellx.Cell;
 */
var Cell = EventEmitter.extend({
	Static: {
		/**
		 * @typesign (cb: Function);
		 */
		afterRelease: function(cb) {
			(afterReleaseCallbacks || (afterReleaseCallbacks = [])).push(cb);
		}
	},

	constructor: function Cell(value, opts) {
		EventEmitter.call(this);

		if (!opts) {
			opts = {};
		}

		var cell = this;

		this.debugKey = opts.debugKey;

		this.owner = opts.owner || this;

		this._pull = typeof value == 'function' ? value : null;
		this._get = opts.get || null;

		this._validate = opts.validate || null;
		this._merge = opts.merge || null;

		this._put = opts.put || defaultPut;

		var push = this.push;
		var fail = this.fail;

		this.push = function(value) { push.call(cell, value); };
		this.fail = function(err) { fail.call(cell, err); };

		this._onFulfilled = this._onRejected = null;

		this._reap = opts.reap || null;

		if (this._pull) {
			this._fixedValue = this._value = void 0;
		} else {
			if (this._validate) {
				this._validate(value, void 0);
			}
			if (this._merge) {
				value = this._merge(value, void 0);
			}

			this._fixedValue = this._value = value;

			if (value instanceof EventEmitter) {
				value.on('change', this._onValueChange, this);
			}
		}

		this._error = null;
		this._errorCell = null;

		this._pushingIndex = 0;
		this._version = 0;

		this._inited = false;
		this._currentlyPulls = false;
		this._active = false;
		this._hasFollowers = false;

		/**
		 * Ведущие ячейки.
		 * @type {?Array<cellx.Cell>}
		 */
		this._masters = null;
		/**
		 * Ведомые ячейки.
		 * @type {Array<cellx.Cell>}
		 */
		this._slaves = [];

		this._level = 0;
		this._levelInRelease = -1;

		this._pending = this._fulfilled = this._rejected = false;

		this._changeEvent = null;
		this._canCancelChange = true;

		this._lastErrorEvent = null;

		if (opts.onChange) {
			this.on('change', opts.onChange);
		}
		if (opts.onError) {
			this.on('error', opts.onError);
		}
	},

	/**
	 * @override
	 */
	on: function on(type, listener, context) {
		if (releasePlanned) {
			release();
		}

		this._activate();

		if (typeof type == 'object') {
			EventEmitter.prototype.on.call(this, type, arguments.length >= 2 ? listener : this.owner);
		} else {
			EventEmitter.prototype.on.call(this, type, listener, arguments.length >= 3 ? context : this.owner);
		}

		this._hasFollowers = true;

		return this;
	},
	/**
	 * @override
	 */
	off: function off(type, listener, context) {
		if (releasePlanned) {
			release();
		}

		var argCount = arguments.length;

		if (argCount) {
			if (typeof type == 'object') {
				EventEmitter.prototype.off.call(this, type, argCount >= 2 ? listener : this.owner);
			} else {
				EventEmitter.prototype.off.call(this, type, listener, argCount >= 3 ? context : this.owner);
			}
		} else {
			EventEmitter.prototype.off.call(this);
		}

		if (!this._slaves.length && !this._events.change && !this._events.error) {
			this._hasFollowers = false;
			this._deactivate();
		}

		return this;
	},

	/**
	 * @typesign (
	 *     listener: (evt: cellx~Event) -> ?boolean,
	 *     context?
	 * ) -> cellx.Cell;
	 */
	addChangeListener: function addChangeListener(listener, context) {
		return this.on('change', listener, arguments.length >= 2 ? context : this.owner);
	},
	/**
	 * @typesign (
	 *     listener: (evt: cellx~Event) -> ?boolean,
	 *     context?
	 * ) -> cellx.Cell;
	 */
	removeChangeListener: function removeChangeListener(listener, context) {
		return this.off('change', listener, arguments.length >= 2 ? context : this.owner);
	},

	/**
	 * @typesign (
	 *     listener: (evt: cellx~Event) -> ?boolean,
	 *     context?
	 * ) -> cellx.Cell;
	 */
	addErrorListener: function addErrorListener(listener, context) {
		return this.on('error', listener, arguments.length >= 2 ? context : this.owner);
	},
	/**
	 * @typesign (
	 *     listener: (evt: cellx~Event) -> ?boolean,
	 *     context?
	 * ) -> cellx.Cell;
	 */
	removeErrorListener: function removeErrorListener(listener, context) {
		return this.off('error', listener, arguments.length >= 2 ? context : this.owner);
	},

	/**
	 * @typesign (
	 *     listener: (err: ?Error, evt: cellx~Event) -> ?boolean,
	 *     context?
	 * ) -> cellx.Cell;
	 */
	subscribe: function subscribe(listener, context) {
		function wrapper(evt) {
			return listener.call(this, evt.error || null, evt);
		}
		wrapper[KEY_INNER] = listener;

		if (arguments.length < 2) {
			context = this.owner;
		}

		return this
			.on('change', wrapper, context)
			.on('error', wrapper, context);
	},
	/**
	 * @typesign (
	 *     listener: (err: ?Error, evt: cellx~Event) -> ?boolean,
	 *     context?
	 * ) -> cellx.Cell;
	 */
	unsubscribe: function unsubscribe(listener, context) {
		if (arguments.length < 2) {
			context = this.owner;
		}

		return this
			.off('change', listener, context)
			.off('error', listener, context);
	},

	/**
	 * @typesign (slave: cellx.Cell);
	 */
	_registerSlave: function _registerSlave(slave) {
		this._activate();

		this._slaves.push(slave);
		this._hasFollowers = true;
	},
	/**
	 * @typesign (slave: cellx.Cell);
	 */
	_unregisterSlave: function _unregisterSlave(slave) {
		this._slaves.splice(this._slaves.indexOf(slave), 1);

		if (!this._slaves.length && !this._events.change && !this._events.error) {
			this._hasFollowers = false;
			this._deactivate();
		}
	},

	/**
	 * @typesign ();
	 */
	_activate: function _activate() {
		if (!this._pull || this._active || this._inited && !this._masters) {
			return;
		}

		if (this._version < releaseVersion) {
			var value = this._tryPull();

			if (value === error) {
				this._fail(error.original, true);
			} else {
				this._push(value, true);
			}
		}

		var masters = this._masters;

		if (masters) {
			for (var i = masters.length; i;) {
				masters[--i]._registerSlave(this);
			}

			this._active = true;
		}
	},
	/**
	 * @typesign ();
	 */
	_deactivate: function _deactivate() {
		if (!this._active) {
			return;
		}

		var masters = this._masters;

		for (var i = masters.length; i;) {
			masters[--i]._unregisterSlave(this);
		}

		this._active = false;

		if (this._reap) {
			this._reap.call(this.owner);
		}
	},

	/**
	 * @typesign ();
	 */
	_addToRelease: function _addToRelease() {
		var level = this._level;

		if (level <= this._levelInRelease) {
			return;
		}

		(releasePlan[level] || (releasePlan[level] = [])).push(this);

		if (releasePlanIndex > level) {
			releasePlanIndex = level;
		}
		if (releasePlanToIndex < level) {
			releasePlanToIndex = level;
		}

		this._levelInRelease = level;

		if (!releasePlanned && !currentlyRelease) {
			releasePlanned = true;
			nextTick(release);
		}
	},

	/**
	 * @typesign (evt: cellx~Event);
	 */
	_onValueChange: function _onValueChange(evt) {
		this._pushingIndex = ++pushingIndexCounter;

		if (this._changeEvent) {
			evt.prev = this._changeEvent;
			this._changeEvent = evt;

			if (this._value === this._fixedValue) {
				this._canCancelChange = false;
			}
		} else {
			evt.prev = null;
			this._changeEvent = evt;
			this._canCancelChange = false;

			this._addToRelease();
		}
	},

	/**
	 * @typesign () -> boolean;
	 */
	pull: function pull() {
		if (!this._pull) {
			return false;
		}

		if (releasePlanned) {
			release();
		}

		var hasFollowers = this._hasFollowers;

		var oldMasters;
		var oldLevel;

		if (hasFollowers) {
			oldMasters = this._masters || [];
			oldLevel = this._level;
		}

		this._pending = true;
		this._fulfilled = this._rejected = false;

		var value = this._tryPull();

		if (hasFollowers) {
			var masters = this._masters || [];
			var masterCount = masters.length;
			var notFoundMasterCount = 0;

			for (var i = masterCount; i;) {
				var master = masters[--i];

				if (oldMasters.indexOf(master) == -1) {
					master._registerSlave(this);
					notFoundMasterCount++;
				}
			}

			if (masterCount - notFoundMasterCount < oldMasters.length) {
				for (var j = oldMasters.length; j;) {
					var oldMaster = oldMasters[--j];

					if (masters.indexOf(oldMaster) == -1) {
						oldMaster._unregisterSlave(this);
					}
				}
			}

			this._active = !!masterCount;

			if (currentlyRelease && this._level > oldLevel) {
				this._addToRelease();
				return false;
			}
		}

		if (value === error) {
			this._fail(error.original, currentlyRelease);
			return true;
		}

		return this._push(value, currentlyRelease);
	},

	/**
	 * @typesign () -> *;
	 */
	_tryPull: function _tryPull() {
		if (this._currentlyPulls) {
			throw new TypeError('Circular pulling detected');
		}

		var prevCell = currentCell;
		currentCell = this;

		this._currentlyPulls = true;
		this._masters = null;
		this._level = 0;

		try {
			return this._pull.call(this.owner, this.push, this.fail, this._value);
		} catch (err) {
			error.original = err;
			return error;
		} finally {
			currentCell = prevCell;

			this._version = releaseVersion + currentlyRelease;

			this._inited = true;
			this._currentlyPulls = false;
		}
	},

	/**
	 * @typesign () -> *;
	 */
	get: function get() {
		if (releasePlanned && this._pull) {
			release();
		}

		if (this._pull && !this._active && this._version < releaseVersion && (!this._inited || this._masters)) {
			var value = this._tryPull();

			if (this._hasFollowers) {
				var masters = this._masters;

				if (masters) {
					for (var i = masters.length; i;) {
						masters[--i]._registerSlave(this);
					}

					this._active = true;
				}
			}

			if (value === error) {
				this._fail(error.original, true);
			} else {
				this._push(value, true);
			}
		}

		if (currentCell) {
			var currentCellMasters = currentCell._masters;
			var level = this._level;

			if (currentCellMasters) {
				if (currentCellMasters.indexOf(this) == -1) {
					currentCellMasters.push(this);

					if (currentCell._level <= level) {
						currentCell._level = level + 1;
					}
				}
			} else {
				currentCell._masters = [this];
				currentCell._level = level + 1;
			}
		}

		return this._get ? this._get(this._value) : this._value;
	},

	/**
	 * @typesign (value) -> cellx.Cell;
	 */
	set: function set(value) {
		var oldValue = this._value;

		if (this._validate) {
			this._validate(value, oldValue);
		}
		if (this._merge) {
			value = this._merge(value, oldValue);
		}

		this._put.call(this.owner, value, this.push, this.fail, oldValue);

		return this;
	},

	/**
	 * @typesign (value) -> cellx.Cell;
	 */
	push: function push(value) {
		this._push(value, false);
		return this;
	},

	/**
	 * @typesign (value, internal: boolean) -> boolean;
	 */
	_push: function _push(value, internal) {
		this._setError(null);

		if (!internal) {
			this._pushingIndex = ++pushingIndexCounter;
		}

		var oldValue = this._value;

		if (is(value, oldValue)) {
			return false;
		}

		this._value = value;

		if (oldValue instanceof EventEmitter) {
			oldValue.off('change', this._onValueChange, this);
		}
		if (value instanceof EventEmitter) {
			value.on('change', this._onValueChange, this);
		}

		if (this._hasFollowers) {
			if (this._changeEvent) {
				if (is(value, this._fixedValue) && this._canCancelChange) {
					this._levelInRelease = -1;
					this._changeEvent = null;
				} else {
					this._changeEvent = {
						target: this,
						type: 'change',
						oldValue: oldValue,
						value: value,
						prev: this._changeEvent
					};
				}
			} else {
				this._changeEvent = {
					target: this,
					type: 'change',
					oldValue: oldValue,
					value: value,
					prev: null
				};
				this._canCancelChange = true;

				this._addToRelease();
			}
		} else {
			if (!currentlyRelease && !internal) {
				releaseVersion++;
			}

			this._fixedValue = value;
		}

		if (!internal && this._pending) {
			this._pending = false;
			this._fulfilled = true;

			if (this._onFulfilled) {
				this._onFulfilled(value);
			}
		}

		return true;
	},

	/**
	 * @typesign (err) -> cellx.Cell;
	 */
	fail: function fail(err) {
		this._fail(err, false);
		return this;
	},

	/**
	 * @typesign (err, internal: boolean);
	 */
	_fail: function _fail(err, internal) {
		this._logError(err);

		if (!(err instanceof Error)) {
			err = new Error(String(err));
		}

		if (!internal && this._pending) {
			this._pending = false;
			this._rejected = true;

			if (this._onRejected) {
				this._onRejected(err);
			}
		}

		this._handleErrorEvent({
			type: 'error',
			error: err
		});
	},

	/**
	 * @typesign (evt: cellx~Event{ error: Error });
	 */
	_handleErrorEvent: function _handleErrorEvent(evt) {
		if (this._lastErrorEvent === evt) {
			return;
		}

		this._setError(evt.error);

		this._lastErrorEvent = evt;
		this._handleEvent(evt);

		var slaves = this._slaves;

		for (var i = 0, l = slaves.length; i < l; i++) {
			slaves[i]._handleErrorEvent(evt);
		}
	},

	/**
	 * @typesign () -> ?Error;
	 */
	getError: function getError() {
		return (this._errorCell || (this._errorCell = new Cell(this._error))).get();
	},

	/**
	 * @typesign (err: ?Error);
	 */
	_setError: function _setError(err) {
		if (this._error === err) {
			return;
		}

		this._error = err;

		if (this._errorCell) {
			this._errorCell.set(err);
		}

		if (!err) {
			var slaves = this._slaves;

			for (var i = 0, l = slaves.length; i < l; i++) {
				slaves[i]._setError(err);
			}
		}
	},

	/**
	 * @typesign (onFulfilled?: (value) -> *, onRejected?: (err) -> *) -> Promise;
	 */
	then: function then(onFulfilled, onRejected) {
		if (releasePlanned) {
			release();
		}

		if (!this._pull || this._fulfilled) {
			return Promise.resolve(this._get ? this._get(this._value) : this._value).then(onFulfilled);
		}

		if (this._rejected) {
			return Promise.reject(this._error).catch(onRejected);
		}

		var cell = this;

		var promise = new Promise(function(resolve, reject) {
			cell._onFulfilled = function onFulfilled(value) {
				cell._onFulfilled = cell._onRejected = null;
				resolve(cell._get ? cell._get(value) : value);
			};

			cell._onRejected = function onRejected(err) {
				cell._onFulfilled = cell._onRejected = null;
				reject(err);
			};
		}).then(onFulfilled, onRejected);

		if (!this._pending) {
			this.pull();
		}

		return promise;
	},

	/**
	 * @typesign (onRejected: (err) -> *) -> Promise;
	 */
	catch: function _catch(onRejected) {
		return this.then(null, onRejected);
	},

	/**
	 * @override
	 */
	_logError: function _logError() {
		var msg = slice.call(arguments);

		if (this.debugKey) {
			msg.unshift('[' + this.debugKey + ']');
		}

		EventEmitter.prototype._logError.apply(this, msg);
	},

	/**
	 * @typesign () -> cellx.Cell;
	 */
	dispose: function dispose() {
		if (releasePlanned) {
			release();
		}

		this._dispose();

		return this;
	},

	/**
	 * @typesign ();
	 */
	_dispose: function _dispose() {
		var slaves = this._slaves;

		for (var i = 0, l = slaves.length; i < l; i++) {
			slaves[i]._dispose();
		}

		this.off();
	}
});

module.exports = Cell;
