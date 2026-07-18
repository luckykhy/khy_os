'use strict';

// compactResultSummary 叶子契约测试(node:test)。
// 核心:压缩成功行追加 auto 决定的压缩强度(mode)+ 折叠条数(compactedCount),
// 门控关 / 缺字段 → 逐字节回退 legacy `会话已压缩：P -> N`。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  compactResultDetailEnabled,
  compactTwinAlignEnabled,
  buildCompactSuccessLine,
} = require('../../src/cli/compactResultSummary');

const LEGACY = (p, n) => `会话已压缩：${p} -> ${n}`;

test('门控默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(compactResultDetailEnabled({}), true);
  assert.strictEqual(compactResultDetailEnabled({ KHY_COMPACT_RESULT_DETAIL: '' }), true);
  assert.strictEqual(compactResultDetailEnabled({ KHY_COMPACT_RESULT_DETAIL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      compactResultDetailEnabled({ KHY_COMPACT_RESULT_DETAIL: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('门控开:三档 mode 映射中文标签 + 折叠条数', () => {
  const on = { KHY_COMPACT_RESULT_DETAIL: '1' };
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 60, nextCount: 12, compactedCount: 48, mode: 'aggressive' }, on),
    '会话已压缩：60 -> 12（激进压缩·折叠 48 条）',
  );
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 30, nextCount: 10, compactedCount: 20, mode: 'balanced' }, on),
    '会话已压缩：30 -> 10（均衡压缩·折叠 20 条）',
  );
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 12, nextCount: 6, compactedCount: 6, mode: 'light' }, on),
    '会话已压缩：12 -> 6（轻度压缩·折叠 6 条）',
  );
});

test('门控开:未知 mode 原样透传;mode 缺失只显折叠条数', () => {
  const on = { KHY_COMPACT_RESULT_DETAIL: '1' };
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 20, nextCount: 8, compactedCount: 12, mode: 'custom-x' }, on),
    '会话已压缩：20 -> 8（custom-x·折叠 12 条）',
  );
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 20, nextCount: 8, compactedCount: 12 }, on),
    '会话已压缩：20 -> 8（折叠 12 条）',
  );
  // 只有 mode,无 compactedCount
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 20, nextCount: 8, mode: 'light' }, on),
    '会话已压缩：20 -> 8（轻度压缩）',
  );
});

test('门控开但 mode + compactedCount 均缺 → 纯 legacy(不显空括号)', () => {
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 20, nextCount: 8 }, { KHY_COMPACT_RESULT_DETAIL: '1' }),
    LEGACY(20, 8),
  );
});

test('门控关 → 逐字节回退 legacy 串(丢明细)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      buildCompactSuccessLine(
        { previousCount: 60, nextCount: 12, compactedCount: 48, mode: 'aggressive' },
        { KHY_COMPACT_RESULT_DETAIL: off },
      ),
      LEGACY(60, 12),
      `门控关(${off})应回退 legacy`,
    );
  }
});

test('畸形 compactedCount(负/非数/非有限)→ 该段省略,绝不抛', () => {
  const on = { KHY_COMPACT_RESULT_DETAIL: '1' };
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 20, nextCount: 8, compactedCount: -3, mode: 'light' }, on),
    '会话已压缩：20 -> 8（轻度压缩）',
  );
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 20, nextCount: 8, compactedCount: 'NaN', mode: 'light' }, on),
    '会话已压缩：20 -> 8（轻度压缩）',
  );
  // 小数折叠向下取整
  assert.strictEqual(
    buildCompactSuccessLine({ previousCount: 20, nextCount: 8, compactedCount: 12.9, mode: 'light' }, on),
    '会话已压缩：20 -> 8（轻度压缩·折叠 12 条）',
  );
});

test('缺 result / 缺 previousCount 不抛(回退安全串)', () => {
  assert.strictEqual(
    buildCompactSuccessLine(undefined, { KHY_COMPACT_RESULT_DETAIL: '1' }),
    '会话已压缩：undefined -> undefined',
  );
  assert.strictEqual(
    buildCompactSuccessLine(null, { KHY_COMPACT_RESULT_DETAIL: 'off' }),
    '会话已压缩：undefined -> undefined',
  );
});

// 刀108:交互 /compact 孪生对齐总开关 KHY_COMPACT_TWIN_ALIGN。
test('compactTwinAlignEnabled 默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(compactTwinAlignEnabled({}), true);
  assert.strictEqual(compactTwinAlignEnabled({ KHY_COMPACT_TWIN_ALIGN: '' }), true);
  assert.strictEqual(compactTwinAlignEnabled({ KHY_COMPACT_TWIN_ALIGN: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      compactTwinAlignEnabled({ KHY_COMPACT_TWIN_ALIGN: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('compactTwinAlignEnabled 独立于结果明细子门控(互不影响)', () => {
  // 明细子门控关但对齐总开关默认开
  assert.strictEqual(compactTwinAlignEnabled({ KHY_COMPACT_RESULT_DETAIL: 'off' }), true);
  // 对齐总开关关但明细子门控默认开
  assert.strictEqual(compactResultDetailEnabled({ KHY_COMPACT_TWIN_ALIGN: 'off' }), true);
});
