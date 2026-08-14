'use strict';

/**
 * opencodeBinResolver 单测(node:test)。
 *
 * 复现症状:opencode 便携装在 <repo>/tools/opencode-portable/node_modules/opencode-ai/bin/
 * 不在 PATH,khy 探测失败乱找目录。断言:
 *   - KHY_OPENCODE_BIN 显式覆盖(存在→绝对路径;不存在→尊重意图原样返回);
 *   - 便携约定命中(KHY_TOOLS_DIR 或 cwd 上溯)→ 返回绝对路径;
 *   - 全落空 → 裸命令 'opencode';
 *   - 门 KHY_OPENCODE_BIN_DISCOVERY=off → 恒 'opencode'(逐字节回退);
 *   - fail-soft:坏 env 不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../../../../src/services/gateway/adapters/opencodeBinResolver');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-${prefix}-`));
}

function binName() {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

/** 在 <root>/tools/opencode-portable/node_modules/opencode-ai/bin/ 建假可执行文件。 */
function makePortable(root) {
  const binDir = path.join(root, 'tools', 'opencode-portable', 'node_modules', 'opencode-ai', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, binName());
  fs.writeFileSync(bin, '#!/bin/sh\n');
  return bin;
}

test('KHY_OPENCODE_BIN 显式覆盖:存在 → 绝对路径', () => {
  const dir = mkTmp('ocbin-explicit');
  const bin = path.join(dir, 'my-opencode');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const got = R.resolveOpencodeBin({ KHY_OPENCODE_BIN: bin }, dir);
  assert.equal(got, path.resolve(bin));
});

test('KHY_OPENCODE_BIN 不存在:尊重用户意图原样返回(让上游报清晰错误)', () => {
  const got = R.resolveOpencodeBin({ KHY_OPENCODE_BIN: '/no/such/opencode' }, '/tmp');
  assert.equal(got, '/no/such/opencode');
});

test('便携约定:cwd 在 repo 内 → 上溯命中 tools/opencode-portable', () => {
  const root = mkTmp('ocbin-portable');
  const bin = makePortable(root);
  const deepCwd = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(deepCwd, { recursive: true });
  const got = R.resolveOpencodeBin({}, deepCwd);
  assert.equal(got, bin);
  assert.equal(R.isResolvedToPortable({}, deepCwd), true);
});

test('便携约定:KHY_TOOLS_DIR 指向 tools/ → 命中其下便携安装', () => {
  const root = mkTmp('ocbin-toolsdir');
  const bin = makePortable(root);
  const env = { KHY_TOOLS_DIR: path.join(root, 'tools') };
  const got = R.resolveOpencodeBin(env, '/tmp'); // cwd 无关,靠 KHY_TOOLS_DIR
  assert.equal(got, bin);
});

test('全落空 → 裸命令 opencode', () => {
  const dir = mkTmp('ocbin-none');
  const got = R.resolveOpencodeBin({}, dir);
  assert.equal(got, R.BARE);
  assert.equal(got, 'opencode');
  assert.equal(R.isResolvedToPortable({}, dir), false);
});

test('门控 KHY_OPENCODE_BIN_DISCOVERY=off:恒裸命令(逐字节回退)', () => {
  const root = mkTmp('ocbin-gateoff');
  makePortable(root); // 即便便携存在,关门也不认
  const env = { KHY_OPENCODE_BIN_DISCOVERY: 'off' };
  assert.equal(R.resolveOpencodeBin(env, root), 'opencode');
  assert.equal(R.isDiscoveryEnabled(env), false);
  assert.equal(R.isDiscoveryEnabled({}), true);
});

test('fail-soft:坏 env / 坏 cwd 不抛', () => {
  assert.doesNotThrow(() => R.resolveOpencodeBin(null, null));
  assert.doesNotThrow(() => R.resolveOpencodeBin(undefined, undefined));
  assert.doesNotThrow(() => R.resolveOpencodeBin({ KHY_OPENCODE_BIN: 42 }, {}));
});
