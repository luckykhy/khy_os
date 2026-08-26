'use strict';

// promptOutputGuard 单测:提问期间 console.* 入队、提问后按序补发,stdout 全程不受影响。

const test = require('node:test');
const assert = require('node:assert');

const guard = require('../../src/cli/promptOutputGuard');
const { runExclusive, isPromptActive, isEnabled, OFF_VALUES, MAX_QUEUED } = guard;

/** 捕获 console.* 的真实落地顺序(替身在 runExclusive 之外安装,模拟真实终端)。 */
function captureConsole(fn) {
  const seen = [];
  const orig = {};
  for (const m of guard.METHODS) {
    orig[m] = console[m];
    console[m] = (...args) => seen.push([m, args.join(' ')]);
  }
  const done = () => {
    for (const m of guard.METHODS) {
      console[m] = orig[m];
    }
  };
  return Promise.resolve()
    .then(() => fn(seen))
    .then((v) => { done(); return v; }, (e) => { done(); throw e; });
}

test.afterEach(() => guard._resetForTests());

// ── 门控 ──────────────────────────────────────────────────────────────────────

test('isEnabled 默认开,仅 0/false/off/no 关(大小写与空格无关)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_PROMPT_OUTPUT_GUARD: '1' }), true);
  for (const v of OFF_VALUES) {
    assert.strictEqual(isEnabled({ KHY_PROMPT_OUTPUT_GUARD: v }), false, v);
    assert.strictEqual(isEnabled({ KHY_PROMPT_OUTPUT_GUARD: ` ${v.toUpperCase()} ` }), false, v);
  }
});

test('isEnabled 不因坏 env 抛出', () => {
  assert.doesNotThrow(() => isEnabled(Object.create(null)));
  assert.strictEqual(isEnabled(Object.create(null)), true);
});

// ── 核心行为 ──────────────────────────────────────────────────────────────────

test('提问期间的 console.log 被暂存,提问返回后才落地', async () => {
  await captureConsole(async (seen) => {
    const result = await runExclusive(async () => {
      console.log('  ℹ 当前版本 v1.1.11 领先于已发布版本 v1.1.7');
      // 提问尚未返回 —— 这行绝不能已经打到屏幕上(否则 inquirer 行计数错位)
      assert.deepStrictEqual(seen, [], '提问期间不得有任何 console 输出落地');
      return 'trusted';
    }, {});
    assert.strictEqual(result, 'trusted', 'fn 的返回值必须原样透传');
    assert.deepStrictEqual(seen, [['log', '  ℹ 当前版本 v1.1.11 领先于已发布版本 v1.1.7']]);
  });
});

test('补发保持原顺序与原方法(log/info/warn/error 各归其位)', async () => {
  await captureConsole(async (seen) => {
    await runExclusive(async () => {
      console.log('first');
      console.error('second');
      console.warn('third');
      console.info('fourth');
    }, {});
    assert.deepStrictEqual(seen, [
      ['log', 'first'],
      ['error', 'second'],
      ['warn', 'third'],
      ['info', 'fourth'],
    ]);
  });
});

test('setImmediate 落进提问窗口的通知同样被暂存(git init / 任务清理的真实形态)', async () => {
  await captureConsole(async (seen) => {
    await runExclusive(async () => {
      setImmediate(() => console.log('📁 已将当前目录初始化为 Git 仓库'));
      await new Promise((r) => setImmediate(() => setImmediate(r))); // 让上面的 immediate 先跑
      assert.deepStrictEqual(seen, [], 'setImmediate 通知也必须被拦住');
    }, {});
    assert.deepStrictEqual(seen, [['log', '📁 已将当前目录初始化为 Git 仓库']]);
  });
});

test('提问抛异常时仍还原 console 并补发已暂存的通知', async () => {
  await captureConsole(async (seen) => {
    await assert.rejects(
      () => runExclusive(async () => {
        console.log('queued-before-throw');
        throw new Error('prompt exploded');
      }, {}),
      /prompt exploded/,
    );
    assert.strictEqual(isPromptActive(), false, '异常路径也必须把深度归零');
    assert.deepStrictEqual(seen, [['log', 'queued-before-throw']]);
    console.log('after');
    assert.deepStrictEqual(seen[1], ['log', 'after'], 'console 必须已还原为真实实现');
  });
});

test('嵌套提问:只有最外层补发,内层结束时不得提前吐出', async () => {
  await captureConsole(async (seen) => {
    await runExclusive(async () => {
      console.log('outer-1');
      await runExclusive(async () => {
        console.log('inner');
        assert.strictEqual(isPromptActive(), true);
      }, {});
      assert.deepStrictEqual(seen, [], '内层返回时不能补发,外层提问还占着屏幕');
      console.log('outer-2');
    }, {});
    assert.deepStrictEqual(seen, [
      ['log', 'outer-1'],
      ['log', 'inner'],
      ['log', 'outer-2'],
    ]);
  });
});

test('isPromptActive 只在提问窗口内为真', async () => {
  assert.strictEqual(isPromptActive(), false);
  await captureConsole(async () => {
    await runExclusive(async () => {
      assert.strictEqual(isPromptActive(), true);
    }, {});
  });
  assert.strictEqual(isPromptActive(), false);
});

// ── 边界 ──────────────────────────────────────────────────────────────────────

test('门控关:console 完全不被接管,通知立即落地(逐字节回退今日行为)', async () => {
  await captureConsole(async (seen) => {
    for (const v of OFF_VALUES) {
      seen.length = 0;
      await runExclusive(async () => {
        console.log('immediate');
        assert.deepStrictEqual(seen, [['log', 'immediate']], `gate off (${v}) 应立即落地`);
      }, { KHY_PROMPT_OUTPUT_GUARD: v });
    }
  });
});

test('超出暂存上限只计数不入队,补发时如实说明省略条数', async () => {
  await captureConsole(async (seen) => {
    await runExclusive(async () => {
      for (let i = 0; i < MAX_QUEUED + 5; i += 1) {
        console.log(`line-${i}`);
      }
    }, {});
    assert.strictEqual(seen.length, MAX_QUEUED + 1, '上限条 + 1 条省略说明');
    assert.strictEqual(seen[0][1], 'line-0');
    assert.strictEqual(seen[MAX_QUEUED - 1][1], `line-${MAX_QUEUED - 1}`);
    assert.match(seen[MAX_QUEUED][1], /省略 5 条通知/);
  });
});

test('非函数入参安全返回 undefined,不接管 console', async () => {
  await captureConsole(async (seen) => {
    assert.strictEqual(await runExclusive(undefined, {}), undefined);
    assert.strictEqual(await runExclusive(null, {}), undefined);
    console.log('still-live');
    assert.deepStrictEqual(seen, [['log', 'still-live']]);
  });
});

test('同步回调也受保护(不要求 fn 返回 Promise)', async () => {
  await captureConsole(async (seen) => {
    const v = await runExclusive(() => {
      console.log('sync-queued');
      return 42;
    }, {});
    assert.strictEqual(v, 42);
    assert.deepStrictEqual(seen, [['log', 'sync-queued']]);
  });
});
