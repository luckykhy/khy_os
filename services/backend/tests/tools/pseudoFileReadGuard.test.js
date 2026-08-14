'use strict';

/**
 * Unit tests for pseudoFileReadGuard.js — the pure leaf that lets tools/readFile.js
 * 对 Linux 伪文件系统(/proc·/sys)下会永久阻塞的**常规**伪文件改走「有界子进程读」,
 * 而非在 detectFile()/readTextFileSmart 里挂死(run via `node --test`).
 *
 * 全部用鸭子类型的 fake stat + DI 注入的 fake spawnSync,不需真跑 head / 真读 /proc,故确定性。
 * 覆盖:
 *   - 门控 pseudoReadGuardEnabled:默认开;env ∈ {0,false,off,no}(含大小写/空白)→ 关。
 *   - isPseudoFsPath:精确 /proc·/sys 前缀;工程目录里的 proc/sys 子目录不误判;非 linux → null。
 *   - shouldBoundedRead:门开+linux+常规文件+size===0+伪路径 → kind;任一不满足 → null。
 *   - buildBoundedReadArgs:head -c <cap> <path>;畸形 maxBytes → 默认 cap。
 *   - buildPseudoTimeoutMessage:点明阻塞+超时杀+逃生门,畸形入参不抛。
 *   - readPseudoFileBounded:退出0有内容 → handled+success;ETIMEDOUT/信号 → handled+timedOut;
 *     spawn 出错/status≠0/空入参 → handled:false;绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const G = require('../../src/tools/pseudoFileReadGuard');

// 常规文件 fake stat（size 可配）。
function fileStat(size) {
  return { isFile: () => true, size };
}

// ── 门控 pseudoReadGuardEnabled ─────────────────────────────────────────────
test('门控:默认开(未设/空/任意非关键字)', () => {
  assert.strictEqual(G.pseudoReadGuardEnabled({}), true);
  assert.strictEqual(G.pseudoReadGuardEnabled({ KHY_READFILE_PSEUDO_GUARD: '' }), true);
  assert.strictEqual(G.pseudoReadGuardEnabled({ KHY_READFILE_PSEUDO_GUARD: '1' }), true);
  assert.strictEqual(G.pseudoReadGuardEnabled({ KHY_READFILE_PSEUDO_GUARD: 'yes' }), true);
});

test('门控:env ∈ {0,false,off,no}(含大小写/空白)→ 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ', 'NO']) {
    assert.strictEqual(G.pseudoReadGuardEnabled({ KHY_READFILE_PSEUDO_GUARD: v }), false, `for ${JSON.stringify(v)}`);
  }
});

test('门控:入参异常 → 保守视为开(default-on)', () => {
  const boom = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.strictEqual(G.pseudoReadGuardEnabled(boom), true);
});

// ── isPseudoFsPath ──────────────────────────────────────────────────────────
test('isPseudoFsPath:/proc·/sys 精确命中', () => {
  assert.strictEqual(G.isPseudoFsPath('/proc/cpuinfo', 'linux'), 'proc');
  assert.strictEqual(G.isPseudoFsPath('/proc/kmsg', 'linux'), 'proc');
  assert.strictEqual(G.isPseudoFsPath('/proc', 'linux'), 'proc');
  assert.strictEqual(G.isPseudoFsPath('/sys/kernel/debug', 'linux'), 'sys');
  assert.strictEqual(G.isPseudoFsPath('/sys', 'linux'), 'sys');
});

test('isPseudoFsPath:工程目录里名为 proc/sys 的子目录不误判', () => {
  assert.strictEqual(G.isPseudoFsPath('/home/x/proc/y', 'linux'), null);
  assert.strictEqual(G.isPseudoFsPath('/home/x/sys/y', 'linux'), null);
  assert.strictEqual(G.isPseudoFsPath('/procession/notes.txt', 'linux'), null); // 前缀陷阱
  assert.strictEqual(G.isPseudoFsPath('/system/config', 'linux'), null);
});

test('isPseudoFsPath:非 linux 平台恒 null', () => {
  assert.strictEqual(G.isPseudoFsPath('/proc/cpuinfo', 'darwin'), null);
  assert.strictEqual(G.isPseudoFsPath('/proc/cpuinfo', 'win32'), null);
});

test('isPseudoFsPath:畸形入参不抛 → null', () => {
  for (const p of [null, undefined, 42, {}, '']) {
    assert.doesNotThrow(() => G.isPseudoFsPath(p, 'linux'));
    assert.strictEqual(G.isPseudoFsPath(p, 'linux'), null);
  }
});

// ── shouldBoundedRead ───────────────────────────────────────────────────────
test('shouldBoundedRead:门开+linux+常规文件+size0+伪路径 → kind', () => {
  const r = G.shouldBoundedRead({ absPath: '/proc/cpuinfo', stat: fileStat(0), env: {}, platform: 'linux' });
  assert.strictEqual(r, 'proc');
  const s = G.shouldBoundedRead({ absPath: '/sys/kernel/x', stat: fileStat(0), env: {}, platform: 'linux' });
  assert.strictEqual(s, 'sys');
});

test('shouldBoundedRead:门关 → null(回退历史路径)', () => {
  const r = G.shouldBoundedRead({ absPath: '/proc/cpuinfo', stat: fileStat(0), env: { KHY_READFILE_PSEUDO_GUARD: '0' }, platform: 'linux' });
  assert.strictEqual(r, null);
});

test('shouldBoundedRead:非 linux → null', () => {
  const r = G.shouldBoundedRead({ absPath: '/proc/cpuinfo', stat: fileStat(0), env: {}, platform: 'darwin' });
  assert.strictEqual(r, null);
});

test('shouldBoundedRead:size≠0 → null(有真实大小,非伪文件签名)', () => {
  const r = G.shouldBoundedRead({ absPath: '/proc/cpuinfo', stat: fileStat(1024), env: {}, platform: 'linux' });
  assert.strictEqual(r, null);
});

test('shouldBoundedRead:非常规文件(无 isFile / isFile()!==true)→ null', () => {
  assert.strictEqual(G.shouldBoundedRead({ absPath: '/proc/x', stat: { size: 0 }, env: {}, platform: 'linux' }), null);
  assert.strictEqual(G.shouldBoundedRead({ absPath: '/proc/x', stat: { isFile: () => false, size: 0 }, env: {}, platform: 'linux' }), null);
});

test('shouldBoundedRead:非伪路径的常规文件 → null(零误伤工程文件)', () => {
  const r = G.shouldBoundedRead({ absPath: '/home/x/proc/report.txt', stat: fileStat(0), env: {}, platform: 'linux' });
  assert.strictEqual(r, null);
});

test('shouldBoundedRead:畸形入参不抛 → null', () => {
  for (const a of [null, undefined, 'x', 42, {}]) {
    assert.doesNotThrow(() => G.shouldBoundedRead(a));
    assert.strictEqual(G.shouldBoundedRead(a), null);
  }
});

// ── buildBoundedReadArgs ────────────────────────────────────────────────────
test('buildBoundedReadArgs:head -c <cap> <path>', () => {
  const { cmd, args } = G.buildBoundedReadArgs('/proc/cpuinfo', 4096);
  assert.strictEqual(cmd, 'head');
  assert.deepStrictEqual(args, ['-c', '4096', '/proc/cpuinfo']);
});

test('buildBoundedReadArgs:畸形/非正 maxBytes → 默认 cap', () => {
  for (const bad of [null, undefined, 0, -5, NaN, 'x']) {
    const { args } = G.buildBoundedReadArgs('/proc/x', bad);
    assert.strictEqual(args[1], String(G.DEFAULT_MAX_BYTES));
  }
});

// ── buildPseudoTimeoutMessage ───────────────────────────────────────────────
test('超时消息:点明阻塞伪文件 + 超时杀 + 逃生门', () => {
  const msg = G.buildPseudoTimeoutMessage({ path: '/proc/kmsg', kind: 'proc', timeoutMs: 4000 });
  assert.match(msg, /\/proc 伪文件/);
  assert.match(msg, /\/proc\/kmsg/);
  assert.match(msg, /阻塞/);
  assert.match(msg, /4000ms/);
  assert.match(msg, /KHY_READFILE_PSEUDO_GUARD=0/);
});

test('超时消息:畸形入参不抛,返回非空串', () => {
  for (const arg of [null, undefined, 'x', 42, {}]) {
    let msg;
    assert.doesNotThrow(() => { msg = G.buildPseudoTimeoutMessage(arg); });
    assert.strictEqual(typeof msg, 'string');
    assert.ok(msg.length > 0);
  }
});

// ── readPseudoFileBounded (DI spawnSync 桩) ─────────────────────────────────
function okSpawn(content) {
  return () => ({ status: 0, stdout: Buffer.from(content, 'utf8'), stderr: Buffer.from(''), error: null, signal: null });
}

test('readPseudoFileBounded:退出0有内容 → handled + success + provenance 头', () => {
  const r = G.readPseudoFileBounded({
    filePath: '/proc/cpuinfo', kind: 'proc', maxBytes: 1024, timeoutMs: 2000,
    deps: { spawnSync: okSpawn('processor : 0\nmodel name : X') },
  });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.result.success, true);
  assert.match(r.result.content, /【\/proc 伪文件 · 有界读】/);
  assert.match(r.result.content, /processor : 0/);
  assert.strictEqual(r.result.format, 'pseudo-fs-proc');
  assert.strictEqual(r.result.extractedBy, 'bounded-read');
  assert.strictEqual(r.result.truncated, false);
});

test('readPseudoFileBounded:输出达 maxBytes → truncated:true + 截断标注', () => {
  const content = 'x'.repeat(64);
  const r = G.readPseudoFileBounded({
    filePath: '/proc/x', kind: 'proc', maxBytes: 64, timeoutMs: 2000,
    deps: { spawnSync: okSpawn(content) },
  });
  assert.strictEqual(r.result.truncated, true);
  assert.match(r.result.content, /已截断至前 64 字节/);
});

test('readPseudoFileBounded:ETIMEDOUT → handled + timedOut + 拒绝消息', () => {
  const r = G.readPseudoFileBounded({
    filePath: '/proc/kmsg', kind: 'proc', maxBytes: 1024, timeoutMs: 1500,
    deps: { spawnSync: () => ({ status: null, stdout: Buffer.from(''), error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM' }) },
  });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.result.success, false);
  assert.strictEqual(r.result.timedOut, true);
  assert.strictEqual(r.result.pseudoFile, 'proc');
  assert.match(r.result.error, /阻塞/);
  assert.match(r.result.error, /1500ms/);
});

test('readPseudoFileBounded:被 SIGTERM 杀(无 ETIMEDOUT code)→ timedOut', () => {
  const r = G.readPseudoFileBounded({
    filePath: '/proc/kmsg', kind: 'proc', maxBytes: 1024, timeoutMs: 1500,
    deps: { spawnSync: () => ({ status: null, stdout: Buffer.from(''), error: null, signal: 'SIGTERM' }) },
  });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.result.timedOut, true);
});

test('readPseudoFileBounded:head 不存在(ENOENT error,非超时)→ handled:false 回退', () => {
  const r = G.readPseudoFileBounded({
    filePath: '/proc/cpuinfo', kind: 'proc', maxBytes: 1024, timeoutMs: 2000,
    deps: { spawnSync: () => ({ status: null, stdout: null, error: Object.assign(new Error('spawn head ENOENT'), { code: 'ENOENT' }), signal: null }) },
  });
  assert.strictEqual(r.handled, false);
});

test('readPseudoFileBounded:status≠0(无 error)→ handled:false 回退', () => {
  const r = G.readPseudoFileBounded({
    filePath: '/proc/x', kind: 'proc', maxBytes: 1024, timeoutMs: 2000,
    deps: { spawnSync: () => ({ status: 1, stdout: Buffer.from(''), error: null, signal: null }) },
  });
  assert.strictEqual(r.handled, false);
});

test('readPseudoFileBounded:spawnSync 抛错 → handled:false,不抛', () => {
  let r;
  assert.doesNotThrow(() => {
    r = G.readPseudoFileBounded({
      filePath: '/proc/x', kind: 'proc', maxBytes: 1024, timeoutMs: 2000,
      deps: { spawnSync: () => { throw new Error('boom'); } },
    });
  });
  assert.strictEqual(r.handled, false);
});

test('readPseudoFileBounded:空/畸形 filePath → handled:false', () => {
  assert.strictEqual(G.readPseudoFileBounded({ filePath: '', kind: 'proc' }).handled, false);
  assert.strictEqual(G.readPseudoFileBounded({ kind: 'proc' }).handled, false);
  assert.strictEqual(G.readPseudoFileBounded(null).handled, false);
  assert.strictEqual(G.readPseudoFileBounded(42).handled, false);
});

test('readPseudoFileBounded:kind 非 sys 一律归 proc(默认)', () => {
  const r = G.readPseudoFileBounded({
    filePath: '/sys/x', kind: 'sys', maxBytes: 64, timeoutMs: 2000,
    deps: { spawnSync: okSpawn('data') },
  });
  assert.strictEqual(r.result.format, 'pseudo-fs-sys');
});
