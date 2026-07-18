'use strict';

/**
 * userMessageWhiteBg.test.js — white-background USER MESSAGE box invariants.
 *
 * Goal「输入的内容要有个白色背景框以方便和输出内容做一个区分是在工作区中的不是
 * 输入框变白」: the user's OWN submitted content, as committed in the workspace
 * transcript, is painted edge-to-edge on a white background so it reads as a
 * distinct box vs the default-background AI/tool output — while the INPUT box
 * itself stays transparent (terminal-native). The styling is Ink (not unit-
 * testable), but the PURE row model that makes the white fill a SOLID, width-safe
 * box is `buildUserMessageBox`, and the env gate is `userMsgWhiteBgEnabled`.
 * These pin:
 *   (A) full-bleed: every row pads to EXACTLY cols-1 inner width;
 *   (B) width safety: total width never exceeds cols-1 (never the wrap margin);
 *   (C) lossless: marker + text round-trips to the original content;
 *   (D) long / multi-line content wraps into in-box rows; and
 *   (E) the gate is default-on and reverts on {0,false,off,no}.
 */
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Transcript = require('../../src/cli/tui/ink-components/Transcript');
const { buildUserMessageBox, userMsgWhiteBgEnabled, userMsgBgColor, userMsgFgColor } = Transcript;

function textOf(row) {
  return row.segments.filter((s) => s.role !== 'pad').map((s) => s.text).join('');
}
function contentOf(row) {
  return row.segments.filter((s) => s.role === 'text').map((s) => s.text).join('');
}

describe('buildUserMessageBox — solid, width-safe white box', () => {
  test('a short message pads to exactly the inner width (cols-1)', () => {
    for (const cols of [40, 80, 120]) {
      const rows = buildUserMessageBox('hello', { cols });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].innerWidth, cols - 1);
      assert.equal(rows[0].totalWidth, cols - 1, `should fill to cols-1 at cols=${cols}`);
      assert.ok(rows[0].pad >= 0);
    }
  });

  test('total width never exceeds cols-1 across long / CJK / mixed content', () => {
    const cases = [
      'x'.repeat(500),
      '中文输入'.repeat(80),
      'mix混合abc'.repeat(30),
      'a'.repeat(79),
    ];
    for (const cols of [40, 80, 100]) {
      for (const c of cases) {
        for (const row of buildUserMessageBox(c, { cols })) {
          assert.ok(row.totalWidth <= cols - 1,
            `row width ${row.totalWidth} exceeds cols-1=${cols - 1}`);
        }
      }
    }
  });

  test('first row uses the ❯ marker, continuation rows use a blank "  " marker', () => {
    const rows = buildUserMessageBox('a'.repeat(300), { cols: 80 });
    assert.ok(rows.length > 1, 'long content should wrap into multiple rows');
    assert.equal(rows[0].segments[0].text, '❯ ');
    for (let i = 1; i < rows.length; i++) {
      assert.equal(rows[i].segments[0].text, '  ');
    }
  });

  test('content is lossless on a single line: text segments reassemble the input', () => {
    const rows = buildUserMessageBox('hello world', { cols: 80 });
    assert.equal(rows.length, 1);
    assert.equal(textOf(rows[0]), '❯ hello world');
    assert.equal(contentOf(rows[0]), 'hello world');
  });

  test('a multi-line message yields one box row per logical line', () => {
    const rows = buildUserMessageBox('line one\nline two\nline three', { cols: 80 });
    assert.equal(rows.length, 3);
    assert.equal(contentOf(rows[0]), 'line one');
    assert.equal(contentOf(rows[1]), 'line two');
    assert.equal(contentOf(rows[2]), 'line three');
    // every row is still full-bleed to the box edge
    for (const row of rows) assert.equal(row.totalWidth, 79);
  });

  test('long single line wraps and reassembles its content across rows', () => {
    const content = 'word '.repeat(60).trim(); // ~299 cols, wraps at cols=80
    const rows = buildUserMessageBox(content, { cols: 80 });
    assert.ok(rows.length > 1);
    assert.equal(rows.map(contentOf).join(''), content); // no data lost in wrap
  });

  test('empty / null content still renders one full-bleed row', () => {
    for (const v of ['', null, undefined]) {
      const rows = buildUserMessageBox(v, { cols: 80 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].totalWidth, 79);
      assert.equal(rows[0].segments[0].text, '❯ ');
    }
  });

  test('degenerate narrow terminals never produce negative pad or throw', () => {
    // At cols<=2 the fixed 2-col "❯ " marker alone exceeds the inner width; the
    // marker cannot shrink, so we only require non-negative pad + finite width
    // here (width-safety for realistic widths is pinned by the case above).
    for (const cols of [1, 2, 3, 5]) {
      for (const row of buildUserMessageBox('一二三abc', { cols })) {
        assert.ok(row.pad >= 0);
        assert.ok(Number.isFinite(row.totalWidth));
      }
    }
  });
});

