'use strict';

/**
 * Tests for the bridge mobile control page generator. `buildMobileHTML(port)`
 * returns a self-contained HTML string, so we assert the device-naming feature
 * is wired in and that the embedded client script parses (no execution).
 *   node --test tests/bridge/mobilePage.test.js
 */
'use strict';
const { buildMobileHTML } = require('../../src/bridge/mobilePage');

describe('Mobile Page', () => {
  test('buildMobileHTML: embeds the configured port', () => {
      const html = buildMobileHTML(9333);
      expect(html.includes('var DIRECT_PORT = 9333;')).toBeTruthy();
  });

  test('buildMobileHTML: includes the device-naming overlay markup', () => {
      const html = buildMobileHTML(9222);
      for (const id of ['deviceOverlay', 'devNameInput', 'devNameSuffix', 'devPreview', 'devOkBtn', 'devAutoBtn', 'deviceNameBadge']) {
        expect(html.includes('id="' + id + '"')).toBeTruthy();
      }
  });

  test('buildMobileHTML: wires device protocol + local persistence + UA-CH', () => {
      const html = buildMobileHTML(9222);
      for (const marker of [
        'set_device', 'resolve_device', 'device_named', 'device_suggestion',
        'khy_device_name', 'khy_device_type',
        'getHighEntropyValues', 'classifyLocal', 'sendAuth',
      ]) {
        expect(html.includes(marker)).toBeTruthy();
      }
  });

  test('buildMobileHTML: embedded client script is syntactically valid', () => {
      const html = buildMobileHTML(9222);
      const m = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(m).toBeTruthy();
      // new Function validates syntax without running browser-only globals.
      expect(() => new Function(m[1]).not.toThrow());
  });

  test('buildMobileHTML: includes attachment upload UI markup', () => {
      const html = buildMobileHTML(9222);
      for (const id of ['fileInput', 'attachBtn', 'attachBar']) {
        expect(html.includes('id="' + id + '"')).toBeTruthy();
      }
      // The file picker accepts images, video, audio and common documents.
      expect(/accept="[^"]*image\/\*[^"]*video\/\*[^"]*\.pdf/.test(html)).toBe();
  });

  test('buildMobileHTML: client wires attachment upload + send payload', () => {
      const html = buildMobileHTML(9222);
      for (const marker of [
        'uploadFiles', 'renderAttachBar', 'pendingAttachments',
        'api/upload', 'attachments: atts', "Authorization",
      ]) {
        expect(html.includes(marker)).toBeTruthy();
      }
  });

});
