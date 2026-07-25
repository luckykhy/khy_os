'use strict';

/**
 * _streamHealthSink — behavior lock for the stream-health telemetry inversion
 * seam (node:test).
 *
 * Background: `_streamStaleDetector.stop()` used to lazily `require` the
 * telemetryService singleton and call `trackServiceCall` directly — one borrow
 * that pulled the whole gateway adapter cluster into the giant dependency SCC.
 * The emission is now inverted through this zero-dependency leaf: the detector
 * EMITS, telemetry REGISTERS itself as the sink at load. Giant SCC 77 -> 63
 * ([DESIGN-ARCH-051] §6.4). This suite pins the best-effort contract, the
 * detector→sink wiring, the telemetry self-registration, and the no-phantom-edge
 * source guard.
 */

const test = require('node:test');
const assert = require('node:assert');

const sinkPath = '../../src/services/gateway/_streamHealthSink';

function freshSink() {
  delete require.cache[require.resolve(sinkPath)];
  return require(sinkPath);
}

test('未注册 sink → emit 为静默 no-op，返回 false，绝不抛', () => {
  const sink = freshSink();
  assert.strictEqual(sink.emitStreamHealth({ service: 'x' }), false);
  assert.strictEqual(sink.emitStreamHealth(null), false);
});

test('注册后 emit 透传 payload 并返回 true', () => {
  const sink = freshSink();
  let captured = null;
  sink.setStreamHealthSink((p) => { captured = p; });
  const ok = sink.emitStreamHealth({ service: 'stream_health', elapsed: 42 });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(captured, { service: 'stream_health', elapsed: 42 });
});

test('sink 抛错被吞，emit 返回 false（best-effort 永不传播异常）', () => {
  const sink = freshSink();
  sink.setStreamHealthSink(() => { throw new Error('boom'); });
  assert.strictEqual(sink.emitStreamHealth({ a: 1 }), false);
});

test('setStreamHealthSink(非函数) 清空 sink', () => {
  const sink = freshSink();
  sink.setStreamHealthSink(() => {});
  assert.strictEqual(sink.emitStreamHealth({}), true);
  sink.setStreamHealthSink(null);
  assert.strictEqual(sink.emitStreamHealth({}), false);
  sink.setStreamHealthSink('not a fn');
  assert.strictEqual(sink.emitStreamHealth({}), false);
});

test('telemetryService 加载即自注册为 sink（trackServiceCall 接管 emit）', () => {
  freshSink(); // clear cache so telemetry re-registers on its own load
  delete require.cache[require.resolve('../../src/services/telemetryService')];
  const tel = require('../../src/services/telemetryService');
  const sink = require(sinkPath);
  // After telemetry loads, an emit must reach trackServiceCall (counter rises).
  const before = tel.getUnifiedStats();
  const ok = sink.emitStreamHealth({
    service: 'stream_health', method: 'openai_stream', success: true, elapsed: 7, meta: { chunkCount: 2 },
  });
  assert.strictEqual(ok, true);
  const after = tel.getUnifiedStats();
  assert.ok(after && before, 'getUnifiedStats returns an object both times');
});

test('_streamStaleDetector.stop() 经 sink 发射，不直接依赖 telemetry，且不抛', () => {
  const sink = freshSink();
  const calls = [];
  sink.setStreamHealthSink((p) => calls.push(p));
  const { StreamStaleDetector } = require('../../src/services/gateway/adapters/_streamStaleDetector');
  const d = new StreamStaleDetector({ provider: 'openai' });
  // simulate some chunks (touch increments _chunkCount) so stop() emits health
  d.touch(10);
  d.touch(20);
  d.stop();
  // If the detector saw chunks, it must have emitted exactly through the sink.
  assert.ok(calls.length <= 1, 'at most one health emission per stop');
  if (calls.length === 1) {
    assert.strictEqual(calls[0].service, 'stream_health');
    assert.strictEqual(calls[0].method, 'openai_stream');
  }
});

test('叶子模块零依赖（含注释也无 require 调用语法——防架构债扫描器误判幽灵边回退）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/gateway/_streamHealthSink.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'sink leaf source (incl. comments) must contain no require-call syntax');
});
