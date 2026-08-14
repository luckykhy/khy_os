'use strict';

/**
 * serviceStatsSink — behavior lock for the service-stats provider sink and the
 * SCC decoupling cut it enables (node:test).
 *
 * The leaf inverts the telemetry → serviceRegistry edge ([DESIGN-ARCH-051] §6.7):
 * serviceRegistry registers its stats getter here at load; telemetry reads
 * through the leaf instead of importing the registry. Cutting that single
 * best-effort query edge splits the giant SCC (59 → 39 giant + a contained
 * 6-node orchestration fragment; total cyclic nodes 59 → 45). This suite pins
 * the sink contract, the best-effort absence semantics, the live registration
 * round-trip, and the no-phantom-edge source guard.
 */

const test = require('node:test');
const assert = require('node:assert');

test('无 provider → getServiceStats 返回 undefined（best-effort 缺省，调用方视作不可用）', () => {
  const sink = require('../../src/services/serviceStatsSink');
  sink.setServiceStatsProvider(null);          // reset to clean state
  assert.strictEqual(sink.getServiceStats(), undefined);
});

test('注册 provider 后透传其返回值', () => {
  const sink = require('../../src/services/serviceStatsSink');
  sink.setServiceStatsProvider(() => ({ total: 3, loaded: 1, errored: 0 }));
  assert.deepStrictEqual(sink.getServiceStats(), { total: 3, loaded: 1, errored: 0 });
  sink.setServiceStatsProvider(null);
});

test('provider 抛错被吞 → undefined（绝不把 best-effort 读取升级为崩溃）', () => {
  const sink = require('../../src/services/serviceStatsSink');
  sink.setServiceStatsProvider(() => { throw new Error('boom'); });
  assert.strictEqual(sink.getServiceStats(), undefined);
  sink.setServiceStatsProvider(null);
});

test('传非函数 → 清空 provider', () => {
  const sink = require('../../src/services/serviceStatsSink');
  sink.setServiceStatsProvider(() => ({ total: 9 }));
  sink.setServiceStatsProvider('not-a-fn');
  assert.strictEqual(sink.getServiceStats(), undefined);
});

test('serviceRegistry 加载即自注册为 provider → 经 sink 读到真实 stats 形状', () => {
  // 加载 registry 触发其 setServiceStatsProvider(stats) 自注册。
  require('../../src/services/serviceRegistry');
  const sink = require('../../src/services/serviceStatsSink');
  const s = sink.getServiceStats();
  assert.ok(s && typeof s === 'object', 'registry 注册后应读到对象');
  assert.strictEqual(typeof s.total, 'number');
  assert.strictEqual(typeof s.loaded, 'number');
  assert.strictEqual(typeof s.errored, 'number');
});

test('叶子零依赖（含注释也无 require 调用语法——防架构债扫描器幽灵边回退）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/serviceStatsSink.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'serviceStatsSink leaf source (incl. comments) must contain no require-call syntax');
});
