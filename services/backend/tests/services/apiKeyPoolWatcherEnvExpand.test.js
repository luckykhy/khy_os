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

describe('Api Key Pool Watcher Env Expand', () => {
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

});
