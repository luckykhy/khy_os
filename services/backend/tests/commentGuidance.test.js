'use strict';

/**
 * commentGuidance — 「什么地方该写什么样的注释」确定性引擎 unit tests.
 *
 * 覆盖三件事:
 *  1. classifyCommentNeed —— 给定作用域/导出/非显然,确定性地落到正确的注释层(file-header /
 *     api-doc / inline-why / todo / none),且 required 标志正确。
 *  2. buildCommentGuidanceDirective —— 内容契约(五层都点到、强调 WHY 而非 WHAT)。
 *  3. auditComments —— 零假阳性优先:有头注释/有文档的代码不报;缺头/缺文档/死代码/裸 TODO
 *     才报,行号与 severity 正确。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  COMMENT_LAYERS,
  classifyCommentNeed,
  languageFromPath,
  normalizeLang,
  syntaxFor,
  buildCommentGuidanceDirective,
  auditComments,
} = require('../src/services/commentGuidance');

describe('classifyCommentNeed — which comment layer belongs where', () => {
  test('file scope → file-header, required', () => {
    const r = classifyCommentNeed({ scope: 'file' });
    assert.equal(r.layer, 'file-header');
    assert.equal(r.required, true);
  });
  test('class scope → api-doc, required', () => {
    assert.equal(classifyCommentNeed({ scope: 'class' }).layer, 'api-doc');
    assert.equal(classifyCommentNeed({ scope: 'class' }).required, true);
  });
  test('exported function → api-doc, required', () => {
    const r = classifyCommentNeed({ scope: 'function', exported: true });
    assert.equal(r.layer, 'api-doc');
    assert.equal(r.required, true);
  });
  test('private complex function → api-doc, NOT required', () => {
    const r = classifyCommentNeed({ scope: 'function', exported: false, complexity: 3 });
    assert.equal(r.layer, 'api-doc');
    assert.equal(r.required, false);
  });
  test('trivial private function → none', () => {
    assert.equal(classifyCommentNeed({ scope: 'function' }).layer, 'none');
  });
  test('workaround statement → inline-why, required', () => {
    const r = classifyCommentNeed({ scope: 'statement', isWorkaround: true });
    assert.equal(r.layer, 'inline-why');
    assert.equal(r.required, true);
  });
  test('non-obvious statement → inline-why, not required', () => {
    const r = classifyCommentNeed({ scope: 'statement', nonObvious: true });
    assert.equal(r.layer, 'inline-why');
    assert.equal(r.required, false);
  });
  test('plain self-explanatory statement → none', () => {
    assert.equal(classifyCommentNeed({ scope: 'statement' }).layer, 'none');
  });
  test('todo flag → todo layer regardless of scope', () => {
    assert.equal(classifyCommentNeed({ scope: 'function', isTodo: true }).layer, 'todo');
  });
  test('guidance string is non-empty and carries the layer title', () => {
    const r = classifyCommentNeed({ scope: 'file' });
    assert.ok(r.guidance.includes(COMMENT_LAYERS['file-header'].title));
  });
});

describe('language normalization', () => {
  test('extensions map to canonical languages', () => {
    assert.equal(languageFromPath('a/b.py'), 'python');
    assert.equal(languageFromPath('k.c'), 'c');
    assert.equal(languageFromPath('x.ts'), 'ts');
    assert.equal(languageFromPath('x.jsx'), 'js');
  });
  test('unknown defaults to js', () => {
    assert.equal(normalizeLang('rust'), 'js');
  });
  test('syntaxFor exposes per-language doc style', () => {
    assert.equal(syntaxFor('python').doc, 'docstring');
    assert.equal(syntaxFor('c').doc, 'Doxygen');
    assert.equal(syntaxFor('js').doc, 'JSDoc');
  });
});

describe('buildCommentGuidanceDirective — content contract', () => {
  const d = buildCommentGuidanceDirective();
  test('mentions all five layers', () => {
    assert.match(d, /File header/);
    assert.match(d, /API doc/);
    assert.match(d, /Inline "why"/);
    assert.match(d, /TODO/);
    assert.match(d, /None/);
  });
  test('emphasizes WHY over WHAT', () => {
    assert.match(d, /WHY, never WHAT/);
  });
  test('forbids restating code', () => {
    assert.match(d, /Never restate code/);
  });
});

describe('auditComments — zero false positive on good code', () => {
  test('documented file with documented export → no findings', () => {
    const src = [
      '/**', ' * purpose of file.', ' */',
      '/**', ' * does the thing.', ' * @returns {number}', ' */',
      'function doThing() { return 1; }',
      ...Array.from({ length: 14 }, (_, i) => `const k${i} = ${i};`),
      'module.exports = { doThing };',
    ].join('\n');
    assert.equal(auditComments({ source: src, lang: 'js' }).summary.total, 0);
  });
  test('short trivial file → no missing-file-header (below threshold)', () => {
    const src = 'const x = 1;\nmodule.exports = { x };';
    assert.equal(auditComments({ source: src, lang: 'js' }).summary.byKind['missing-file-header'], undefined);
  });
  test('python def with docstring → no undocumented-export', () => {
    const src = 'def f(a):\n    """does f."""\n    return a';
    assert.equal(auditComments({ source: src, lang: 'python' }).summary.total, 0);
  });
  test('private python def (underscore) is not required to have docstring', () => {
    const src = 'def _helper(a):\n    return a';
    assert.equal(auditComments({ source: src, lang: 'python' }).summary.total, 0);
  });
});

