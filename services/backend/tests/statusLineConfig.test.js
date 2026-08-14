'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../src/cli/statusLine/statusLineConfig');

test('isEnabled: default on; {0,false,off,no} disables', () => {
  assert.strictEqual(cfg.isEnabled({}), true);
  assert.strictEqual(cfg.isEnabled({ KHY_STATUS_LINE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(cfg.isEnabled({ KHY_STATUS_LINE: v }), false, v);
  }
});

test('resolveStatusLineSetting: configured command', () => {
  const r = cfg.resolveStatusLineSetting({ statusLine: { type: 'command', command: '  echo hi  ', padding: 2 } });
  assert.strictEqual(r.configured, true);
  assert.strictEqual(r.type, 'command');
  assert.strictEqual(r.command, 'echo hi');
  assert.strictEqual(r.padding, 2);
});

test('resolveStatusLineSetting: missing / empty command → not configured', () => {
  assert.strictEqual(cfg.resolveStatusLineSetting({}).configured, false);
  assert.strictEqual(cfg.resolveStatusLineSetting({ statusLine: {} }).configured, false);
  assert.strictEqual(cfg.resolveStatusLineSetting({ statusLine: { command: '   ' } }).configured, false);
  assert.strictEqual(cfg.resolveStatusLineSetting(null).configured, false);
});

test('resolveStatusLineSetting: type defaults to command, padding clamps to >=0 int', () => {
  const r = cfg.resolveStatusLineSetting({ statusLine: { command: 'x', padding: -5 } });
  assert.strictEqual(r.type, 'command');
  assert.strictEqual(r.padding, 0);
  const r2 = cfg.resolveStatusLineSetting({ statusLine: { command: 'x', padding: 3.9 } });
  assert.strictEqual(r2.padding, 3);
});

test('buildStdinPayload: full contract shape with percentages', () => {
  const p = cfg.buildStdinPayload({
    sessionId: 's1', cwd: '/proj', projectDir: '/proj', addedDirs: ['/a', 2, '/b'],
    model: { id: 'claude-opus-4-8', displayName: 'Opus' }, version: '1.2.3',
    context: { totalInputTokens: 100, totalOutputTokens: 50, contextWindowSize: 200, inputTokens: 40, outputTokens: 10 },
  });
  assert.strictEqual(p.session_id, 's1');
  assert.strictEqual(p.cwd, '/proj');
  assert.deepStrictEqual(p.model, { id: 'claude-opus-4-8', display_name: 'Opus' });
  assert.deepStrictEqual(p.workspace.added_dirs, ['/a', '/b']); // non-strings dropped
  assert.strictEqual(p.workspace.current_dir, '/proj');
  assert.strictEqual(p.version, '1.2.3');
  assert.strictEqual(p.context_window.context_window_size, 200);
  assert.deepStrictEqual(p.context_window.current_usage, { input_tokens: 40, output_tokens: 10 });
  // used = (40+10)/200 = 25%
  assert.strictEqual(p.context_window.used_percentage, 25);
  assert.strictEqual(p.context_window.remaining_percentage, 75);
});

test('buildStdinPayload: 刀42 fractional percentage rounded to integer (CC context.ts 口径)', () => {
  // (947+0)/2000 = 47.35% → Math.round → 47;remaining 由取整 used 派生 = 53(和恒 100)。
  const prev = process.env.KHY_STATUS_LINE_PCT_ROUND;
  delete process.env.KHY_STATUS_LINE_PCT_ROUND; // default-on
  try {
    const p = cfg.buildStdinPayload({
      context: { contextWindowSize: 2000, inputTokens: 947, outputTokens: 0 },
    });
    assert.strictEqual(p.context_window.used_percentage, 47);
    assert.strictEqual(p.context_window.remaining_percentage, 53);
    // 整数 + 和恒 100
    assert.ok(Number.isInteger(p.context_window.used_percentage));
    assert.ok(Number.isInteger(p.context_window.remaining_percentage));
    assert.strictEqual(
      p.context_window.used_percentage + p.context_window.remaining_percentage,
      100
    );
  } finally {
    if (prev == null) delete process.env.KHY_STATUS_LINE_PCT_ROUND;
    else process.env.KHY_STATUS_LINE_PCT_ROUND = prev;
  }
});

test('buildStdinPayload: 刀42 gate off → 逐字节回退原始浮点(不取整)', () => {
  const prev = process.env.KHY_STATUS_LINE_PCT_ROUND;
  process.env.KHY_STATUS_LINE_PCT_ROUND = 'off';
  try {
    const p = cfg.buildStdinPayload({
      context: { contextWindowSize: 2000, inputTokens: 947, outputTokens: 0 },
    });
    // 关门:原始浮点 47.349999999999994(浮点垃圾,正是 CC 取整要消除的),
    // remaining = 100 - used = 52.650000000000006(legacy 行为逐字节)。
    assert.strictEqual(p.context_window.used_percentage, (947 / 2000) * 100);
    assert.strictEqual(p.context_window.remaining_percentage, 100 - (947 / 2000) * 100);
  } finally {
    if (prev == null) delete process.env.KHY_STATUS_LINE_PCT_ROUND;
    else process.env.KHY_STATUS_LINE_PCT_ROUND = prev;
  }
});

test('buildStdinPayload: unknown window size → null percentages (honest, no fabrication)', () => {
  const p = cfg.buildStdinPayload({ context: { inputTokens: 10 } });
  assert.strictEqual(p.context_window.context_window_size, 0);
  assert.strictEqual(p.context_window.used_percentage, null);
  assert.strictEqual(p.context_window.remaining_percentage, null);
});

test('buildStdinPayload: empty input is safe with all defaults', () => {
  const p = cfg.buildStdinPayload();
  assert.strictEqual(p.session_id, '');
  assert.strictEqual(p.model.id, '');
  assert.deepStrictEqual(p.workspace.added_dirs, []);
  assert.strictEqual(p.context_window.total_input_tokens, 0);
});

test('buildStdinPayload: project_dir falls back to cwd when absent', () => {
  const p = cfg.buildStdinPayload({ cwd: '/x' });
  assert.strictEqual(p.workspace.project_dir, '/x');
});

test('buildStdinPayload: 刀92 cost block (default on) carries coerced cost + duration', () => {
  const p = cfg.buildStdinPayload(
    { cost: { totalCostUSD: 0.0421, totalDurationMs: 12500 } },
    {}, // default-on gate
  );
  assert.deepStrictEqual(p.cost, { total_cost_usd: 0.0421, total_duration_ms: 12500 });
});

test('buildStdinPayload: 刀92 cost block coerces bad/missing values to 0 (no fabrication of untracked fields)', () => {
  const p = cfg.buildStdinPayload({ cost: { totalCostUSD: 'nope' } }, {});
  assert.deepStrictEqual(p.cost, { total_cost_usd: 0, total_duration_ms: 0 });
  // Only the two live-substrate fields exist — CC's api_duration/lines_* are honestly omitted.
  assert.deepStrictEqual(Object.keys(p.cost), ['total_cost_usd', 'total_duration_ms']);
  // Missing snapshot.cost entirely → still a safe zeroed block when gate on.
  const p2 = cfg.buildStdinPayload({}, {});
  assert.deepStrictEqual(p2.cost, { total_cost_usd: 0, total_duration_ms: 0 });
});

test('buildStdinPayload: 刀92 gate off (KHY_STATUS_LINE_COST) → no cost key (byte-identical to pre-刀92)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    const p = cfg.buildStdinPayload({ cost: { totalCostUSD: 9.9 } }, { KHY_STATUS_LINE_COST: v });
    assert.strictEqual('cost' in p, false, v);
  }
});

