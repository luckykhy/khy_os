'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { findAvailablePort, portResponds } = require('../src/cli/handlers/service');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('findAvailablePort keeps a free requested port', async () => {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  assert.equal(await findAvailablePort(port, 1), port);
});

test('occupied non-KHY port advances to the next available port', async () => {
  const occupied = net.createServer((socket) => socket.destroy());
  const port = await listen(occupied);
  try {
    assert.equal(await portResponds(port), false);
    assert.equal(await findAvailablePort(port, 2), port + 1);
  } finally {
    await close(occupied);
  }
});
