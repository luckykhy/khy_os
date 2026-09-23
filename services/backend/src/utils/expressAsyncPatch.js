/**
 * Patch Express router methods so async handlers automatically forward errors.
 * This guarantees rejected promises are routed to the global JSON error handler.
 */
const Router = require('express/lib/router');

let patched = false;

function wrapHandler(handler) {
  if (typeof handler !== 'function') {
    return handler;
  }

  return function wrappedHandler(req, res, next) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch(next);
      }
      return result;
    } catch (error) {
      return next(error);
    }
  };
}

function wrapArgs(args) {
  return args.map((arg) => {
    if (Array.isArray(arg)) {
      return wrapArgs(arg);
    }
    return wrapHandler(arg);
  });
}

function patchExpressAsync() {
  if (patched) {
    return;
  }

  const methods = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
  for (const method of methods) {
    // Express >= 4.22 defines route methods as own properties of the Router
    // function object (instances inherit via [[Prototype]] === Router), not
    // on Router.prototype — reading the prototype there yields undefined and
    // the patch silently no-ops. Read from whichever object actually owns the
    // method so both layouts are covered.
    const owner = typeof Router[method] === 'function' ? Router : Router.prototype;
    const original = owner[method];
    if (typeof original !== 'function') {
      continue;
    }

    owner[method] = function patchedRouterMethod(...args) {
      return original.apply(this, wrapArgs(args));
    };
  }

  patched = true;
}

module.exports = { patchExpressAsync };
