'use strict';

// PR: merge-khychat-into-bridge — auto-login / LAN-gate unit tests.
//
//   - _isLanOrLoopbackIp: classification helper exported by bridgeServer
//   - The /api/auto-login route itself is exercised end-to-end via the
//     real bridge server in uploadRoute.test.js (which already starts
//     a bridge and uses HTTP requests against it). We focus the unit
//     layer on the IP gate (fast, pure, no DB needed).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _isLanOrLoopbackIp } = require('../../src/bridge/bridgeServer');

test('_isLanOrLoopbackIp accepts loopback addresses (IPv4 + IPv6 + IPv4-mapped)', () => {
  for (const ip of [
    '127.0.0.1',
    '127.255.255.254',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:127.255.255.254',
    'localhost',
  ]) {
    assert.equal(_isLanOrLoopbackIp(ip), true, 'expected loopback: ' + ip);
  }
});

test('_isLanOrLoopbackIp accepts RFC1918 private IPv4 ranges', () => {
  for (const ip of [
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.20.30.40',
    '172.31.255.254',
    '192.168.1.1',
    '192.168.255.254',
  ]) {
    assert.equal(_isLanOrLoopbackIp(ip), true, 'expected private: ' + ip);
  }
});

test('_isLanOrLoopbackIp accepts IPv6 ULA + link-local', () => {
  for (const ip of ['fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fea5::1']) {
    assert.equal(_isLanOrLoopbackIp(ip), true, 'expected LAN IPv6: ' + ip);
  }
});

test('_isLanOrLoopbackIp rejects public IPv4 addresses', () => {
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '9.9.9.9',
    '203.0.113.42',
    '198.51.100.7',
    // 172.15.x.x and 172.32.x.x are NOT in the 172.16/12 private range.
    '172.15.0.1',
    '172.32.0.1',
  ]) {
    assert.equal(_isLanOrLoopbackIp(ip), false, 'expected public: ' + ip);
  }
});

test('_isLanOrLoopbackIp rejects public IPv6 addresses', () => {
  for (const ip of [
    '2001:db8::1', // documentation block
    '2606:4700:4700::1111', // Cloudflare DNS (public)
  ]) {
    assert.equal(_isLanOrLoopbackIp(ip), false, 'expected public IPv6: ' + ip);
  }
});

test('_isLanOrLoopbackIp handles empty / malformed input safely', () => {
  for (const ip of ['', null, undefined, '   ', 'not-an-ip', '256.256.256.256']) {
    assert.equal(_isLanOrLoopbackIp(ip), false, 'expected reject: ' + JSON.stringify(ip));
  }
});