test('normalizeRenderedLine: first non-empty line, trailing trimmed, padding applied', () => {
  assert.strictEqual(cfg.normalizeRenderedLine('\n\n  hello world  \nsecond'), '  hello world');
  assert.strictEqual(cfg.normalizeRenderedLine('one\ntwo', { padding: 2 }), '  one');
  assert.strictEqual(cfg.normalizeRenderedLine(''), '');
  assert.strictEqual(cfg.normalizeRenderedLine(null), '');
});

test('normalizeRenderedLine: caps at maxLen', () => {
  const out = cfg.normalizeRenderedLine('x'.repeat(1000), { maxLen: 10 });
  assert.strictEqual(out.length, 10);
});

test('summarizeStatusLine: disabled / unconfigured / configured', () => {
  assert.match(cfg.summarizeStatusLine({ configured: true, command: 'x' }, false), /已关闭/);
  assert.match(cfg.summarizeStatusLine({ configured: false }, true), /未配置/);
  assert.match(cfg.summarizeStatusLine({ configured: true, type: 'command', command: 'echo hi' }, true), /已配置/);
});

// ── 刀96:resolveModelDisplayName — model.display_name 走友好名 SSOT(注入),不回显 raw id ──
// 注入 stub formatModelLabel 保持叶子测试零依赖(真 SSOT 是 cli/ccModelName.formatModelLabel)。
const _stubLabel = (m) => (m === 'claude-opus-4-8' ? 'Opus 4.8' : m);

