'use strict';
/**
 * filePreReadHangGuard 单元 + 接线 + 行为测�?
 *
 * 覆盖:
 *  - 纯叶:安全常规文件→null;三条向量各命�?各族门关→byte-revert(null);畸形入参不抛�?
 *  - 接线(源级):inspectDocument.js / replaceAtLocation.js 均在 detectFile 之前�?classifyPreReadHang�?
 *  - 行为(execute):FIFO 被拒(�?win32);常规文本文件正常通过(不误�?�?
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { classifyPreReadHang } = require('../../src/tools/filePreReadHangGuard');
const REGULAR = path.join(__dirname, '..', '..', 'package.json');
const REG_STAT = fs.statSync(REGULAR);
// ---- 纯叶 ----
test('FIFO �?special:fifo blocked', { skip: process.platform === 'win32' }, () => {
  const p = path.join(os.tmpdir(), `khy_prehang_${process.pid}_${Date.now?.() || 'x'}`);
  const fifo = p + '_f';
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const r = classifyPreReadHang({ absPath: fifo, stat: fs.statSync(fifo) });
    expect(r && r.blocked).toBeTruthy();
    expect(r.kind).toBe('special:fifo');
    expect(r.error).toMatch(/FIFO|管道|套接字|设备|阻塞/);
  } finally {
    fs.unlinkSync(fifo);
  }
});
test('special guard off �?FIFO passes (byte-revert)', { skip: process.platform === 'win32' }, () => {
  const fifo = path.join(os.tmpdir(), `khy_prehang_off_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const st = fs.statSync(fifo);
    // 关族�?�?该向量返 null(pseudo �?FIFO 不适用)
    const r = classifyPreReadHang({ absPath: fifo, stat: st, env: { KHY_READFILE_SPECIAL_GUARD: '0' } });
    expect(r).toBe(null);
  } finally {
    fs.unlinkSync(fifo);
  }
});
test('/proc pseudo �?pseudo:proc blocked (linux)', { skip: process.platform !== 'linux' }, () => {
  const st = fs.statSync('/proc/self/status');
  const r = classifyPreReadHang({ absPath: '/proc/self/status', stat: st });
  expect(r && r.blocked).toBeTruthy();
  expect(r.kind).toBe('pseudo:proc');
  expect(r.error).toMatch(/proc|sys|伪文件|阻塞|timeout|超时/i);
});
test('pseudo guard off �?/proc passes (byte-revert)', { skip: process.platform !== 'linux' }, () => {
  const st = fs.statSync('/proc/self/status');
  const r = classifyPreReadHang({ absPath: '/proc/self/status', stat: st, env: { KHY_READFILE_PSEUDO_GUARD: '0' } });
  expect(r).toBe(null);
});
test('Windows reserved name is platform-gated off on non-win32', { skip: process.platform === 'win32' }, () => {
  // 在非 Windows,win-device 向量应恒 null(classifyWindowsDevice platform-gate)�?
  expect(classifyPreReadHang({ absPath: '/tmp/CON', stat: REG_STAT })).toBe(null);
});
// ---- 接线(源级) ----
for (const rel of ['inspectDocument.js', 'replaceAtLocation.js']) {
}
// editFile / exploreTool read bytes with readFileSync directly (no detectFile) -> guard must precede that read.
for (const rel of ['editFile.js', 'exploreTool.js']) {
}
// exploreTool reuses the stat it already computed (zero extra IO) and skips-and-continues on a hang target.
// ---- 行为(execute) ----
test('editFile.execute refuses FIFO but still edits a normal file', { skip: process.platform === 'win32' }, async () => {
  const editFile = require('../../src/tools/editFile');
  // editFile 把写路径限定 cwd �?先于本守卫的 traversal 检�?,�?FIFO 须落 cwd 内�?
  const fifo = path.join(process.cwd(), `khy_prehang_edit_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const res = await editFile.execute({ file_path: fifo, old_string: 'a', new_string: 'b' });
    expect(res.success).toBe(false);
    expect(res.blockedRead && /special/.test(res.blockedRead)).toBeTruthy();
  } finally {
    fs.unlinkSync(fifo);
  }
  // 不误�?正常文本文件仍可编辑�?
  const f = path.join(process.cwd(), `khy_prehang_edit_ok_${process.pid}.txt`);
  fs.writeFileSync(f, 'hello world');
  try {
    const res = await editFile.execute({ file_path: f, old_string: 'world', new_string: 'khy' });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(f, 'utf-8')).toBe('hello khy');
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
    expect(res.success).toBe(false);
    expect(res.blockedRead && /special/.test(res.blockedRead)).toBeTruthy();
  } finally {
    fs.unlinkSync(fifo);
  }
});
test('replaceAtLocation.execute refuses FIFO', { skip: process.platform === 'win32' }, async () => {
  const repl = require('../../src/tools/replaceAtLocation');
  // replaceAtLocation 把写路径限定�?cwd �?先于本守卫的 traversal 检�?,�?FIFO 须落 cwd 内�?
  const fifo = path.join(process.cwd(), `khy_prehang_repl_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const res = await repl.execute({ file_path: fifo, word: 'a', replacement: 'b' });
    expect(res.success).toBe(false);
    expect(res.blockedRead && /special/.test(res.blockedRead)).toBeTruthy();
  } finally {
    fs.unlinkSync(fifo);
  }
});
// ---- unpack:流式读取(createReadStream)�?execute-chokepoint 防护 ----
// unpack �?validateInput.isFile() 只在 registry 分发路径拦特殊文�?source-dependent);
// 守卫落在 execute 体内�?source-无关地防住流式解包对 FIFO 的永久卡�?�?5 个同族读工具一致�?

describe('File Pre Read Hang Guard', () => {
  test('safe regular file �?null', async () => {
      expect(classifyPreReadHang({ absPath: REGULAR, stat: REG_STAT })).toBe(null);
  });

  test('malformed args do not throw', async () => {
      expect(classifyPreReadHang(null)).toBe(null);
      expect(classifyPreReadHang({})).toBe(null);
      expect(classifyPreReadHang({ absPath: REGULAR })).toBe(null); // �?stat �?special/pseudo 跳过
  });

  test('${rel} wires classifyPreReadHang before detectFile', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', rel), 'utf-8');
        const reqIdx = src.indexOf("require('./filePreReadHangGuard')");
        const callIdx = src.indexOf('classifyPreReadHang(');
        const detectIdx = src.indexOf('detectFile(absPath)');
        expect(reqIdx > -1).toBeTruthy();
        expect(callIdx > -1).toBeTruthy();
        expect(detectIdx > -1).toBeTruthy();
        expect(callIdx < detectIdx).toBeTruthy();
        expect(src.slice(callIdx, callIdx + 200)).toMatch(/blocked/);
  });

  test('${rel} wires classifyPreReadHang before readFileSync', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', rel), 'utf-8');
        const reqIdx = src.indexOf("require('./filePreReadHangGuard')");
        const callIdx = src.indexOf('classifyPreReadHang(');
        const readIdx = src.search(/fs\.readFileSync\(absPath/);
        expect(reqIdx > -1).toBeTruthy();
        expect(callIdx > -1).toBeTruthy();
        expect(readIdx > -1).toBeTruthy();
        expect(callIdx < readIdx).toBeTruthy();
        expect(src.slice(callIdx, callIdx + 240)).toMatch(/blocked/);
  });

  test('exploreTool reuses existing stat and continues on hang (no extra statSync, no hard fail)', async () => {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', 'exploreTool.js'), 'utf-8');
      const statIdx = src.indexOf('const stat = fs.statSync(absPath)');
      const callIdx = src.indexOf('classifyPreReadHang(');
      const readIdx = src.search(/fs\.readFileSync\(absPath/);
      expect(statIdx > -1 && callIdx > -1 && readIdx > -1).toBeTruthy();
      expect(statIdx < callIdx && callIdx < readIdx).toBeTruthy();
      expect(src.slice(callIdx, callIdx + 260)).toMatch(/continue/);
  });

  test('inspectDocument.execute passes a normal text file', async () => {
      const insp = require('../../src/tools/inspectDocument');
      const f = path.join(os.tmpdir(), `khy_prehang_ok_${process.pid}.txt`);
      fs.writeFileSync(f, 'hello world\n');
      try {
        const res = await insp.execute({ file_path: f });
        expect(res.success).not.toBe(false, `normal file must not be blocked: ${JSON.stringify(res).slice(0,120)}`);
        expect(!res.blockedRead).toBeTruthy();
      } finally {
        fs.unlinkSync(f);
      }
  });

});

