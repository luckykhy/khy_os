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
    const original = Router.prototype[method];
    if (typeof original !== 'function') {
      continue;
    }

    Router.prototype[method] = function patchedRouterMethod(...args) {
      return original.apply(this, wrapArgs(args));
    };
  }

  patched = true;
}

module.exports = { patchExpressAsync };
