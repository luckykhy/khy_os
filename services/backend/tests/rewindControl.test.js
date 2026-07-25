'use strict';

/**
 * Tests for rewindControl.js — the pure leaf behind the TUI double-ESC rewind.
 * Covers env gating (KHY_ESC_REWIND / KHY_TUI_TURN_CHECKPOINT, default on), the
 * idle-ESC reconciliation verdict (decideEscIdle), the UI→backend rank mapping
 * (userTurnRankFromEnd / selectLastUserTarget), and the immutable checkpoint-id
 * patch (patchUserCheckpointId). No React/IO — same jest style as activeAssist.
 */

const assert = require('assert');

const REWIND = 'KHY_ESC_REWIND';
const CHECKPOINT = 'KHY_TUI_TURN_CHECKPOINT';
const HINT = 'KHY_ESC_REWIND_HINT';
const ALL_FLAGS = [REWIND, CHECKPOINT, HINT];
const MODULE_PATH = '../src/cli/tui/rewindControl';

function load(env = {}) {
  for (const f of ALL_FLAGS) delete process.env[f];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

describe('rewindControl — enablement', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  test('both gates ON by default', () => {
    const m = load();
    assert.strictEqual(m.isRewindEnabled(), true);
    assert.strictEqual(m.turnCheckpointEnabled(), true);
  });

  test('each gate OFF via 0/false/off/no (case/space tolerant)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
      assert.strictEqual(load({ [REWIND]: v }).isRewindEnabled(), false, `rewind=${JSON.stringify(v)}`);
      assert.strictEqual(load({ [CHECKPOINT]: v }).turnCheckpointEnabled(), false, `ckpt=${JSON.stringify(v)}`);
    }
  });

  test('any other value keeps a gate enabled', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
      assert.strictEqual(load({ [REWIND]: v }).isRewindEnabled(), true, `value=${JSON.stringify(v)}`);
    }
  });
});

describe('rewindControl — decideEscIdle', () => {
  const m = load();

  test('vim owns ESC regardless of other state', () => {
    assert.strictEqual(
      m.decideEscIdle({ vimEnabled: true, pendingImagesLen: 0, value: '', withinWindow: true, rewindEnabled: true }),
      'vim',
    );
  });

  test('staged images are dropped before any clear/rewind', () => {
    assert.strictEqual(
      m.decideEscIdle({ vimEnabled: false, pendingImagesLen: 2, value: '', withinWindow: true, rewindEnabled: true }),
      'drop-images',
    );
  });

  test('draft present: double-press clears, single-press arms clear', () => {
    const base = { vimEnabled: false, pendingImagesLen: 0, value: 'hi', rewindEnabled: true };
    assert.strictEqual(m.decideEscIdle({ ...base, withinWindow: true }), 'clear-input');
    assert.strictEqual(m.decideEscIdle({ ...base, withinWindow: false }), 'arm-clear');
  });

  test('empty line + rewind on: double-press opens rewind, single-press arms rewind', () => {
    const base = { vimEnabled: false, pendingImagesLen: 0, value: '', rewindEnabled: true };
    assert.strictEqual(m.decideEscIdle({ ...base, withinWindow: true }), 'open-rewind');
    assert.strictEqual(m.decideEscIdle({ ...base, withinWindow: false }), 'arm-rewind');
  });

  test('empty line + rewind off: noop (today behavior)', () => {
    const base = { vimEnabled: false, pendingImagesLen: 0, value: '', rewindEnabled: false };
    assert.strictEqual(m.decideEscIdle({ ...base, withinWindow: true }), 'noop');
    assert.strictEqual(m.decideEscIdle({ ...base, withinWindow: false }), 'noop');
  });

  test('draft never gets hijacked into rewind even on double-press', () => {
    assert.strictEqual(
      m.decideEscIdle({ vimEnabled: false, pendingImagesLen: 0, value: 'draft', withinWindow: true, rewindEnabled: true }),
      'clear-input',
    );
  });
});

