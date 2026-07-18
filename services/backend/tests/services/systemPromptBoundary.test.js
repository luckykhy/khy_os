'use strict';

/**
 * systemPromptBoundary — golden behavior lock for the extracted dynamic-boundary
 * marker leaf (node:test).
 *
 * Background: the marker constant + `splitSystemPromptAtBoundary` /
 * `stripSystemPromptBoundary` were inlined in the 1802-line `constants/prompts`
 * assembler. Three gateway adapters (`_messageBuilder`, `_protocolPipeline`,
 * `claudeAdapter`) borrowed them, and that one edge pulled the otherwise-pure
 * `_messageBuilder` helper (plus its `_ideTokenMixin` dependent) into the
 * backend's giant dependency SCC. Sinking the trio into a zero-dependency leaf
 * and inverting the dependency shrank the giant SCC 79 -> 77 with byte-identical
 * behavior ([DESIGN-ARCH-051] §6.3). The original prompt tests are Jest (no
 * runner here), so this runnable node:test suite pins "behavior verbatim
 * unchanged" + "leaf is dependency-free" + "prompts.js re-export still identical".
 */

const test = require('node:test');
const assert = require('node:assert');

const boundary = require('../../src/constants/systemPromptBoundary');
const { SYSTEM_PROMPT_DYNAMIC_BOUNDARY: B, splitSystemPromptAtBoundary, stripSystemPromptBoundary } = boundary;

// Verbatim copies of the original inline implementations, as golden baselines.
function _goldenStrip(system) {
  const text = typeof system === 'string' ? system : '';
  if (!text.includes(B)) return text;
  return text
    .replace(new RegExp(`\\n*${B}\\n*`), '\n\n')
    .replace(B, '');
}
function _goldenSplit(system) {
  const text = typeof system === 'string' ? system : '';
  const idx = text.indexOf(B);
  if (idx === -1) return { staticPrefix: '', dynamicSuffix: text };
  const before = text.slice(0, idx).replace(/\n+$/, '');
  const after = text.slice(idx + B.length).replace(/^\n+/, '');
  return { staticPrefix: before, dynamicSuffix: after };
}

const SAMPLES = [
  'STATIC PART\n\n' + B + '\n\nDYNAMIC PART',
  B,
  'no marker here',
  '',
  'prefix only\n\n' + B,
  B + '\n\nsuffix only',
  'a' + B + 'b',
  '多段中文\n\n' + B + '\n\n动态部分',
];

test('strip 与原内联实现逐字等价（golden）', () => {
  for (const s of SAMPLES) {
    assert.strictEqual(stripSystemPromptBoundary(s), _goldenStrip(s), `strip mismatch: ${JSON.stringify(s)}`);
  }
});

test('split 与原内联实现逐字等价（golden）', () => {
  for (const s of SAMPLES) {
    assert.deepStrictEqual(splitSystemPromptAtBoundary(s), _goldenSplit(s), `split mismatch: ${JSON.stringify(s)}`);
  }
});

test('strip 幂等：无 marker 原样返回、剥离后再剥仍稳定', () => {
  assert.strictEqual(stripSystemPromptBoundary('plain'), 'plain');
  const once = stripSystemPromptBoundary('A\n\n' + B + '\n\nB');
  assert.strictEqual(stripSystemPromptBoundary(once), once); // idempotent
  assert.strictEqual(once.includes(B), false);
});

test('非字符串 / 空 → 安全兜底，绝不抛', () => {
  assert.strictEqual(stripSystemPromptBoundary(null), '');
  assert.strictEqual(stripSystemPromptBoundary(undefined), '');
  assert.strictEqual(stripSystemPromptBoundary(42), '');
  assert.deepStrictEqual(splitSystemPromptAtBoundary(null), { staticPrefix: '', dynamicSuffix: '' });
  assert.deepStrictEqual(splitSystemPromptAtBoundary(undefined), { staticPrefix: '', dynamicSuffix: '' });
});

test('叶子模块零依赖（含注释也无 require 调用语法——防架构债扫描器误判幽灵边回退）', () => {
  // The arch-debt scanner matches require-call syntax line-by-line WITHOUT
  // stripping comments; if this file contained that syntax anywhere (even in a
  // comment) it would synthesize a phantom edge back into the assembler and
  // re-pull the leaf into the SCC, undoing the 79->77 decoupling. Assert the
  // whole source is free of any require-call syntax.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/constants/systemPromptBoundary.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'leaf source (incl. comments) must contain no require-call syntax');
});

test('prompts.js 仍 re-export 同一组绑定（导出面逐字不变）', () => {
  const prompts = require('../../src/constants/prompts');
  assert.strictEqual(prompts.SYSTEM_PROMPT_DYNAMIC_BOUNDARY, B);
  assert.strictEqual(prompts.stripSystemPromptBoundary, stripSystemPromptBoundary);
  assert.strictEqual(prompts.splitSystemPromptAtBoundary, splitSystemPromptAtBoundary);
  // assembleSystemPrompt still filters the marker out (internal use intact)
  assert.strictEqual(prompts.assembleSystemPrompt(['A', B, 'C']), 'A\n\nC');
});