test('刀96 resolveModelDisplayName: 默认开 → 走注入的友好名', () => {
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', _stubLabel, {}), 'Opus 4.8');
});

test('刀96 resolveModelDisplayName: 门控关 → 逐字节回退原始 id', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      cfg.resolveModelDisplayName('claude-opus-4-8', _stubLabel, { KHY_STATUS_LINE_MODEL_NAME: off }),
      'claude-opus-4-8', off,
    );
  }
});

test('刀96 resolveModelDisplayName: 未知 model(SSOT 返回 raw)→ 原样', () => {
  assert.strictEqual(cfg.resolveModelDisplayName('some-unknown-model', _stubLabel, {}), 'some-unknown-model');
});

test('刀96 resolveModelDisplayName: 空/null/undefined → 空串', () => {
  assert.strictEqual(cfg.resolveModelDisplayName('', _stubLabel, {}), '');
  assert.strictEqual(cfg.resolveModelDisplayName(null, _stubLabel, {}), '');
  assert.strictEqual(cfg.resolveModelDisplayName(undefined, _stubLabel, {}), '');
});

test('刀96 resolveModelDisplayName: formatModelLabel 缺失 → 回退 raw', () => {
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', undefined, {}), 'claude-opus-4-8');
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', null, {}), 'claude-opus-4-8');
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', 'nope', {}), 'claude-opus-4-8');
});

test('刀96 resolveModelDisplayName: SSOT 抛出/返回空 → 回退 raw(fail-soft,绝不丢原值)', () => {
  const thrower = () => { throw new Error('boom'); };
  const emptyReturner = () => '   ';
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', thrower, {}), 'claude-opus-4-8');
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', emptyReturner, {}), 'claude-opus-4-8');
});

test('刀96 resolveModelDisplayName: 门控默认开(unset/空/未知值)', () => {
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', _stubLabel, { KHY_STATUS_LINE_MODEL_NAME: '' }), 'Opus 4.8');
  assert.strictEqual(cfg.resolveModelDisplayName('claude-opus-4-8', _stubLabel, { KHY_STATUS_LINE_MODEL_NAME: 'x' }), 'Opus 4.8');
});

test('刀96 resolveModelDisplayName: 非字符串 model → 强转后处理,绝不抛', () => {
  assert.doesNotThrow(() => cfg.resolveModelDisplayName(123, _stubLabel, {}));
  assert.strictEqual(cfg.resolveModelDisplayName(123, (m) => `id:${m}`, {}), 'id:123');
});

// ── 刀97:buildStdinPayload output_style 段(对齐 CC types/statusLine.ts:23-25) ──
test('刀97 output_style: 默认开 → 从注入的 outputStyle 填 name', () => {
  const p = cfg.buildStdinPayload({ outputStyle: 'senior-engineer' }, {});
  assert.deepStrictEqual(p.output_style, { name: 'senior-engineer' });
});

