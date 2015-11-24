# About

  Generic connection pool which utilizes [Observerables](http://reactivex.io/documentation/observable.html).
  Can be used to reuse or throttle expensive resources such as database connections.

## Example

### Step 1 - Create pool using a factory object

```js
// Create a MySQL connection pool with
// a max of 10 connections, a min of 2, and a 30 second max idle time
import Pool from 'observable-connection-pool'
import mysql from 'mysql'
var pool = Pool({
    name     : 'mysql',
    create   : function(callback) {
      var connection = mysql.createConnection({
        user: 'root',
        password: 'password',
        database: 'testdb'
      })
      connection.connect(function(err) {
        callback(err, connection);
      })
    },
    destroy  : function(connection) { connection.end(); },
  }, {
    max: 10,
    min: 2,
    idleTimeoutMillis: 30000,
    log: true
  });
```

### Step 2 - Use pool in your code to acquire/release resources

```js
// acquire connection - Obsserver.onNext() is called once a connection becomes
// available
pool.acquire(Observer.create(
  function(connection) {
    console.log('Acquired connection', connection)
    pool.release(connection)
  },
  function(err) {
    console.log('Observable onError', err)
  },
  function() {
    console.log('Observable onCompleted')
  }
);
```

### Step 3 - Drain pool during shutdown (optional)

If you are shutting down a long-lived process, you may notice
that node fails to exit for 30 seconds or so.  This is a side
effect of the idleTimeoutMillis behavior -- the pool has a
setTimeout() call registered that is in the event loop queue, so
node won't terminate until all resources have timed out, and the pool
stops trying to manage them.

This behavior will be more problematic when you set factory.min > 0,
as the pool will never become empty, and the setTimeout calls will
never end.

In these cases, use the pool.drain() function.  This sets the pool
into a "draining" state which will gracefully wait until all
idle resources have timed out.  For example, you can call:

```js
// Only call this once in your application -- at the point you want
// to shutdown and stop using this pool.
pool.drain(Observer.create(function() {
  pool.destroyAllNow();
}));
```

If you do this, your node process will exit gracefully.


## Documentation

         Pool(clientFactory, options) accepts:

         clientFactory.name : name of pool (string, optional)
       clientFactory.create : function that returns a new resource
                                should call callback() with the created resource
      clientFactory.destroy : function that accepts a resource and destroys it
                options.max : maximum number of resources to create at any given time
                              optional (default=1)
                options.min : minimum number of resources to keep in pool at any given time
                              if this is set > max, the pool will silently set the min
                              to factory.max - 1
                              optional (default=0)
      options.priorityRange : Maximum priority when acquring a connection. (default=10)
        options.refreshIdle : boolean that specifies whether idle resources at or below the min threshold
                              should be destroyed/re-created.  optional (default=true)
  options.idleTimeoutMillis : max milliseconds a resource can go unused before it should be destroyed
                         (default 30000)
 options.reapIntervalMillis : frequency to check for idle resources (default 1000),
       options.returnToHead : boolean, if true the most recently released resources will be the first to be allocated.
                         This in effect turns the pool's behaviour from a queue into a stack. optional (default false)
      options.priorityRange : int between 1 and x - if set, borrowers can specify their
                         relative priority in the queue if no resources are available.
                         see example.  (default 1)
           options.validate : function that accepts a pooled resource and returns true if the resource
                         is OK to use, or false if the object is invalid.  Invalid objects will be destroyed.
                         This function is called in acquire() before returning a resource from the pool.
                         Optional.  Default function always returns true.
                options.log : true/false or function -
                           If a log is a function, it will be called with two parameters:
                                                    - log string
                                                    - log level ('verbose', 'info', 'warn', 'error')
                           Else if log is true, verbose log info will be sent to console.log()
                           Else internal log messages be ignored (this is the default)

## Priority Queueing

The pool now supports optional priority queueing.  This becomes relevant when no resources
are available and the caller has to wait. `acquire()` accepts an optional priority int which
specifies the caller's relative position in the queue.

```js
// create pool with priorityRange of 3
// acquirers can specify a priority 0 to 2
var pool = Pool({
  name     : 'mysql',
  create   : function(callback) {
    var connection = mysql.createConnection({
      user: 'root',
      password: 'password',
      database: 'testdb'
    })
    connection.connect(function(err) {
      callback(err, connection);
    })
  },
  destroy  : function(connection) { connection.end(); },
}, {
  priorityRange: 3,
  max: 10,
  min: 2,
  idleTimeoutMillis: 30000,
  log: true
});

// acquire connection - no priority - will go at front of line (same as high priority)
pool.acquire(function(observer);

// acquire connection - high priority - will go into front slot
pool.acquire(observer, 0);

// acquire connection - medium priority - will go into middle slot
pool.acquire(observer, 1);

// etc..
```

## Draining

If you know would like to terminate all the resources in your pool before
their timeouts have been reached, you can use `destroyAllNow()` in conjunction
with `drain()`:

```js
pool.drain(Observer.create(function() {
  pool.destroyAllNow();
}));
```

One side-effect of calling `drain()` is that subsequent calls to `acquire()`
will throw an Error.

## Pool info

The following functions will let you get information about the pool:

```js
// returns factory.name for this pool
pool.getName()

// returns number of resources in the pool regardless of
// whether they are free or in use
pool.poolSize()

// returns number of unused resources in the pool
pool.availableConnectionsCount()

// returns number of callers waiting to acquire a resource
pool.waitingClientsCount()

// returns number of maxixmum number of resources allowed by ppol
pool.maxPoolSize()
```
