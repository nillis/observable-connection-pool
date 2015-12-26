'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _mangabiDatastructures = require('mangabi-datastructures');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function Pool(clientFactory) {
  var opts = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  var options = {
    idleTimeoutMillis: opts.idleTimeoutMillis || 30000,
    reapInterval: opts.reapInterval || 1000,
    refreshIdle: 'refreshIdle' in opts ? opts.refreshIdle : true,
    returnToHead: opts.returnToHead || false,
    validate: opts.validate || function () {},
    priorityRange: opts.priorityRange || 10,
    max: Math.max(isNaN(opts.max) ? 1 : Number(opts.max), 1),
    min: isNaN(opts.min) ? 0 : Number(opts.min)
  };
  options.min = Math.min(options.min, options.max - 1);

  var name = clientFactory.name;

  var availableConnections = [];

  var waitingClients = Object.create(_mangabiDatastructures.PriorityQueue);
  waitingClients.comparator = priorityComparator;

  var totalConnections = 0;
  var removeIdleScheduled = false;
  var removeIdleTimer = null;
  var draining = false;

  var log = options.log ? wrapLogger(options.log, name) : function () {};

  ensureMinimum();

  /**
   * Request a new client. The callback will be called,
   * when a new client will be availabe, passing the client to it.
   *
   * @public
   * @param {Function|Observer} observer
   * @param {Number} [priority] Integer between 0 and (priorityRange - 1).
   *  Specifies the priority of the caller if there are no available resources.
   *  Lower numbers mean higher priority.
   */
  function acquire(observer) {
    var priority = arguments.length <= 1 || arguments[1] === undefined ? Math.floor(options.priorityRange / 2) : arguments[1];

    if (draining) {
      return observer.onError('pool is draining and cannot accept work');
    }
    waitingClients.enqueue(observer, Math.max(Math.min(priority, 0), options.priorityRange));
    dispense();
    return totalConnections < options.max;
  }

  /**
   * Request the client to be destroyed. The factory's destroy handler
   * will also be called.
   *
   * This should be called within an acquire() block as an alternative to release().
   *
   * @public
   * @param {Object} connection The acquired item to be destoyed.
   */
  function destroy(connection) {
    clientFactory.destroy(connection, function onDestroy() {
      totalConnections -= 1;
      _lodash2.default.remove(availableConnections, function (connectionWithTimeout) {
        return connectionWithTimeout === connection;
      });
      ensureMinimum();
    });
  }

  /**
   * Return the client to the pool, in case it is no longer required.
   *
   * @param {Object} connection
   *   The acquired object to be put back to the pool.
   */
  function release(connection) {
    // check to see if this object has already been released
    if (availableConnections.some(function (connectionWithTimeout) {
      return connectionWithTimeout.connection === connection;
    })) {
      return;
    }
    var connectionWithTimeout = {
      connection: connection,
      timeout: Date.now() + options.idleTimeoutMillis
    };

    if (options.returnToHead) {
      availableConnections.splice(0, 0, connectionWithTimeout);
    } else {
      availableConnections.push(connectionWithTimeout);
    }

    dispense();
    scheduleRemoveIdle();
  }

  function returnToPool(connection) {
    release(connection);
  }

  /**
   * Disallow any new requests and let the request backlog dissapate.
   *
   * @param {Observer|Function} observer
   *   Optional. Callback invoked when all work is done and all clients have been
   *   released.
   */
  function drain(observer) {
    draining = true;

    function check() {
      if (waitingClients.size() > 0) {
        setTimeout(check, 100);
      } else if (availableConnections.length !== totalConnections) {
        setTimeout(check, 100);
      } else {
        if (observer && observer.onCompleted) {
          observer.onCompleted();
        } else if (typeof observer == 'function') {
          observer();
        }
      }
    }
    check();
  }

  /**
   * Forcibly destroys all clients regardless of timeout.  Intended to be
   * invoked as part of a drain.  Does not prevent the creation of new
   * clients as a result of subsequent calls to acquire.
   *
   * Note that if options.min > 0, the pool will destroy all idle resources
   * in the pool, but replace them with newly created resources up to the
   * specified options.min value.  If this is not desired, set options.min
   * to zero before calling destroyAllNow()
   *
   * @param {Observer|Function} observer
   *   Optional. Callback invoked after all existing clients are destroyed.
   */
  function destroyAllNow(observer) {
    _lodash2.default.remove(availableConnections, function (connectionWithTimeout) {
      destroy(connectionWithT(connectionWithTimeout.connection));
    });
    removeIdleScheduled = false;
    clearTimeout(removeIdleTimer);

    if (observer && observer.onCompleted) {
      observer.onCompleted();
    } else if (typeof observer == 'function') {
      observer();
    }
  }

  function pooled(decorated, priority) {
    // return function(...args) {
    //   const observer = args[args.length - 1]
    //   const hasObserver = observer && observer.onCompleted !== undefined
    //   const hasCallback = observer && typeof observer == 'function'

    //   const myObserver = Observer.create(function(client) {
    //     const myArgs = [client].concat(args.slice(0, (hasObserver || hasCallback) ? -1 : undefined))
    //     myArgs.push(function() {
    //       release(client)
    //       if (hasObserver) {
    //         observer.onNext(myArgs)
    //         observer.onCompleted()
    //       } else if (hasCallback) {
    //         return callback(...myArgs)
    //       }
    //     })

    //     decorated(...myArgs)
    //   })
    //   acquire(myObserver, priority)
    // }
  }

  function poolSize() {
    return totalConnections;
  }

  function getName() {
    return name;
  }

  function availableConnectionsCount() {
    return availableConnections.size();
  }

  function waitingClientsCount() {
    return waitingClients.size();
  }

  function maxPoolSize() {
    return options.max;
  }

  /**
   * Checks and removes the available (idle) clients that have timed out.
   */
  function removeIdle() {
    removeIdleScheduled = false;
    if (!options.refreshIdle) {
      return;
    }

    availableConnections.filter(function (connectionWithTimeout, idx) {
      if (totalConnections - options.min < idx) {
        return false;
      }
      return Date.now() > connectionWithTimeout.timeout;
    }).map(function (connectionWithTimeout) {
      return connectionWithTimeout.connection;
    }).forEach(function (connection) {
      return destroy(connection);
    });

    if (availableConnections.length > 0) {
      scheduleRemoveIdle();
    }
  }

  /**
   * Schedule removal of idle items in the pool.
   *
   * More schedules cannot run concurrently.
   */
  function scheduleRemoveIdle() {
    if (!removeIdleScheduled) {
      removeIdleScheduled = true;
      removeIdleTimer = setTimeout(removeIdle, options.reapInterval);
    }
  }

  /**
   * Try to get a new client to work, and clean up pool unused (idle) items.
   *
   *  - If there are available clients waiting, shift the first one out (LIFO),
   *    and call its callback.
   *  - If there are no waiting clients, try to create one if it won't exceed
   *    the maximum number of clients.
   *  - If creating a new client would exceed the maximum, add the client to
   *    the wait list.
   */
  function dispense() {
    if (waitingClients.size() > 0) {
      var validClient = _lodash2.default.find(availableConnections, function (connectionWithTimeout) {
        if (!options.validate(connectionWithTimeout.connection)) {
          destroy(connectionWithTimeout.connection);
          return false;
        }
        return true;
      });

      if (validClient) {
        availableConnections.shift();
        var observer = waitingClients.dequeue();

        if (observer.onNext) {
          observer.onNext(validClient);
          observer.onCompleted();
        } else if (typeof observer == 'function') {
          observer(null, validClient);
        }
      }

      if (totalConnections < options.max) {
        createResource();
      }
    }
  }

  function createResource() {
    totalConnections += 1;
    clientFactory.create(function () {
      var err = undefined,
          connection = undefined;
      if (arguments.length > 1) {
        err = arguments[0];
        connection = arguments[1];
      } else {
        err = arguments[0] instanceof Error ? arguments[0] : null;
        connection = arguments[0] instanceof Error ? null : arguments[0];
      }

      var observer = undefined;
      if (waitingClients.size() > 0) {
        observer = waitingClients.dequeue();
      }

      if (err) {
        totalConnections -= 1;
        if (totalConnections < 0) {
          totalConnections = 0;
        }

        process.nextTick(function () {
          return dispense();
        });
        if (observer && observer.onError) {
          return observer.onError(err);
        } else if (typeof observer == 'function') {
          return observer(err);
        }
      }

      if (observer && observer.onNext) {
        observer.onNext(connection);
        return observer.onCompleted();
      } else if (typeof observer == 'function') {
        return observer(null, connection);
      } else {
        release(connection);
      }
    });
  }

  function ensureMinimum() {
    if (!draining && totalConnections < options.min) {
      _lodash2.default.times(options.min - totalConnections, function () {
        return createResource();
      });
    }
  }

  return {
    acquire: acquire,
    destroy: destroy,
    release: release,
    returnToPool: returnToPool,
    drain: drain,
    destroyAllNow: destroyAllNow,
    pooled: pooled,
    poolSize: poolSize,
    getName: getName,
    availableConnectionsCount: availableConnectionsCount,
    waitingClientsCount: waitingClientsCount,
    maxPoolSize: maxPoolSize
  };
}

function priorityComparator(e1, e2) {
  if (!e1.priority && !e2.priority) {
    return 0;
  } else if (e1.priority && !e2.priority) {
    return -1;
  } else if (e2.priority && !e1.priority) {
    return 1;
  } else {
    return e2.priority - e1.priority;
  }
}

function wrapLogger(logger, poolName) {
  return function (msg, level) {
    if (typeof logger == 'function') {
      logger(msg);
    } else {
      console.log('[level.toUpperCase] pool ' + poolName + ' - ' + msg);
    }
  };
}

exports.default = Pool;