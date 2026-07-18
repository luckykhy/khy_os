'use strict';

/**
 * editDiffPreview — pre-write diff preview for the Ink approval dialog.
 *
 * Goal (「让 khy 的 TUI 拥有 cc 一样的真 code 生产能力」):
 *   Claude Code paints the red/green diff INSIDE the edit-approval prompt so a
 *   file edit is reviewed BEFORE the write. khy's default UI (the Ink TUI's
 *   PermissionsPrompt) routes edits through onControlRequest with only raw
 *   params → no diff → in `default` mode the user approves edits blind, seeing
 *   the diff only AFTER the write. This leaf computes {beforeContent,
 *   afterContent} for Write/Edit/MultiEdit without touching disk, so the prompt
 *   can reuse ToolLines' existing red/green renderer.
 *
 * Guard invariants:
 *   ① gate KHY_EDIT_DIFF_PREVIEW default ON; off/0/false/no → OFF (byte-revert → null)
 *   ② write-tool name set locked (guards against silent drift)
 *   ③ Write → after = content; new file → before ''
 *   ④ Edit → old_string→new_string (first occurrence); replace_all → all
 *   ⑤ MultiEdit → edits[] applied in sequence (the case the classic path misses)
 *   ⑥ no visible change (before === after) → null
 *   ⑦ non-write-family tool → null; missing file path → null
 *   ⑧ editing a non-existent file → null; readFile is injectable
 *   ⑨ LIVE wiring: toolCalling attaches diffPreview; PermissionsPrompt renders it;
 *      ToolLines exports renderDiffRows; flagRegistry registers KHY_EDIT_DIFF_PREVIEW
 *
 * node:test (jest via rtk proxy reports Exec format error and is unavailable).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leaf = require('../../src/services/editDiffPreview');

const BACKEND_ROOT = path.resolve(__dirname, '../../');

// A readFile stub backed by an in-memory map; missing keys throw (ENOENT-like).
function mkRead(map) {
  return (p) => {
    if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
    const e = new Error(`ENOENT: no such file '${p}'`);
    e.code = 'ENOENT';
    throw e;
  };
}

// ── ① gate default ON; falsy words → OFF (byte-revert) ────────────────────
test('KHY_EDIT_DIFF_PREVIEW defaults ON, reverts on falsy words', () => {
  assert.strictEqual(leaf.isEditDiffPreviewEnabled({}), true);
  assert.strictEqual(leaf.isEditDiffPreviewEnabled({ KHY_EDIT_DIFF_PREVIEW: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.isEditDiffPreviewEnabled({ KHY_EDIT_DIFF_PREVIEW: off }), false,
      `'${off}' should disable preview`);
  }
  assert.strictEqual(leaf.isEditDiffPreviewEnabled({ KHY_EDIT_DIFF_PREVIEW: '1' }), true);
});

// ── ② write-tool name set locked ──────────────────────────────────────────
test('editDiffPreviewToolNames locks the write-family set', () => {
  const names = leaf.editDiffPreviewToolNames().sort();
  assert.deepStrictEqual(names, [
    'createfile', 'edit', 'editfile', 'multiedit', 'multieditfile', 'write', 'writefile',
  ].sort());
});

// ── ③ Write: after = content; new file → before '' ────────────────────────
test('Write computes after=content; new file → before empty (all-green)', () => {
  const readFile = mkRead({ '/a.txt': 'old line\n' });
  const dp = leaf.computeEditDiffPreview('Write', { file_path: '/a.txt', content: 'new line\n' }, { env: {}, readFile });
  assert.deepStrictEqual(dp, { beforeContent: 'old line\n', afterContent: 'new line\n', filePath: '/a.txt' });

  const dpNew = leaf.computeEditDiffPreview('Write', { file_path: '/new.txt', content: 'hello\n' }, { env: {}, readFile });
  assert.strictEqual(dpNew.beforeContent, '');
  assert.strictEqual(dpNew.afterContent, 'hello\n');
});

// ── ④ Edit: first-occurrence + replace_all ────────────────────────────────
test('Edit applies old→new first occurrence, and replace_all for all', () => {
  const readFile = mkRead({ '/f.js': 'foo bar foo\n' });
  const first = leaf.computeEditDiffPreview('Edit',
    { file_path: '/f.js', old_string: 'foo', new_string: 'baz' }, { env: {}, readFile });
  assert.strictEqual(first.afterContent, 'baz bar foo\n');

  const all = leaf.computeEditDiffPreview('Edit',
    { file_path: '/f.js', old_string: 'foo', new_string: 'baz', replace_all: true }, { env: {}, readFile });
  assert.strictEqual(all.afterContent, 'baz bar baz\n');
});

// ── ⑤ MultiEdit: sequential edits (classic path misses this) ──────────────
test('MultiEdit applies edits[] in sequence', () => {
  const readFile = mkRead({ '/m.js': 'const a = 1;\nconst b = 2;\n' });
  const dp = leaf.computeEditDiffPreview('MultiEdit', {
    file_path: '/m.js',
    edits: [
      { old_string: 'a = 1', new_string: 'a = 10' },
      { old_string: 'b = 2', new_string: 'b = 20' },
    ],
  }, { env: {}, readFile });
  assert.strictEqual(dp.afterContent, 'const a = 10;\nconst b = 20;\n');

  // A later edit that cannot locate its target → whole preview aborts (atomic).
  const bad = leaf.computeEditDiffPreview('MultiEdit', {
    file_path: '/m.js',
    edits: [
      { old_string: 'a = 1', new_string: 'a = 10' },
      { old_string: 'NOT PRESENT', new_string: 'x' },
    ],
  }, { env: {}, readFile });
  assert.strictEqual(bad, null);
});

// ── ⑥ no visible change → null ────────────────────────────────────────────
test('identical before/after → null', () => {
  const readFile = mkRead({ '/s.txt': 'same\n' });
  assert.strictEqual(
    leaf.computeEditDiffPreview('Write', { file_path: '/s.txt', content: 'same\n' }, { env: {}, readFile }),
    null);
});

// ── ⑦ non-write tool + missing path → null ────────────────────────────────
test('non-write-family tool and missing file path → null', () => {
  const readFile = mkRead({ '/x': 'y' });
  assert.strictEqual(leaf.computeEditDiffPreview('Bash', { command: 'ls' }, { env: {}, readFile }), null);
  assert.strictEqual(leaf.computeEditDiffPreview('Read', { file_path: '/x' }, { env: {}, readFile }), null);
  assert.strictEqual(leaf.computeEditDiffPreview('Write', { content: 'x' }, { env: {}, readFile }), null);
});

// ── ⑧ Edit on non-existent file → null (fail-open, no bogus preview) ───────
test('Edit on non-existent file → null; readFile injectable', () => {
  const readFile = mkRead({}); // every read throws
  assert.strictEqual(
    leaf.computeEditDiffPreview('Edit', { file_path: '/gone', old_string: 'a', new_string: 'b' }, { env: {}, readFile }),
    null);
});

// ── ① byte-revert: gate OFF → null even for a real change ──────────────────
test('gate OFF → null (byte-revert)', () => {
  const readFile = mkRead({ '/a.txt': 'old\n' });
  const off = leaf.computeEditDiffPreview('Write',
    { file_path: '/a.txt', content: 'new\n' }, { env: { KHY_EDIT_DIFF_PREVIEW: 'off' }, readFile });
  assert.strictEqual(off, null);
});

// ── never throws on garbage input ─────────────────────────────────────────
test('computeEditDiffPreview never throws on garbage', () => {
  assert.strictEqual(leaf.computeEditDiffPreview(null, null, null), null);
  assert.strictEqual(leaf.computeEditDiffPreview('Edit', undefined, {}), null);
  assert.strictEqual(leaf.computeEditDiffPreview('MultiEdit', { file_path: '/z', edits: 'nope' }, { env: {}, readFile: mkRead({ '/z': 'a' }) }), null);
});

// ── ⑨ LIVE wiring guards (drift locks) ────────────────────────────────────
test('toolCalling.js attaches diffPreview on the Ink approval path', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/toolCalling.js'), 'utf8');
  assert.ok(/editDiffPreview'\)\.computeEditDiffPreview/.test(src),
    'toolCalling.js must call editDiffPreview.computeEditDiffPreview (wiring drift)');
  assert.ok(/diffPreview: _dp/.test(src),
    'toolCalling.js must attach diffPreview to the control-request input');
});

test('PermissionsPrompt.js renders input.diffPreview via ToolLines', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/cli/tui/ink-components/PermissionsPrompt.js'), 'utf8');
  assert.ok(/input\.diffPreview/.test(src), 'prompt must read input.diffPreview');
  assert.ok(/buildWriteDiffRows/.test(src) && /renderDiffRows/.test(src),
    'prompt must build + render diff rows');
});

test('ToolLines exports renderDiffRows; flagRegistry registers the gate', () => {
  const TL = require('../../src/cli/tui/ink-components/ToolLines');
  assert.strictEqual(typeof TL.renderDiffRows, 'function', 'renderDiffRows must be exported');
  assert.strictEqual(typeof TL.buildWriteDiffRows, 'function', 'buildWriteDiffRows must be exported');
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_EDIT_DIFF_PREVIEW', {}), true,
    'KHY_EDIT_DIFF_PREVIEW must be registered and default ON');
  assert.strictEqual(reg.isFlagEnabled('KHY_EDIT_DIFF_PREVIEW', { KHY_EDIT_DIFF_PREVIEW: 'off' }), false);
});

// ── E2E: computed preview feeds ToolLines.buildWriteDiffRows into real rows ─
test('E2E: computed preview produces renderable diff rows', () => {
  const readFile = mkRead({ '/e.js': 'line one\nline two\nline three\n' });
  const dp = leaf.computeEditDiffPreview('Edit',
    { file_path: '/e.js', old_string: 'line two', new_string: 'LINE TWO' }, { env: {}, readFile });
  assert.ok(dp && dp.beforeContent && dp.afterContent);
  const TL = require('../../src/cli/tui/ink-components/ToolLines');
  const rows = TL.buildWriteDiffRows(dp, true);
  assert.ok(Array.isArray(rows) && rows.length, 'diff rows should be produced');
  assert.ok(rows.some((r) => r.kind === 'add' && /LINE TWO/.test(r.text)), 'has the +new line');
  assert.ok(rows.some((r) => r.kind === 'del' && /line two/.test(r.text)), 'has the -old line');
});
