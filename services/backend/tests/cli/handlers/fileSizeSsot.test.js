'use strict';

// 对齐 CC「后端逻辑也对齐」:字节数 → 人类可读的**单一真源收敛**。
// CC 后端把所有文件大小都过同一个 src/utils/format.ts `formatFileSize`;Khy 此前
// health.js `_bytesHuman` / storage.js `_fmtBytes` 各有一套发散本地算法(无空格 "NB"、
// 变小数位、" N.N KB" 带空格、含 TB 档)。本测试验证:门控 KHY_CC_FORMAT 开时两者都
// 路由到 ccFormat SSOT(与 CC formatFileSize 逐字节同口径);门控关时逐字节回退旧本地口径。
const test = require('node:test');
const assert = require('node:assert');

const { _bytesHuman } = require('../../../src/cli/handlers/health');
const { _fmtBytes } = require('../../../src/cli/handlers/storage');
const { ccFormatFileSize } = require('../../../src/cli/ccFormat');

const ON = { KHY_CC_FORMAT: '1' };
const OFF = { KHY_CC_FORMAT: 'off' };

// ── 门控开:两个 call-site 都与 CC formatFileSize 逐字节一致 ──────────────
test('health _bytesHuman 门控开 = CC formatFileSize 逐字节同口径', () => {
  for (const n of [0, 1, 512, 1023, 1024, 1536, 1024 * 1024, 5 * 1024 * 1024, 3 * 1024 * 1024 * 1024]) {
    assert.strictEqual(_bytesHuman(n, ON), ccFormatFileSize(n), `bytes=${n}`);
  }
});

test('storage _fmtBytes 门控开 = CC formatFileSize 逐字节同口径', () => {
  for (const n of [1, 512, 1023, 1024, 1536, 1024 * 1024, 5 * 1024 * 1024, 3 * 1024 * 1024 * 1024]) {
    assert.strictEqual(_fmtBytes(n, ON), ccFormatFileSize(n), `bytes=${n}`);
  }
});

test('门控开:CC 口径具体形态(无空格 / "bytes" 词 / 去尾随 .0 / GB 进位)', () => {
  assert.strictEqual(_bytesHuman(512, ON), '512 bytes');     // <1KB → "N bytes"(英文词,带空格)
  assert.strictEqual(_bytesHuman(1024, ON), '1KB');           // 整数 KB 去 .0,无空格
  assert.strictEqual(_bytesHuman(1536, ON), '1.5KB');         // 1 位小数,无空格
  assert.strictEqual(_fmtBytes(5 * 1024 * 1024, ON), '5MB');  // MB 进位,无空格
  assert.strictEqual(_fmtBytes(2 * 1024 * 1024 * 1024, ON), '2GB'); // GB 进位
});

// ── 门控关:逐字节回退到各自的旧本地口径 ────────────────────────────────
test('health _bytesHuman 门控关 = 旧本地口径(无空格、变小数位、含 TB)', () => {
  assert.strictEqual(_bytesHuman(512, OFF), '512B');          // <1024 → 0 小数位,无空格,单位 B
  assert.strictEqual(_bytesHuman(1536, OFF), '1.5KB');        // i!=0 且 <10 → 1 位小数
  assert.strictEqual(_bytesHuman(12 * 1024, OFF), '12KB');    // v>=10 → 0 位小数
  assert.strictEqual(_bytesHuman(2 * 1024 ** 4, OFF), '2.0TB'); // 旧口径有 TB 档(CC 无)
});

test('storage _fmtBytes 门控关 = 旧本地口径(带空格、含 TB、0→"0 B")', () => {
  assert.strictEqual(_fmtBytes(0, OFF), '0 B');
  assert.strictEqual(_fmtBytes(512, OFF), '512 B');           // 带空格
  assert.strictEqual(_fmtBytes(1536, OFF), '1.5 KB');         // 带空格
  assert.strictEqual(_fmtBytes(2 * 1024 ** 4, OFF), '2.0 TB');
});

// ── 边界:非有限 / 无效输入两档都 fail-soft 回退本地兜底(绝不抛、绝不空串)──
test('非有限输入:门控开也回退到各自本地兜底(不被 SSOT 的 "" 吞掉)', () => {
  // ccFormatFileSize 对非有限/负数返 ''(falsy)→ 不 return → 落到 legacy 兜底。
  for (const env of [ON, OFF]) {
    assert.strictEqual(_bytesHuman(NaN, env), '未知');
    assert.strictEqual(_bytesHuman(-1, env), '未知');
    assert.strictEqual(_fmtBytes(undefined, env), '0 B');
    assert.strictEqual(_fmtBytes(-5, env), '0 B');
  }
});

test('默认(无显式门控)= 开档行为(与 CC 同口径)', () => {
  const prev = process.env.KHY_CC_FORMAT;
  delete process.env.KHY_CC_FORMAT;
  try {
    assert.strictEqual(_bytesHuman(1536), ccFormatFileSize(1536));
    assert.strictEqual(_fmtBytes(1536), ccFormatFileSize(1536));
  } finally {
    if (prev === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = prev;
  }
});

// ── 内联 call-site 的共享门控助手 _ccFileSize(bytes, legacy)(router / session)──
// 二者实现同款:门控开 → ccFormatFileSize(bytes);关 / 非有限 → 原样返回 legacy 串。
const { _ccFileSize: routerCcFileSize } = require('../../../src/cli/router');
const { _ccFileSize: sessionCcFileSize } = require('../../../src/cli/handlers/session');

function withGate(val, fn) {
  const prev = process.env.KHY_CC_FORMAT;
  if (val === undefined) delete process.env.KHY_CC_FORMAT;
  else process.env.KHY_CC_FORMAT = val;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = prev;
  }
}

for (const [name, ccFileSize] of [['router', routerCcFileSize], ['session', sessionCcFileSize]]) {
  test(`${name}._ccFileSize 门控开 → CC 口径(忽略 legacy)`, () => {
    withGate('1', () => {
      assert.strictEqual(ccFileSize(1536, '1.5 KB'), '1.5KB');      // CC 无空格,legacy 带空格被忽略
      assert.strictEqual(ccFileSize(5 * 1024 * 1024, '5.0 MB'), '5MB');
      assert.strictEqual(ccFileSize(512, '0.5 KB'), '512 bytes');   // <1KB → "N bytes"
    });
  });

  test(`${name}._ccFileSize 门控关 → legacy 串逐字节回退`, () => {
    withGate('off', () => {
      assert.strictEqual(ccFileSize(1536, '1.5 KB'), '1.5 KB');
      assert.strictEqual(ccFileSize(512, '0.5 KB'), '0.5 KB');
    });
  });

  test(`${name}._ccFileSize 非有限 bytes → legacy 兜底(不被 SSOT 的 "" 吞)`, () => {
    withGate('1', () => {
      assert.strictEqual(ccFileSize(NaN, '原样 KB'), '原样 KB');
      assert.strictEqual(ccFileSize(-1, '原样 KB'), '原样 KB');
    });
  });
}

test('router 本地模型 sizeMB(已是 MB)→ MB*1024*1024 还原成字节喂 SSOT', () => {
  withGate('1', () => {
    // sizeMB=2048 → 2048*1024*1024 字节 → CC gb=2 → "2GB"。
    assert.strictEqual(routerCcFileSize(2048 * 1024 * 1024, '2.0 GB'), '2GB');
    // sizeMB=512 → "512MB"。
    assert.strictEqual(routerCcFileSize(512 * 1024 * 1024, '512 MB'), '512MB');
  });
});
