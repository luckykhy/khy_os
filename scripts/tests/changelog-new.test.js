'use strict';

/**
 * changelog-new.test.js — pins scripts/release/changelog-new.js.
 *
 * Verifies the pure helpers (topVersion / insertStub / isValidVersion) against
 * a fixture CHANGELOG string — NEVER touches the real CHANGELOG.md. Covers:
 * parser-compatible stub shape, idempotent re-insert, existing entries kept,
 * and version validation.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const cl = require('../release/changelog-new');

const FIXTURE = [
  '# Changelog',
  '',
  'All notable changes are documented here.',
  '',
  '---',
  '',
  '## 1.1.6',
  '',
  'khy OS 1.1.6: something.',
  '',
  '### Highlights',
  '',
  '- did a thing',
  '',
  '---',
  '',
].join('\n');

// Mirror of the parser anchor in changelogParse.js.
const VERSION_RE = /^##\s+(\S.*?)\s*$/;

describe('changelog-new', () => {
  test('topVersion reads the first ## header, not ###', () => {
    assert.equal(cl.topVersion(FIXTURE), '1.1.6');
    assert.equal(cl.topVersion('### Highlights\n## 9.9.9\n'), '9.9.9');
  });

  test('isValidVersion accepts X.Y.Z and tagged, rejects junk', () => {
    assert.ok(cl.isValidVersion('1.1.7'));
    assert.ok(cl.isValidVersion('2.0.0-rc1'));
    assert.ok(!cl.isValidVersion('not-a-version'));
    assert.ok(!cl.isValidVersion('1.2'));
  });

  test('buildStub emits a parser-compatible ## header + required sections', () => {
    const stub = cl.buildStub('1.1.7');
    const headerLine = stub.split('\n').find((l) => VERSION_RE.test(l));
    assert.ok(headerLine, 'stub has a ## version header the parser will match');
    assert.equal(VERSION_RE.exec(headerLine)[1], '1.1.7');
    assert.match(stub, /^### Highlights$/m, 'has Highlights section');
    assert.match(stub, /^### Compatibility$/m, 'has Compatibility section');
    assert.match(stub, /^---$/m, 'ends with an entry separator');
  });

  test('insertStub prepends a new version above the newest entry', () => {
    const { changed, text } = cl.insertStub(FIXTURE, '1.1.7');
    assert.equal(changed, true);
    assert.equal(cl.topVersion(text), '1.1.7', 'new version is now on top');
    assert.match(text, /## 1\.1\.6/, 'old 1.1.6 entry is still present');
    // 1.1.7 header appears before 1.1.6 header.
    assert.ok(text.indexOf('## 1.1.7') < text.indexOf('## 1.1.6'));
    // The `# Changelog` preamble is preserved and stays first.
    assert.ok(text.startsWith('# Changelog'));
  });

  test('insertStub is idempotent when the version is already on top', () => {
    const once = cl.insertStub(FIXTURE, '1.1.7').text;
    const twice = cl.insertStub(once, '1.1.7');
    assert.equal(twice.changed, false, 'second insert is a no-op');
    assert.equal(twice.text, once, 'text unchanged on idempotent re-run');
  });

  test('insertStub appends when there are no existing entries', () => {
    const bare = '# Changelog\n\nSome preamble.\n';
    const { changed, text } = cl.insertStub(bare, '1.0.0');
    assert.equal(changed, true);
    assert.equal(cl.topVersion(text), '1.0.0');
    assert.ok(text.startsWith('# Changelog'));
  });
});
