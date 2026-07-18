'use strict';

const { ERRNO, negErrno } = require('./m1Constants');

function _toU32(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} out of u32 range: ${value}`);
  }
  return value >>> 0;
}

function _isU32LikeNumber(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff;
}

function _errnoFromError(err, fallback = negErrno(ERRNO.EIO)) {
  if (err && Number.isInteger(err.errno) && err.errno < 0) return err.errno;
  if (err && typeof err.code === 'string') {
    if (err.code === 'EACCES' || err.code === 'EPERM') return negErrno(ERRNO.EACCES);
    if (err.code === 'EINVAL') return negErrno(ERRNO.EINVAL);
    if (err.code === 'EMSGSIZE') return negErrno(ERRNO.EMSGSIZE);
    if (err.code === 'EPROTO') return negErrno(ERRNO.EPROTO);
  }
  return fallback;
}

function createKhySysHost({ bridge, memoryExport = 'memory' } = {}) {
  if (!bridge || typeof bridge.callJsonSync !== 'function') {
    throw new TypeError('bridge.callJsonSync(...) is required');
  }

  const state = {
    instance: null,
    memoryExport,
    lastResponseLen: 0,
    lastStatus: 0,
    lastError: '',
    callCount: 0,
  };

  function _memory() {
    const mem = state.instance?.exports?.[state.memoryExport];
    if (!(mem instanceof WebAssembly.Memory)) {
      throw new Error(`WASM memory export "${state.memoryExport}" not found`);
    }
    return mem;
  }

  function _memoryView() {
    return new Uint8Array(_memory().buffer);
  }

  function _readBytes(ptr, len) {
    const p = _toU32(ptr, 'ptr');
    const l = _toU32(len, 'len');
    const view = _memoryView();
    if (p + l > view.byteLength) {
      throw Object.assign(new Error(`memory read out of bounds: ptr=${p}, len=${l}`), { code: 'EINVAL' });
    }
    return Buffer.from(view.subarray(p, p + l));
  }

  function _writeBytes(ptr, cap, payload) {
    const p = _toU32(ptr, 'ptr');
    const c = _toU32(cap, 'cap');
    if (!Buffer.isBuffer(payload)) {
      throw new TypeError('payload must be Buffer');
    }
    if (payload.length > c) {
      return negErrno(ERRNO.EMSGSIZE);
    }

    const view = _memoryView();
    if (p + c > view.byteLength) {
      throw Object.assign(new Error(`memory write out of bounds: ptr=${p}, cap=${c}`), { code: 'EINVAL' });
    }
    view.fill(0, p, p + c);
    view.set(payload, p);
    return 0;
  }

  function _jsonFromRequest(reqPtr, reqLen) {
    if (_toU32(reqLen, 'reqLen') === 0) return {};
    const bytes = _readBytes(reqPtr, reqLen);
    const text = bytes.toString('utf-8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch (err) {
      throw Object.assign(new Error(`request JSON parse failed: ${err.message}`), { code: 'EINVAL' });
    }
  }

  const imports = {
    cap_check(capBit) {
      try {
        if (typeof bridge.hasCapability !== 'function') return 0;
        return bridge.hasCapability(capBit) ? 1 : 0;
      } catch {
        return 0;
      }
    },

    ipc_call(serviceId, methodId, reqPtr, reqLen, respPtr, respCap, timeoutMs) {
      state.callCount += 1;
      state.lastError = '';
      state.lastResponseLen = 0;
      state.lastStatus = 0;

      try {
        if (!_isU32LikeNumber(reqPtr) || !_isU32LikeNumber(respPtr)) {
          throw Object.assign(
            new Error(
              'unsupported khy_sys IPC ABI: req_ptr/resp_ptr must be u32 pointers'
            ),
            { code: 'EPROTO' }
          );
        }
        const sid = _toU32(serviceId, 'serviceId');
        const mid = _toU32(methodId, 'methodId');
        const payload = _jsonFromRequest(reqPtr, reqLen);
        const timeout = _toU32(timeoutMs, 'timeoutMs');

        const result = bridge.callJsonSync(sid, mid, payload, { timeoutMs: timeout });
        const out = result?.rawPayload && result.rawPayload.length > 0
          ? Buffer.from(result.rawPayload)
          : Buffer.from(JSON.stringify(result?.data || {}), 'utf-8');

        state.lastResponseLen = out.length;
        const writeRc = _writeBytes(respPtr, respCap, out);
        if (writeRc < 0) {
          state.lastStatus = writeRc;
          return writeRc;
        }

        state.lastStatus = Number.isInteger(result?.status) ? result.status : 0;
        return state.lastStatus;
      } catch (err) {
        const rc = _errnoFromError(err);
        state.lastStatus = rc;
        state.lastError = String(err?.message || err);
        return rc;
      }
    },

    ipc_last_len() {
      return _toU32(state.lastResponseLen, 'lastResponseLen');
    },

    ipc_last_status() {
      return state.lastStatus | 0;
    },

    shm_create() {
      return negErrno(ERRNO.ENOSYS);
    },

    shm_map() {
      return negErrno(ERRNO.ENOSYS);
    },
  };

  return {
    imports,
    attachInstance(instance) {
      state.instance = instance;
    },
    state,
  };
}

module.exports = {
  createKhySysHost,
};
