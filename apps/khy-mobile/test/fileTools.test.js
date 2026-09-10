// 文件操作工具测试
// 验证：免 root 文件操作工具已正确注册，参数定义完整
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSrc = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('文件操作工具注册', () => {
  it('localTools.js 包含 5 个文件操作工具', () => {
    const src = readSrc('src/api/localTools.js');
    expect(src).toMatch(/name: 'khy\.local\.fileList'/);
    expect(src).toMatch(/name: 'khy\.local\.fileRead'/);
    expect(src).toMatch(/name: 'khy\.local\.fileWrite'/);
    expect(src).toMatch(/name: 'khy\.local\.fileDelete'/);
    expect(src).toMatch(/name: 'khy\.local\.fileInfo'/);
  });

  it('fileList 工具使用 Directory.Documents', () => {
    const src = readSrc('src/api/localTools.js');
    // 找到 fileList 工具的完整定义块
    const block = extractToolBlock(src, 'khy.local.fileList');
    expect(block).toMatch(/Directory\.Documents/);
    expect(block).toMatch(/Filesystem\.readdir/);
  });

  it('fileRead 工具使用 Encoding.UTF8', () => {
    const src = readSrc('src/api/localTools.js');
    const block = extractToolBlock(src, 'khy.local.fileRead');
    expect(block).toMatch(/Encoding\.UTF8/);
    expect(block).toMatch(/Filesystem\.readFile/);
  });

  it('fileWrite 工具支持 append 模式', () => {
    const src = readSrc('src/api/localTools.js');
    const block = extractToolBlock(src, 'khy.local.fileWrite');
    expect(block).toMatch(/append/);
    expect(block).toMatch(/Filesystem\.writeFile/);
    expect(block).toMatch(/mkdir/);
  });

  it('fileDelete 工具调用 deleteFile', () => {
    const src = readSrc('src/api/localTools.js');
    const block = extractToolBlock(src, 'khy.local.fileDelete');
    expect(block).toMatch(/deleteFile/);
  });

  it('fileInfo 工具调用 Filesystem.stat', () => {
    const src = readSrc('src/api/localTools.js');
    const block = extractToolBlock(src, 'khy.local.fileInfo');
    expect(block).toMatch(/Filesystem\.stat/);
  });

  it('所有文件工具使用 @capacitor/filesystem', () => {
    const src = readSrc('src/api/localTools.js');
    // 检查动态 import 语句（在 execute 函数内）
    expect(src).toMatch(/await import\('@capacitor\/filesystem'\)/);
    // 检查 Directory.Documents 被使用
    expect(src).toMatch(/Directory\.Documents/);
  });

  it('Agent system prompt 包含文件工具', () => {
    const src = readSrc('src/api/mobileAgent.js');
    expect(src).toMatch(/fileList/);
    expect(src).toMatch(/fileRead/);
    expect(src).toMatch(/fileWrite/);
    expect(src).toMatch(/fileDelete/);
    expect(src).toMatch(/fileInfo/);
  });
});

// 辅助函数：从源码中提取指定工具的代码块（包含 execute 函数体）
function extractToolBlock(src, toolName) {
  // 匹配从 name: 'toolName' 开始到 execute 函数结束的完整块
  const regex = new RegExp(`name: '${toolName}'[\\s\\S]*?execute\\([\\s\\S]*?\\n  \\},`);
  const m = src.match(regex);
  return m ? m[0] : '';
}