describe('rewindControl — userTurnRankFromEnd / selectLastUserTarget', () => {
  const m = load();
  const msgs = [
    { role: 'user', content: 'Q1' },        // 0  rank 3
    { role: 'assistant', content: 'A1' },   // 1
    { role: 'user', content: 'Q2' },        // 2  rank 2
    { role: 'error', content: 'oops' },     // 3
    { role: 'user', content: 'Q3' },        // 4  rank 1
    { role: 'assistant', content: 'A3' },   // 5
  ];

  test('rank counts user messages from the end (1-based)', () => {
    assert.strictEqual(m.userTurnRankFromEnd(msgs, 4), 1);
    assert.strictEqual(m.userTurnRankFromEnd(msgs, 2), 2);
    assert.strictEqual(m.userTurnRankFromEnd(msgs, 0), 3);
  });

  test('non-user index or out-of-bounds → 0', () => {
    assert.strictEqual(m.userTurnRankFromEnd(msgs, 1), 0, 'assistant');
    assert.strictEqual(m.userTurnRankFromEnd(msgs, 3), 0, 'error role');
    assert.strictEqual(m.userTurnRankFromEnd(msgs, 99), 0, 'oob');
    assert.strictEqual(m.userTurnRankFromEnd(null, 0), 0, 'not array');
  });

  test('selectLastUserTarget returns the last user turn with rank 1', () => {
    const t = m.selectLastUserTarget(msgs);
    assert.deepStrictEqual(
      { idx: t.idx, content: t.content, checkpointId: t.checkpointId, rankFromEnd: t.rankFromEnd },
      { idx: 4, content: 'Q3', checkpointId: null, rankFromEnd: 1 },
    );
  });

  test('selectLastUserTarget surfaces an existing checkpointId', () => {
    const withId = [{ role: 'user', content: 'Q1', checkpointId: 'ck_42' }];
    assert.strictEqual(m.selectLastUserTarget(withId).checkpointId, 'ck_42');
  });

  test('selectLastUserTarget → null when no user message', () => {
    assert.strictEqual(m.selectLastUserTarget([{ role: 'assistant', content: 'A' }]), null);
    assert.strictEqual(m.selectLastUserTarget([]), null);
    assert.strictEqual(m.selectLastUserTarget(null), null);
  });
});

describe('rewindControl — listUserTargets (Phase 2 picker source)', () => {
  const m = load();
  const msgs = [
    { role: 'user', content: 'Q1', checkpointId: 'ck_1' }, // 0  rank 3
    { role: 'assistant', content: 'A1' },                  // 1
    { role: 'user', content: 'Q2' },                       // 2  rank 2
    { role: 'error', content: 'oops' },                    // 3
    { role: 'user', content: 'Q3' },                       // 4  rank 1
    { role: 'assistant', content: 'A3' },                  // 5
  ];

  test('lists user turns newest-first with idx + rankFromEnd + checkpointId', () => {
    const t = m.listUserTargets(msgs);
    assert.deepStrictEqual(
      t.map((x) => ({ idx: x.idx, content: x.content, rankFromEnd: x.rankFromEnd, checkpointId: x.checkpointId })),
      [
        { idx: 4, content: 'Q3', rankFromEnd: 1, checkpointId: null },
        { idx: 2, content: 'Q2', rankFromEnd: 2, checkpointId: null },
        { idx: 0, content: 'Q1', rankFromEnd: 3, checkpointId: 'ck_1' },
      ],
    );
  });

  test('each target carries a flattened, length-capped preview', () => {
    const long = { role: 'user', content: 'line one\n  line  two   with    spaces ' + 'x'.repeat(200) };
    const [t] = m.listUserTargets([long], 40);
    assert.ok(t.preview.length <= 40, `preview length ${t.preview.length} <= 40`);
    assert.ok(!/\n/.test(t.preview), 'no newlines in preview');
    assert.ok(t.preview.endsWith('…'), 'truncated with ellipsis');
    assert.strictEqual(t.content, long.content, 'full content preserved separately');
  });

  test('no user messages / non-array → empty list', () => {
    assert.deepStrictEqual(m.listUserTargets([{ role: 'assistant', content: 'A' }]), []);
    assert.deepStrictEqual(m.listUserTargets([]), []);
    assert.deepStrictEqual(m.listUserTargets(null), []);
  });
});

