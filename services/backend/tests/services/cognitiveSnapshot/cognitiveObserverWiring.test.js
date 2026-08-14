'use strict';

/**
 * cognitiveObserverWiring.test.js — cognitiveSnapshot → toolUseLoop observe-mode 接线验收。
 *
 * 闭合 weak_model_delivery_unlock 记忆的「4 未接线引擎」之一（cognitiveSnapshot）。
 * 验证 maybeAttachCognitiveObserver 的接线契约：
 *   ① 默认关闭 → 返回 null（主循环零行为变化）；
 *   ② 环境变量 KHY_COGNITIVE_SNAPSHOT=1 / options.cognitiveSnapshot.enabled=true → 启用；
 *   ③ options.cognitiveSnapshot.enabled=false 单次关闭优先于 env；
 *   ④ observe() 用真实 token 估算驱动 beforeStep，绝不抛进主循环（fail-soft）；
 *   ⑤ observe() 是纯计算/观测：不产生持久化快照（零磁盘副作用）。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// 持久化引到独立临时数据家目录，便于断言「observe 不落盘」。须在 require 引擎前设置。
const TMP_HOME = path.join(os.tmpdir(), `khy-cogobs-wiring-${process.pid}`);
process.env.KHY_DATA_HOME = TMP_HOME;

const { describe, test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { maybeAttachCognitiveObserver } = require('../../../src/services/toolUseLoop');

function clearEnv() {
  delete process.env.KHY_COGNITIVE_SNAPSHOT;
}

afterEach(clearEnv);
after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('cognitiveSnapshot observe-mode 接线契约', () => {
  test('① 默认关闭（无 env、无 options）→ 返回 null', () => {
    clearEnv();
    assert.equal(maybeAttachCognitiveObserver('build a thing', {}), null);
    assert.equal(maybeAttachCognitiveObserver('build a thing', { cognitiveSnapshot: {} }), null);
  });

  test('② KHY_COGNITIVE_SNAPSHOT=1 → 启用，返回带 observe 的对象', () => {
    process.env.KHY_COGNITIVE_SNAPSHOT = '1';
    const obs = maybeAttachCognitiveObserver('ultimate goal text', { sessionId: 's1' });
    assert.ok(obs, 'env=1 应启用');
    assert.equal(typeof obs.observe, 'function');
  });

  test('② on/true 同样启用', () => {
    process.env.KHY_COGNITIVE_SNAPSHOT = 'on';
    assert.ok(maybeAttachCognitiveObserver('g', { sessionId: 's' }));
    process.env.KHY_COGNITIVE_SNAPSHOT = 'true';
    assert.ok(maybeAttachCognitiveObserver('g', { sessionId: 's' }));
  });

  test('② options.cognitiveSnapshot.enabled=true 启用（无需 env）', () => {
    clearEnv();
    const obs = maybeAttachCognitiveObserver('g', { cognitiveSnapshot: { enabled: true, taskId: 't1' } });
    assert.ok(obs);
  });

  test('③ options.enabled=false 单次关闭优先于 env=1', () => {
    process.env.KHY_COGNITIVE_SNAPSHOT = '1';
    const obs = maybeAttachCognitiveObserver('g', { cognitiveSnapshot: { enabled: false } });
    assert.equal(obs, null, 'enabled:false 必须压过 env');
  });

  test('④ observe() 用真实 token 估算驱动 beforeStep，返回裁决且不抛', () => {
    process.env.KHY_COGNITIVE_SNAPSHOT = '1';
    const obs = maybeAttachCognitiveObserver('the ultimate goal', { sessionId: 's-verdict' });
    // 低占用：放行
    const lo = obs.observe({ iteration: 1, usedTokens: 100, contextWindow: 100000 });
    assert.ok(lo, '应返回前置闸门裁决');
    assert.equal(lo.allow, true, '低占用应放行');
    // 高占用（>80%）：闸门转压缩/卸载（allow=false），但仅观测、绝不阻断主循环
    const hi = obs.observe({ iteration: 2, usedTokens: 95000, contextWindow: 100000 });
    assert.ok(hi);
    assert.equal(hi.allow, false, '越 80% 应触发熔断裁决');
  });

  test('④ observe() 对脏输入 fail-soft（绝不抛）', () => {
    process.env.KHY_COGNITIVE_SNAPSHOT = '1';
    const obs = maybeAttachCognitiveObserver('g', { sessionId: 's-dirty' });
    assert.doesNotThrow(() => obs.observe());
    assert.doesNotThrow(() => obs.observe({ usedTokens: 'NaN', contextWindow: -1 }));
    assert.doesNotThrow(() => obs.observe({ iteration: null, usedTokens: undefined }));
  });

  test('⑤ observe() 零磁盘副作用：不写任何快照', () => {
    process.env.KHY_COGNITIVE_SNAPSHOT = '1';
    const obs = maybeAttachCognitiveObserver('g', { sessionId: 's-nodisk' });
    obs.observe({ iteration: 1, usedTokens: 90000, contextWindow: 100000 });
    obs.observe({ iteration: 2, usedTokens: 99000, contextWindow: 100000 });
    // observe 只跑 beforeStep（preflight 纯计算），不调用 commitStep/persist。
    // 因此即便高占用，也不应产生持久化快照文件。
    let snapFiles = [];
    try {
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/snapshot|\.snap|cogsnap/i.test(e.name)) snapFiles.push(p);
        }
      };
      if (fs.existsSync(TMP_HOME)) walk(TMP_HOME);
    } catch { /* dir may not exist — that's the expected no-op case */ }
    assert.equal(snapFiles.length, 0, `observe 不应落盘，但发现: ${snapFiles.join(', ')}`);
  });
});
