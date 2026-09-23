'use strict';

/**
 * credential-lease wire protocol (pure layer, zero IO).
 *
 * Frame = u32BE payload length + UTF-8 JSON, hard-capped at 64 KiB so a
 * malformed length prefix can never turn into an unbounded allocation.
 * Borrowed as `reference` from MiniMax-AI/minimax-code oauth-lease-protocol
 * (proposal 2026-09-18-tier1-minimax-code); shapes rewritten to repo style.
 */

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = 'khy-credential-lease-v1';
const MAX_FRAME_BYTES = 64 * 1024;
const CAPABILITY_BYTES = 32;

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    const err = new Error(`lease frame exceeds ${MAX_FRAME_BYTES} bytes`);
    err.code = 'frame-too-large';
    throw err;
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Incremental frame reader: feed raw chunks via push(buf); complete JSON
 * payloads arrive as 'frame' events, protocol violations as 'error' events.
 */
function createFrameDecoder() {
  const emitter = new EventEmitter();
  let chunks = [];
  let buffered = 0;

  function fail(code, message) {
    chunks = [];
    buffered = 0;
    emitter.emit('error', Object.assign(new Error(message), { code }));
  }

  function drain() {
    while (buffered >= 4) {
      const header = Buffer.concat(chunks, buffered).subarray(0, 4);
      const size = header.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES) return fail('frame-too-large', 'declared frame size over limit');
      if (buffered < 4 + size) return;
      const all = Buffer.concat(chunks, buffered);
      let parsed;
      try {
        parsed = JSON.parse(all.subarray(4, 4 + size).toString('utf8'));
      } catch {
        return fail('bad-json', 'frame is not valid JSON');
      }
      chunks = [all.subarray(4 + size)];
      buffered = all.length - (4 + size);
      emitter.emit('frame', parsed);
    }
  }

  return {
    on: (evt, fn) => emitter.on(evt, fn),
    push(chunk) {
      chunks.push(chunk);
      buffered += chunk.length;
      if (buffered > MAX_FRAME_BYTES + 4) return fail('frame-too-large', 'buffered bytes over limit');
      drain();
    },
  };
}

function newCapability() {
  return crypto.randomBytes(CAPABILITY_BYTES).toString('base64url');
}

// Constant-time compare; unequal lengths or non-strings simply fail.
function verifyCapability(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function endpointPathFor(dataDir, { namespace = '' } = {}) {
  const suffix = crypto.createHash('sha256').update(String(dataDir)).digest('hex').slice(0, 16);
  const stem = `${PROTOCOL_VERSION}${namespace ? `-${namespace}` : ''}-${suffix}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${stem}`;
  return path.join(String(dataDir), 'run', `${stem}.sock`);
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  encodeFrame,
  createFrameDecoder,
  newCapability,
  verifyCapability,
  endpointPathFor,
};