test('刀97 output_style: 自定义样式名原样透传', () => {
  const p = cfg.buildStdinPayload({ outputStyle: '  my-style  ' }, {});
  assert.deepStrictEqual(p.output_style, { name: 'my-style' });
});

test('刀97 output_style: 门控关(KHY_STATUS_LINE_OUTPUT_STYLE)→ 无 output_style 键(逐字节回退刀97前)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const p = cfg.buildStdinPayload({ outputStyle: 'senior-engineer' }, { KHY_STATUS_LINE_OUTPUT_STYLE: off });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(p, 'output_style'), false, off);
  }
});

test('刀97 output_style: 注入缺失/空 → 省略整段(不臆造 name:\'\')', () => {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({}, {}), 'output_style'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({ outputStyle: '' }, {}), 'output_style'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({ outputStyle: '   ' }, {}), 'output_style'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({ outputStyle: 123 }, {}), 'output_style'), false);
});

test('刀97 output_style: 默认开(unset/空/未知门控值)', () => {
  assert.deepStrictEqual(cfg.buildStdinPayload({ outputStyle: 'x' }, { KHY_STATUS_LINE_OUTPUT_STYLE: '' }).output_style, { name: 'x' });
  assert.deepStrictEqual(cfg.buildStdinPayload({ outputStyle: 'x' }, { KHY_STATUS_LINE_OUTPUT_STYLE: 'z' }).output_style, { name: 'x' });
});

// ── 刀98:resolvePermissionModeLabel + permission_mode 字段(对齐 CC types/statusLine.ts:9) ──
test('刀98 resolvePermissionModeLabel: khy 内部词汇 → CC PermissionMode 词汇', () => {
  assert.strictEqual(cfg.resolvePermissionModeLabel('default'), 'default');
  assert.strictEqual(cfg.resolvePermissionModeLabel('plan'), 'plan');
  assert.strictEqual(cfg.resolvePermissionModeLabel('acceptEdits'), 'acceptEdits');
  assert.strictEqual(cfg.resolvePermissionModeLabel('auto'), 'auto');
  assert.strictEqual(cfg.resolvePermissionModeLabel('dontAsk'), 'dontAsk');
  assert.strictEqual(cfg.resolvePermissionModeLabel('bypass'), 'bypassPermissions'); // 唯一映射差异
});

test('刀98 resolvePermissionModeLabel: 已是 CC 拼写 → 直通;首尾空白容忍', () => {
  assert.strictEqual(cfg.resolvePermissionModeLabel('bypassPermissions'), 'bypassPermissions');
  assert.strictEqual(cfg.resolvePermissionModeLabel('  plan  '), 'plan');
});

test('刀98 resolvePermissionModeLabel: 未知/空/非字符串 → \'\'(省略,不臆造 default)', () => {
  assert.strictEqual(cfg.resolvePermissionModeLabel('yolo'), '');
  assert.strictEqual(cfg.resolvePermissionModeLabel(''), '');
  assert.strictEqual(cfg.resolvePermissionModeLabel(null), '');
  assert.strictEqual(cfg.resolvePermissionModeLabel(undefined), '');
  assert.strictEqual(cfg.resolvePermissionModeLabel(123), '');
});

test('刀98 permission_mode: 默认开 → 从注入的 permissionMode 填(bypass→bypassPermissions)', () => {
  assert.strictEqual(cfg.buildStdinPayload({ permissionMode: 'default' }, {}).permission_mode, 'default');
  assert.strictEqual(cfg.buildStdinPayload({ permissionMode: 'acceptEdits' }, {}).permission_mode, 'acceptEdits');
  assert.strictEqual(cfg.buildStdinPayload({ permissionMode: 'bypass' }, {}).permission_mode, 'bypassPermissions');
});

test('刀98 permission_mode: 门控关(KHY_STATUS_LINE_PERMISSION_MODE)→ 无 permission_mode 键(逐字节回退刀98前)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const p = cfg.buildStdinPayload({ permissionMode: 'bypass' }, { KHY_STATUS_LINE_PERMISSION_MODE: off });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(p, 'permission_mode'), false, off);
  }
});

