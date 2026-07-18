'use strict';

/**
 * _execCompat.test.js — 非阻塞 execSync 垫片的单测(node:test)。
 *
 * 覆盖:成功 resolve stdout;非 0 退出 reject 且 .status 同形(grep 无匹配=1);命令不存在
 * reject 且 .status 非 1;**不阻塞事件循环**(execAsync 运行期间 setImmediate 仍能穿插);
 * isNonBlockingExecEnabled 默认 on / 显式 off。
 *
 * 运行:node --test services/backend/tests/tools/_execCompat.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ec = require('../../src/tools/_execCompat');

test('execAsync:退出码 0 → resolve 出 stdout', async () => {
  const out = await ec.execAsync('printf hello', { encoding: 'utf-8' });
  assert.equal(String(out), 'hello');
});

test('execAsync:未指定 encoding → 返回 Buffer(与 execSync 默认同形,shell 回退路径依赖 raw bytes)', async () => {
  const out = await ec.execAsync('printf hi', {});
  assert.equal(Buffer.isBuffer(out), true, 'encoding omitted should yield a Buffer like execSync');
  assert.equal(out.toString('utf-8'), 'hi');
});

test('execAsync:非 0 退出 → reject,.status 与 execSync 同形(exit 1 → status 1)', async () => {
  await assert.rejects(
    ec.execAsync('sh -c "exit 1"', { encoding: 'utf-8' }),
    (err) => {
      assert.equal(err.status, 1, 'exit code 1 should map to err.status === 1');
      return true;
    },
  );
});

test('execAsync:命令不存在 → reject,.status 非 1(调用方 err.status===1 分支不误命中)', async () => {
  await assert.rejects(
    ec.execAsync('this_command_does_not_exist_khy_12345', { encoding: 'utf-8' }),
    (err) => {
      assert.notEqual(err.status, 1);
      return true;
    },
  );
});

test('execAsync:不阻塞事件循环 —— 运行期间 setImmediate 能穿插执行', async () => {
  const order = [];
  // 一个短暂 sleep 的子进程;若同步阻塞,setImmediate 只能在其后执行。
  const p = ec.execAsync('sh -c "sleep 0.2; printf done"', { encoding: 'utf-8' })
    .then((out) => { order.push('exec:' + String(out)); });
  // 该回调应在子进程结束前就先跑(证明事件循环没被阻塞)。
  await new Promise((resolve) => setImmediate(() => { order.push('immediate'); resolve(); }));
  await p;
  assert.equal(order[0], 'immediate', 'setImmediate should fire before the child finishes (loop not blocked)');
  assert.equal(order[1], 'exec:done');
});

test('isNonBlockingExecEnabled:默认 on;显式 off 关', () => {
  assert.equal(ec.isNonBlockingExecEnabled({}), true);
  assert.equal(ec.isNonBlockingExecEnabled({ KHY_EXEC_NONBLOCKING: 'off' }), false);
  assert.equal(ec.isNonBlockingExecEnabled({ KHY_EXEC_NONBLOCKING: '0' }), false);
  assert.equal(ec.isNonBlockingExecEnabled({ KHY_EXEC_NONBLOCKING: 'no' }), false);
});
