'use strict';

/**
 * convertFile.test.js — the second capability-as-code instance (DESIGN-ARCH-059).
 *
 * Covers:
 *   - Tool contract (name / not read-only / aliases / capability metadata +
 *     declared tests; capability does NOT leak into toFunctionDef).
 *   - Shared-core routing via an INJECTED spawn (no Python needed): each
 *     source→target pair maps to the correct docHelper subcommand + argv,
 *     including multi-image merge, default output names, unsupported pairs,
 *     missing-python (needsDep) and missing-input guards.
 *   - python-gated e2e (import PIL / docx / pypdf probed independently): build
 *     real files and assert the conversions actually produce the target format.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

// Treat the fixture dir as "the project" so write-path confinement passes.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-convert-'));
process.env.KHYQUANT_CWD = FIXTURE_DIR;

const tool = require('../src/tools/convertFile');
const { runConvert } = require('../src/cli/handlers/convert');

/** Probe whether a given Python import is available; returns the interpreter or null. */
function _hasPy(mod) {
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['-c', `import ${mod}`], { stdio: 'ignore', timeout: 5000 });
      return py;
    } catch { /* try next */ }
  }
  return null;
}

/** A fake `spawn` that records (cmd, argv) and replays a canned JSON result. */
function _fakeSpawn(captured, payload) {
  return (cmd, argv) => {
    captured.cmd = cmd;
    captured.argv = argv;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify(payload));
      child.emit('close', 0);
    });
    return child;
  };
}

