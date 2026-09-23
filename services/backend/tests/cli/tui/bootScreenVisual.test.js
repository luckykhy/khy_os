'use strict';

// bootScreenVisual.test — 启动屏**视觉契约**的源码断言（[DESIGN-ARCH-134] §7.1 #3）。
//
// 与 `startupBeatsWiring.test.js`（节拍接线锁）分工：那个锁「完成信号从哪来」，
// 这个锁「长什么样」。分开成文件是为了让接线锁保持单一职责；两类断言都是
// 正则断言源码（仓库先例：updateWiring.test.js），因为挂 ink 渲染需要
// --experimental-vm-modules，CI 的 test:node 不带该 flag。
//
// ⚠ 用 node:test 写。`tests/**/*.test.js` 是 CI 的全量 glob，
//   裸 `describe`/`test`（jest 全局）会落地即红（liveFrameGeometry.test.js 前科）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BOOT = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'cli',
  'tui',
  'ink-components',
  'BootScreen.js'
);

const src = fs.readFileSync(BOOT, 'utf8');

test('视觉：根 Box 必须按档位决定水平居中（alignItems center / flex-start）', () => {
  // 居中不是写死的 —— bootLayout 的 center 档位决定它（窄终端 < 40 列放弃居中）。
  assert.ok(
    /alignItems:\s*layout\.center\s*\?\s*'center'\s*:\s*'flex-start'/.test(src),
    '根 Box 的 alignItems 必须来自 bootLayout 的 center 判定，而不是写死'
  );
  // 硬规则（[DESIGN-ARCH-134] §3.1）：清单行必须包进 flex-start 内层 Box，
  // 否则 alignItems:center 是逐子元素居中，六行 label 左边缘会参差。
  assert.ok(
    /alignItems:\s*'flex-start'/g.test(src),
    '必须有 flex-start 内层容器承载品牌块 / 节拍块'
  );
});

test('视觉：硬编码分隔线已删除', () => {
  assert.equal(
    /'─'\.repeat\(/.test(src),
    false,
    "BootScreen 不得再有 '─'.repeat(N) —— 宽度失明是 [DESIGN-ARCH-115] 登记的 D6"
  );
});

test('视觉：字标不得用仓库目录名 khy-os', () => {
  assert.equal(
    /khy-os/.test(src),
    false,
    "字标是 'khy OS'（与欢迎横幅同字面）；'khy-os' 是仓库目录名，不是产品名"
  );
});

test('视觉：进度必须来自节拍真源，不得自造', () => {
  assert.ok(/src\.progress\(\)/.test(src), '进度数据必须来自 beats.progress()');
  assert.ok(/require\('\.\/ProgressBar'\)/.test(src), '必须复用 ProgressBar，不得写第二个进度条');
  assert.ok(
    /kind:\s*'count'/.test(src),
    "进度行用 ProgressBar 的 count 档（条形 + N/M + 百分比）"
  );
  assert.ok(
    /_elapsedMsToStr/.test(src),
    '耗时格式化必须复用 bootPhaseLine 的人读时长口径，不得自写第二个'
  );
});

test('视觉：耗时文案不得暗示时间进度（六拍耗时极不均衡）', () => {
  for (const bad of ['预计剩余', '剩余时间', '已完成 50', 'eta', 'ETA']) {
    assert.equal(
      new RegExp(bad, 'i').test(src),
      false,
      `启动屏不得出现「${bad}」—— 等权百分比只对拍数成立，不构成时间预估`
    );
  }
});

test('视觉：像素必须来自共享资产，不得内联', () => {
  assert.equal(/\\u2584\\u2588/.test(src), false, '块字符像素表不得内联在渲染器里');
  assert.ok(/require\('\.\.\/logoArt'\)/.test(src), '四叶草必须来自 logoArt 单一资产');
  assert.ok(/require\('\.\.\/bootLayout'\)/.test(src), '档位必须来自 bootLayout 单一账本');
});
