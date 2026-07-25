'use strict';

/**
 * webSearchTransport.test.js (node:test)
 *
 * Regression for `TypeError [ERR_INVALID_PROTOCOL]: Protocol "http:" not
 * supported. Expected "https:"` thrown while following a 3xx redirect.
 *
 * The domestic search engines (Baidu/Bing/Sogou/360) follow one redirect hop.
 * When the Location header downgrades to an http:// URL, the old code called
 * https.get() on it and the whole search attempt crashed. _httpClientFor picks
 * the transport module from the URL's actual scheme so http:// redirects use
 * node:http and never throw ERR_INVALID_PROTOCOL. Pure (no network).
 */
const test = require('node:test');
const assert = require('node:assert');

const http = require('http');
const https = require('https');
const ws = require('../../src/services/webSearchService');
const { httpClientFor } = ws.__parsersForTests;

test('http:// URL selects the node:http module', () => {
  assert.strictEqual(httpClientFor('http://example.com/path'), http);
});

test('https:// URL selects the node:https module', () => {
  assert.strictEqual(httpClientFor('https://example.com/path'), https);
});

test('scheme-relative / unparseable input defaults to https (conservative)', () => {
  assert.strictEqual(httpClientFor('//example.com/path'), https);
  assert.strictEqual(httpClientFor('not a url'), https);
  assert.strictEqual(httpClientFor(''), https);
  assert.strictEqual(httpClientFor(undefined), https);
});

test('uppercase HTTP:// scheme is still routed to node:http', () => {
  assert.strictEqual(httpClientFor('HTTP://example.com'), http);
});

test('selecting the client for an http:// redirect never throws ERR_INVALID_PROTOCOL', () => {
  // The real bug: https.get('http://...') throws synchronously. Prove the
  // chosen client accepts the http:// URL up to the point of dispatch.
  const client = httpClientFor('http://127.0.0.1:0/redirect-target');
  assert.strictEqual(client, http);
  assert.doesNotThrow(() => {
    const req = client.get('http://127.0.0.1:0/redirect-target', { timeout: 1 }, () => {});
    req.on('error', () => {}); // swallow the inevitable connrefused/timeout
    req.destroy();
  });
});
