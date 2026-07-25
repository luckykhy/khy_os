'use strict';

/**
 * rtkEffectiveState 纯叶子单测 —— RTK「真实生效状态」诚实对账。
 *
 * 覆盖:
 *   · resolveEffectiveState 三态语义(active / pending-install / off),尤其
 *     mode-on 但没装的关键诚实档必须 status='pending-install' + effective=false +
 *     标签明说「未生效」并提到原生兜底,绝不显示为「已启用」;
 *   · describeEffectiveState 门控:开 → 返回对账态;关(KHY_RTK_EFFECTIVE_STATE
 *     ∈ {0,false,off,no})→ 返回 null(调用方逐字节回退旧渲染);
 *   · autoInstall 影响 pending-install 档的 hint 措辞;
 *   · 绝不抛(坏输入 → 安全默认)。
 *
 * node:test(非 jest)。运行:`node --test tests/rtkEffectiveState.test.js`。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const rtkEff = require('../src/services/rtkEffectiveState');

const ENV_KEYS = ['KHY_RTK_EFFECTIVE_STATE', 'KHY_FLAG_REGISTRY'];
let _savedEnv;

beforeEach(() => {
  _savedEnv = {};
  for (const k of ENV_KEYS) _savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (_savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = _savedEnv[k];
  }
});

describe('resolveEffectiveState — 三态对账', () => {
  test('mode && installed → active(已启用并生效)', () => {
    const r = rtkEff.resolveEffectiveState({ mode: true, installed: true, autoInstall: true });
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.effective, true);
    assert.match(r.label, /生效/);
    assert.match(r.hint, /gain/);
  });

  test('mode && !installed → pending-install(关键诚实档:开着但没装=未生效)', () => {
    const r = rtkEff.resolveEffectiveState({ mode: true, installed: false, autoInstall: true });
    assert.strictEqual(r.status, 'pending-install');
    assert.strictEqual(r.effective, false);
    // 绝不显示为「已启用并生效」——必须显式说未生效。
    assert.match(r.label, /未生效/);
    // 必须说清仍有原生兜底(token 仍在压)。
    assert.match(r.label, /smartTruncation|原生/);
    // 引导安装。
    assert.match(r.hint, /rtk install/);
  });

  test('!mode → off(已关闭)', () => {
    const r = rtkEff.resolveEffectiveState({ mode: false, installed: false, autoInstall: false });
    assert.strictEqual(r.status, 'off');
    assert.strictEqual(r.effective, false);
    assert.match(r.label, /已关闭/);
  });

  test('!mode 但已装 → 仍 off,但标签点明二进制已装只是模式被关', () => {
    const r = rtkEff.resolveEffectiveState({ mode: false, installed: true, autoInstall: false });
    assert.strictEqual(r.status, 'off');
    assert.strictEqual(r.effective, false);
    assert.match(r.label, /已安装|已装|被关/);
  });

  test('pending-install 的 hint 随 autoInstall 措辞不同', () => {
    const on = rtkEff.resolveEffectiveState({ mode: true, installed: false, autoInstall: true });
    const off = rtkEff.resolveEffectiveState({ mode: true, installed: false, autoInstall: false });
    assert.match(on.hint, /自动安装/);
    assert.match(off.hint, /自动安装当前关闭|KHY_RTK_AUTO_INSTALL/);
    assert.notStrictEqual(on.hint, off.hint);
  });

  test('缺参 / 坏输入 → 安全默认(全 false 视角),绝不抛', () => {
    assert.doesNotThrow(() => rtkEff.resolveEffectiveState());
    const r = rtkEff.resolveEffectiveState({});
    assert.strictEqual(r.mode, false);
    assert.strictEqual(r.installed, false);
    assert.strictEqual(r.status, 'off');
    // 非布尔真值(如字符串 'true')按 !== true 视为 false —— 严格布尔契约。
    const s = rtkEff.resolveEffectiveState({ mode: 'true', installed: 1 });
    assert.strictEqual(s.mode, false);
    assert.strictEqual(s.installed, false);
  });
});

describe('describeEffectiveState — 门控', () => {
  test('门控开(默认)→ 返回对账态', () => {
    const r = rtkEff.describeEffectiveState({ mode: true, installed: true }, {});
    assert.ok(r);
    assert.strictEqual(r.status, 'active');
  });

  test('门控关(off / false / 0 / no)→ 返回 null(逐字节回退旧渲染)', () => {
    for (const v of ['off', 'false', '0', 'no', 'OFF', 'False']) {
      const r = rtkEff.describeEffectiveState(
        { mode: true, installed: false },
        { KHY_RTK_EFFECTIVE_STATE: v }
      );
      assert.strictEqual(r, null, `KHY_RTK_EFFECTIVE_STATE=${v} 应回退 null`);
    }
  });

  test('门控其它值(true/1/未设)→ 视为开', () => {
    for (const env of [{}, { KHY_RTK_EFFECTIVE_STATE: 'true' }, { KHY_RTK_EFFECTIVE_STATE: '1' }]) {
      const r = rtkEff.describeEffectiveState({ mode: false }, env);
      assert.ok(r, `env=${JSON.stringify(env)} 应返回对账态`);
      assert.strictEqual(r.status, 'off');
    }
  });

  test('绝不抛:坏 env / 坏 input → null 或安全对账态', () => {
    assert.doesNotThrow(() => rtkEff.describeEffectiveState(null, null));
    assert.doesNotThrow(() => rtkEff.describeEffectiveState(undefined, undefined));
  });
});

describe('isEnabled — 与 flagRegistry 一致', () => {
  test('默认开', () => {
    assert.strictEqual(rtkEff.isEnabled({}), true);
  });
  test('CANON 关闭词', () => {
    assert.strictEqual(rtkEff.isEnabled({ KHY_RTK_EFFECTIVE_STATE: 'off' }), false);
    assert.strictEqual(rtkEff.isEnabled({ KHY_RTK_EFFECTIVE_STATE: 'no' }), false);
  });
});
