'use strict';

/**
 * BUG-35 regression — the advertised newline key must actually insert a newline.
 *
 * Measured on Windows Terminal 1.24 by feeding real keypress bytes through the
 * same parser ink uses, then mounting the live useTextInput hook and reading the
 * buffer back (Z/repro-keybytes.cjs, Z/repro-after-altenter.cjs):
 *
 *   Enter          -> \r        -> ink name 'return'  -> key.return = true  -> submits
 *   Shift + Enter  -> \r        -> identical bytes     -> submits (terminal cannot tell them apart)
 *   Ctrl + Enter   -> (nothing) -> consumed by the terminal itself (fullscreen)
 *   Alt + Enter    -> ESC only  -> consumed by the terminal's own fullscreen binding
 *   Ctrl + J       -> \n        -> ink name 'enter'    -> key.return = FALSE, bare LF reaches us
 *
 * The bare LF is the one newline byte this terminal really delivers. Before the
 * fix useTextInput let it fall through to the printable path, whose single-char
 * control filter (`charCodeAt(0) < 0x20`) dropped it: the `?` overlay advertised
 * 换行, the terminal delivered a byte, and the input did nothing.
 *
 * These tests pin both halves of the contract: the terminal/ink fact (asserted
 * against ink's own parser, not against my reading of it) and the handler
 * invariant (the LF branch must sit between submit and the control-byte drop —
 * above submit and it would eat Enter on CR-delivering terminals, below the
 * drop and it is dead code).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOOK_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/cli/tui/hooks/useTextInput.js'),
  'utf8'
);

/** ink ships a CJS build; requiring it directly keeps this a plain node:test. */
function loadKeypressParser() {
  const p = path.resolve(__dirname, '../../../../node_modules/ink/build/parse-keypress.js');
  if (!fs.existsSync(p)) return null;
  try {
    const mod = require(p);
    return typeof mod === 'function' ? mod : mod.default;
  } catch {
    return null;
  }
}

test('ink 把 Ctrl+J 送来的裸 LF 解析成 name=enter(而非 return)', () => {
  const parse = loadKeypressParser();
  if (!parse) {
    // node_modules layout differs (hoisted vs nested); the handler invariant
    // below still guards the fix, so skip the upstream fact rather than fail.
    return;
  }
  const cr = parse(Buffer.from('\r'));
  const lf = parse(Buffer.from('\n'));

  assert.equal(cr.name, 'return');
  // use-input.js maps key.return = (name === 'return'): LF must NOT be 'return',
  // which is exactly why the submit branch cannot see the LF newline key.
  assert.notEqual(lf.name, 'return');
  assert.equal(lf.name, 'enter');
  // And no modifier survives: the byte alone is all the handler gets.
  assert.equal(lf.ctrl, false);
  assert.equal(lf.shift, false);
});

test('裸 LF 分支存在，且位于「提交」之后、「控制字符丢弃」之前', () => {
  const submitIdx = HOOK_SRC.indexOf('if (key.return)');
  const lfIdx = HOOK_SRC.indexOf("if (input === '\\n' && !key.return)");
  const dropIdx = HOOK_SRC.indexOf('input.charCodeAt(0) < 0x20');

  assert.ok(submitIdx > 0, 'submit 分支未找到');
  assert.ok(dropIdx > 0, '控制字符丢弃分支未找到');
  assert.ok(lfIdx > 0, '缺裸 LF → 换行分支:Ctrl+J 会被静默吞掉(BUG-35)');
  assert.ok(lfIdx > submitIdx, 'LF 分支不得排在 submit 之前,否则会抢走 Enter');
  assert.ok(lfIdx < dropIdx, 'LF 分支不得排在控制字符丢弃之后,那是死代码');
});

test('裸 LF 分支插入换行并短路，绝不落到提交路径', () => {
  const lfIdx = HOOK_SRC.indexOf("if (input === '\\n' && !key.return)");
  const block = HOOK_SRC.slice(lfIdx, lfIdx + 200);
  assert.match(block, /cur\.insert\('\\n'\)/);
  // Exactly one insert + return: no onSubmit call inside the newline branch,
  // otherwise a documented newline key would fire a whole AI turn.
  assert.doesNotMatch(block, /onSubmit/);
});
