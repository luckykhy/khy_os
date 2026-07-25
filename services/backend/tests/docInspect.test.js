'use strict';

/**
 * docInspect.test.js — inspectDocument 工具的红线测试（能力 B：文档格式精确提取）。
 *
 * 覆盖：
 *   - 工具注册与只读契约
 *   - 文本/Markdown 的进程内结构识别（无需 Python）
 *   - 扩展名↔内容不一致（.txt 实为 PDF）的精确识别
 *   - 二进制文件不强行解析
 *   - 文件不存在的明确报错
 *   - docx 字体/字号/一级标题/首行缩进/行距提取（依赖 python-docx，缺失则跳过）
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 让夹具目录视作「项目内」，绕过写入边界（本工具只读，但复用同一路径封禁）。
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-docinspect-'));
process.env.KHYQUANT_CWD = FIXTURE_DIR;

const tool = require('../src/tools/inspectDocument');

function _hasPythonDocx() {
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['-c', 'import docx'], { stdio: 'ignore', timeout: 5000 });
      return py;
    } catch { /* try next */ }
  }
  return null;
}

after(() => {
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('inspectDocument — 工具契约', () => {
  test('名称/只读/别名', () => {
    assert.equal(tool.name, 'inspectDocument');
    const ro = typeof tool.isReadOnly === 'function' ? tool.isReadOnly() : tool.isReadOnly;
    assert.equal(ro, true);
    assert.ok(tool.aliases.includes('inspect_format'));
  });
});

describe('inspectDocument — 文本/Markdown 进程内识别', () => {
  test('markdown：识别格式 + 结构大纲（无需 Python）', async () => {
    const f = path.join(FIXTURE_DIR, 'a.md');
    fs.writeFileSync(f, '# 标题一\n\n第一段正文。\n\n## 小节\n\n第二段正文。\n');
    const r = await tool.execute({ file_path: f });
    assert.equal(r.success, true);
    assert.equal(r.detection.format, 'markdown');
    assert.equal(r.detection.isBinary, false);
    assert.equal(r.formatting.summary.headingCount, 2);
    assert.deepEqual(r.formatting.outline.map((o) => o.level), [1, 2]);
    assert.equal(r.formatting.outline[0].text, '标题一');
  });

  test('源码 .c：分类为 code，无视觉格式属性', async () => {
    const f = path.join(FIXTURE_DIR, 'main.c');
    fs.writeFileSync(f, 'int main(void){return 0;}\n');
    const r = await tool.execute({ file_path: f });
    assert.equal(r.success, true);
    assert.equal(r.detection.format, 'c');
    assert.equal(r.detection.category, 'code');
    assert.ok(/纯文本|结构/.test(r.formatting.note));
  });
});

describe('inspectDocument — 精确识别（扩展名 vs 内容）', () => {
  test('.txt 实为 PDF → 标记 mismatch，以内容为准', async () => {
    const f = path.join(FIXTURE_DIR, 'mislabeled.txt');
    fs.writeFileSync(f, '%PDF-1.7\nfake pdf body\n');
    const r = await tool.execute({ file_path: f });
    assert.equal(r.success, true);
    assert.equal(r.detection.format, 'pdf');
    assert.equal(r.detection.mismatch, true);
    assert.ok(r.detection.mismatchHint && /pdf/i.test(r.detection.mismatchHint));
  });

  test('二进制图片：不强行解析文本', async () => {
    const f = path.join(FIXTURE_DIR, 'pic.png');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
    const r = await tool.execute({ file_path: f });
    assert.equal(r.success, true);
    assert.equal(r.detection.format, 'png');
    assert.equal(r.detection.isBinary, true);
    assert.equal(r.formatting, null);
  });
});

describe('inspectDocument — 报错', () => {
  test('文件不存在 → 明确报错', async () => {
    const r = await tool.execute({ file_path: path.join(FIXTURE_DIR, 'nope.md') });
    assert.equal(r.success, false);
    assert.ok(/not found/i.test(r.error));
  });
  test('缺 file_path → 报错', async () => {
    const r = await tool.execute({});
    assert.equal(r.success, false);
  });
});

describe('inspectDocument — docx 格式提取（依赖 python-docx）', () => {
  const py = _hasPythonDocx();

  test('字体/字号/一级标题/首行缩进/行距精确提取', { skip: py ? false : 'python-docx 不可用' }, async () => {
    const docxPath = path.join(FIXTURE_DIR, 'fmt.docx');
    const script = [
      'from docx import Document',
      'from docx.shared import Pt',
      'from docx.oxml.ns import qn',
      'd = Document()',
      "d.add_heading('一级标题', level=1)",
      "p = d.add_paragraph('正文用于测试字体字号首行缩进与行距。')",
      'r = p.runs[0]',
      "r.font.name = 'Times New Roman'",
      'r.font.size = Pt(12)',
      "r._element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')",
      'pf = p.paragraph_format',
      'pf.first_line_indent = Pt(24)',
      'pf.line_spacing = 1.5',
      `d.save(${JSON.stringify(docxPath)})`,
    ].join('\n');
    execFileSync(py, ['-c', script], { stdio: 'ignore', timeout: 15000 });

    const r = await tool.execute({ file_path: docxPath });
    assert.equal(r.success, true);
    assert.equal(r.detection.format, 'docx');
    assert.ok(r.formatting && r.formatting.success, 'formatting should succeed');
    const sum = r.formatting.summary;
    assert.equal(sum.bodyFont, '宋体');
    assert.equal(sum.bodySizePt, 12);
    // 一级标题字号来自样式链（python-docx 默认 Heading 1 = 14pt）
    assert.ok(sum.heading1 && sum.heading1.sizePt, 'heading-1 size resolved via style chain');
    // 正文段：首行缩进 2 字符 + 1.5 倍行距
    const body = r.formatting.paragraphs.find((x) => !x.isHeading);
    assert.equal(body.fontAscii, 'Times New Roman');
    assert.equal(body.fontEastAsia, '宋体');
    assert.equal(body.sizePt, 12);
    assert.equal(body.firstLineIndentChars, 2);
    assert.equal(body.lineSpacing, 1.5);
    // 页面几何被读取
    assert.ok(r.formatting.page && typeof r.formatting.page.widthCm === 'number');
  });
});
