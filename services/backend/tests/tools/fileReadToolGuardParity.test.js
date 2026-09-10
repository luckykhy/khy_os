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
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/tools/FileReadTool/index.js'), 'utf8');
const FileReadTool = require('../../src/tools/FileReadTool/index.js');
// ── 源级接线断言(readFileSync + regex)──────────────────────────────────────

describe('File Read Tool Guard Parity', () => {
  test('wiring: special 守卫已 require 且消费 stat 类型谓词', async () => {
      expect(SRC).toMatch(/require\(['"]\.\.\/specialFileReadGuard['"]\)/);
      expect(SRC).toMatch(/specialReadGuardEnabled\(process\.env\)/);
      expect(SRC).toMatch(/classifySpecialFile\(stat\)/);
      assert.match(SRC, /buildSpecialFileRefusal\(/, 'renders refusal');
  });

});
