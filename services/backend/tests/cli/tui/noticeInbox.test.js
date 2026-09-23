'use strict';

/**
 * noticeInbox — 会话期「外部想让用户看见的一行话」收件箱契约（BUG-17）。
 *
 * 关键不变量：**绝不静默丢弃**。`push()` 返回 false 就是「没人认领」，调用方必须回到
 * 自己的旧写入路径；返回 true 才允许调用方闭嘴。门控关 ⇒ 恒 false ⇒ 逐字节旧行为。
 */

const test = require('node:test');
const assert = require('node:assert');

const inbox = require('../../../src/cli/tui/noticeInbox');

function withFresh(fn) {
  inbox.resetForTest();
  try {
    return fn();
  } finally {
    inbox.resetForTest();
  }
}

test('N1 无订阅者 → push 返回 false（调用方须回退旧 sink），且不抛', () => {
  withFresh(() => {
    assert.strictEqual(inbox.push('[Watchdog] 事件循环曾阻塞 32.9s'), false);
  });
});

test('N2 有订阅者 → 行原样送达、push 返回 true', () => {
  withFresh(() => {
    const got = [];
    const off = inbox.subscribe((line) => {
      got.push(line);
      return true;
    });
    assert.strictEqual(inbox.push('  带空格的一行  '), true);
    assert.deepStrictEqual(got, ['带空格的一行'], '应 trim 后送达');
    off();
  });
});

test('N3 门控 KHY_WATCHDOG_NOTICE=0 → 恒不认领且不回调订阅者（字节回退旧行为）', () => {
  withFresh(() => {
    let called = 0;
    const off = inbox.subscribe(() => {
      called += 1;
      return true;
    });
    for (const raw of ['0', 'false', 'off']) {
      called = 0;
      assert.strictEqual(inbox.push('一行', { KHY_WATCHDOG_NOTICE: raw }), false, `raw=${raw}`);
      assert.strictEqual(called, 0, `raw=${raw} 时订阅者不应被调用`);
    }
    // 未设 / 其它值 → 默认开
    assert.strictEqual(inbox.push('一行', {}), true);
    assert.strictEqual(called, 1);
    off();
  });
});

test('N4 订阅者抛错视为未认领；后续订阅者仍有机会，全失败则 push 返回 false', () => {
  withFresh(() => {
    const off1 = inbox.subscribe(() => {
      throw new Error('boom');
    });
    assert.strictEqual(inbox.push('一行'), false, '唯一订阅者抛错 ⇒ 未认领');
    off1();
    const got = [];
    const offBad = inbox.subscribe(() => {
      throw new Error('boom');
    });
    const offGood = inbox.subscribe((line) => {
      got.push(line);
      return true;
    });
    assert.strictEqual(inbox.push('一行'), true, '一个订阅者失败不影响其它');
    assert.deepStrictEqual(got, ['一行']);
    offBad();
    offGood();
  });
});

test('N5 订阅者显式拒收（返回 false，例如已卸载）→ push 返回 false', () => {
  withFresh(() => {
    const off = inbox.subscribe(() => false);
    assert.strictEqual(inbox.push('一行'), false);
    off();
  });
});

test('N6 退订后回到「无人认领」', () => {
  withFresh(() => {
    const off = inbox.subscribe(() => true);
    assert.strictEqual(inbox.push('一行'), true);
    off();
    assert.strictEqual(inbox.push('一行'), false);
  });
});

test('N7 空行 / 非字符串垃圾 → 不认领（避免 transcript 出现空 notice）', () => {
  withFresh(() => {
    let called = 0;
    const off = inbox.subscribe(() => {
      called += 1;
      return true;
    });
    for (const junk of ['', '   ', null, undefined]) {
      assert.strictEqual(inbox.push(junk), false, JSON.stringify(junk));
    }
    assert.strictEqual(called, 0);
    // 数字 0 是「有内容」的边界：转字符串后仍非空才认领
    assert.strictEqual(inbox.push(0), true);
    assert.strictEqual(called, 1);
    off();
  });
});

test('N8 subscribe 传非函数 → 拿到可用的空退订，不抛', () => {
  withFresh(() => {
    const off = inbox.subscribe(null);
    assert.strictEqual(typeof off, 'function');
    assert.strictEqual(off(), false);
    assert.strictEqual(inbox.push('一行'), false);
  });
});
