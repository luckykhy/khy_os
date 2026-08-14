/* khy-frame.js — Agent ⇄ OS wire frame codec (COBS + CRC16), host side.
 *
 * A faithful JavaScript port of the kernel's agentframe.c, so the host bridge
 * and the kernel agree byte-for-byte on the wire. Pure and I/O-free: it only
 * encodes/decodes frames in memory. khy-bridge.js owns the COM2 transport.
 *
 * Logical frame (little-endian), before COBS encoding:
 *     [type:1][seq:4][code:2][len:2][payload:len][crc16:2]
 * The whole frame is COBS-encoded and terminated with a single 0x00 byte; COBS
 * guarantees the body contains no 0x00, so the delimiter is unambiguous and the
 * stream self-synchronizes (a reader that joins mid-stream waits for the next
 * 0x00). CRC-16/CCITT-FALSE over [type..payload] catches link corruption.
 */
'use strict';

// Frame types (parity with agentframe.h).
const TYPE = Object.freeze({
  REQUEST: 0x01,        // agent -> OS: do something
  RESPONSE: 0x02,       // OS -> agent: result of a request
  EVENT: 0x03,          // OS -> agent: async notification (fire-and-forget)
  DECISION_REQ: 0x04,   // OS -> agent: please decide
  DECISION_RESP: 0x05,  // agent -> OS: the decision
});

const HEADER = 9;       // type(1)+seq(4)+code(2)+len(2)
const PAYLOAD_MAX = 1024;

/* CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
function crc16(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/* COBS encode: never emits a 0x00. Mirrors agentframe.c / the Python tests. */
function cobsEncode(data) {
  const out = [0];          // placeholder for the first code byte
  let codeIdx = 0;
  let code = 1;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0) {
      out[codeIdx] = code;
      code = 1;
      codeIdx = out.length;
      out.push(0);
    } else {
      out.push(byte);
      code += 1;
      if (code === 0xff) {
        out[codeIdx] = code;
        code = 1;
        codeIdx = out.length;
        out.push(0);
      }
    }
  }
  out[codeIdx] = code;
  return Buffer.from(out);
}

/* COBS decode: rejects a malformed (zero) code byte. */
function cobsDecode(data) {
  const out = [];
  let i = 0;
  const n = data.length;
  while (i < n) {
    const code = data[i];
    if (code === 0) throw new Error('zero code byte in COBS data');
    i += 1;
    for (let k = 0; k < code - 1; k++) {
      out.push(data[i]);
      i += 1;
    }
    if (code < 0xff && i < n) out.push(0);
  }
  return Buffer.from(out);
}

/* Serialize a logical frame to a wire buffer (COBS-encoded, 0x00-terminated). */
function encodeFrame({ type, seq, code, payload }) {
  const body = payload && payload.length ? payload : Buffer.alloc(0);
  if (body.length > PAYLOAD_MAX) {
    throw new Error(`payload too large: ${body.length} > ${PAYLOAD_MAX}`);
  }
  const raw = Buffer.alloc(HEADER + body.length + 2);
  raw.writeUInt8(type & 0xff, 0);
  raw.writeUInt32LE(seq >>> 0, 1);
  raw.writeUInt16LE(code & 0xffff, 5);
  raw.writeUInt16LE(body.length, 7);
  body.copy(raw, HEADER);
  raw.writeUInt16LE(crc16(raw.subarray(0, HEADER + body.length)), HEADER + body.length);
  return Buffer.concat([cobsEncode(raw), Buffer.from([0x00])]);
}

/* Parse one wire frame (bytes BEFORE the 0x00 delimiter). Throws on any
 * malformation so the caller can drop the frame. */
function decodeFrame(wire) {
  const raw = cobsDecode(wire);
  if (raw.length < HEADER + 2) throw new Error('frame too short');
  const type = raw.readUInt8(0);
  const seq = raw.readUInt32LE(1);
  const code = raw.readUInt16LE(5);
  const len = raw.readUInt16LE(7);
  if (HEADER + len + 2 > raw.length) throw new Error('length field exceeds frame');
  const payload = raw.subarray(HEADER, HEADER + len);
  const want = raw.readUInt16LE(HEADER + len);
  if (crc16(raw.subarray(0, HEADER + len)) !== want) throw new Error('CRC mismatch');
  return { type, seq, code, payload };
}

/* Streaming splitter: feed it arbitrary byte chunks; it calls onFrame(wire) for
 * each 0x00-delimited frame (delimiter stripped). Empty frames are skipped.
 * Oversized accumulation is dropped and resynchronized on the next delimiter,
 * mirroring the kernel's rx_overflow discipline — a corrupt stream cannot wedge
 * the reader. */
class FrameSplitter {
  constructor(onFrame, { maxLen = PAYLOAD_MAX * 2 + 64 } = {}) {
    this.onFrame = onFrame;
    this.maxLen = maxLen;
    this.buf = [];
    this.overflow = false;
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b === 0x00) {
        if (!this.overflow && this.buf.length > 0) {
          this.onFrame(Buffer.from(this.buf));
        }
        this.buf = [];
        this.overflow = false;
      } else if (this.buf.length < this.maxLen) {
        this.buf.push(b);
      } else {
        this.overflow = true; // drop until the next delimiter resynchronizes us
      }
    }
  }
}

module.exports = {
  TYPE, HEADER, PAYLOAD_MAX,
  crc16, cobsEncode, cobsDecode, encodeFrame, decodeFrame, FrameSplitter,
};
