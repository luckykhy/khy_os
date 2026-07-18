'use strict';

/**
 * capabilityRegistry.test.js — the capability-as-code facade over the tool
 * registry. Verifies that capabilities (tools carrying a `.capability` block)
 * are discovered, that the first instance (docTitleStyle) shows up with its
 * declared tests, and that the test-presence check resolves real files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cap = require('../src/services/capabilityRegistry');

describe('capabilityRegistry — 发现', () => {
  test('listCapabilities 含 docTitleStyle 且声明测试', () => {
    const caps = cap.listCapabilities();
    const dts = caps.find((c) => c.name === 'docTitleStyle');
    assert.ok(dts, 'docTitleStyle should be a registered capability');
    assert.ok(dts.tests.includes('tests/docTitleStyle.test.js'));
    assert.ok(dts.summary && dts.summary.length > 0);
    assert.ok(dts.surfaces.includes('agent'));
  });

  test('结果按名称排序且字段完整', () => {
    const caps = cap.listCapabilities();
    for (const c of caps) {
      assert.ok(typeof c.name === 'string' && c.name);
      assert.ok(Array.isArray(c.tests));
      assert.ok(Array.isArray(c.surfaces));
    }
    const names = caps.map((c) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('capabilityRegistry — describeCapability', () => {
  test('docTitleStyle 的声明测试文件确实存在', () => {
    const info = cap.describeCapability('docTitleStyle');
    assert.ok(info);
    assert.ok(info.testsResolved.length > 0);
    // The declared test file is THIS suite's sibling — it must resolve & exist.
    for (const t of info.testsResolved) {
      assert.equal(t.exists, fs.existsSync(t.absPath));
      assert.ok(t.absPath.startsWith(cap.PACKAGE_ROOT));
    }
    assert.equal(info.testsPresent, true);
  });

  test('未知能力 → null', () => {
    assert.equal(cap.describeCapability('no_such_capability_xyz'), null);
  });

  test('PACKAGE_ROOT 指向 backend 包根（含 tests/ 目录）', () => {
    assert.ok(fs.existsSync(path.join(cap.PACKAGE_ROOT, 'tests')));
    assert.ok(fs.existsSync(path.join(cap.PACKAGE_ROOT, 'src', 'tools', 'docTitleStyle.js')));
  });
});
