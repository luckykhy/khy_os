'use strict';

/**
 * archDebtScan 的注释剥离回归测试。
 *
 * 背景（2026-09-22 实测）：`extractRequires` 原本是**逐行裸正则**，分不清代码与注释。
 * 后果是一个「描述某条倒置」的文档注释本身被 R1 报成倒置 —— 实例是
 * `src/services/domain/extensions/extensions/markdownWorkbench.js:10`，
 * 那个模块的全部意义就是**消除**它被指控的那条依赖。
 *
 * 这类假阳性比假阴性贵：它逼人删掉有解释价值的注释去「迎合工具」，
 * 也就是让文档为工具让路。修法只能是修判据（提取前剥注释），不是改注释措辞。
 *
 * 本测试锁三件事：
 *   1. 行注释 / 块注释里的 `require(...)` 不再被提取；
 *   2. 真实代码里的 `require(...)` 仍然被提取（防空转断言 —— 否则「全剥离」也能全绿）；
 *   3. 行号仍是原文行号（剥注释不能错位，否则报告指不到正确位置）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractRequires, stripComments } = require('../scripts/archDebtScan');

function withTempFile(source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-archdebt-'));
  const file = path.join(dir, 'probe.js');
  fs.writeFileSync(file, source, 'utf-8');
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 1. 注释里的伪 require 不得提取 ────────────────────────────────────
test('line comment: require inside // is not extracted', () => {
  const src = [
    "const real = require('../real');", // 第 1 行 —— 真调用
    "// 注释: require('../../../../cli/handlers/md') —— 历史缺陷", // 第 2 行
  ].join('\n');

  withTempFile(src, (file) => {
    const found = extractRequires(file).map((r) => r.spec);
    assert.deepEqual(found, ['../real'], 'only the real require is reported');
  });
});

test('block comment and doc-comment star lines: require is not extracted', () => {
  const src = [
    '/**',
    ' * markdownWorkbench —— 本模块消除下面这条倒置：',
    " *   `require('../../../../cli/handlers/md')` —— 服务层反向依赖 cli 层。",
    ' */',
    "'use strict';",
    "const fs = require('fs');",
  ].join('\n');

  withTempFile(src, (file) => {
    const found = extractRequires(file).map((r) => r.spec);
    assert.deepEqual(found, ['fs'], 'doc comment described the defect; only fs is real');
  });
});

// ── 2. 真调用仍须提取（防空转） ──────────────────────────────────────
test('ANTI-VACUOUS: real requires in code are still extracted', () => {
  const src = [
    "const a = require('alpha');",
    "const b = require('../../../../cli/handlers/x');",
  ].join('\n');

  withTempFile(src, (file) => {
    const found = extractRequires(file).map((r) => r.spec);
    assert.deepEqual(
      found,
      ['alpha', '../../../../cli/handlers/x'],
      'stripping comments must not swallow code — else R1 would go blind'
    );
  });
});

// ── 3. 行号必须来自原文 ──────────────────────────────────────────────
test('line numbers stay aligned with the raw file', () => {
  const src = [
    '// require("phantom/one")',
    '/*',
    ' * require("phantom/two")',
    ' */',
    "const real = require('real-mod');", // 第 5 行
  ].join('\n');

  withTempFile(src, (file) => {
    const found = extractRequires(file);
    assert.equal(found.length, 1, 'phantom requires filtered out');
    assert.equal(found[0].spec, 'real-mod');
    assert.equal(found[0].line, 5, 'line number is the raw-file line, not a stripped-text line');
  });
});

// ── 4. 字符串与模板串内的 `//` 不得误判为注释 ────────────────────────
test('URL inside a string is not treated as a comment start', () => {
  const src = ["const u = 'https://example.com/x';", "const m = require('mod');"].join('\n');

  withTempFile(src, (file) => {
    const found = extractRequires(file).map((r) => r.spec);
    assert.deepEqual(found, ['mod'], 'a `//` inside a string must not open a comment');
  });
});

// ── 5. stripComments 保持长度（行号对齐的前提） ──────────────────────
test('stripComments preserves length and newlines', () => {
  const src = "// aaa\nconst x = require('y'); // tail\n/* block\n more */\n";
  const out = stripComments(src);
  assert.equal(out.length, src.length, 'length preserved');
  assert.equal((out.match(/\n/g) || []).length, (src.match(/\n/g) || []).length, 'newline count preserved');
  assert.ok(out.includes("require('y')"), 'code survives stripping');
  assert.ok(!out.includes('aaa'), 'line comment content is blanked');
});
