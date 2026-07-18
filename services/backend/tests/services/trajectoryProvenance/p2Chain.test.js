'use strict';

/**
 * P2 防篡改哈希链测试（DESIGN-ARCH-047 PHASE 2）。
 *
 * 覆盖：
 *   - traceChain append/read/verify happy path（确定性 sha256 链，跨进程稳定）
 *   - 改一字段 → brokenAt 精确定位（篡改证据）
 *   - prevHash 断链 / seq 不连续 → 定位首坏块
 *   - verifyAgainstEntries：改 JSONL 正文 / 删行 → contentHash 失配定位
 *   - chainPathFor 派生并列路径
 *   - appendMessage 写完 JSONL 后落 sidecar 链（端到端往返 + 篡改检测）
 *   - 链目录不可写时 appendMessage 仍成功（防呆② fail-soft）
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const traceChain = require('../../../src/services/trajectoryProvenance/traceChain');
const khyTrace = require('../../../src/services/trajectoryProvenance/khyTrace');
const sessionPersistence = require('../../../src/services/sessionPersistence');

const { PRODUCER, TRUST } = khyTrace;

const TMP = path.join(os.tmpdir(), `khy-traj-p2-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

function chainFile(name) {
  return path.join(TMP, `${name}.trace-chain.json`);
}

describe('traceChain 哈希链 append/read/verify', () => {
  test('append 三条 → verify 全绿 + seq/prevHash 链接', () => {
    const f = chainFile('happy');
    traceChain.append(f, { uuid: 'a', producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED, content: 'one' });
    traceChain.append(f, { uuid: 'b', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'two' });
    traceChain.append(f, { uuid: 'c', producer: PRODUCER.RELAY, trust: TRUST.CLAIMED, content: 'three' });
    const chain = traceChain.read(f);
    assert.equal(chain.length, 3);
    assert.equal(chain[0].prevHash, traceChain.GENESIS_PREV);
    assert.equal(chain[1].prevHash, chain[0].hash);
    assert.equal(chain[2].prevHash, chain[1].hash);
    const v = traceChain.verify(f);
    assert.equal(v.ok, true);
    assert.equal(v.length, 3);
    assert.equal(v.brokenAt, null);
  });

  test('改链中一条记录的 producer → verify 定位首坏块', () => {
    const f = chainFile('tamper-field');
    traceChain.append(f, { uuid: 'a', producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED, content: 'x' });
    traceChain.append(f, { uuid: 'b', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'y' });
    const chain = traceChain.read(f);
    chain[1].producer = PRODUCER.KHY_LOCAL; // 把「外部声称」洗成「本地已验证」
    fs.writeFileSync(f, JSON.stringify(chain, null, 2));
    const v = traceChain.verify(f);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
  });

  test('prevHash 断链 → 定位', () => {
    const f = chainFile('tamper-prev');
    traceChain.append(f, { uuid: 'a', content: 'x' });
    traceChain.append(f, { uuid: 'b', content: 'y' });
    const chain = traceChain.read(f);
    chain[1].prevHash = '0'.repeat(64);
    fs.writeFileSync(f, JSON.stringify(chain, null, 2));
    const v = traceChain.verify(f);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
  });

  test('verify 缺文件 → available:false 但不抛', () => {
    const v = traceChain.verify(chainFile('nonexistent'));
    assert.equal(v.available, false);
    assert.equal(v.ok, false);
  });

  test('hash 跨「进程」确定性：重算 _hashEntry 与落盘 hash 一致', () => {
    const f = chainFile('determinism');
    traceChain.append(f, { uuid: 'a', producer: PRODUCER.CODEX, trust: TRUST.CLAIMED, content: 'stable' });
    const [e] = traceChain.read(f);
    assert.equal(traceChain._hashEntry(e), e.hash);
  });
});

describe('traceChain.verifyAgainstEntries 交叉核对 transcript', () => {
  test('改 JSONL 正文而链未重算 → contentHash 失配定位', () => {
    const f = chainFile('xcheck-content');
    traceChain.append(f, { uuid: 'a', content: 'original body' });
    traceChain.append(f, { uuid: 'b', content: 'second body' });
    const tampered = [
      { uuid: 'a', content: 'HACKED body' },
      { uuid: 'b', content: 'second body' },
    ];
    const v = traceChain.verifyAgainstEntries(f, tampered);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0);
  });

  test('删 transcript 行（链有 uuid 但 entries 缺）→ 定位', () => {
    const f = chainFile('xcheck-deleted');
    traceChain.append(f, { uuid: 'a', content: 'x' });
    traceChain.append(f, { uuid: 'b', content: 'y' });
    const v = traceChain.verifyAgainstEntries(f, [{ uuid: 'a', content: 'x' }]);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
  });

  test('正文一致 → 全绿', () => {
    const f = chainFile('xcheck-ok');
    traceChain.append(f, { uuid: 'a', content: 'x' });
    const v = traceChain.verifyAgainstEntries(f, [{ uuid: 'a', content: 'x' }]);
    assert.equal(v.ok, true);
  });
});

describe('chainPathFor 派生', () => {
  test('与 JSONL 同目录同 basename、换扩展名', () => {
    const jsonl = path.join('/tmp/x', 'sess-1.jsonl');
    assert.equal(traceChain.chainPathFor(jsonl), path.join('/tmp/x', 'sess-1.trace-chain.json'));
  });
});

describe('appendMessage 端到端落链', () => {
  function jsonlEntries(sid) {
    const f = path.join(TMP, `${sid}.jsonl`);
    return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  test('写消息后 sidecar 链出现且 verify 绿 + 与 transcript 一致', () => {
    const sid = 'e2e-chain';
    sessionPersistence.appendMessage(sid, { role: 'user', content: 'hi' }, null, TMP);
    sessionPersistence.appendMessage(sid, {
      role: 'assistant', content: 'done',
      _khyProvenance: { producer: PRODUCER.CODEX, trust: TRUST.CLAIMED },
    }, null, TMP);
    const f = path.join(TMP, `${sid}.trace-chain.json`);
    assert.ok(fs.existsSync(f), 'sidecar 链文件应存在');
    const v = traceChain.verify(f);
    assert.equal(v.ok, true);
    assert.equal(v.length, 2);
    const v2 = traceChain.verifyAgainstEntries(f, jsonlEntries(sid));
    assert.equal(v2.ok, true);
  });

  test('手改 JSONL 一行正文 → verifyAgainstEntries 报断链（会话仍可读）', () => {
    const sid = 'e2e-tamper';
    sessionPersistence.appendMessage(sid, { role: 'user', content: 'real question' }, null, TMP);
    sessionPersistence.appendMessage(sid, { role: 'assistant', content: 'real answer' }, null, TMP);
    const jf = path.join(TMP, `${sid}.jsonl`);
    const entries = jsonlEntries(sid);
    entries[0].content = 'forged question';
    fs.writeFileSync(jf, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const f = path.join(TMP, `${sid}.trace-chain.json`);
    const v = traceChain.verifyAgainstEntries(f, jsonlEntries(sid));
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0);
  });

  test('链目录不可写时 appendMessage 仍成功（防呆② fail-soft）', () => {
    const sid = 'e2e-failsoft';
    // 预先占位一个不可写的链文件目录：用一个普通文件冒充链文件且只读，append 失败但不抛。
    const f = path.join(TMP, `${sid}.trace-chain.json`);
    fs.writeFileSync(f, 'not-json-and-readonly');
    fs.chmodSync(f, 0o400);
    let res;
    assert.doesNotThrow(() => {
      res = sessionPersistence.appendMessage(sid, { role: 'user', content: 'still works' }, null, TMP);
    });
    assert.ok(res && res.uuid, '消息写入应成功');
    // JSONL 行必须落地（热路径不受链失败影响）。
    const f2 = path.join(TMP, `${sid}.jsonl`);
    assert.ok(fs.existsSync(f2));
    fs.chmodSync(f, 0o600);
  });
});
