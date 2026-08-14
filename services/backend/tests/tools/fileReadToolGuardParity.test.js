/**
 * FileReadTool 防卡死守卫接线 parity 测试(OPS-MAN-145)。
 *
 * 背景:`tools/index.js` 把两条读定义都暴露给模型——`Read`(FileReadTool,`file_path`,
 * 模型按 Claude Code 惯例主要调它)与 `readFile`(readFile.js,`path`)。整个防卡死守卫族
 * 此前只接在 readFile.js,主读工具 FileReadTool **裸奔**。本套件锁定 FileReadTool 已把
 * 全部四条族守卫(special / pseudo / binary / format,winDevice 已在 OPS-143 接好)接到位、
 * 且顺序正确(设备/伪文件触碰前拦、二进制仅非图片路径),防止回归。
 *
 * HOW-TO-EXTEND:新增一条族守卫接进 FileReadTool 时,在此加一条 require 断言 +
 * 一条顺序断言(guardIdx < readTextFileSmart/image 分支 idx),并补一条 execute 行为断言。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/tools/FileReadTool/index.js'), 'utf8');
const FileReadTool = require('../../src/tools/FileReadTool/index.js');

// ── 源级接线断言(readFileSync + regex)──────────────────────────────────────

test('wiring: special 守卫已 require 且消费 stat 类型谓词', () => {
  assert.match(SRC, /require\(['"]\.\.\/specialFileReadGuard['"]\)/, 'requires specialFileReadGuard');
  assert.match(SRC, /specialReadGuardEnabled\(process\.env\)/, 'consults gate');
  assert.match(SRC, /classifySpecialFile\(stat\)/, 'classifies stat');
  assert.match(SRC, /buildSpecialFileRefusal\(/, 'renders refusal');
});

test('wiring: pseudo 守卫已 require 且消费有界读', () => {
  assert.match(SRC, /require\(['"]\.\.\/pseudoFileReadGuard['"]\)/, 'requires pseudoFileReadGuard');
  assert.match(SRC, /shouldBoundedRead\(\{/, 'consults shouldBoundedRead');
  assert.match(SRC, /readPseudoFileBounded\(\{/, 'invokes bounded read');
});

test('wiring: binary 守卫 + format 路由已 require', () => {
  assert.match(SRC, /require\(['"]\.\.\/readBinaryGuard['"]\)/, 'requires readBinaryGuard');
  assert.match(SRC, /require\(['"]\.\.\/readFileFormatRouter['"]\)/, 'requires readFileFormatRouter');
  assert.match(SRC, /binaryReadGuardEnabled\(process\.env\)/, 'consults gate');
  assert.match(SRC, /isBinaryForRead\(fmt\)/, 'classifies format');
  assert.match(SRC, /routeFormatRead\(\{/, 'routes format');
});

test('order: special/pseudo 排在图片检测与 readTextFileSmart 之前(设备/伪文件触碰前拦)', () => {
  const specialIdx = SRC.indexOf("require('../specialFileReadGuard')");
  const pseudoIdx = SRC.indexOf("require('../pseudoFileReadGuard')");
  const imageIdx = SRC.indexOf('Image detection');
  const readIdx = SRC.indexOf('readTextFileSmart(filePath');
  assert.ok(specialIdx > 0 && pseudoIdx > 0 && imageIdx > 0 && readIdx > 0, 'all anchors present');
  assert.ok(specialIdx < imageIdx, 'special precedes image detection');
  assert.ok(pseudoIdx < imageIdx, 'pseudo precedes image detection');
  assert.ok(specialIdx < readIdx && pseudoIdx < readIdx, 'special/pseudo precede text read');
});

test('order: binary 守卫仅对非图片生效(if (!isImage) 包裹)且排在文本读取前', () => {
  const guardIdx = SRC.indexOf("require('../readBinaryGuard')");
  const notImageIdx = SRC.indexOf('if (!isImage)');
  const readIdx = SRC.indexOf('readTextFileSmart(filePath');
  assert.ok(notImageIdx > 0, 'if (!isImage) guard present');
  assert.ok(notImageIdx < guardIdx, 'binary guard sits inside !isImage block');
  assert.ok(guardIdx < readIdx, 'binary guard precedes text read');
});

// ── execute 行为断言(经真实主读路径 FileReadTool.execute)─────────────────────

test('behavior: 纯文本正常读出(无回归)', async () => {
  const p = path.join(os.tmpdir(), 'khy_parity_txt_' + process.pid + '.txt');
  fs.writeFileSync(p, 'alpha khy\nbeta');
  const r = await FileReadTool.execute({ file_path: p });
  fs.unlinkSync(p);
  assert.equal(r.success, true);
  assert.match(r.content || '', /alpha khy/);
});

test('behavior: 二进制文件被拒绝/路由,绝不解码为乱码', async () => {
  const p = path.join(os.tmpdir(), 'khy_parity_bin_' + process.pid + '.bin');
  fs.writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...Array(200).fill(0)]));
  const r = await FileReadTool.execute({ file_path: p });
  fs.unlinkSync(p);
  assert.ok(r.binary === true || (r.success === false && /二进制|binary|格式|不可读/i.test(r.error || '')), 'binary refused/routed, not leaked as text');
});

test('behavior: .png 图片不被二进制守卫拦截(仍走图片/OCR 专路)', async () => {
  const p = path.join(os.tmpdir(), 'khy_parity_img_' + process.pid + '.png');
  fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f5f0000000049454e44ae426082', 'hex'));
  const r = await FileReadTool.execute({ file_path: p });
  fs.unlinkSync(p);
  assert.ok(r.type === 'image' || r._ocrFallback || (r.success === false && /image/i.test(r.error || '')), 'image handled by image branch, not binary-refused');
  assert.notEqual(r.binary, true, 'must not be flagged binary');
});

// FIFO 阻塞防护(POSIX only;非 POSIX 平台无 mkfifo → 跳过)。
test('behavior: FIFO 被特殊文件守卫瞬时拦下(不卡死)', (t) => {
  if (process.platform === 'win32') return t.skip('non-POSIX: no mkfifo');
  const fifo = path.join(os.tmpdir(), 'khy_parity_fifo_' + process.pid);
  try { fs.unlinkSync(fifo); } catch { /* absent */ }
  try { cp.execSync('mkfifo ' + fifo); } catch { return t.skip('mkfifo unavailable'); }
  return FileReadTool.execute({ file_path: fifo }).then((r) => {
    fs.unlinkSync(fifo);
    assert.equal(r.success, false, 'FIFO read refused (not hung)');
    assert.ok(r.specialFile || /特殊|设备|管道|FIFO/i.test(r.error || ''), 'refusal names special file');
  });
});
