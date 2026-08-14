'use strict';

// 对齐 CC「后端逻辑也对齐」:`/cost`·`/usage` 报表 token 计数 → 紧凑记数**单一真源收敛**。
// CC 的 `/cost` 报表(`cost-tracker.ts::formatModelUsage`)与 `Stats.tsx` "Total tokens"
// 一律用 `formatNumber`(紧凑:1234567 → "1.2m"、12345 → "12.3k"、<1000 原样),与 khy 其余
// 所有 token 显示面(HUD/Spinner/Footer/Compaction/turnStats,均走 ccFormatTokens)同口径。
// 此前 khy `/cost`·`/usage` 报表子系统是唯一漏网:三处局部 `fmtNum = n.toLocaleString('en-US')`
// 产**全分隔符** "1,234,567"。本测试验证收敛后的 `tokenUsageService._fmtTokenCount`:
//   - 门控 KHY_CC_FORMAT 开 → === ccFormatTokens(紧凑)
//   - 门控关 → 逐字节回退各 call-site 自带 legacy(旧 toLocaleString 全分隔符口径)
// 零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const { ccFormatTokens } = require('../../src/cli/ccFormat');
const { _fmtTokenCount } = require('../../src/services/tokenUsageService');

const ON = { KHY_CC_FORMAT: '1' };
const OFF = { KHY_CC_FORMAT: 'off' };
const legacy = (n) => n.toLocaleString('en-US');
const VALUES = [0, 42, 900, 999, 1000, 1234, 12345, 123456, 1234567, 2000000, 999999999];

// ── 门控开:与 CC formatNumber(=ccFormatTokens)逐字节一致 ────────────────────
test('_fmtTokenCount 门控开 = ccFormatTokens 逐字节同口径(CC 报表 formatNumber 口径)', () => {
  for (const n of VALUES) {
    assert.strictEqual(_fmtTokenCount(n, legacy(n), ON), ccFormatTokens(n), `n=${n}`);
  }
});

test('门控开:具体紧凑形态(<1000 原样·≥1000 紧凑小写)', () => {
  assert.strictEqual(_fmtTokenCount(900, legacy(900), ON), '900');       // <1000 原样
  assert.strictEqual(_fmtTokenCount(12345, legacy(12345), ON), '12.3k'); // 旧报表显 "12,345"
  assert.strictEqual(_fmtTokenCount(1234567, legacy(1234567), ON), '1.2m'); // 旧报表显 "1,234,567"
  assert.strictEqual(_fmtTokenCount(2000000, legacy(2000000), ON), '2m');
});

// ── 门控关:逐字节回退 call-site 自带 legacy(全分隔符 toLocaleString)─────────
test('_fmtTokenCount 门控关 = 历史 toLocaleString 全分隔符口径(逐字节)', () => {
  for (const off of [OFF, { KHY_CC_FORMAT: '0' }, { KHY_CC_FORMAT: 'no' }, { KHY_CC_FORMAT: 'false' }]) {
    assert.strictEqual(_fmtTokenCount(1234567, legacy(1234567), off), '1,234,567');
    assert.strictEqual(_fmtTokenCount(12345, legacy(12345), off), '12,345');
    assert.strictEqual(_fmtTokenCount(900, legacy(900), off), '900');
  }
});

test('门控开 / 关唯一分歧 = SSOT 紧凑 vs 全分隔符(锁定本刀修正点)', () => {
  assert.notStrictEqual(_fmtTokenCount(1234567, legacy(1234567), ON), _fmtTokenCount(1234567, legacy(1234567), OFF));
  assert.strictEqual(_fmtTokenCount(1234567, legacy(1234567), ON), '1.2m');
  assert.strictEqual(_fmtTokenCount(1234567, legacy(1234567), OFF), '1,234,567');
});

test('防呆:非有限 ccFormatTokens 返回 \'\' → 落 legacy(门控开也回退)', () => {
  assert.strictEqual(_fmtTokenCount(NaN, 'N/A', ON), 'N/A');           // ccFormatTokens(NaN)='' → legacy
  assert.strictEqual(_fmtTokenCount(Infinity, 'inf', ON), 'inf');
  // legacy 缺省(null)→ 走内置 toLocaleString('en-US') 兜底
  assert.strictEqual(_fmtTokenCount(1234567, null, OFF), '1,234,567');
});

test('默认门控(env 无 KHY_CC_FORMAT)= 开(紧凑)', () => {
  assert.strictEqual(_fmtTokenCount(1234567, legacy(1234567), {}), '1.2m');
});
