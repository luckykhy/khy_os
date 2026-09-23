'use strict';

/**
 * credential-lease client (child / delegated side).
 *
 * Reads the host-published coordinates (endpoint + capability, both 0600 under
 * <dataDir>/run), sends one framed request over local IPC, resolves exactly one
 * response frame. One request per connection keeps the broker stateless.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const {
  PROTOCOL_VERSION,
  encodeFrame,
  createFrameDecoder,
} = require('./leaseProtocol');

// Connect/handshake guard only — idle I/O watchdog, not a task deadline
// (RUNTIME-003 legal exception: short connect timeout without kill semantics).
const CONNECT_TIMEOUT_MS = 10_000;

function _coordFilePrefix(namespace) {
  return `${PROTOCOL_VERSION}${namespace ? `-${namespace}` : ''}`;
}

function readLeaseCoord({ dataDir, namespace = '' } = {}) {
  if (!dataDir) throw new Error('readLeaseCoord: dataDir is required');
  const prefix = _coordFilePrefix(namespace);
  const capabilityPath = path.join(dataDir, 'run', `${prefix}.cap`);
  const endpointPath = path.join(dataDir, 'run', `${prefix}.endpoint`);
  if (!fs.existsSync(capabilityPath) || !fs.existsSync(endpointPath)) {
    throw Object.assign(
      new Error(`credential-lease 坐标缺失 (${capabilityPath})：宿主未启动 broker 或已退出`),
      { code: 'no-lease-coord' },
    );
  }
  return {
    endpoint: fs.readFileSync(endpointPath, 'utf8').trim(),
    capability: fs.readFileSync(capabilityPath, 'utf8').trim(),
    capabilityPath,
  };
}

function _roundTrip(endpoint, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: endpoint });
    const decoder = createFrameDecoder();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(arg);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      finish(reject, Object.assign(new Error(`credential-lease 连接超时 (${endpoint})：broker 可能已退出，请重试或走宿主正门`), { code: 'lease-connect-timeout' }));
    });
    socket.on('error', (error) => finish(reject, Object.assign(error, { code: error.code || 'lease-transport' })));
    socket.on('connect', () => socket.write(encodeFrame(frame)));
    socket.on('data', (chunk) => decoder.push(chunk));
    decoder.on('error', (error) => finish(reject, error));
    decoder.on('frame', (response) => finish(resolve, response));
    socket.on('close', () => {
      if (!settled) finish(reject, Object.assign(new Error('credential-lease 连接在完成前关闭'), { code: 'lease-transport' }));
    });
  });
}

function _request({ dataDir, namespace = '', endpoint, capability, op, minValidityMs }) {
  const coords = endpoint && capability ? { endpoint, capability } : readLeaseCoord({ dataDir, namespace });
  return _roundTrip(coords.endpoint, {
    capability: coords.capability,
    op,
    ...(op === 'lease' ? { minValidityMs } : {}),
  }).then((response) => {
    if (!response || response.ok !== true) {
      throw Object.assign(
        new Error(`credential-lease ${op} 失败：${response && response.code ? response.code : '无响应'}`),
        { code: response ? response.code : 'lease-unavailable' },
      );
    }
    return response;
  });
}

function requestLease(options = {}) {
  return _request({ ...options, op: 'lease', minValidityMs: options.minValidityMs || 0 });
}

requestLease.status = (options = {}) => _request({ ...options, op: 'status' });

module.exports = { requestLease, readLeaseCoord, CONNECT_TIMEOUT_MS };
