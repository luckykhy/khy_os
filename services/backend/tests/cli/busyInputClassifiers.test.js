'use strict';

/**
 * busyInputClassifiers.test.js — pure busy-input & paste text classifiers.
 *
 * Extracted verbatim from the cli/repl.js god file as part of the
 * behavior-preserving split. These had NO direct test coverage while buried in
 * the REPL closure; this pins their contracts as an importable, pure module.
 */

const {
  PASTED_CONTENT_BLOCK_RE,
  summarizeQueuedInputForDisplay,
  classifyBusyInput,
  routeBusyInput,
  findFirstMarker,
  stripBracketArtifacts,
} = require('../../src/cli/repl/busyInputClassifiers');

const ESC = '\u001b';

describe('summarizeQueuedInputForDisplay', () => {
  test('collapses whitespace and returns short input untouched', () => {
    expect(summarizeQueuedInputForDisplay('  hello   world \n')).toBe('hello world');
  });

  test('clamps long input to maxLen with an ellipsis', () => {
    expect(summarizeQueuedInputForDisplay('x'.repeat(60), 10)).toBe('x'.repeat(10) + '...');
  });

  test('renders pasted-content blocks as a CC line tally (newline count, "+2 not 3")', () => {
    // CC getPastedTextRefNumLines 数换行符:3 行内容 → +2 lines(刀37,门控默认开)。
    const raw = '<pasted-content>\nline1\nline2\nline3\n</pasted-content>';
    expect(summarizeQueuedInputForDisplay(raw)).toBe('[Pasted text +2 lines]');
  });

  test('appends a clamped supplement after the paste tally', () => {
    const raw = 'see this <pasted-content>\na\nb\n</pasted-content> thanks';
    // body 'a\nb' = 1 换行 → CC +1 lines(历史 split=2 误报 +2)。
    expect(summarizeQueuedInputForDisplay(raw, 100)).toBe('[Pasted text +1 lines] · see this thanks');
  });

  test('门控关 KHY_PASTED_REF_LINES → 逐字节回退历史 split 计数', () => {
    const raw = '<pasted-content>\nline1\nline2\nline3\n</pasted-content>';
    const prev = process.env.KHY_PASTED_REF_LINES;
    process.env.KHY_PASTED_REF_LINES = 'off';
    try {
      expect(summarizeQueuedInputForDisplay(raw)).toBe('[Pasted text +3 lines]'); // split=3 历史口径
    } finally {
      if (prev == null) delete process.env.KHY_PASTED_REF_LINES;
      else process.env.KHY_PASTED_REF_LINES = prev;
    }
  });

  test('handles nullish input', () => {
    expect(summarizeQueuedInputForDisplay(null)).toBe('');
    expect(summarizeQueuedInputForDisplay(undefined)).toBe('');
  });
});

describe('classifyBusyInput', () => {
  test('empty input queues', () => {
    expect(classifyBusyInput('')).toEqual({ mode: 'queue', text: '' });
    expect(classifyBusyInput('   ')).toEqual({ mode: 'queue', text: '' });
  });

  test('explicit /steer and /s prefixes steer with the payload stripped', () => {
    expect(classifyBusyInput('/steer use TypeScript')).toEqual({ mode: 'steer', text: 'use TypeScript' });
    expect(classifyBusyInput('/s do it differently')).toEqual({ mode: 'steer', text: 'do it differently' });
  });

  test('explicit stop keywords interrupt (CN + EN, full match only)', () => {
    expect(classifyBusyInput('停').mode).toBe('interrupt');
    expect(classifyBusyInput('取消').mode).toBe('interrupt');
    expect(classifyBusyInput('stop!').mode).toBe('interrupt');
    expect(classifyBusyInput('cancel').mode).toBe('interrupt');
  });

  test('very long input queues as a new topic', () => {
    expect(classifyBusyInput('a'.repeat(301)).mode).toBe('queue');
  });

  test('steer-intent patterns route to steer (CN + EN)', () => {
    expect(classifyBusyInput('改成用 Rust').mode).toBe('steer');
    expect(classifyBusyInput('actually, do it another way').mode).toBe('steer');
    expect(classifyBusyInput('switch to dark mode').mode).toBe('steer');
  });

  test('plain new instruction queues', () => {
    expect(classifyBusyInput('write a haiku about cats').mode).toBe('queue');
  });
});

describe('findFirstMarker', () => {
  test('returns the earliest-appearing marker with its index', () => {
    expect(findFirstMarker('abXYcd', ['cd', 'XY'])).toEqual({ idx: 2, marker: 'XY' });
  });

  test('returns null when no marker is present', () => {
    expect(findFirstMarker('plain text', ['ZZ', 'QQ'])).toBeNull();
  });
});

describe('stripBracketArtifacts', () => {
  test('strips DECSET 2004 enable/disable and 200/201 markers', () => {
    const dirty = ESC + '[?2004h' + ESC + '[200~payload' + ESC + '[201~' + ESC + '[?2004l';
    expect(stripBracketArtifacts(dirty)).toBe('payload');
  });

  test('strips bare 00~ prefix and 01~ suffix', () => {
    expect(stripBracketArtifacts('00~middle01~')).toBe('middle');
  });

  test('strips ESC-less [200~ / [201~ markers anywhere', () => {
    expect(stripBracketArtifacts('a[200~b[201~c')).toBe('abc');
  });

  test('handles nullish input', () => {
    expect(stripBracketArtifacts(null)).toBe('');
  });
});

describe('PASTED_CONTENT_BLOCK_RE', () => {
  test('captures the body of a pasted-content block', () => {
    const m = PASTED_CONTENT_BLOCK_RE.exec('<pasted-content>\nhi\nthere\n</pasted-content>');
    expect(m && m[1]).toBe('hi\nthere');
  });
});

describe('routeBusyInput', () => {
  test('/s! urgent prefix → urgent action with the body stripped', () => {
    expect(routeBusyInput('/s! 别建文件')).toEqual({ action: 'urgent', text: '别建文件' });
    expect(routeBusyInput('/steer! switch to plan B')).toEqual({ action: 'urgent', text: 'switch to plan B' });
  });

  test('urgent prefix wins over the plain /s steer prefix (no whitespace collision)', () => {
    // Plain `/s ` is steer; `/s!` is urgent — the `!` must route to urgent, not steer.
    expect(routeBusyInput('/s 改用 X').action).toBe('steer');
    expect(routeBusyInput('/s! 改用 X').action).toBe('urgent');
  });

  test('explicit /steer prefix → steer action', () => {
    expect(routeBusyInput('/steer 改用二分查找')).toEqual({ action: 'steer', text: '改用二分查找' });
  });

  test('steer-intent prose → steer action (shared with classifyBusyInput)', () => {
    expect(routeBusyInput('改用 TypeScript 重写').action).toBe('steer');
    expect(routeBusyInput('actually, use a hashmap instead').action).toBe('steer');
  });

  test('explicit stop word → interrupt action', () => {
    expect(routeBusyInput('停').action).toBe('interrupt');
    expect(routeBusyInput('cancel').action).toBe('interrupt');
  });

  test('a plain new topic → queue action', () => {
    expect(routeBusyInput('帮我查一下今天的天气').action).toBe('queue');
  });

  test('routing stays consistent with classifyBusyInput for non-urgent input', () => {
    for (const s of ['改用 X', '停', 'a new unrelated request here']) {
      expect(routeBusyInput(s).action).toBe(classifyBusyInput(s).mode);
    }
  });

  test('handles nullish input as queue', () => {
    expect(routeBusyInput(null)).toEqual({ action: 'queue', text: '' });
  });
});