describe('rewindControl — patchUserCheckpointId', () => {
  const m = load();

  test('patches the user message matching the timestamp, immutably', () => {
    const msgs = [
      { role: 'user', content: 'Q1', timestamp: 100 },
      { role: 'assistant', content: 'A1', timestamp: 101 },
      { role: 'user', content: 'Q2', timestamp: 200 },
    ];
    const next = m.patchUserCheckpointId(msgs, 200, 'ck_9');
    assert.notStrictEqual(next, msgs, 'returns a new array');
    assert.strictEqual(next[2].checkpointId, 'ck_9');
    assert.strictEqual(msgs[2].checkpointId, undefined, 'original untouched');
    assert.strictEqual(next[0].checkpointId, undefined, 'only the matching turn is patched');
  });

  test('no matching timestamp → original array returned (no churn)', () => {
    const msgs = [{ role: 'user', content: 'Q1', timestamp: 100 }];
    assert.strictEqual(m.patchUserCheckpointId(msgs, 999, 'ck_9'), msgs);
  });

  test('missing id or non-array → original returned', () => {
    const msgs = [{ role: 'user', content: 'Q1', timestamp: 100 }];
    assert.strictEqual(m.patchUserCheckpointId(msgs, 100, ''), msgs);
    assert.strictEqual(m.patchUserCheckpointId(null, 100, 'ck'), null);
  });
});

describe('rewindControl — buildEscRewindHint (对齐 CC errors.ts double-ESC 提示)', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  const ON = { rewindEnabled: true, interactive: true };
  const RECOVERABLE = 'Request too large (max 5MB)';

  test('recoverable + interactive + rewind enabled → hint text', () => {
    const m = load();
    const hint = m.buildEscRewindHint(RECOVERABLE, ON);
    assert.strictEqual(hint, m.ESC_REWIND_HINT_TEXT);
    assert.ok(/双击 Esc/.test(hint));
  });

  test('matches the CC-analog recoverable classes (too large / 限流 / 超时 / 网络 / 过载)', () => {
    const m = load();
    for (const t of [
      'payload_too_large', '内容过大', 'rate limit exceeded', '触发限流，请稍后重试',
      'Request timed out', '连接超时', 'ECONNRESET', 'network error', 'Overloaded 529',
      'HTTP 429 too many requests',
    ]) {
      assert.strictEqual(m.buildEscRewindHint(t, ON), m.ESC_REWIND_HINT_TEXT, `should hint: ${t}`);
    }
  });

  test('non-recoverable classes (auth / permission / syntax / 工具) → null', () => {
    const m = load();
    for (const t of [
      'Invalid API key · Please run /login', '401 unauthorized', 'permission denied',
      'SyntaxError: unexpected token', '工具执行失败: ENOENT', '',
    ]) {
      assert.strictEqual(m.buildEscRewindHint(t, ON), null, `should NOT hint: ${t}`);
    }
  });

  test('rewind affordance OFF → null (never advertise an action that does nothing)', () => {
    const m = load();
    assert.strictEqual(
      m.buildEscRewindHint(RECOVERABLE, { rewindEnabled: false, interactive: true }),
      null,
    );
  });

  test('non-interactive (piped) → null (double-ESC unusable)', () => {
    const m = load();
    assert.strictEqual(
      m.buildEscRewindHint(RECOVERABLE, { rewindEnabled: true, interactive: false }),
      null,
    );
  });

  test('display sub-gate KHY_ESC_REWIND_HINT off → null (affordance stays, hint silenced)', () => {
    const m = load();
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.strictEqual(
        m.buildEscRewindHint(RECOVERABLE, { ...ON, env: { [HINT]: v } }),
        null,
        `off value: ${v}`,
      );
    }
  });

  test('escRewindHintEnabled default on, off values disable', () => {
    const m = load();
    assert.strictEqual(m.escRewindHintEnabled({}), true);
    assert.strictEqual(m.escRewindHintEnabled({ [HINT]: 'off' }), false);
  });

  test('never throws on hostile input', () => {
    const m = load();
    assert.doesNotThrow(() => m.buildEscRewindHint(null, ON));
    assert.doesNotThrow(() => m.buildEscRewindHint({}, ON));
    assert.doesNotThrow(() => m.buildEscRewindHint('x', undefined));
    assert.strictEqual(m.buildEscRewindHint(null, ON), null);
  });
});
