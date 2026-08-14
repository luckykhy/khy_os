'use strict';

/**
 * docTitleStyle.test.js — the first capability-as-code instance.
 *
 * Covers:
 *   - Tool contract (name / not read-only / capability metadata + declared tests)
 *   - Shared-core orchestration via an INJECTED spawn (no Python needed): the
 *     correct docHelper argv (input/output + --match/--style/--size/--color) and
 *     the default sibling *.styled.docx output.
 *   - Fail-soft guards: missing Python → needsDep; nothing-to-change.
 *   - python-docx-gated e2e: build a real .docx, restyle the title, reopen and
 *     assert the run font size + color actually changed.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

// Treat the fixture dir as "the project" so write-path confinement passes.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-doctitle-'));
process.env.KHYQUANT_CWD = FIXTURE_DIR;

const tool = require('../src/tools/docTitleStyle');
const { runTitleStyle } = require('../src/cli/handlers/doc');

function _hasPythonDocx() {
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['-c', 'import docx'], { stdio: 'ignore', timeout: 5000 });
      return py;
    } catch { /* try next */ }
  }
  return null;
}

/** A fake `spawn` that records argv and replays a canned JSON result. */
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

describe('docTitleStyle — 工具契约', () => {
  test('名称 / 非只读 / 别名', () => {
    assert.equal(tool.name, 'docTitleStyle');
    const ro = typeof tool.isReadOnly === 'function' ? tool.isReadOnly() : tool.isReadOnly;
    assert.equal(ro, false);
    assert.ok(tool.aliases.includes('restyle_title'));
  });

  test('携带 capability 元数据并声明测试', () => {
    assert.ok(tool.capability, 'tool.capability should exist');
    assert.ok(Array.isArray(tool.capability.tests) && tool.capability.tests.length > 0);
    assert.ok(tool.capability.tests.includes('tests/docTitleStyle.test.js'));
    assert.deepEqual(tool.capability.surfaces, ['cli', 'agent', 'mcp']);
  });

  test('capability 不泄漏给模型（toFunctionDef）', () => {
    const def = tool.toFunctionDef();
    assert.equal('capability' in def, false);
    assert.ok(def.parameters.properties.path);
  });
});

describe('docTitleStyle — 共核编排（注入 spawn，无需 Python）', () => {
  test('传入 match/size/color → docHelper argv 正确', async () => {
    const captured = {};
    const inPath = path.join(FIXTURE_DIR, 'doc.docx');
    fs.writeFileSync(inPath, 'stub'); // existence not required by core, but realistic
    const res = await runTitleStyle(
      { path: inPath, output: path.join(FIXTURE_DIR, 'out.docx'), match: '财务报表', size: 18, color: '#C00000' },
      { spawn: _fakeSpawn(captured, { success: true, output: path.join(FIXTURE_DIR, 'out.docx'), changed: 2, matchedParagraphs: 1 }), findPython: () => 'python3' },
    );
    assert.equal(res.success, true);
    // argv = [docHelper.py, 'title-style', input, output, --match …]
    assert.equal(captured.argv[1], 'title-style');
    assert.equal(captured.argv[2], inPath);
    assert.equal(captured.argv[3], path.join(FIXTURE_DIR, 'out.docx'));
    const flags = captured.argv.slice(4);
    assert.deepEqual(flags, ['--match', '财务报表', '--size', '18', '--color', '#C00000']);
  });

  test('省略 output → 默认 sibling *.styled.docx', async () => {
    const captured = {};
    const inPath = path.join(FIXTURE_DIR, 'report.docx');
    await runTitleStyle(
      { path: inPath, size: 16 },
      { spawn: _fakeSpawn(captured, { success: true, output: 'x', changed: 1, matchedParagraphs: 1 }), findPython: () => 'python3' },
    );
    assert.equal(captured.argv[3], path.join(FIXTURE_DIR, 'report.styled.docx'));
  });

  test('缺 Python → needsDep（不崩）', async () => {
    const res = await runTitleStyle(
      { path: path.join(FIXTURE_DIR, 'a.docx'), size: 14 },
      { findPython: () => { throw new Error('no python'); } },
    );
    assert.equal(res.success, false);
    assert.equal(res.needsDep, true);
    assert.match(res.hint, /khy-os\[doc\]/);
  });

  test('既无 size 也无 color → 明确报错', async () => {
    const res = await runTitleStyle({ path: path.join(FIXTURE_DIR, 'a.docx') });
    assert.equal(res.success, false);
    assert.match(res.error, /size|color/i);
  });

  test('缺输入路径 → 报错', async () => {
    const res = await runTitleStyle({ size: 12 });
    assert.equal(res.success, false);
  });
});

