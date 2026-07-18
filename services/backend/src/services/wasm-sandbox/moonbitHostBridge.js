'use strict';

const { CAP, IPC, METHOD, SERVICE, hasCapability, toBigInt } = require('./m1Constants');
const { createHeader, decodeFrame, encodeFrame, nextRequestId } = require('./ipcCodec');

class CapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapabilityError';
    this.code = 'EACCES';
    this.errno = -13;
  }
}

class IpcTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IpcTransportError';
    this.code = 'EIO';
    this.errno = -5;
  }
}

class IpcProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IpcProtocolError';
    this.code = 'EPROTO';
    this.errno = -71;
  }
}

function requiredCapabilityForCall(serviceId, methodId) {
  if (serviceId === SERVICE.NET) {
    return CAP.NET;
  }

  if (serviceId === SERVICE.FS) {
    if (methodId === METHOD.FS.READ_FILE || methodId === METHOD.FS.STAT) {
      return CAP.FS_READ;
    }
    return CAP.FS_WRITE;
  }

  if (serviceId === SERVICE.WM) {
    return CAP.WINDOW;
  }

  return CAP.IPC;
}

function _mustHave(mask, capBit, label) {
  if (!hasCapability(mask, capBit)) {
    throw new CapabilityError(`Missing capability: ${label}`);
  }
}

function _asJsonBuffer(payload) {
  if (payload === undefined) {
    return Buffer.from('{}', 'utf-8');
  }
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (typeof payload === 'string') {
    return Buffer.from(payload, 'utf-8');
  }
  return Buffer.from(JSON.stringify(payload), 'utf-8');
}

function _decodeJsonResponse(decoded) {
  let data = {};
  if (decoded.payload.length > 0) {
    const text = decoded.payload.toString('utf-8');
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new IpcProtocolError(`Response JSON parse failed: ${err.message}`);
    }
  }
  return data;
}

function _validateDecodedResponse(decoded, requestId) {
  if (decoded.header.requestId !== requestId) {
    throw new IpcProtocolError(
      `Mismatched request_id: expected=${requestId.toString()} actual=${decoded.header.requestId.toString()}`
    );
  }

  if (
    decoded.header.msgType !== IPC.MSG_TYPE.RESPONSE &&
    decoded.header.msgType !== IPC.MSG_TYPE.ERROR
  ) {
    throw new IpcProtocolError(`Unexpected response msg_type: ${decoded.header.msgType}`);
  }
}

function createMoonbitHostBridge({
  transport,
  capabilityMask = 0n,
  defaultTimeoutMs = IPC.DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!transport || (typeof transport.call !== 'function' && typeof transport.callSync !== 'function')) {
    throw new TypeError('transport.call(frame, meta) or transport.callSync(frame, meta) is required');
  }

  let mask = toBigInt(capabilityMask, 'capabilityMask');

  return {
    getCapabilityMask() {
      return mask;
    },

    setCapabilityMask(nextMask) {
      mask = toBigInt(nextMask, 'capabilityMask');
    },

    hasCapability(capBit) {
      return hasCapability(mask, capBit);
    },

    async callJson(serviceId, methodId, payload, options = {}) {
      _mustHave(mask, CAP.IPC, 'CAP_IPC');
      _mustHave(mask, requiredCapabilityForCall(serviceId, methodId), `service:${serviceId}`);

      const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : defaultTimeoutMs;

      const requestId = nextRequestId();
      const body = _asJsonBuffer(payload);
      if (body.length > IPC.MAX_PAYLOAD_BYTES) {
        throw new RangeError(`JSON payload too large: ${body.length} bytes`);
      }

      const requestHeader = createHeader({
        msgType: IPC.MSG_TYPE.REQUEST,
        requestId,
        serviceId,
        methodId,
        status: 0,
      });

      const requestFrame = encodeFrame({
        header: requestHeader,
        payload: body,
      });

      let rawResponse;
      try {
        if (typeof transport.call === 'function') {
          rawResponse = await transport.call(requestFrame, {
            requestId,
            serviceId,
            methodId,
            timeoutMs,
          });
        } else if (typeof transport.callSync === 'function') {
          rawResponse = transport.callSync(requestFrame, {
            requestId,
            serviceId,
            methodId,
            timeoutMs,
          });
        } else {
          throw new Error('transport has neither call nor callSync');
        }
      } catch (err) {
        throw new IpcTransportError(`IPC transport failed: ${err.message}`);
      }

      let decoded;
      try {
        decoded = decodeFrame(rawResponse);
      } catch (err) {
        throw new IpcProtocolError(`Failed to decode IPC response: ${err.message}`);
      }

      _validateDecodedResponse(decoded, requestId);
      const data = _decodeJsonResponse(decoded);

      return {
        requestId,
        status: decoded.header.status,
        ok: decoded.header.status >= 0 && decoded.header.msgType === IPC.MSG_TYPE.RESPONSE,
        data,
        rawPayload: Buffer.from(decoded.payload),
      };
    },

    callJsonSync(serviceId, methodId, payload, options = {}) {
      _mustHave(mask, CAP.IPC, 'CAP_IPC');
      _mustHave(mask, requiredCapabilityForCall(serviceId, methodId), `service:${serviceId}`);

      if (!transport || typeof transport.callSync !== 'function') {
        throw new IpcTransportError('IPC sync transport is not available');
      }

      const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : defaultTimeoutMs;

      const requestId = nextRequestId();
      const body = _asJsonBuffer(payload);
      if (body.length > IPC.MAX_PAYLOAD_BYTES) {
        throw new RangeError(`JSON payload too large: ${body.length} bytes`);
      }

      const requestHeader = createHeader({
        msgType: IPC.MSG_TYPE.REQUEST,
        requestId,
        serviceId,
        methodId,
        status: 0,
      });

      const requestFrame = encodeFrame({
        header: requestHeader,
        payload: body,
      });

      let rawResponse;
      try {
        rawResponse = transport.callSync(requestFrame, {
          requestId,
          serviceId,
          methodId,
          timeoutMs,
        });
      } catch (err) {
        throw new IpcTransportError(`IPC sync transport failed: ${err.message}`);
      }

      let decoded;
      try {
        decoded = decodeFrame(rawResponse);
      } catch (err) {
        throw new IpcProtocolError(`Failed to decode IPC response: ${err.message}`);
      }

      _validateDecodedResponse(decoded, requestId);
      const data = _decodeJsonResponse(decoded);

      return {
        requestId,
        status: decoded.header.status,
        ok: decoded.header.status >= 0 && decoded.header.msgType === IPC.MSG_TYPE.RESPONSE,
        data,
        rawPayload: Buffer.from(decoded.payload),
      };
    },
  };
}

module.exports = {
  CapabilityError,
  IpcTransportError,
  IpcProtocolError,
  requiredCapabilityForCall,
  createMoonbitHostBridge,
};
