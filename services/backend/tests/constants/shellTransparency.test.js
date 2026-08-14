'use strict';

/**
 * shellTransparency.test.js — 纯叶子:透明性命令许可的单一真源(零 IO,确定性)。
 *
 * 验收要点:
 *  - 门控:未设/任意非关键字 → 开;0/false/off/no(含大小写/空白) → 关。
 *  - 关闭态 buildToolAvoidanceBlock() 与原始禁令块逐字节相同(byte-revert 锚)。
 *  - 开启态:仍禁 cat/grep/find/sed/awk 替代 dedicated tool;同时显式许可
 *    echo 叙述 + head/tail/wc 裁剪输出(TRANSPARENCY 段)。
 *  - buildTransparencyItem():开 → 非空正向许可串;关 → null。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const LEAF_PATH = path.resolve(__dirname, '../../src/constants/shellTransparency');

// 每次 require 都需读当前 env → 清缓存重载,使门控可被逐例切换。
function loadFresh() {
  delete require.cache[require.resolve(LEAF_PATH)];
  return require(LEAF_PATH);
}

function withEnv(value, fn) {
  const prev = process.env.KHY_SHELL_TRANSPARENCY;
  if (value === undefined) delete process.env.KHY_SHELL_TRANSPARENCY;
  else process.env.KHY_SHELL_TRANSPARENCY = value;
  try {
    return fn(loadFresh());
  } finally {
    if (prev === undefined) delete process.env.KHY_SHELL_TRANSPARENCY;
    else process.env.KHY_SHELL_TRANSPARENCY = prev;
  }
}

// 原始禁令块(改动前 shellCommand.js 描述内 IMPORTANT 块),用于 byte-revert 断言。
const ORIGINAL_BLOCK = [
  'IMPORTANT: Avoid using this tool to run find, grep, cat, head, tail, sed, awk, or echo commands unless explicitly instructed. Instead, use the appropriate dedicated tool:',
  ' - File search: Use Glob (NOT find or ls)',
  ' - Content search: Use Grep (NOT grep or rg)',
  ' - Read files: Use Read (NOT cat/head/tail)',
  ' - Edit files: Use Edit (NOT sed/awk)',
  ' - Write files: Use Write (NOT echo >/cat <<EOF)',
].join('\n');

test('isEnabled: 未设 → 开', () => {
  withEnv(undefined, (m) => assert.equal(m.isEnabled(), true));
});

test('isEnabled: 任意非关键字(on/1/yes/乱值) → 开', () => {
  for (const v of ['on', '1', 'yes', 'true', 'whatever']) {
    withEnv(v, (m) => assert.equal(m.isEnabled(), true, `value=${v}`));
  }
});

test('isEnabled: 0/false/off/no(含大小写/空白) → 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' False ', 'No']) {
    withEnv(v, (m) => assert.equal(m.isEnabled(), false, `value=${v}`));
  }
});

test('buildToolAvoidanceBlock: 关闭态与原始禁令块逐字节相同(byte-revert)', () => {
  withEnv('off', (m) => {
    assert.equal(m.buildToolAvoidanceBlock(), ORIGINAL_BLOCK);
    assert.equal(m.LEGACY_BLOCK, ORIGINAL_BLOCK);
  });
});

test('buildToolAvoidanceBlock: 开启态仍禁 cat/grep/find/sed/awk 替代 dedicated tool', () => {
  withEnv('on', (m) => {
    const block = m.buildToolAvoidanceBlock();
    assert.match(block, /Use Glob \(NOT find or ls\)/);
    assert.match(block, /Use Grep \(NOT grep or rg\)/);
    assert.match(block, /Use Read \(NOT cat\/head\/tail/);
    assert.match(block, /Use Edit \(NOT sed\/awk\)/);
    assert.match(block, /Use Write \(NOT echo >\/cat <<EOF\)/);
  });
});

test('buildToolAvoidanceBlock: 开启态显式许可 echo 叙述 + head/tail/wc 裁剪输出', () => {
  withEnv('on', (m) => {
    const block = m.buildToolAvoidanceBlock();
    assert.match(block, /TRANSPARENCY \(encouraged/);
    assert.match(block, /`echo` to label/);
    assert.match(block, /`head`, `tail`, or `wc -l`/);
    // 必须明确:透明性用途不在禁令打击面内。
    assert.match(block, /does NOT discourage echo narration or head\/tail output-trimming/i);
  });
});

test('buildToolAvoidanceBlock: 开启态 ≠ 关闭态(确有改写)', () => {
  const on = withEnv('on', (m) => m.buildToolAvoidanceBlock());
  const off = withEnv('off', (m) => m.buildToolAvoidanceBlock());
  assert.notEqual(on, off);
});

test('buildTransparencyItem: 开 → 非空正向许可;关 → null', () => {
  withEnv('on', (m) => {
    const item = m.buildTransparencyItem();
    assert.equal(typeof item, 'string');
    assert.match(item, /encouraged/);
    assert.match(item, /echo/);
    assert.match(item, /head/);
  });
  withEnv('off', (m) => assert.equal(m.buildTransparencyItem(), null));
});

test('buildTransparencyItem: 开启态教 `=== label ===` 分节表头规范(供前端结构化渲染)', () => {
  withEnv('on', (m) => {
    const item = m.buildTransparencyItem();
    // 必须教出与 BashTool 描述同款的 `=== label ===` 约定,且强调固定形态便于两端解析。
    assert.match(item, /=== label ===/);
    assert.match(item, /header line/i);
    assert.match(item, /frontend can render each section as a titled/i);
  });
});

test('确定性:同一门控多次调用返回相同结果(无副作用)', () => {
  withEnv('on', (m) => {
    assert.equal(m.buildToolAvoidanceBlock(), m.buildToolAvoidanceBlock());
    assert.equal(m.buildTransparencyItem(), m.buildTransparencyItem());
  });
});
