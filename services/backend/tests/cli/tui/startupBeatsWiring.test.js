'use strict';

// startupBeatsWiring.test — 启动板块接线的**回归锁**（[DESIGN-ARCH-115] §4.2）。
//
// 这些不是普通单测，是防止后来者把 D1 重新引入的闸。仓库已有先例：
// tests/cli/tui/updateWiring.test.js 也是用正则断言源码，而非运行时行为。
//
// 锁的三件事：
//   1. 完成信号不得再引用 banner 的 git 来源探测（D1 根因）；
//   2. 不得再出现「用 setTimeout 标记启动完成」（D3 空壳拍）；
//   3. 完成只能通过 startupBeats 的 done()/preload() 上报。
//
// 另含 BootScreen 门控取值的运行时断言（0 / legacy / off / 默认）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'cli',
  'tui',
  'ink-components',
  'App.js'
);

const src = fs.readFileSync(APP_JS, 'utf8');

test('D1 锁：启动完成信号不得引用 banner 的 git 来源探测', () => {
  // 旧实现：`}, [bannerUpdateLine]);` —— 把 banner 的 git 来源探测当「会话就绪」
  // 信号。于是启动时长 = 该探测耗时 + 1.5s + 0.4s，而那个探测与启动毫无关系。
  assert.equal(
    /\[bannerUpdateLine\]/.test(src),
    false,
    'App.js 又出现了以 bannerUpdateLine 为依赖的 effect —— 这是 D1 的根因，禁止恢复'
  );
});

test('D3 锁：不得用 setTimeout 标记启动完成（空壳拍）', () => {
  // 旧实现：`setTimeout(() => setBootComplete(true), 400)`，
  // 以及 `setTimeout(markSession, 1500)` —— 两步都是纯时长驱动，与真实工作无关。
  assert.equal(
    /setBootComplete\(true\)/.test(src),
    false,
    '不得再直接把 boot 标记为完成 —— 完成必须来自 startupBeats 的真实信号'
  );
  assert.equal(
    /setTimeout\(markSession/.test(src),
    false,
    '不得再出现时长驱动的 markSession'
  );
});

test('接线：完成信号统一走 startupBeats', () => {
  assert.ok(
    /require\('\.\.\/\.\.\/startupBeats'\)/.test(src),
    'App.js 必须 require startupBeats（启动板块单一真源）'
  );
  assert.ok(
    /beats\.preload\(\[/.test(src),
    'App.js 必须用 preload 标记 pre-mount 已完成的四拍（预热起点）'
  );
  assert.ok(/beats\.done\('render'\)/.test(src), '拍 3 render 必须由首帧 commit 上报');
  assert.ok(/beats\.done\('gateway'\)/.test(src), '拍 5 gateway 必须有真实完成信号');
  assert.ok(
    /beats\.fail\('gateway'/.test(src),
    '网关等不到确认必须走 fail()（可见降级），而不是 done()（伪装成功）'
  );
  assert.ok(/beats\.subscribe/.test(src), 'App 必须订阅节拍真源以驱动 _bootComplete');
});

test('接线：降级看门狗是唯一超时，且只用于降级', () => {
  // 允许 GATEWAY_DEGRADE_MS 这一个超时常量，但它的处理必须是 fail 而非 done。
  assert.ok(/GATEWAY_DEGRADE_MS/.test(src), '网关降级看门狗常量应存在');
  assert.equal(
    /GATEWAY_DEGRADE_MS\s*=\s*\d+/.test(src),
    true,
    'GATEWAY_DEGRADE_MS 应为一个具体毫秒数'
  );
});

test('接线：旧的 ad-hoc tracker 已被移除', () => {
  assert.equal(/_bootTracker/.test(src), false, '_bootTracker 应已移除');
  assert.equal(/createBootTracker/.test(src), false, 'createBootTracker 应已移除');
  assert.equal(/_bootGateRef/.test(src), false, '_bootGateRef 应已移除（原为「一 ref 两用」）');
});

// ── BootScreen 门控（运行时） ────────────────────────────────────────────

const { isBootScreenEnabled } = require('../../../src/cli/tui/ink-components/BootScreen');

test('BootScreen 门控：默认开', () => {
  assert.equal(isBootScreenEnabled({}), true);
  assert.equal(isBootScreenEnabled({ KHY_BOOT_SCREEN: '1' }), true);
});

test('BootScreen 门控：0 / legacy / off / no 全部关闭', () => {
  for (const v of ['0', 'legacy', 'off', 'no', 'false', ' LEGACY ', 'Off']) {
    assert.equal(isBootScreenEnabled({ KHY_BOOT_SCREEN: v }), false, `${v} 应关闭启动屏`);
  }
});

test('BootScreen：不再导出旧的 ad-hoc tracker API', () => {
  const mod = require('../../../src/cli/tui/ink-components/BootScreen');
  assert.equal(typeof mod.BootScreen, 'function');
  assert.equal(typeof mod.createBootTracker, 'undefined', 'createBootTracker 应已被 startupBeats 取代');
  assert.equal(typeof mod.STEPS, 'undefined', ' STEPS 常量应已被 startupBeats 的 BEATS 取代');
});
