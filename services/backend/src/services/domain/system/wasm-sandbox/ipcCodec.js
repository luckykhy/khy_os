'use strict';

const { IPC, toBigInt } = require('./m1Constants');

const MAX_REQUEST_ID = (1n << 63n) - 1n;
let _requestCounter = 1n;

function _ensureIntInRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
}

function normalizePayload(payload) {
  if (payload === null || payload === undefined) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }
  if (typeof payload === 'string') {
    return Buffer.from(payload, 'utf-8');
  }
  throw new TypeError('payload must be Buffer, Uint8Array, string, null, or undefined');
}

function nextRequestId() {
  const id = _requestCounter;
  _requestCounter += 1n;
  if (_requestCounter > MAX_REQUEST_ID) {
    _requestCounter = 1n;
  }
  return id;
}

function createHeader({
  msgType,
  requestId,
  serviceId,
  methodId,
  flags = 0,
  status = 0,
  payloadLen = 0,
}) {
  _ensureIntInRange(msgType, 1, 0xffff, 'msgType');
  _ensureIntInRange(serviceId, 0, 0xffff, 'serviceId');
  _ensureIntInRange(methodId, 0, 0xffff, 'methodId');
  _ensureIntInRange(flags, 0, 0xffffffff, 'flags');
  _ensureIntInRange(status, -0x80000000, 0x7fffffff, 'status');
  _ensureIntInRange(payloadLen, 0, 0xffffffff, 'payloadLen');

  if (payloadLen > IPC.MAX_PAYLOAD_BYTES) {
    throw new RangeError(`payload exceeds M1 max ${IPC.MAX_PAYLOAD_BYTES} bytes`);
  }

  const rid = requestId === undefined ? nextRequestId() : toBigInt(requestId, 'requestId');
  if (rid <= 0n || rid > MAX_REQUEST_ID) {
    throw new RangeError(`requestId out of range: ${rid.toString()}`);
  }

  return {
    magic: IPC.MAGIC,
    version: IPC.VERSION,
    msgType,
    requestId: rid,
    serviceId,
    methodId,
    flags,
    status,
    payloadLen,
  };
}

function encodeFrame({ header, payload }) {
  if (!header || typeof header !== 'object') {
    throw new TypeError('header is required');
  }

  const body = normalizePayload(payload);
  const hdr = createHeader({
    ...header,
    payloadLen: body.length,
  });

  const out = Buffer.alloc(IPC.HEADER_SIZE + body.length);
  out.writeUInt32LE(hdr.magic >>> 0, 0);
  out.writeUInt16LE(hdr.version, 4);
  out.writeUInt16LE(hdr.msgType, 6);
  out.writeBigUInt64LE(hdr.requestId, 8);
  out.writeUInt16LE(hdr.serviceId, 16);
  out.writeUInt16LE(hdr.methodId, 18);
  out.writeUInt32LE(hdr.flags >>> 0, 20);
  out.writeInt32LE(hdr.status | 0, 24);
  out.writeUInt32LE(hdr.payloadLen >>> 0, 28);
  // bytes [32, 35] reserved for forward compatibility
  out.fill(0, 32, IPC.HEADER_SIZE);
  body.copy(out, IPC.HEADER_SIZE);
  return out;
}

function decodeFrame(frame) {
  const buf = normalizePayload(frame);
  if (buf.length < IPC.HEADER_SIZE) {
    throw new Error(`frame too short: ${buf.length}`);
  }

  const magic = buf.readUInt32LE(0);
  if (magic !== IPC.MAGIC) {
    throw new Error(`invalid magic: 0x${magic.toString(16)}`);
  }

  const version = buf.readUInt16LE(4);
  if (version !== IPC.VERSION) {
    throw new Error(`unsupported IPC version: ${version}`);
  }

  const msgType = buf.readUInt16LE(6);
  const requestId = buf.readBigUInt64LE(8);
  const serviceId = buf.readUInt16LE(16);
  const methodId = buf.readUInt16LE(18);
  const flags = buf.readUInt32LE(20);
  const status = buf.readInt32LE(24);
  const payloadLen = buf.readUInt32LE(28);

  if (payloadLen > IPC.MAX_PAYLOAD_BYTES) {
    throw new Error(`payload_len too large: ${payloadLen}`);
  }

  const expectedLen = IPC.HEADER_SIZE + payloadLen;
  if (buf.length !== expectedLen) {
    throw new Error(`frame length mismatch: got ${buf.length}, expected ${expectedLen}`);
  }

  return {
    header: {
      magic,
      version,
      msgType,
      requestId,
      serviceId,
      methodId,
      flags,
      status,
      payloadLen,
    },
    payload: buf.subarray(IPC.HEADER_SIZE),
  };
}

module.exports = {
  normalizePayload,
  nextRequestId,
  createHeader,
  encodeFrame,
  decodeFrame,
};
