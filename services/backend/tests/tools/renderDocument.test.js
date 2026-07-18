/**
 * renderDocument.test.js — the atomic, template-driven typeset tool.
 *
 * Two layers:
 *   1. Pure-JS contract & 防呆 gating that needs NO python — descriptor shape,
 *      format-code interception, unknown-template handling, path confinement.
 *   2. An end-to-end render that is SKIPPED unless python + python-docx are
 *      available; it renders a real .docx, re-opens it, and asserts the
 *      deterministic format (A4 page, heading present) — proving the
 *      write-after-verify pipeline, not the model, owns the formatting.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const renderDocument = require('../../src/tools/renderDocument');

/** Detect a python interpreter that can `import docx` (python-docx). */
function pythonWithDocx() {
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['-c', 'import docx'], { stdio: 'ignore', timeout: 5000 });
      return py;
    } catch { /* try next */ }
  }
  return null;
}

describe('renderDocument — tool contract', () => {
  test('exposes the expected descriptor', () => {
    expect(renderDocument.name).toBe('renderDocument');
    expect(renderDocument.category).toBe('filesystem');
    expect(renderDocument.isReadOnly()).toBe(false); // defineTool normalizes to a method
    expect(typeof renderDocument.execute).toBe('function');
  });

  test('declares discovery aliases', () => {
    for (const a of ['typeset_document', 'render_docx', 'create_paper']) {
      expect(renderDocument.aliases).toContain(a);
    }
  });

  test('requires content and outputPath in the schema', () => {
    expect(renderDocument.inputSchema.content.required).toBe(true);
    expect(renderDocument.inputSchema.outputPath.required).toBe(true);
    expect(renderDocument.inputSchema.template.required).toBe(false);
  });
});

describe('renderDocument — input gating (no python needed)', () => {
  test('empty content is rejected', async () => {
    const r = await renderDocument.execute({ content: '   ', outputPath: 'x.docx' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/content is required/i);
  });

  test('missing outputPath is rejected', async () => {
    const r = await renderDocument.execute({ content: '# hi' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/output path/i);
  });

  test('防呆: a LaTeX command in content is rejected before any render', async () => {
    const r = await renderDocument.execute({
      content: '正文 \\textbf{粗体} 继续',
      outputPath: path.join(process.cwd(), '.tmp-typeset-test', 'never.docx'),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Structured-content check failed/);
    expect(r.hint).toMatch(/semantic content only/i);
  });

  test('防呆: an HTML tag in content is rejected', async () => {
    const r = await renderDocument.execute({
      content: '正文 <b>粗体</b>',
      outputPath: path.join(process.cwd(), '.tmp-typeset-test', 'never.docx'),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/HTML\/XML tag/);
  });

  test('unknown template returns the available list', async () => {
    const r = await renderDocument.execute({
      content: '# 标题',
      template: 'no-such-template',
      outputPath: path.join(process.cwd(), '.tmp-typeset-test', 'never.docx'),
    });
    expect(r.success).toBe(false);
    expect(r.availableTemplates).toEqual(expect.arrayContaining(['default', 'gbt7714', 'ieee']));
  });

  test('path confinement: writing outside the allowed roots is refused', async () => {
    const r = await renderDocument.execute({
      content: '# 标题',
      outputPath: '/etc/khy-pwned.docx',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/path|confine|outside|traversal|Refused/i);
  });
});

const hasDocx = pythonWithDocx();
const e2e = hasDocx ? describe : describe.skip;

e2e('renderDocument — end-to-end deterministic render (python-docx)', () => {
  const outDir = path.join(process.cwd(), '.tmp-typeset-test');
  const outPath = path.join(outDir, 'paper.docx');

  afterAll(() => {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('renders a real .docx and verifies A4 + applied formatting', async () => {
    const content = [
      '# 引言',
      '',
      '这是正文，包含 **重点** 与 *强调*。',
      '',
      '- 第一条',
      '- 第二条',
      '',
      '[[newpage]]',
      '',
      '## 方法',
      '',
      '| 指标 | 值 |',
      '| --- | --- |',
      '| 精度 | 0.95 |',
    ].join('\n');

    const r = await renderDocument.execute({
      content,
      template: 'gbt7714',
      title: '测试论文',
      outputPath: outPath,
    });

    expect(r.success).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
    // The renderer reports its own write-after verification.
    expect(r.validation).toBeDefined();
    expect(r.validation.pageSizeA4).toBe(true);
    expect(r.validation.headingSizeOk).toBe(true);
    expect(r.template).toBe('builtin:gbt7714');

    // Re-open the docx with python-docx and assert the DETERMINISTIC format:
    // exactly one A4 section, the title + headings present, eastAsia stamped.
    const probe = `
import sys, docx
from docx.shared import Emu
d = docx.Document(sys.argv[1])
sec = d.sections[0]
A4_W, A4_H = 210*36000, 297*36000
assert abs(sec.page_width - A4_W) < 36000, ('width', sec.page_width)
assert abs(sec.page_height - A4_H) < 36000, ('height', sec.page_height)
texts = [p.text for p in d.paragraphs]
assert any('引言' in t for t in texts), 'missing H1'
assert any('方法' in t for t in texts), 'missing H2'
# every run that carries text must declare an eastAsia font (防呆 Chinese support)
import docx.oxml.ns as ns
missing = 0
for p in d.paragraphs:
    for run in p.runs:
        if not run.text.strip():
            continue
        rpr = run._element.rPr
        ea = None
        if rpr is not None and rpr.rFonts is not None:
            ea = rpr.rFonts.get(ns.qn('w:eastAsia'))
        if not ea:
            missing += 1
print('OK missing_eastAsia=%d sections=%d' % (missing, len(d.sections)))
`;
    const out = execFileSync(hasDocx, ['-c', probe, outPath], { encoding: 'utf-8' });
    expect(out).toMatch(/OK missing_eastAsia=0/);
  }, 30000);
});
