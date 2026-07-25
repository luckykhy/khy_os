'use strict';

/**
 * Port utilities for the KHY OS runner.
 *
 * QEMU exposes the kernel's 16550 serial port as a TCP listener
 * (`-serial tcp:127.0.0.1:<port>,server`). We pick a free ephemeral port on the
 * loopback interface and hand it to QEMU. Using TCP (not a unix socket) keeps
 * the bridge identical on Windows and Linux.
 */

const net = require('net');

/**
 * Ask the OS for a free TCP port by binding to port 0 on loopback, reading back
 * the assigned port, then closing. There is an unavoidable TOCTOU window between
 * close and QEMU's bind — small on loopback, and KhyOsRunner's connect retry
 * loop tolerates a transient bind failure by letting QEMU exit and surfacing it.
 *
 * @param {string} [host='127.0.0.1']
 * @returns {Promise<number>}
 */
function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

module.exports = { findFreePort };
