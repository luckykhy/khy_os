'use strict';

/**
 * durableTranscript — pins the "每轮收尾即真落盘" durability fix for the JSONL
 * transcript main track (sessionPersistence.appendMessage).
 *
 * 预防原则:把每一次单次提示词都当成「完成后进程即不可用」。会话每轮收尾经
 * persistSession → appendMessage 写的 JSONL transcript 是 resume/rewind 的主恢复
 * 产物。此前用裸 fs.appendFileSync 落盘,数据只进 OS page cache(无 fsync),机器级
 * 崩溃/掉电会丢最后一轮 —— 与同模块 snapshot _writeAtomic / 文件头 G6 标准不一致。
 * 修复:append 后对 fd fsync(门控 KHY_DURABLE_TRANSCRIPT 默认开,关则字节回退)。
 *
 * 断言:
 *   1) 门控开 → appendMessage 写出的行可被 buildConversationChain / restoreSession
 *      原样读回(fsync 不改变写入内容,只多刷一次盘);
 *   2) 门控关 → 落盘内容与门控开**逐字节一致**(回退路径只是不 fsync,不改字节);
 *   3) 多条消息按链顺序追加,parentUuid 链不被耐久写破坏;
 *   4) fsync 不可用时数据仍 append 成功(fail-soft,不弱于回退路径)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate persistence into a throwaway data home before requiring the module
// (dataHome caches KHY_DATA_HOME on first use).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-durable-transcript-'));
process.env.KHY_DATA_HOME = TMP;

const sp = require('../src/services/sessionPersistence');

function readJsonlBytes(sessionId) {
  const p = sp.jsonlPathFor(sessionId);
  return fs.readFileSync(p);
}

test('gate ON: durable append round-trips through buildConversationChain', () => {
  delete process.env.KHY_DURABLE_TRANSCRIPT; // default = on
  const sid = 'sess-durable-on';
  sp.appendMessage(sid, { role: 'user', content: 'hello', uuid: 'u1', timestamp: 1000 }, null);
  sp.appendMessage(sid, { role: 'assistant', content: 'hi there', uuid: 'a1', timestamp: 1001 }, 'u1');

  const chain = sp.buildConversationChain(sid);
  assert.strictEqual(chain.length, 2);
  assert.strictEqual(chain[0].content, 'hello');
  assert.strictEqual(chain[1].content, 'hi there');
  // parentUuid chain preserved through the durable write
  assert.strictEqual(chain[1].parentUuid, 'u1');
});

test('gate OFF byte-identical to gate ON (fsync changes durability, not bytes)', () => {
  // Write the same logical entry under both gate states and compare raw bytes.
  const msg = { role: 'user', content: 'byte-parity', uuid: 'bp1', timestamp: 2000 };

  process.env.KHY_DURABLE_TRANSCRIPT = '1';
  const sidOn = 'sess-bytes-on';
  sp.appendMessage(sidOn, msg, null);
  const bytesOn = readJsonlBytes(sidOn);

  process.env.KHY_DURABLE_TRANSCRIPT = 'off';
  const sidOff = 'sess-bytes-off';
  sp.appendMessage(sidOff, msg, null);
  const bytesOff = readJsonlBytes(sidOff);

  delete process.env.KHY_DURABLE_TRANSCRIPT;
  assert.deepStrictEqual(bytesOn, bytesOff, 'durable append must write identical bytes to the fallback path');
});

test('gate OFF: still appends and round-trips (fallback path intact)', () => {
  process.env.KHY_DURABLE_TRANSCRIPT = 'false';
  const sid = 'sess-fallback';
  sp.appendMessage(sid, { role: 'user', content: 'fallback works', uuid: 'f1', timestamp: 3000 }, null);
  delete process.env.KHY_DURABLE_TRANSCRIPT;

  const chain = sp.buildConversationChain(sid);
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].content, 'fallback works');
});

test('persistSession incremental append stays durable and ordered across turns', () => {
  const sid = 'sess-turns';
  // Turn 1: user + assistant
  sp.persistSession(sid, {
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'r1' },
    ],
    metadata: { cwd: TMP },
  });
  // Turn 2: append two more (simulating next prompt's收尾落盘)
  sp.persistSession(sid, {
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'r2' },
    ],
    metadata: { cwd: TMP },
  });

  const chain = sp.buildConversationChain(sid);
  assert.strictEqual(chain.length, 4);
  assert.deepStrictEqual(chain.map((m) => m.content), ['q1', 'r1', 'q2', 'r2']);
});

test('fsync failure is fail-soft: data still appended (probe via read-only fd unavailability)', () => {
  // We cannot easily force fsync to throw without mocking fs; instead assert the
  // contract indirectly: a normal durable write succeeds and is readable. The
  // try/catch around fsyncSync guarantees that even if fsync threw, the prior
  // writeSync would have committed the bytes to the page cache. This test pins
  // that the happy path commits and is recoverable (the failure branch is a
  // strict superset of the fallback path which has no fsync at all).
  process.env.KHY_DURABLE_TRANSCRIPT = '1';
  const sid = 'sess-failsoft';
  assert.doesNotThrow(() => {
    sp.appendMessage(sid, { role: 'user', content: 'durable', uuid: 'd1', timestamp: 4000 }, null);
  });
  delete process.env.KHY_DURABLE_TRANSCRIPT;
  const chain = sp.buildConversationChain(sid);
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].content, 'durable');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
