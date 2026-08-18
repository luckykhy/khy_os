'use strict';

/**
 * ppmFrame.test.js — the P6 PPM parser that decodes QEMU screendump output.
 *
 * QEMU's HMP `screendump` writes a binary P6 PPM; this leaf turns it into an RGBA
 * buffer a browser canvas can blit. Guards: correct magic/dimension parsing,
 * whitespace + comment tolerance in the header, RGB→RGBA expansion with opaque
 * alpha, and clear rejection of the shapes screendump never emits (P3 ASCII,
 * 16-bit, truncated data).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePpmHeader, ppmToRgba } = require('../../../src/runtime/khyos/ppmFrame');

/** Build a minimal P6 PPM buffer from a header string + raw RGB bytes. */
function makePpm(header, rgbBytes) {
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(rgbBytes)]);
}

describe('ppmFrame — parsePpmHeader', () => {
  test('parses a canonical "P6\\n<w> <h>\\n255\\n" header', () => {
    const h = parsePpmHeader(makePpm('P6\n2 3\n255\n', new Array(2 * 3 * 3).fill(0)));
    assert.equal(h.width, 2);
    assert.equal(h.height, 3);
    assert.equal(h.maxval, 255);
    assert.equal(h.dataOffset, 'P6\n2 3\n255\n'.length);
  });

  test('tolerates spaces/newlines mixed between tokens', () => {
    const h = parsePpmHeader(makePpm('P6   4\n\n  5   255\n', new Array(4 * 5 * 3).fill(1)));
    assert.equal(h.width, 4);
    assert.equal(h.height, 5);
  });

  test('skips a # comment line in the header', () => {
    const h = parsePpmHeader(makePpm('P6\n# qemu screendump\n2 2\n255\n', new Array(12).fill(0)));
    assert.equal(h.width, 2);
    assert.equal(h.height, 2);
  });

  test('rejects a non-P6 magic (P3 ASCII)', () => {
    assert.throws(() => parsePpmHeader(Buffer.from('P3\n1 1\n255\n0 0 0\n')), /P6/);
  });

  test('rejects 16-bit maxval (screendump never emits it)', () => {
    assert.throws(() => parsePpmHeader(makePpm('P6\n1 1\n65535\n', [0, 0, 0, 0, 0, 0])), /maxval/);
  });

  test('rejects non-positive dimensions', () => {
    assert.throws(() => parsePpmHeader(makePpm('P6\n0 5\n255\n', [])), /dimension/);
  });

  test('throws on a non-buffer / empty input', () => {
    assert.throws(() => parsePpmHeader(null), /non-buffer/);
    assert.throws(() => parsePpmHeader(Buffer.alloc(0)), /non-buffer|empty/);
  });
});

describe('ppmFrame — ppmToRgba', () => {
  test('expands RGB → RGBA with opaque alpha, correct length', () => {
    // 2x1 image: red pixel, green pixel.
    const buf = makePpm('P6\n2 1\n255\n', [255, 0, 0, 0, 255, 0]);
    const { width, height, rgba } = ppmToRgba(buf);
    assert.equal(width, 2);
    assert.equal(height, 1);
    assert.equal(rgba.length, 2 * 1 * 4);
    assert.deepEqual(Array.from(rgba), [255, 0, 0, 255, 0, 255, 0, 255]);
  });

  test('preserves pixel order for a 1x2 (two rows) image', () => {
    const buf = makePpm('P6\n1 2\n255\n', [1, 2, 3, 4, 5, 6]);
    const { rgba } = ppmToRgba(buf);
    assert.deepEqual(Array.from(rgba), [1, 2, 3, 255, 4, 5, 6, 255]);
  });

  test('throws when the pixel region is truncated', () => {
    // header claims 2x2 (12 RGB bytes) but only 6 provided.
    const buf = makePpm('P6\n2 2\n255\n', [0, 0, 0, 1, 1, 1]);
    assert.throws(() => ppmToRgba(buf), /truncated/);
  });
});
