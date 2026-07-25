'use strict';

/**
 * resolveGatewayEnvPaths.test.js — 锁 utils/resolveGatewayEnvPaths 口径
 *   (收敛 5 处 .env 目标解析 helper 的护栏)。
 *   非纯:经 process.env(KHY_ENV_FILE / KHY_ENV_SYNC_ROOT)驱动·用临时文件探测 fs 分支。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const resolveGatewayEnvPaths = require('../src/utils/resolveGatewayEnvPaths');

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('KHY_ENV_FILE 覆盖 → canonical = resolve(该路径)', () => {
  withEnv({ KHY_ENV_FILE: '/tmp/custom-khy.env', KHY_ENV_SYNC_ROOT: 'false' }, () => {
    const { canonicalPath, targets } = resolveGatewayEnvPaths();
    assert.strictEqual(canonicalPath, path.resolve('/tmp/custom-khy.env'));
    assert.deepStrictEqual(targets, [canonicalPath]);
  });
});

test('KHY_ENV_SYNC_ROOT=false → 只含 canonical(不追加 mirror)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyenv-'));
  const envFile = path.join(tmp, '.env');
  fs.writeFileSync(envFile, 'A=1\n');
  try {
    withEnv({ KHY_ENV_FILE: envFile, KHY_ENV_SYNC_ROOT: 'false' }, () => {
      const { targets } = resolveGatewayEnvPaths();
      assert.strictEqual(targets.length, 1);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('返回新对象/新数组 (不 mutate·每次全新)', () => {
  withEnv({ KHY_ENV_FILE: '/tmp/a.env', KHY_ENV_SYNC_ROOT: 'false' }, () => {
    const a = resolveGatewayEnvPaths();
    const b = resolveGatewayEnvPaths();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.targets, b.targets);
    assert.deepStrictEqual(a, b);
  });
});

test('canonical 恒为 targets 首元素', () => {
  withEnv({ KHY_ENV_FILE: '/tmp/z.env' }, () => {
    const { canonicalPath, targets } = resolveGatewayEnvPaths();
    assert.strictEqual(targets[0], canonicalPath);
  });
});

test('逐输入等价原体(经 KHY_ENV_FILE 分支·__dirname 无关)', () => {
  const ref = () => {
    const canonicalPath = process.env.KHY_ENV_FILE
      ? path.resolve(process.env.KHY_ENV_FILE)
      : path.resolve(__dirname, '../../.env');
    const mirrorPath = path.resolve(__dirname, '../../../.env');
    const syncMirror = String(process.env.KHY_ENV_SYNC_ROOT || 'true').toLowerCase() !== 'false';
    const targets = [canonicalPath];
    if (syncMirror && mirrorPath !== canonicalPath && (fs.existsSync(mirrorPath) || fs.existsSync(canonicalPath))) {
      targets.push(mirrorPath);
    }
    return { canonicalPath, targets };
  };
  // 注:ref 与被测 util 位于不同目录,__dirname 相对分支不可比;
  //   故仅在 KHY_ENV_FILE 覆盖(绕开 __dirname)且 SYNC_ROOT=false(绕开 mirror)下比对 canonical。
  withEnv({ KHY_ENV_FILE: '/tmp/parity.env', KHY_ENV_SYNC_ROOT: 'false' }, () => {
    assert.strictEqual(resolveGatewayEnvPaths().canonicalPath, ref().canonicalPath);
  });
});