describe('userMsgWhiteBgEnabled — gate semantics', () => {
  const prev = process.env.KHY_USER_MSG_WHITE_BG;
  afterEach(() => {
    if (prev === undefined) delete process.env.KHY_USER_MSG_WHITE_BG;
    else process.env.KHY_USER_MSG_WHITE_BG = prev;
  });

  test('default (unset) is ON', () => {
    delete process.env.KHY_USER_MSG_WHITE_BG;
    assert.equal(userMsgWhiteBgEnabled(), true);
  });

  test('reverts on {0,false,off,no} (any case / whitespace)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', '  false ', 'No']) {
      process.env.KHY_USER_MSG_WHITE_BG = v;
      assert.equal(userMsgWhiteBgEnabled(), false, `"${v}" should disable`);
    }
  });

  test('stays ON for any other value', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'white']) {
      process.env.KHY_USER_MSG_WHITE_BG = v;
      assert.equal(userMsgWhiteBgEnabled(), true, `"${v}" should enable`);
    }
  });
});

describe('userMsgBgColor — 米白 (off-white) tint, not glaring pure white', () => {
  const prev = process.env.KHY_USER_MSG_BG;
  afterEach(() => {
    if (prev === undefined) delete process.env.KHY_USER_MSG_BG;
    else process.env.KHY_USER_MSG_BG = prev;
  });

  test('default is a soft cream hex, never pure "white"', () => {
    delete process.env.KHY_USER_MSG_BG;
    const c = userMsgBgColor();
    assert.equal(c, '#F0EAD6');
    assert.notEqual(c.toLowerCase(), 'white');
  });

  test('respects KHY_USER_MSG_BG override (hex or named), trimmed', () => {
    process.env.KHY_USER_MSG_BG = '  #EEE8D5 ';
    assert.equal(userMsgBgColor(), '#EEE8D5');
    process.env.KHY_USER_MSG_BG = 'gray';
    assert.equal(userMsgBgColor(), 'gray');
  });

  test('blank / unset falls back to the cream default', () => {
    process.env.KHY_USER_MSG_BG = '   ';
    assert.equal(userMsgBgColor(), '#F0EAD6');
  });
});

describe('userMsgFgColor — true-black text (immune to the bold→gray promotion)', () => {
  const prev = process.env.KHY_USER_MSG_FG;
  afterEach(() => {
    if (prev === undefined) delete process.env.KHY_USER_MSG_FG;
    else process.env.KHY_USER_MSG_FG = prev;
  });

  test('default is a truecolor near-black hex, never named "black"', () => {
    // The whole point: named 'black' + bold renders as gray on most terminals.
    // A hex is immune to that bold→bright promotion, so it must NOT be 'black'.
    delete process.env.KHY_USER_MSG_FG;
    const c = userMsgFgColor();
    assert.equal(c, '#1A1A1A');
    assert.notEqual(c.toLowerCase(), 'black');
    assert.match(c, /^#[0-9a-fA-F]{6}$/);
  });

  test('respects KHY_USER_MSG_FG override (hex or named), trimmed', () => {
    process.env.KHY_USER_MSG_FG = '  #000000 ';
    assert.equal(userMsgFgColor(), '#000000');
    process.env.KHY_USER_MSG_FG = 'black';
    assert.equal(userMsgFgColor(), 'black');
  });

  test('blank / unset falls back to the near-black default', () => {
    process.env.KHY_USER_MSG_FG = '   ';
    assert.equal(userMsgFgColor(), '#1A1A1A');
  });
});
