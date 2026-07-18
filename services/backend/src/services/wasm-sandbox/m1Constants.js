'use strict';

/**
 * M1 microkernel/IPC constants shared by host runtime and adapters.
 * Keep these IDs stable once published.
 */

function toBigInt(value, label = 'value') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`${label} must be a safe integer or bigint`);
}

const SYSCALL = Object.freeze({
  PROC_SPAWN: 0x01,
  PROC_EXIT: 0x02,
  CAP_GRANT: 0x03,
  CAP_REVOKE: 0x04,
  IPC_CALL: 0x10,
  IPC_REPLY: 0x11,
  IPC_SEND: 0x12,
  IPC_RECV: 0x13,
  SHM_CREATE: 0x20,
  SHM_MAP: 0x21,
  IRQ_BIND: 0x30,
  IRQ_ACK: 0x31,
});

const CAP = Object.freeze({
  IPC: 1n << 0n,
  NET: 1n << 1n,
  FS_READ: 1n << 2n,
  FS_WRITE: 1n << 3n,
  WINDOW: 1n << 4n,
  SHM: 1n << 5n,
  IRQ_BIND: 1n << 6n,
});

const SERVICE = Object.freeze({
  FS: 1,
  NET: 2,
  WM: 3,
});

const METHOD = Object.freeze({
  FS: Object.freeze({
    READ_FILE: 1,
    STAT: 2,
  }),
  NET: Object.freeze({
    HTTP_GET: 1,
    DNS_RESOLVE: 2,
  }),
  WM: Object.freeze({
    PRESENT_TEXT: 1,
    BLIT_RGBA: 2,
  }),
});

const IPC = Object.freeze({
  MAGIC: 0x4b485950, // "KHYP"
  VERSION: 1,
  HEADER_SIZE: 36,
  MAX_PAYLOAD_BYTES: 64 * 1024,
  DEFAULT_TIMEOUT_MS: 3000,
  MSG_TYPE: Object.freeze({
    REQUEST: 1,
    RESPONSE: 2,
    EVENT: 3,
    ERROR: 4,
  }),
});

const ERRNO = Object.freeze({
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  ENOMEM: 12,
  EACCES: 13,
  EINVAL: 22,
  ENOSYS: 38,
  ETIMEDOUT: 60,
  EPROTO: 71,
  EMSGSIZE: 90,
});

function negErrno(errnoCode) {
  if (!Number.isInteger(errnoCode) || errnoCode <= 0) {
    throw new TypeError(`errnoCode must be positive integer, got ${errnoCode}`);
  }
  return -errnoCode;
}

function capMask(...caps) {
  let mask = 0n;
  for (const cap of caps) {
    mask |= toBigInt(cap, 'cap');
  }
  return mask;
}

function hasCapability(mask, capBit) {
  const m = toBigInt(mask, 'mask');
  const c = toBigInt(capBit, 'capBit');
  return (m & c) === c;
}

module.exports = {
  toBigInt,
  SYSCALL,
  CAP,
  SERVICE,
  METHOD,
  IPC,
  ERRNO,
  negErrno,
  capMask,
  hasCapability,
};