after(() => {
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('convertFile — 工具契约', () => {
  test('名称 / 非只读 / 别名', () => {
    assert.equal(tool.name, 'convertFile');
    const ro = typeof tool.isReadOnly === 'function' ? tool.isReadOnly() : tool.isReadOnly;
    assert.equal(ro, false);
    assert.ok(tool.aliases.includes('convert'));
    assert.ok(tool.aliases.includes('image_to_pdf'));
  });

  test('携带 capability 元数据并声明测试', () => {
    assert.ok(tool.capability, 'tool.capability should exist');
    assert.ok(Array.isArray(tool.capability.tests) && tool.capability.tests.length > 0);
    assert.ok(tool.capability.tests.includes('tests/convertFile.test.js'));
    assert.deepEqual(tool.capability.surfaces, ['cli', 'agent', 'mcp']);
  });

  test('capability 不泄漏给模型（toFunctionDef）', () => {
    const def = tool.toFunctionDef();
    assert.equal('capability' in def, false);
    assert.ok(def.parameters.properties.input);
    assert.ok(def.parameters.properties.to);
  });
});

describe('convertFile — 共核路由（注入 spawn，无需 Python）', () => {
  const py = () => 'python3';

  test('图片→PDF（单张）→ img2pdf argv 正确', async () => {
    const captured = {};
    const img = path.join(FIXTURE_DIR, 'a.png');
    fs.writeFileSync(img, 'stub');
    const out = path.join(FIXTURE_DIR, 'a.pdf');
    const res = await runConvert(
      { input: img, to: 'pdf' },
      { spawn: _fakeSpawn(captured, { success: true, output: out, pages: 1 }), findPython: py },
    );
    assert.equal(res.success, true);
    assert.equal(captured.argv[1], 'img2pdf');
    // argv = [docHelper.py, 'img2pdf', <out.pdf>, <img...>]
    assert.equal(captured.argv[2], path.join(FIXTURE_DIR, 'a.pdf'));
    assert.deepEqual(captured.argv.slice(3), [img]);
  });

  test('多图→单 PDF（合并）→ argv 含全部图片，默认 *.merged.pdf', async () => {
    const captured = {};
    const i1 = path.join(FIXTURE_DIR, 'p1.png');
    const i2 = path.join(FIXTURE_DIR, 'p2.png');
    fs.writeFileSync(i1, 'stub'); fs.writeFileSync(i2, 'stub');
    const res = await runConvert(
      { input: `${i1},${i2}` },
      { spawn: _fakeSpawn(captured, { success: true, output: 'x', pages: 2 }), findPython: py },
    );
    assert.equal(res.success, true);
    assert.equal(captured.argv[1], 'img2pdf');
    assert.equal(captured.argv[2], path.join(FIXTURE_DIR, 'p1.merged.pdf'));
    assert.deepEqual(captured.argv.slice(3), [i1, i2]);
  });

  test('PDF→TXT → pdf2txt argv 正确（默认 sibling .txt）', async () => {
    const captured = {};
    const pdf = path.join(FIXTURE_DIR, 'doc.pdf');
    fs.writeFileSync(pdf, 'stub');
    const res = await runConvert(
      { input: pdf },
      { spawn: _fakeSpawn(captured, { success: true, output: 'x', chars: 10 }), findPython: py },
    );
    assert.equal(res.success, true);
    assert.equal(captured.argv[1], 'pdf2txt');
    assert.equal(captured.argv[2], pdf);
    assert.equal(captured.argv[3], path.join(FIXTURE_DIR, 'doc.txt'));
  });

  test('PDF→Word → 复用 pdf2word argv', async () => {
    const captured = {};
    const pdf = path.join(FIXTURE_DIR, 'rep.pdf');
    fs.writeFileSync(pdf, 'stub');
    const res = await runConvert(
      { input: pdf, to: 'docx' },
      { spawn: _fakeSpawn(captured, { success: true, output: 'x' }), findPython: py },
    );
    assert.equal(res.success, true);
    assert.equal(captured.argv[1], 'pdf2word');
    assert.equal(captured.argv[3], path.join(FIXTURE_DIR, 'rep.docx'));
  });

  test('Word→TXT → docx2txt argv 正确', async () => {
    const captured = {};
    const docx = path.join(FIXTURE_DIR, 'w.docx');
    fs.writeFileSync(docx, 'stub');
    const res = await runConvert(
      { input: docx },
      { spawn: _fakeSpawn(captured, { success: true, output: 'x', chars: 5 }), findPython: py },
    );
    assert.equal(res.success, true);
    assert.equal(captured.argv[1], 'docx2txt');
    assert.equal(captured.argv[3], path.join(FIXTURE_DIR, 'w.txt'));
  });

  test('TXT→Word → txt2docx argv 正确', async () => {
    const captured = {};
    const txt = path.join(FIXTURE_DIR, 'n.txt');
    fs.writeFileSync(txt, 'stub');
    const res = await runConvert(
      { input: txt },
      { spawn: _fakeSpawn(captured, { success: true, output: 'x' }), findPython: py },
    );
    assert.equal(res.success, true);
    assert.equal(captured.argv[1], 'txt2docx');
    assert.equal(captured.argv[3], path.join(FIXTURE_DIR, 'n.docx'));
  });

  test('不支持的 pair（txt→pdf）→ 干净错误', async () => {
    const txt = path.join(FIXTURE_DIR, 'x.txt');
    fs.writeFileSync(txt, 'stub');
    const res = await runConvert({ input: txt, to: 'pdf' }, { findPython: py });
    assert.equal(res.success, false);
    assert.match(res.error, /No conversion|Supported/i);
  });

  test('未知输入类型 → 干净错误', async () => {
    const bin = path.join(FIXTURE_DIR, 'x.bin');
    fs.writeFileSync(bin, 'stub');
    const res = await runConvert({ input: bin }, { findPython: py });
    assert.equal(res.success, false);
    assert.match(res.error, /Unsupported input/i);
  });

  test('缺 Python → needsDep（不崩）', async () => {
    const img = path.join(FIXTURE_DIR, 'np.png');
    fs.writeFileSync(img, 'stub');
    const res = await runConvert(
      { input: img, to: 'pdf' },
      { findPython: () => { throw new Error('no python'); } },
    );
    assert.equal(res.success, false);
    assert.equal(res.needsDep, true);
    assert.match(res.hint, /khy-os\[doc\]/);
  });

  test('缺输入 → 报错', async () => {
    const res = await runConvert({});
    assert.equal(res.success, false);
  });

  test('输入文件不存在 → 报错', async () => {
    const res = await runConvert(
      { input: path.join(FIXTURE_DIR, 'ghost.pdf') },
      { findPython: py },
    );
    assert.equal(res.success, false);
    assert.match(res.error, /not found/i);
  });
});

describe('convertFile — 真实端到端（依赖 Pillow / python-docx / pypdf）', () => {
  const pilPy = _hasPy('PIL');
  const docxPy = _hasPy('docx');
  const pypdfPy = _hasPy('pypdf');

  test('图片→PDF：造 PNG（含 RGBA）→ 输出以 %PDF 开头', { skip: pilPy ? false : 'Pillow 不可用' }, async () => {
    const img = path.join(FIXTURE_DIR, 'e2e_a.png');
    execFileSync(pilPy, ['-c', [
      'from PIL import Image',
      "Image.new('RGBA', (40, 30), (200, 30, 30, 255)).save(" + JSON.stringify(img) + ')',
    ].join('\n')], { stdio: 'ignore', timeout: 15000 });

    const out = path.join(FIXTURE_DIR, 'e2e_a.pdf');
    const res = await runConvert({ input: img, output: out });
    assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
    assert.ok(fs.existsSync(out));
    const head = fs.readFileSync(out).slice(0, 4).toString('latin1');
    assert.equal(head, '%PDF');
  });

  test('多图→单 PDF：两张 PNG → 合并；有 pypdf 时断言 2 页', { skip: pilPy ? false : 'Pillow 不可用' }, async () => {
    const i1 = path.join(FIXTURE_DIR, 'm1.png');
    const i2 = path.join(FIXTURE_DIR, 'm2.png');
    execFileSync(pilPy, ['-c', [
      'from PIL import Image',
      "Image.new('RGB', (20, 20), (10, 10, 10)).save(" + JSON.stringify(i1) + ')',
      "Image.new('RGB', (20, 20), (250, 250, 250)).save(" + JSON.stringify(i2) + ')',
    ].join('\n')], { stdio: 'ignore', timeout: 15000 });

    const out = path.join(FIXTURE_DIR, 'merged.pdf');
    const res = await runConvert({ input: [i1, i2], output: out });
    assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
    assert.ok(fs.existsSync(out));
    if (pypdfPy) {
      const n = execFileSync(pypdfPy, ['-c', [
        'from pypdf import PdfReader',
        `print(len(PdfReader(${JSON.stringify(out)}).pages))`,
      ].join('\n')], { encoding: 'utf-8', timeout: 15000 }).trim();
      assert.equal(n, '2');
    }
  });

  test('TXT→Word→TXT 往返：保留中文内容', { skip: docxPy ? false : 'python-docx 不可用' }, async () => {
    const txt = path.join(FIXTURE_DIR, 'rt.txt');
    fs.writeFileSync(txt, '第一行\n第二行', 'utf-8');

    const docx = path.join(FIXTURE_DIR, 'rt.docx');
    const r1 = await runConvert({ input: txt, output: docx });
    assert.equal(r1.success, true, `txt→docx failed: ${JSON.stringify(r1)}`);
    assert.ok(fs.existsSync(docx));

    const backTxt = path.join(FIXTURE_DIR, 'rt.back.txt');
    const r2 = await runConvert({ input: docx, output: backTxt });
    assert.equal(r2.success, true, `docx→txt failed: ${JSON.stringify(r2)}`);
    const back = fs.readFileSync(backTxt, 'utf-8');
    assert.match(back, /第一行/);
    assert.match(back, /第二行/);
  });

  test('PDF→TXT：从含文本层的 PDF 提取文字', { skip: (pypdfPy && _hasPy('reportlab')) ? false : 'pypdf+reportlab 不可用' }, async () => {
    // Build a text-layer PDF with reportlab (only run when present).
    const pdf = path.join(FIXTURE_DIR, 'text.pdf');
    execFileSync(pypdfPy, ['-c', [
      'from reportlab.pdfgen import canvas',
      `c = canvas.Canvas(${JSON.stringify(pdf)})`,
      "c.drawString(72, 720, 'HelloKhyos')",
      'c.save()',
    ].join('\n')], { stdio: 'ignore', timeout: 15000 });

    const out = path.join(FIXTURE_DIR, 'text.txt');
    const res = await runConvert({ input: pdf, output: out });
    assert.equal(res.success, true, `pdf→txt failed: ${JSON.stringify(res)}`);
    const body = fs.readFileSync(out, 'utf-8');
    assert.match(body, /HelloKhyos/);
  });
});
