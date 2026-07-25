/* khy-protocol.js — control/decision/event payload (de)serializers, host side.
 *
 * The single host-side source of truth for how each plane's payload maps to and
 * from JSON. It mirrors, byte-for-byte, the wire layouts the kernel implements:
 *   - control plane verbs + responses ......... agentctl.c
 *   - event plane records ..................... agentevent.c
 *   - status / verb / event code numbers ...... agentctl.h / agentevent.h
 * khy-bridge.js calls these to turn a JSON request into REQUEST payload bytes
 * and a RESPONSE / EVENT payload back into a plain object. Keeping the
 * translation here (not scattered in the bridge) means one place to audit
 * against the kernel.
 */
'use strict';

// Control-plane verbs (frame `code`).
const VERB = Object.freeze({
  STAT: 0x0001, LIST: 0x0002, READ: 0x0003,
  WRITE: 0x0004, MKDIR: 0x0005, REMOVE: 0x0006, PS: 0x0007,
});

// Response status (first payload byte).
const STATUS = Object.freeze({
  OK: 0x00, ENOENT: 0x01, EINVAL: 0x02, EEXIST: 0x03, EPERM: 0x04,
});
const STATUS_NAME = Object.freeze(
  Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k])));

// vfs node types.
const NODE = Object.freeze({ FILE: 1, DIR: 2 });
const NODE_NAME = Object.freeze({ 1: 'file', 2: 'dir' });

// Write modes.
const WRITE = Object.freeze({ OVERWRITE: 0, APPEND: 1 });

// Event codes (frame `code` on EVENT frames; parity with agentevent.h).
const EVENT = Object.freeze({ SPAWN: 0x0001, EXIT: 0x0002, FAULT: 0x0003 });
const EVENT_NAME = Object.freeze({ 1: 'spawn', 2: 'exit', 3: 'fault' });

// Per-page entry caps the kernel honors (a short page signals the last page).
const PAGE_FULL = 16;

const enc = (s) => Buffer.from(s, 'utf8');

// ── Request builders (JSON args -> REQUEST payload bytes) ────────────────────

function statReq(path) {
  return enc(path);
}

function listReq(start, path) {
  const p = enc(path);
  const b = Buffer.alloc(4 + p.length);
  b.writeUInt32LE(start >>> 0, 0);
  p.copy(b, 4);
  return b;
}

function readReq(offset, len, path) {
  const p = enc(path);
  const b = Buffer.alloc(12 + p.length);
  b.writeBigUInt64LE(BigInt(offset), 0);
  b.writeUInt32LE(len >>> 0, 8);
  p.copy(b, 12);
  return b;
}

function writeReq(mode, path, data) {
  const p = enc(path);
  const d = Buffer.isBuffer(data) ? data : enc(String(data));
  const b = Buffer.alloc(3 + p.length + d.length);
  b.writeUInt8(mode & 0xff, 0);
  b.writeUInt16LE(p.length, 1);
  p.copy(b, 3);
  d.copy(b, 3 + p.length);
  return b;
}

function pathReq(path) {        // MKDIR / REMOVE
  return enc(path);
}

function psReq(start) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(start >>> 0, 0);
  return b;
}

// ── Response parsers (RESPONSE payload bytes -> JSON) ────────────────────────

/* Split a RESPONSE payload into its status byte and the remaining body. */
function splitStatus(payload) {
  if (payload.length < 1) throw new Error('empty response payload');
  return { status: payload[0], statusName: STATUS_NAME[payload[0]] || `0x${payload[0].toString(16)}`,
           body: payload.subarray(1) };
}

function parseStat(body) {
  return {
    type: NODE_NAME[body.readUInt8(0)] || body.readUInt8(0),
    mode: body.readUInt16LE(1),
    uid: body.readUInt32LE(3),
    gid: body.readUInt32LE(7),
    size: Number(body.readBigUInt64LE(11)),
    mtime: Number(body.readBigUInt64LE(19)),
    atime: Number(body.readBigUInt64LE(27)),
    ctime: Number(body.readBigUInt64LE(35)),
  };
}

function parseListPage(body) {
  const count = body.readUInt16LE(0);
  const entries = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    const type = body.readUInt8(off); off += 1;
    const size = Number(body.readBigUInt64LE(off)); off += 8;
    const namelen = body.readUInt8(off); off += 1;
    const name = body.subarray(off, off + namelen).toString('utf8'); off += namelen;
    entries.push({ name, type: NODE_NAME[type] || type, size });
  }
  return entries;
}

function parseReadPage(body) {
  const nread = body.readUInt32LE(0);
  return { nread, bytes: body.subarray(4, 4 + nread) };
}

function parseWritten(body) {
  return body.readUInt32LE(0);
}

function parsePsPage(body) {
  const count = body.readUInt16LE(0);
  const procs = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    const pid = body.readUInt32LE(off); off += 4;
    const tid = body.readUInt32LE(off); off += 4;
    const state = body.readUInt8(off); off += 1;
    const isUser = body.readUInt8(off); off += 1;
    const namelen = body.readUInt8(off); off += 1;
    const name = body.subarray(off, off + namelen).toString('utf8'); off += namelen;
    procs.push({ pid, tid, state, isUser: !!isUser, name });
  }
  return procs;
}

/* EVENT payload: [pid:4][aux:4][info:4][namelen:1][name]. Field meaning depends
 * on the event code (see agentevent.h); we surface both the raw triple and a
 * friendly per-kind view. */
function parseEvent(code, payload) {
  const pid = payload.readUInt32LE(0);
  const aux = payload.readUInt32LE(4);
  const info = payload.readInt32LE(8);
  const namelen = payload.readUInt8(12);
  const name = payload.subarray(13, 13 + namelen).toString('utf8');
  const kind = EVENT_NAME[code] || `0x${code.toString(16)}`;
  const base = { kind, pid, name, aux, info };
  if (code === EVENT.SPAWN) return { ...base, parent: aux, tid: info };
  if (code === EVENT.EXIT) return { ...base, tid: aux, code: info };
  if (code === EVENT.FAULT) return { ...base, vector: info };
  return base;
}

module.exports = {
  VERB, STATUS, STATUS_NAME, NODE, NODE_NAME, WRITE, EVENT, EVENT_NAME, PAGE_FULL,
  statReq, listReq, readReq, writeReq, pathReq, psReq,
  splitStatus, parseStat, parseListPage, parseReadPage, parseWritten, parsePsPage,
  parseEvent,
};
