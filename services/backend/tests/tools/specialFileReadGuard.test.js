'use strict';

/**
 * Unit tests for specialFileReadGuard.js — the pure leaf that lets tools/readFile.js
 * refuse会永久阻塞的特殊文件(FIFO / socket / char-device / block-device)读前拦下,
 * 而非在 detectFile()/readTextFileSmart 里挂死(run via `node --test`).
 *
 * 全部用鸭子类型的 fake stat(暴露 isFIFO 等谓词方法),不需真建 FIFO/设备,故确定性。
 * 覆盖:
 *   - 门控 specialReadGuardEnabled:默认开;env ∈ {0,false,off,no}(含大小写/空白)→ 关。
 *   - classifySpecialFile:fifo/socket/char/block 各正确分类;常规文件/目录/畸形 → null。
 *   - buildSpecialFileRefusal:点明类型 + 逃生门,畸形入参不抛。
 *   - 绝不抛(谓词抛错/缺失 → 视为不匹配)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const G = require('../../src/tools/specialFileReadGuard');

// 构造暴露指定为 true 的谓词的 fake stat。
function fakeStat(trueKind) {
  const kinds = ['isFIFO', 'isSocket', 'isCharacterDevice', 'isBlockDevice', 'isDirectory', 'isFile'];
  const st = {};
  for (const k of kinds) st[k] = () => k === trueKind;
  return st;
}

// ── 门控 ────────────────────────────────────────────────────────────────────
test('门控默认开(未设 env)', () => {
  assert.strictEqual(G.specialReadGuardEnabled({}), true);
  assert.strictEqual(G.specialReadGuardEnabled({ KHY_READFILE_SPECIAL_GUARD: undefined }), true);
});

test('门控 env ∈ {0,false,off,no}(含大小写/空白)→ 关', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False', 'No']) {
    assert.strictEqual(G.specialReadGuardEnabled({ KHY_READFILE_SPECIAL_GUARD: v }), false, `env='${v}' 应关`);
  }
});

test('门控其它值 → 开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.strictEqual(G.specialReadGuardEnabled({ KHY_READFILE_SPECIAL_GUARD: v }), true, `env='${v}' 应开`);
  }
});

// ── classifySpecialFile ──────────────────────────────────────────────────────
test('classifySpecialFile:FIFO → fifo', () => {
  assert.strictEqual(G.classifySpecialFile(fakeStat('isFIFO')), 'fifo');
});

test('classifySpecialFile:套接字 → socket', () => {
  assert.strictEqual(G.classifySpecialFile(fakeStat('isSocket')), 'socket');
});

test('classifySpecialFile:字符设备 → char-device', () => {
  assert.strictEqual(G.classifySpecialFile(fakeStat('isCharacterDevice')), 'char-device');
});

test('classifySpecialFile:块设备 → block-device', () => {
  assert.strictEqual(G.classifySpecialFile(fakeStat('isBlockDevice')), 'block-device');
});

test('classifySpecialFile:常规文件 → null(放行)', () => {
  assert.strictEqual(G.classifySpecialFile(fakeStat('isFile')), null);
});

test('classifySpecialFile:目录 → null(readFile 有专门特判,本叶不接管)', () => {
  assert.strictEqual(G.classifySpecialFile(fakeStat('isDirectory')), null);
});

test('classifySpecialFile:目录优先于其它谓词(即使 isFIFO 也 true 也返回 null)', () => {
  // 防御:某些平台上元数据异常时不误判目录为 FIFO。
  const weird = { isDirectory: () => true, isFIFO: () => true, isSocket: () => false, isCharacterDevice: () => false, isBlockDevice: () => false };
  assert.strictEqual(G.classifySpecialFile(weird), null);
});

test('classifySpecialFile:畸形入参(null/非对象/缺谓词/谓词抛错)→ null,不抛', () => {
  assert.strictEqual(G.classifySpecialFile(null), null);
  assert.strictEqual(G.classifySpecialFile(undefined), null);
  assert.strictEqual(G.classifySpecialFile('x'), null);
  assert.strictEqual(G.classifySpecialFile(42), null);
  assert.strictEqual(G.classifySpecialFile({}), null); // 谓词缺失
  assert.strictEqual(G.classifySpecialFile({ isFIFO: 'notfn' }), null); // 谓词非函数
  assert.strictEqual(G.classifySpecialFile({ isFIFO: () => { throw new Error('boom'); } }), null); // 谓词抛错
});

// ── buildSpecialFileRefusal ──────────────────────────────────────────────────
test('拒绝消息:FIFO 点明类型 + 永久阻塞 + 逃生门', () => {
  const msg = G.buildSpecialFileRefusal({ kind: 'fifo', path: '/tmp/p.pipe' });
  assert.match(msg, /命名管道（FIFO）/);
  assert.match(msg, /\/tmp\/p\.pipe/);
  assert.match(msg, /永久阻塞/);
  assert.match(msg, /KHY_READFILE_SPECIAL_GUARD=0/);
});

test('拒绝消息:块设备走大小分支', () => {
  const msg = G.buildSpecialFileRefusal({ kind: 'block-device', path: '/dev/sda', size: 1024 });
  assert.match(msg, /块设备/);
  assert.match(msg, /\/dev\/sda/);
});

test('拒绝消息:未知 kind → 泛化「特殊文件」,不抛', () => {
  const msg = G.buildSpecialFileRefusal({ kind: 'weird', path: '/x' });
  assert.match(msg, /特殊文件/);
});

test('拒绝消息:畸形入参(null/非对象/无 path)不抛', () => {
  for (const arg of [null, undefined, 'x', 42, {}]) {
    let msg;
    assert.doesNotThrow(() => { msg = G.buildSpecialFileRefusal(arg); });
    assert.strictEqual(typeof msg, 'string');
    assert.ok(msg.length > 0);
  }
});
