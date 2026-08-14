/**
 * Tests for the bridge mobile control page generator. `buildMobileHTML(port)`
 * returns a self-contained HTML string, so we assert the device-naming feature
 * is wired in and that the embedded client script parses (no execution).
 *   node --test tests/bridge/mobilePage.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMobileHTML } = require('../../src/bridge/mobilePage');

test('buildMobileHTML: embeds the configured port', () => {
  const html = buildMobileHTML(9333);
  assert.ok(html.includes('var DIRECT_PORT = 9333;'), 'port interpolated into client');
});

test('buildMobileHTML: includes the device-naming overlay markup', () => {
  const html = buildMobileHTML(9222);
  for (const id of ['deviceOverlay', 'devNameInput', 'devNameSuffix', 'devPreview', 'devOkBtn', 'devAutoBtn', 'deviceNameBadge']) {
    assert.ok(html.includes('id="' + id + '"'), 'overlay element present: ' + id);
  }
});

test('buildMobileHTML: wires device protocol + local persistence + UA-CH', () => {
  const html = buildMobileHTML(9222);
  for (const marker of [
    'set_device', 'resolve_device', 'device_named', 'device_suggestion',
    'khy_device_name', 'khy_device_type',
    'getHighEntropyValues', 'classifyLocal', 'sendAuth',
  ]) {
    assert.ok(html.includes(marker), 'client wires: ' + marker);
  }
});

test('buildMobileHTML: embedded client script is syntactically valid', () => {
  const html = buildMobileHTML(9222);
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'a <script> block exists');
  // new Function validates syntax without running browser-only globals.
  assert.doesNotThrow(() => new Function(m[1]));
});

test('buildMobileHTML: includes attachment upload UI markup', () => {
  const html = buildMobileHTML(9222);
  for (const id of ['fileInput', 'attachBtn', 'attachBar']) {
    assert.ok(html.includes('id="' + id + '"'), 'attachment element present: ' + id);
  }
  // The file picker accepts images, video, audio and common documents.
  assert.ok(/accept="[^"]*image\/\*[^"]*video\/\*[^"]*\.pdf/.test(html), 'file input accepts media + pdf');
});

test('buildMobileHTML: client wires attachment upload + send payload', () => {
  const html = buildMobileHTML(9222);
  for (const marker of [
    'uploadFiles', 'renderAttachBar', 'pendingAttachments',
    'api/upload', 'attachments: atts', "Authorization",
  ]) {
    assert.ok(html.includes(marker), 'client wires: ' + marker);
  }
});
