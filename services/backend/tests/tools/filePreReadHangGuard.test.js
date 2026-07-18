'use strict';

/**
 * filePreReadHangGuard 单元 + 接线 + 行为测。
 *
 * 覆盖:
 *  - 纯叶:安全常规文件→null;三条向量各命中;各族门关→byte-revert(null);畸形入参不抛。
 *  - 接线(源级):inspectDocument.js / replaceAtLocation.js 均在 detectFile 之前调 classifyPreReadHang。
 *  - 行为(execute):FIFO 被拒(非 win32);常规文本文件正常通过(不误伤)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { classifyPreReadHang } = require('../../src/tools/filePreReadHangGuard');

const REGULAR = path.join(__dirname, '..', '..', 'package.json');
const REG_STAT = fs.statSync(REGULAR);

// ---- 纯叶 ----

test('safe regular file → null', () => {
  assert.strictEqual(classifyPreReadHang({ absPath: REGULAR, stat: REG_STAT }), null);
});

test('malformed args do not throw', () => {
  assert.strictEqual(classifyPreReadHang(null), null);
  assert.strictEqual(classifyPreReadHang({}), null);
  assert.strictEqual(classifyPreReadHang({ absPath: REGULAR }), null); // 无 stat → special/pseudo 跳过
});

test('FIFO → special:fifo blocked', { skip: process.platform === 'win32' }, () => {
  const p = path.join(os.tmpdir(), `khy_prehang_${process.pid}_${Date.now?.() || 'x'}`);
  const fifo = p + '_f';
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const r = classifyPreReadHang({ absPath: fifo, stat: fs.statSync(fifo) });
    assert.ok(r && r.blocked, 'FIFO must be blocked');
    assert.strictEqual(r.kind, 'special:fifo');
    assert.match(r.error, /FIFO|管道|套接字|设备|阻塞/);
  } finally {
    fs.unlinkSync(fifo);
  }
});

test('special guard off → FIFO passes (byte-revert)', { skip: process.platform === 'win32' }, () => {
  const fifo = path.join(os.tmpdir(), `khy_prehang_off_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const st = fs.statSync(fifo);
    // 关族门 → 该向量返 null(pseudo 对 FIFO 不适用)
    const r = classifyPreReadHang({ absPath: fifo, stat: st, env: { KHY_READFILE_SPECIAL_GUARD: '0' } });
    assert.strictEqual(r, null);
  } finally {
    fs.unlinkSync(fifo);
  }
});

test('/proc pseudo → pseudo:proc blocked (linux)', { skip: process.platform !== 'linux' }, () => {
  const st = fs.statSync('/proc/self/status');
  const r = classifyPreReadHang({ absPath: '/proc/self/status', stat: st });
  assert.ok(r && r.blocked, '/proc file must be blocked');
  assert.strictEqual(r.kind, 'pseudo:proc');
  assert.match(r.error, /proc|sys|伪文件|阻塞|timeout|超时/i);
});

test('pseudo guard off → /proc passes (byte-revert)', { skip: process.platform !== 'linux' }, () => {
  const st = fs.statSync('/proc/self/status');
  const r = classifyPreReadHang({ absPath: '/proc/self/status', stat: st, env: { KHY_READFILE_PSEUDO_GUARD: '0' } });
  assert.strictEqual(r, null);
});

test('Windows reserved name is platform-gated off on non-win32', { skip: process.platform === 'win32' }, () => {
  // 在非 Windows,win-device 向量应恒 null(classifyWindowsDevice platform-gate)。
  assert.strictEqual(classifyPreReadHang({ absPath: '/tmp/CON', stat: REG_STAT }), null);
});

// ---- 接线(源级) ----

for (const rel of ['inspectDocument.js', 'replaceAtLocation.js']) {
  test(`${rel} wires classifyPreReadHang before detectFile`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', rel), 'utf-8');
    const reqIdx = src.indexOf("require('./filePreReadHangGuard')");
    const callIdx = src.indexOf('classifyPreReadHang(');
    const detectIdx = src.indexOf('detectFile(absPath)');
    assert.ok(reqIdx > -1, 'must require filePreReadHangGuard');
    assert.ok(callIdx > -1, 'must call classifyPreReadHang');
    assert.ok(detectIdx > -1, 'must call detectFile(absPath)');
    assert.ok(callIdx < detectIdx, 'classifyPreReadHang must precede detectFile');
    assert.match(src.slice(callIdx, callIdx + 200), /blocked/, 'must short-circuit on blocked');
  });
}

// editFile / exploreTool read bytes with readFileSync directly (no detectFile) -> guard must precede that read.
for (const rel of ['editFile.js', 'exploreTool.js']) {
  test(`${rel} wires classifyPreReadHang before readFileSync`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', rel), 'utf-8');
    const reqIdx = src.indexOf("require('./filePreReadHangGuard')");
    const callIdx = src.indexOf('classifyPreReadHang(');
    const readIdx = src.search(/fs\.readFileSync\(absPath/);
    assert.ok(reqIdx > -1, 'must require filePreReadHangGuard');
    assert.ok(callIdx > -1, 'must call classifyPreReadHang');
    assert.ok(readIdx > -1, 'must call fs.readFileSync(absPath...)');
    assert.ok(callIdx < readIdx, 'classifyPreReadHang must precede fs.readFileSync');
    assert.match(src.slice(callIdx, callIdx + 240), /blocked/, 'must react to blocked');
  });
}

// exploreTool reuses the stat it already computed (zero extra IO) and skips-and-continues on a hang target.
test('exploreTool reuses existing stat and continues on hang (no extra statSync, no hard fail)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', 'exploreTool.js'), 'utf-8');
  const statIdx = src.indexOf('const stat = fs.statSync(absPath)');
  const callIdx = src.indexOf('classifyPreReadHang(');
  const readIdx = src.search(/fs\.readFileSync\(absPath/);
  assert.ok(statIdx > -1 && callIdx > -1 && readIdx > -1);
  assert.ok(statIdx < callIdx && callIdx < readIdx, 'guard sits between the existing statSync and the readFileSync');
  assert.match(src.slice(callIdx, callIdx + 260), /continue/, 'explore skips a hang target rather than hard-failing');
});

// ---- 行为(execute) ----

test('editFile.execute refuses FIFO but still edits a normal file', { skip: process.platform === 'win32' }, async () => {
  const editFile = require('../../src/tools/editFile');
  // editFile 把写路径限定 cwd 内(先于本守卫的 traversal 检查),故 FIFO 须落 cwd 内。
  const fifo = path.join(process.cwd(), `khy_prehang_edit_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const res = await editFile.execute({ file_path: fifo, old_string: 'a', new_string: 'b' });
    assert.strictEqual(res.success, false);
    assert.ok(res.blockedRead && /special/.test(res.blockedRead), `expected blockedRead, got ${JSON.stringify(res).slice(0,120)}`);
  } finally {
    fs.unlinkSync(fifo);
  }
  // 不误伤:正常文本文件仍可编辑。
  const f = path.join(process.cwd(), `khy_prehang_edit_ok_${process.pid}.txt`);
  fs.writeFileSync(f, 'hello world');
  try {
    const res = await editFile.execute({ file_path: f, old_string: 'world', new_string: 'khy' });
    assert.strictEqual(res.success, true, `normal edit must succeed: ${JSON.stringify(res).slice(0,120)}`);
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'hello khy');
  } finally {
    fs.unlinkSync(f);
  }
});

test('inspectDocument.execute refuses FIFO', { skip: process.platform === 'win32' }, async () => {
  const insp = require('../../src/tools/inspectDocument');
  const fifo = path.join(os.tmpdir(), `khy_prehang_insp_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const res = await insp.execute({ file_path: fifo });
    assert.strictEqual(res.success, false);
    assert.ok(res.blockedRead && /special/.test(res.blockedRead), `expected blockedRead, got ${JSON.stringify(res).slice(0,120)}`);
  } finally {
    fs.unlinkSync(fifo);
  }
});

test('inspectDocument.execute passes a normal text file', async () => {
  const insp = require('../../src/tools/inspectDocument');
  const f = path.join(os.tmpdir(), `khy_prehang_ok_${process.pid}.txt`);
  fs.writeFileSync(f, 'hello world\n');
  try {
    const res = await insp.execute({ file_path: f });
    assert.notStrictEqual(res.success, false, `normal file must not be blocked: ${JSON.stringify(res).slice(0,120)}`);
    assert.ok(!res.blockedRead, 'normal file must not carry blockedRead');
  } finally {
    fs.unlinkSync(f);
  }
});

test('replaceAtLocation.execute refuses FIFO', { skip: process.platform === 'win32' }, async () => {
  const repl = require('../../src/tools/replaceAtLocation');
  // replaceAtLocation 把写路径限定在 cwd 内(先于本守卫的 traversal 检查),故 FIFO 须落 cwd 内。
  const fifo = path.join(process.cwd(), `khy_prehang_repl_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const res = await repl.execute({ file_path: fifo, word: 'a', replacement: 'b' });
    assert.strictEqual(res.success, false);
    assert.ok(res.blockedRead && /special/.test(res.blockedRead), `expected blockedRead, got ${JSON.stringify(res).slice(0,120)}`);
  } finally {
    fs.unlinkSync(fifo);
  }
});

// ---- unpack:流式读取(createReadStream)的 execute-chokepoint 防护 ----
// unpack 的 validateInput.isFile() 只在 registry 分发路径拦特殊文件(source-dependent);
// 守卫落在 execute 体内可 source-无关地防住流式解包对 FIFO 的永久卡死,与 5 个同族读工具一致。

test('unpackTool wires classifyPreReadHang at the execute chokepoint (before streaming)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', 'unpackTool.js'), 'utf-8');
  const reqIdx = src.indexOf("require('./filePreReadHangGuard')");
  const callIdx = src.indexOf('classifyPreReadHang(');
  assert.ok(reqIdx > -1, 'must require filePreReadHangGuard');
  assert.ok(callIdx > -1, 'must call classifyPreReadHang');
  assert.ok(src.indexOf('createReadStream') > -1, 'unpack streams bytes (createReadStream) — that is what the guard protects');
  assert.match(src.slice(callIdx, callIdx + 240), /blocked/, 'must short-circuit on blocked');
  assert.match(src.slice(callIdx, callIdx + 240), /return\s*\{\s*success:\s*false/, 'blocked hit returns a structured refusal');
  // NOTE: runtime ordering (guard fires before the streaming helpers) is proven by the
  // behavioral tests below (FIFO refused at execute, normal .gz still extracts). Token-index
  // ordering is not asserted here because validateInput and execute share the same helper
  // tokens (_detectFormat/createReadStream), making lexical position an unreliable signal.
});

test('unpack.execute refuses a FIFO archive (would hang the stream otherwise)', { skip: process.platform === 'win32' }, async () => {
  const unpack = require('../../src/tools/unpackTool');
  const fifo = path.join(os.tmpdir(), `khy_prehang_unpack_${process.pid}.gz`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    // Bypass validateInput deliberately — hit the execute chokepoint that streams bytes.
    const res = await unpack.execute({ file_path: fifo, list_only: false });
    assert.strictEqual(res.success, false);
    assert.ok(res.blockedRead && /special/.test(res.blockedRead), `expected blockedRead, got ${JSON.stringify(res).slice(0, 120)}`);
  } finally {
    fs.unlinkSync(fifo);
  }
});

test('unpack.execute still extracts a normal .gz (non-regression / byte-revert-safe)', async () => {
  const unpack = require('../../src/tools/unpackTool');
  const zlib = require('zlib');
  const gzPath = path.join(process.cwd(), `khy_prehang_unpack_ok_${process.pid}.gz`);
  const outDir = path.join(process.cwd(), `khy_prehang_unpack_out_${process.pid}`);
  fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.from('hello khy unpack')));
  try {
    const res = await unpack.execute({ file_path: gzPath, output_dir: outDir, list_only: false });
    assert.strictEqual(res.success, true, `expected success, got ${JSON.stringify(res).slice(0, 160)}`);
  } finally {
    try { fs.unlinkSync(gzPath); } catch { /* best effort */ }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
