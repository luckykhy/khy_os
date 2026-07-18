'use strict';

/**
 * planStageFlush — Phase 1.1 drain decision for the streaming timeline. Pure
 * planner behind useQueryBridge.flushCompletedStages: given the live timeline
 * and flags, it returns { k, sealed } = how many leading WHOLE segments to
 * commit plus a markdown-safe prefix of the open trailing text to commit
 * progressively. The hook applies the side effects; this pins the decision.
 *
 * The end-to-end invariant these tests protect: across a streamed turn, the
 * concatenation of every committed fragment plus the final force-drain equals
 * the full text — no loss, no duplication, never a cut mid-structure.
 */

const { planStageFlush, splitSealedText } = require('../../src/cli/tui/hooks/useQueryBridge');

const txt = (text) => ({ type: 'text', text });
const tool = (result) => ({ type: 'tool', tool: { name: 'Read', id: 'x', result } });
const pendingTool = () => ({ type: 'tool', tool: { name: 'Read', id: 'x' } });

describe('planStageFlush — whole-segment draining', () => {
  test('empty timeline drains nothing', () => {
    expect(planStageFlush([], {})).toEqual({ k: 0, sealed: '' });
  });

  test('a lone open text segment with no boundary drains nothing', () => {
    expect(planStageFlush([txt('streaming, no blank')], {})).toEqual({ k: 0, sealed: '' });
  });

  test('a resolved tool followed by open text drains the tool', () => {
    const tl = [tool({ text: 'ok' }), txt('after, no blank yet')];
    expect(planStageFlush(tl, {})).toMatchObject({ k: 1, sealed: '' });
  });

  test('stops at a pending tool, keeping it and everything after live', () => {
    const tl = [txt('intro\n\n'), pendingTool(), txt('later')];
    // The intro text is sealed (a tool follows it) → k advances past it; the
    // pending tool halts the drain.
    expect(planStageFlush(tl, {})).toMatchObject({ k: 1 });
  });

  test('force drains the entire timeline and never seals', () => {
    const tl = [txt('a\n\n'), tool({ text: 'ok' }), txt('open tail')];
    expect(planStageFlush(tl, { force: true })).toEqual({ k: 3, sealed: '' });
  });

  test('sealTrailing drains the open trailing text whole (no partial seal)', () => {
    const tl = [txt('para\n\nmore in progress')];
    expect(planStageFlush(tl, { sealTrailing: true })).toEqual({ k: 1, sealed: '' });
  });
});

describe('planStageFlush — progressive seal of the open tail', () => {
  test('seals the completed prefix of a lone open text segment', () => {
    const tl = [txt('para one\n\npara two in progress')];
    expect(planStageFlush(tl, {})).toEqual({ k: 0, sealed: 'para one\n\n' });
  });

  test('seals the open tail after already-drained sealed text segments', () => {
    // A sealed text (tool follows) + resolved tool + open text with a boundary.
    const tl = [txt('first\n\n'), tool({ text: 'ok' }), txt('second\n\nthird typing')];
    const { k, sealed } = planStageFlush(tl, {});
    expect(k).toBe(2);
    expect(sealed).toBe('second\n\n');
  });

  test('does not seal inside an open fence', () => {
    const tl = [txt('intro\n\n```js\ncode\n\nmore')];
    expect(planStageFlush(tl, {})).toEqual({ k: 0, sealed: 'intro\n\n' });
  });
});

describe('progressive commit reconstructs the full text (end-to-end)', () => {
  // Simulate the bridge: stream a turn in chunks, draining the sealed prefix of
  // the single open text segment after each chunk, then a final force-drain.
  // Assert the committed fragments concatenate to exactly the streamed text and
  // that fragments DO grow mid-stream (not all-at-finalize).
  function runStream(chunks) {
    let openText = '';
    const committed = [];
    for (const c of chunks) {
      openText += c;
      // Mirror the hook: only attempt when the chunk introduced a newline.
      if (c.indexOf('\n') === -1) continue;
      const { sealed } = planStageFlush([txt(openText)], {});
      if (sealed) {
        committed.push(sealed);
        openText = splitSealedText(openText).live; // keep the exact remainder
      }
    }
    // Finalize: force-drain commits whatever open text remains.
    if (openText) committed.push(openText);
    return committed;
  }

  test('multi-paragraph prose commits incrementally and loses nothing', () => {
    const full = 'Intro paragraph.\n\nSecond paragraph here.\n\nThird and final.';
    // Chunk it arbitrarily (token-ish), including splits across the blank lines.
    const chunks = ['Intro ', 'paragraph.', '\n', '\n', 'Second ', 'paragraph ', 'here.', '\n\n', 'Third ', 'and final.'];
    expect(chunks.join('')).toBe(full); // sanity
    const committed = runStream(chunks);
    expect(committed.join('')).toBe(full);          // no loss / no dup
    expect(committed.length).toBeGreaterThan(1);     // committed mid-stream
  });

  test('a fenced code block is never split across fragments', () => {
    const full = 'Here is code:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.';
    const chunks = ['Here is code:\n\n', '```js\n', 'const a = 1;\n', '\n', 'const b = 2;\n', '```\n', '\n', 'Done.'];
    expect(chunks.join('')).toBe(full);
    const committed = runStream(chunks);
    expect(committed.join('')).toBe(full);
    // The fence must live in a single fragment (open + close in the same one).
    const fenceFrag = committed.find((f) => f.includes('```js'));
    expect(fenceFrag).toBeDefined();
    expect((fenceFrag.match(/```/g) || []).length).toBe(2);
  });
});