describe('auditComments — flags real structural gaps', () => {
  test('missing file header on a non-trivial exporting file', () => {
    const src = ['"use strict";',
      ...Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`),
      'module.exports = { v0 };'].join('\n');
    const r = auditComments({ source: src, lang: 'js' });
    assert.equal(r.summary.byKind['missing-file-header'], 1);
  });
  test('undocumented exported symbol → high severity', () => {
    const src = 'function exportedThing(a) { return a; }\nmodule.exports = { exportedThing };';
    const r = auditComments({ source: src, lang: 'js' });
    const f = r.findings.find((x) => x.kind === 'undocumented-export');
    assert.ok(f);
    assert.equal(f.severity, 'high');
    assert.equal(f.line, 1);
  });
  test('commented-out code block (>=2 consecutive code-ish lines)', () => {
    const src = 'const a = 1;\n// const dead = 1;\n// foo(dead);\nconst b = 2;';
    const r = auditComments({ source: src, lang: 'js' });
    const f = r.findings.find((x) => x.kind === 'commented-out-code');
    assert.ok(f);
    assert.equal(f.line, 2);
  });
  test('a single commented line is NOT flagged as dead code', () => {
    const src = 'const a = 1;\n// note: a is the seed\nconst b = 2;';
    const r = auditComments({ source: src, lang: 'js' });
    assert.equal(r.findings.find((x) => x.kind === 'commented-out-code'), undefined);
  });
  test('vague TODO without context → low severity', () => {
    const src = '// TODO\nconst a = 1;';
    const r = auditComments({ source: src, lang: 'js' });
    const f = r.findings.find((x) => x.kind === 'vague-todo');
    assert.ok(f);
    assert.equal(f.severity, 'low');
  });
  test('a TODO with enough context is NOT flagged', () => {
    const src = '// TODO migrate to async API once SDK ships v2\nconst a = 1;';
    const r = auditComments({ source: src, lang: 'js' });
    assert.equal(r.findings.find((x) => x.kind === 'vague-todo'), undefined);
  });
  test('python public def without docstring → undocumented-export', () => {
    const src = 'def public_fn(a):\n    return a';
    const r = auditComments({ source: src, lang: 'python' });
    assert.equal(r.summary.byKind['undocumented-export'], 1);
  });
});

describe('auditComments — return shape', () => {
  test('summary.total matches findings length and byKind sums', () => {
    const src = ['"use strict";',
      'function f(a){return a;}',
      ...Array.from({ length: 16 }, (_, i) => `const v${i} = ${i};`),
      'module.exports = { f };'].join('\n');
    const r = auditComments({ source: src, lang: 'js' });
    assert.equal(r.summary.total, r.findings.length);
    const sum = Object.values(r.summary.byKind).reduce((a, b) => a + b, 0);
    assert.equal(sum, r.findings.length);
  });
  test('empty source → no findings, lang inferred', () => {
    const r = auditComments({ source: '', path: 'x.py' });
    assert.equal(r.summary.total, 0);
    assert.equal(r.lang, 'python');
  });
});
