'use strict';

const fs = require('fs');
const path = require('path');
const { ERRNO, IPC, METHOD, SERVICE, negErrno } = require('./m1Constants');
const { createHeader, decodeFrame, encodeFrame } = require('./ipcCodec');

function _asObjectPayload(payload) {
  if (!payload || payload.length === 0) return {};
  const text = Buffer.from(payload).toString('utf-8');
  return JSON.parse(text);
}

function _responseFrame(requestHeader, status, body) {
  const payload = Buffer.from(JSON.stringify(body || {}), 'utf-8');
  return encodeFrame({
    header: createHeader({
      msgType: status >= 0 ? IPC.MSG_TYPE.RESPONSE : IPC.MSG_TYPE.ERROR,
      requestId: requestHeader.requestId,
      serviceId: requestHeader.serviceId,
      methodId: requestHeader.methodId,
      status,
    }),
    payload,
  });
}

function _safeResolveUnderRoot(rootDir, relPath) {
  const resolved = path.resolve(rootDir, relPath || '.');
  const base = path.resolve(rootDir);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('path escapes fsRoot');
  }
  return resolved;
}

function _temperatureFromCity(city) {
  const s = String(city || 'unknown');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  const normalized = Math.abs(hash % 1700) / 100; // 0.00~17.00
  return Number((15 + normalized).toFixed(1)); // 15.0~32.0
}

function createBuiltinRouter(options = {}) {
  const fsRoot = options.fsRoot ? path.resolve(options.fsRoot) : null;
  const custom = options.handlers || {};
  const withNow = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  function customHandler(serviceId, methodId) {
    const exact = custom[`${serviceId}:${methodId}`];
    if (exact) return exact;
    return null;
  }

  function route({ serviceId, methodId, payload, meta }) {
    const handler = customHandler(serviceId, methodId);
    if (handler) {
      return handler(payload, meta);
    }

    if (serviceId === SERVICE.NET && methodId === METHOD.NET.HTTP_GET) {
      const city = String(payload.city || payload.q || 'unknown');
      return {
        status: 0,
        body: {
          provider: 'loopback-netd',
          city,
          temperatureC: _temperatureFromCity(city),
          condition: 'partly-cloudy',
          at: withNow(),
        },
      };
    }

    if (serviceId === SERVICE.NET && methodId === METHOD.NET.DNS_RESOLVE) {
      const host = String(payload.host || payload.domain || 'localhost');
      return {
        status: 0,
        body: {
          provider: 'loopback-netd',
          host,
          addresses: ['127.0.0.1'],
          ttl: 60,
        },
      };
    }

    if (serviceId === SERVICE.FS && methodId === METHOD.FS.READ_FILE) {
      if (!fsRoot) {
        return { status: negErrno(ERRNO.EPERM), body: { error: 'fsRoot is not configured' } };
      }
      const reqPath = String(payload.path || '');
      if (!reqPath) {
        return { status: negErrno(ERRNO.EINVAL), body: { error: 'path is required' } };
      }
      try {
        const abs = _safeResolveUnderRoot(fsRoot, reqPath);
        const content = fs.readFileSync(abs, 'utf-8');
        return { status: 0, body: { path: reqPath, content } };
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { status: negErrno(ERRNO.ENOENT), body: { error: 'not found', path: reqPath } };
        }
        return { status: negErrno(ERRNO.EIO), body: { error: err.message } };
      }
    }

    if (serviceId === SERVICE.FS && methodId === METHOD.FS.STAT) {
      if (!fsRoot) {
        return { status: negErrno(ERRNO.EPERM), body: { error: 'fsRoot is not configured' } };
      }
      const reqPath = String(payload.path || '');
      if (!reqPath) {
        return { status: negErrno(ERRNO.EINVAL), body: { error: 'path is required' } };
      }
      try {
        const abs = _safeResolveUnderRoot(fsRoot, reqPath);
        const st = fs.statSync(abs);
        return {
          status: 0,
          body: {
            path: reqPath,
            exists: true,
            isFile: st.isFile(),
            isDirectory: st.isDirectory(),
            size: st.size,
            mtimeMs: st.mtimeMs,
          },
        };
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { status: 0, body: { path: reqPath, exists: false } };
        }
        return { status: negErrno(ERRNO.EIO), body: { error: err.message } };
      }
    }

    if (serviceId === SERVICE.WM && methodId === METHOD.WM.PRESENT_TEXT) {
      return {
        status: 0,
        body: {
          provider: 'loopback-wmd',
          displayed: String(payload.text || ''),
        },
      };
    }

    if (serviceId === SERVICE.WM && methodId === METHOD.WM.BLIT_RGBA) {
      return {
        status: 0,
        body: {
          provider: 'loopback-wmd',
          blitted: true,
          width: Number(payload.width || 0),
          height: Number(payload.height || 0),
        },
      };
    }

    return {
      status: negErrno(ERRNO.ENOSYS),
      body: {
        error: 'service/method not implemented',
        serviceId,
        methodId,
      },
    };
  }

  return { route };
}

function createLoopbackTransport(options = {}) {
  const router = options.router || createBuiltinRouter(options);

  async function call(frame, meta = {}) {
    const { header, payload } = decodeFrame(frame);
    if (header.msgType !== IPC.MSG_TYPE.REQUEST) {
      throw new Error(`loopback transport expects REQUEST frame, got msgType=${header.msgType}`);
    }

    let payloadObj = {};
    try {
      payloadObj = _asObjectPayload(payload);
    } catch (err) {
      return _responseFrame(header, negErrno(ERRNO.EINVAL), {
        error: 'invalid JSON payload',
        detail: err.message,
      });
    }

    let result;
    try {
      result = await router.route({
        serviceId: header.serviceId,
        methodId: header.methodId,
        payload: payloadObj,
        meta,
      });
    } catch (err) {
      return _responseFrame(header, negErrno(ERRNO.EIO), {
        error: 'loopback handler failed',
        detail: err.message,
      });
    }

    const status = Number.isInteger(result?.status) ? result.status : 0;
    return _responseFrame(header, status, result?.body || {});
  }

  function callSync(frame, meta = {}) {
    const { header, payload } = decodeFrame(frame);
    if (header.msgType !== IPC.MSG_TYPE.REQUEST) {
      throw new Error(`loopback transport expects REQUEST frame, got msgType=${header.msgType}`);
    }

    let payloadObj = {};
    try {
      payloadObj = _asObjectPayload(payload);
    } catch (err) {
      return _responseFrame(header, negErrno(ERRNO.EINVAL), {
        error: 'invalid JSON payload',
        detail: err.message,
      });
    }

    const result = router.route({
      serviceId: header.serviceId,
      methodId: header.methodId,
      payload: payloadObj,
      meta,
    });

    if (result && typeof result.then === 'function') {
      throw new Error('loopback callSync requires sync route handlers');
    }

    const status = Number.isInteger(result?.status) ? result.status : 0;
    return _responseFrame(header, status, result?.body || {});
  }

  return {
    call,
    callSync,
    router,
  };
}

module.exports = {
  createBuiltinRouter,
  createLoopbackTransport,
};
