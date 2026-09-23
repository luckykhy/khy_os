'use strict';

/**
 * credential-lease — 凭据短租约（宿主侧 broker + 子进程侧 client）。
 *
 * 能力域登记：docs/10_规范/registry/FEATURE-OWNERSHIP.json (credential-lease)。
 * 借鉴出处与六字段提案：.khy/feedback/2026-09-18-tier1-minimax-code/proposal-b-p2.md
 * （minimax-code oauth-lease-protocol，reference 档，MIT）。
 */

const protocol = require('./leaseProtocol');
const { createLeaseBroker, DEFAULTS } = require('./leaseBroker');
const { requestLease, readLeaseCoord } = require('./leaseClient');
const { createStaticKeyProvider } = require('./providers');

function defaultLeaseDataDir() {
  // Lazy require keeps this module IO-free at load time (leaf-import rule).
  const { getDataDir } = require('../../utils/dataHome');
  return getDataDir('credential-lease');
}

module.exports = {
  PROTOCOL_VERSION: protocol.PROTOCOL_VERSION,
  createLeaseBroker,
  requestLease,
  readLeaseCoord,
  createStaticKeyProvider,
  defaultLeaseDataDir,
  DEFAULTS,
};