describe('docTitleStyle — 真实 .docx 端到端（依赖 python-docx）', () => {
  const py = _hasPythonDocx();

  test('改一级标题字号+颜色，重开断言生效', { skip: py ? false : 'python-docx 不可用' }, async () => {
    const inPath = path.join(FIXTURE_DIR, 'e2e.docx');
    const buildScript = [
      'from docx import Document',
      'd = Document()',
      "d.add_heading('季度财务报表', level=1)",
      "d.add_paragraph('正文内容。')",
      `d.save(${JSON.stringify(inPath)})`,
    ].join('\n');
    execFileSync(py, ['-c', buildScript], { stdio: 'ignore', timeout: 15000 });

    const outPath = path.join(FIXTURE_DIR, 'e2e.styled.docx');
    const res = await runTitleStyle({ path: inPath, output: outPath, style: 'Heading 1', size: 18, color: 'C00000' });
    assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
    assert.ok(res.matchedParagraphs >= 1);
    assert.ok(res.changed >= 1);
    assert.ok(fs.existsSync(outPath));

    // Reopen and assert the heading run's size (Pt→EMU: 18pt = 228600) and color.
    const checkScript = [
      'from docx import Document',
      `d = Document(${JSON.stringify(outPath)})`,
      "h = [p for p in d.paragraphs if p.style and p.style.name == 'Heading 1'][0]",
      'r = h.runs[0]',
      'import json',
      "print(json.dumps({'size': r.font.size.pt if r.font.size else None, 'color': str(r.font.color.rgb) if r.font.color and r.font.color.rgb else None}))",
    ].join('\n');
    const out = execFileSync(py, ['-c', checkScript], { encoding: 'utf-8', timeout: 15000 });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.size, 18);
    assert.equal(parsed.color, 'C00000');
  });

  test('文本定位（match）命中具体标题', { skip: py ? false : 'python-docx 不可用' }, async () => {
    const inPath = path.join(FIXTURE_DIR, 'match.docx');
    const buildScript = [
      'from docx import Document',
      'd = Document()',
      "d.add_heading('第一章', level=1)",
      "d.add_heading('第二章', level=1)",
      `d.save(${JSON.stringify(inPath)})`,
    ].join('\n');
    execFileSync(py, ['-c', buildScript], { stdio: 'ignore', timeout: 15000 });

    const outPath = path.join(FIXTURE_DIR, 'match.styled.docx');
    const res = await runTitleStyle({ path: inPath, output: outPath, match: '第二章', color: '0000FF' });
    assert.equal(res.success, true);
    assert.equal(res.matchedParagraphs, 1, 'only the exact-text match should be restyled');
  });

  test('无命中 → success:false + 提示换 match/style', { skip: py ? false : 'python-docx 不可用' }, async () => {
    const inPath = path.join(FIXTURE_DIR, 'nomatch.docx');
    execFileSync(py, ['-c', [
      'from docx import Document',
      'd = Document()',
      "d.add_heading('标题', level=1)",
      `d.save(${JSON.stringify(inPath)})`,
    ].join('\n')], { stdio: 'ignore', timeout: 15000 });

    const res = await runTitleStyle({ path: inPath, output: path.join(FIXTURE_DIR, 'nomatch.styled.docx'), match: '不存在的标题', size: 14 });
    assert.equal(res.success, false);
    assert.equal(res.changed, 0);
    assert.ok(res.hint);
  });
});
