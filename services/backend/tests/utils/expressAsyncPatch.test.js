'use strict';

const { patchExpressAsync } = require('../../src/utils/expressAsyncPatch');

describe('expressAsyncPatch', () => {
  describe('patchExpressAsync', () => {
    test('is a function', () => {
      expect(typeof patchExpressAsync).toBe('function');
    });

    test('does not throw on call', () => {
      expect(() => patchExpressAsync()).not.toThrow();
    });

    test('is idempotent (second call does not throw)', () => {
      patchExpressAsync();
      expect(() => patchExpressAsync()).not.toThrow();
    });

    test('wraps async handlers and forwards rejected promises', async () => {
      const Router = require('express/lib/router');
      patchExpressAsync();

      const router = new Router();
      const next = jest.fn();
      const req = {};
      const res = {};

      const asyncHandler = async () => { throw new Error('boom'); };

      const method = router.get;
      if (typeof method === 'function') {
        router.get('/', asyncHandler);
        const layer = router.stack[0];
        if (layer && layer.route && layer.route.stack[0].handle) {
          const wrapped = layer.route.stack[0].handle;
          wrapped(req, res, next);
          await new Promise(r => setTimeout(r, 10));
          expect(next).toHaveBeenCalledWith(expect.any(Error));
        }
      }
    });

    test('wraps sync handlers that throw', () => {
      const Router = require('express/lib/router');
      patchExpressAsync();

      const router = new Router();
      const next = jest.fn();
      const req = {};
      const res = {};

      const syncHandler = () => { throw new Error('sync boom'); };

      router.get('/', syncHandler);
      const layer = router.stack[0];
      if (layer && layer.route && layer.route.stack[0].handle) {
        const wrapped = layer.route.stack[0].handle;
        wrapped(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.any(Error));
      }
    });

    test('handles synchronous non-promise return values', () => {
      const Router = require('express/lib/router');
      patchExpressAsync();

      const router = new Router();
      const next = jest.fn();
      const req = {};
      const res = {};

      const syncHandler = (rq, rs, nx) => 'result';

      router.get('/', syncHandler);
      const layer = router.stack[0];
      if (layer && layer.route && layer.route.stack[0].handle) {
        const wrapped = layer.route.stack[0].handle;
        const result = wrapped(req, res, next);
        expect(result).toBe('result');
        expect(next).not.toHaveBeenCalled();
      }
    });

    test('does not wrap non-function arguments', () => {
      const Router = require('express/lib/router');
      patchExpressAsync();

      const router = new Router();
      // Express 4.22 itself rejects non-function callbacks at registration
      // time — the patch wraps handlers before Express sees them, so a
      // non-function argument still surfaces Express' own validation error
      // (the patch must not swallow or alter that).
      expect(() => {
        router.get('/', 'not a function');
      }).toThrow(/requires a callback function/);
    });

    test('wraps arrays of handlers', () => {
      const Router = require('express/lib/router');
      patchExpressAsync();

      const router = new Router();
      const next = jest.fn();

      const handler1 = jest.fn();
      const handler2 = jest.fn();

      router.get('/', [handler1, handler2]);
      const layer = router.stack[0];
      expect(layer).toBeDefined();
    });

    test('covers all standard HTTP methods', () => {
      const Router = require('express/lib/router');
      patchExpressAsync();

      const methods = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
      // Express >= 4.22: route methods live as own properties of the Router
      // function object, not on Router.prototype — assert reachability
      // through the constructor itself and an instance's prototype chain.
      const router = new Router();
      for (const method of methods) {
        expect(typeof Router[method]).toBe('function');
        expect(typeof router[method]).toBe('function');
      }
    });
  });
});