test('刀98 permission_mode: 注入缺失/未知 → 省略字段(不臆造 default)', () => {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({}, {}), 'permission_mode'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({ permissionMode: 'yolo' }, {}), 'permission_mode'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({ permissionMode: '' }, {}), 'permission_mode'), false);
});

// ── 刀99:session_id 透传(对齐 CC types/statusLine.ts:6 + StatusLine.tsx:302 session_id:getSessionId()) ──
test('刀99 session_id: 默认开 → 透传注入的 sessionId', () => {
  assert.strictEqual(cfg.buildStdinPayload({ sessionId: 'sess-abc123' }, {}).session_id, 'sess-abc123');
});

test('刀99 session_id: 门控关(KHY_STATUS_LINE_SESSION_ID)→ 逐字节回退空串(刀99前:壳从不注入)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const p = cfg.buildStdinPayload({ sessionId: 'sess-abc123' }, { KHY_STATUS_LINE_SESSION_ID: off });
    assert.strictEqual(p.session_id, '', off);
    // session_id 恒为必填顶层键(CC 契约必填),门控只改值不改键存在性。
    assert.strictEqual(Object.prototype.hasOwnProperty.call(p, 'session_id'), true, off);
  }
});

test('刀99 session_id: 注入缺失/非字符串 → 空串(不臆造)', () => {
  assert.strictEqual(cfg.buildStdinPayload({}, {}).session_id, '');
  assert.strictEqual(cfg.buildStdinPayload({ sessionId: 123 }, {}).session_id, '');
  assert.strictEqual(cfg.buildStdinPayload({ sessionId: null }, {}).session_id, '');
});

test('刀99 session_id: 门控默认开(unset/空/未知值)', () => {
  assert.strictEqual(cfg.buildStdinPayload({ sessionId: 's1' }, { KHY_STATUS_LINE_SESSION_ID: '' }).session_id, 's1');
  assert.strictEqual(cfg.buildStdinPayload({ sessionId: 's1' }, { KHY_STATUS_LINE_SESSION_ID: 'x' }).session_id, 's1');
});

// ── 刀100:transcript_path 字段(对齐 CC types/statusLine.ts:7 顶层 transcript_path:string) ──
test('刀100 transcript_path: 默认开 → 透传注入的路径', () => {
  const p = cfg.buildStdinPayload({ transcriptPath: '/home/u/.khy/sessions/proj/sess.jsonl' }, {});
  assert.strictEqual(p.transcript_path, '/home/u/.khy/sessions/proj/sess.jsonl');
});

test('刀100 transcript_path: 默认开但注入缺失/非字符串 → 恒发 \'\'(CC 必填·honest 空)', () => {
  assert.strictEqual(cfg.buildStdinPayload({}, {}).transcript_path, '');
  assert.strictEqual(cfg.buildStdinPayload({ transcriptPath: 123 }, {}).transcript_path, '');
  assert.strictEqual(cfg.buildStdinPayload({ transcriptPath: null }, {}).transcript_path, '');
  // 门控开时键恒在(与 CC 必填对齐)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg.buildStdinPayload({}, {}), 'transcript_path'), true);
});

test('刀100 transcript_path: 门控关(KHY_STATUS_LINE_TRANSCRIPT_PATH)→ 无 transcript_path 键(逐字节回退刀100前)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const p = cfg.buildStdinPayload({ transcriptPath: '/x/sess.jsonl' }, { KHY_STATUS_LINE_TRANSCRIPT_PATH: off });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(p, 'transcript_path'), false, off);
  }
});

test('刀100 transcript_path: 门控默认开(unset/空/未知值)', () => {
  assert.strictEqual(cfg.buildStdinPayload({ transcriptPath: '/a.jsonl' }, { KHY_STATUS_LINE_TRANSCRIPT_PATH: '' }).transcript_path, '/a.jsonl');
  assert.strictEqual(cfg.buildStdinPayload({ transcriptPath: '/a.jsonl' }, { KHY_STATUS_LINE_TRANSCRIPT_PATH: 'x' }).transcript_path, '/a.jsonl');
});

