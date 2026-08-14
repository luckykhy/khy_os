'use strict';

/**
 * apiKeyPoolWatcher 的 .env 热覆盖:`{env:VAR}` 必须在写进 process.env 前展开。
 *
 * 这条回归针对一个**只在编辑 .env 之后才发作**的故障:启动时 bootstrap/init 已经把
 * `RELAY_API_KEY={env:STEPFUN_API_KEY}` 展开成了真 key,进程跑得好好的;此后任何一次
 * .env 变动都会让 watcher 把磁盘上的**原始占位符**重新覆盖回去,于是每个 relay 请求都
 * 变成 `Bearer {env:STEPFUN_API_KEY}` → 401。故障比那次编辑活得久,日志里也没有任何东西
 * 把两者联系起来,看上去就像「我的 API key 突然失效了」。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { __testHooks } = require('../../src/services/apiKeyPoolWatcher');
const { overlayEnvFile } = __testHooks;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-keypool-env-'));

/** 写一个临时 .env,返回路径。 */
function writeEnv(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body);
  return p;
}

/** 跑一次覆盖,结束后把动过的 env 变量恢复原状。 */
function withEnv(seed, fn) {
  const touched = new Set([...Object.keys(seed)]);
  const saved = new Map();
  for (const k of touched) saved.set(k, process.env[k]);
  // 注意:不能 Object.assign —— 给 process.env 赋 undefined 会存成**字符串** 'undefined',
  // 于是「这个变量不存在」的场景反而变成了「它有值」,测试就测不到真实分支了。
  for (const [k, v] of Object.entries(seed)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn((k) => {
      touched.add(k);
      if (!saved.has(k)) saved.set(k, process.env[k]);
      return process.env[k];
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('{env:VAR} 在覆盖前被展开 —— 而不是把占位符原样塞进 process.env', () => {
  const envPath = writeEnv('a.env', [
    'STEPFUN_API_KEY=sk-real-stepfun-key',
    'RELAY_API_KEY={env:STEPFUN_API_KEY}',
  ].join('\n'));

  withEnv({ RELAY_API_KEY: undefined, STEPFUN_API_KEY: undefined }, (read) => {
    overlayEnvFile(envPath);
    assert.strictEqual(read('RELAY_API_KEY'), 'sk-real-stepfun-key',
      '占位符必须展开;原样覆盖会让每个 relay 请求 401');
  });
});

test('启动时已展开的值,不会被后续 .env 编辑打回占位符(本 bug 的真实形态)', () => {
  const envPath = writeEnv('b.env', [
    'STEPFUN_API_KEY=sk-real-stepfun-key',
    'RELAY_API_KEY={env:STEPFUN_API_KEY}',
    'RELAY_API_ENDPOINT=https://api.stepfun.com/step_plan/v1',
  ].join('\n'));

  // 模拟真实时序:bootstrap/init 已经展开过,进程里是真 key。
  withEnv({
    RELAY_API_KEY: 'sk-real-stepfun-key',
    STEPFUN_API_KEY: 'sk-real-stepfun-key',
  }, (read) => {
    overlayEnvFile(envPath);           // ← 用户改了 .env,watcher 触发
    assert.ok(!String(read('RELAY_API_KEY')).includes('{env:'),
      '热重载绝不能把已解析的凭据打回占位符');
    assert.strictEqual(read('RELAY_API_KEY'), 'sk-real-stepfun-key');
  });
});

test('占位符指向只存在于 process.env 的变量(shell export / ~/.khy/.env)也能解', () => {
  // 引用目标**不在**这个文件里 —— 只按 parsed 解会解不出来。
  const envPath = writeEnv('c.env', 'RELAY_API_KEY={env:SHELL_ONLY_API_KEY}\n');

  withEnv({ RELAY_API_KEY: undefined, SHELL_ONLY_API_KEY: 'sk-from-shell' }, (read) => {
    overlayEnvFile(envPath);
    assert.strictEqual(read('RELAY_API_KEY'), 'sk-from-shell',
      '必须按合并视图解析,不能只看当前文件');
  });
});

test('解不开的引用保持原样,不被清空 —— 错得显眼好过静默变成「没配 key」', () => {
  const envPath = writeEnv('d.env', 'RELAY_API_KEY={env:NOT_DEFINED_ANYWHERE}\n');

  withEnv({ RELAY_API_KEY: undefined, NOT_DEFINED_ANYWHERE: undefined }, (read) => {
    overlayEnvFile(envPath);
    assert.strictEqual(read('RELAY_API_KEY'), '{env:NOT_DEFINED_ANYWHERE}',
      '留着占位符才能一眼看出是引用没解开;空字符串会被读成「未配置」');
  });
});

test('普通值与 endpoint 照旧覆盖;非 key 形状的变量一律不碰', () => {
  const envPath = writeEnv('e.env', [
    'RELAY_API_KEY=sk-plain',
    'RELAY_API_ENDPOINT=https://example.test/v1',
    'SOME_UNRELATED_SETTING=changed',
  ].join('\n'));

  withEnv({
    RELAY_API_KEY: undefined,
    RELAY_API_ENDPOINT: undefined,
    SOME_UNRELATED_SETTING: 'original',
  }, (read) => {
    const applied = overlayEnvFile(envPath);
    assert.strictEqual(read('RELAY_API_KEY'), 'sk-plain');
    assert.strictEqual(read('RELAY_API_ENDPOINT'), 'https://example.test/v1');
    assert.strictEqual(read('SOME_UNRELATED_SETTING'), 'original',
      'watcher 只负责 key/endpoint 形状的变量,不该顺手改别的配置');
    assert.strictEqual(applied, 2, '应只报告真正改动的条数');
  });
});

test('文件不存在 / 内容为空:返回 0 且不抛', () => {
  assert.strictEqual(overlayEnvFile(path.join(TMP, 'nope.env')), 0);
  assert.strictEqual(overlayEnvFile(writeEnv('empty.env', '')), 0);
});
