// queryBridgeTimeline.buildTurnArtifacts —— 「交互过程与输出结构化」持久化投影的
// 叶子级单测:把内存回合状态(timeline/toolCallLog/elapsedMs/tokens)投影成可选持久化
// 字段 _timeline/_toolCalls/_turnStats。锁三条契约:
//   ① 完整投影:text 连续段合并、thinking 保留独立段与真实 durationMs、tool 段收拢为
//      tools 组;toolCallLog 蒸馏出 seq/name/paramsSummary/durationMs/status/error;
//   ② 诚实省略(present-only):不可得的量一律省略、绝不补零;空输入返回 {};
//   ③ paramsSummary 有界:超长参数截到 200 字符 + 省略号,换行压平。
//
// 运行: node --test tests/tui/queryBridgeTimeline.buildTurnArtifacts.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnArtifacts } = require('../../src/cli/tui/hooks/queryBridgeTimeline');

test('完整投影:text 合并 / thinking 独立段带时长 / tool 收拢为 tools 组', () => {
  const timeline = [
    { type: 'text', text: '第一段 ' },
    { type: 'text', text: '续写' },                          // merges into previous text
    { type: 'thinking', text: '想一想', durationMs: 800 },
    { type: 'tool', tool: { name: 'Read', input: { file_path: 'a.js' }, result: { text: 'ok', isError: false } } },
    { type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: { text: '', isError: true } } },
    { type: 'text', text: '收尾' },
  ];
  const toolCallLog = [
    { tool: 'Read', params: { file_path: 'a.js' }, elapsed: 42, result: { success: true } },
    { tool: 'Bash', params: { command: 'ls' }, elapsed: 7, result: { success: false, error: 'boom' } },
  ];
  const out = buildTurnArtifacts({ timeline, toolCallLog, elapsedMs: 1234.6, tokens: 99 });

  // _timeline: [text(merged), thinking, tools[2], text]
  assert.equal(out._timeline.length, 4);
  assert.deepEqual(out._timeline[0], { type: 'text', text: '第一段 续写' });
  assert.equal(out._timeline[1].type, 'thinking');
  assert.equal(out._timeline[1].durationMs, 800);
  assert.equal(out._timeline[2].type, 'tools');
  assert.equal(out._timeline[2].tools.length, 2);
  assert.equal(out._timeline[2].tools[0].name, 'Read');
  assert.equal(out._timeline[2].tools[0].status, 'done');
  assert.equal(out._timeline[2].tools[1].status, 'error');
  assert.deepEqual(out._timeline[3], { type: 'text', text: '收尾' });

  // _toolCalls: distilled from the authoritative log — never full results.
  assert.equal(out._toolCalls.length, 2);
  assert.deepEqual(out._toolCalls[0], {
    seq: 1, name: 'Read', paramsSummary: '{"file_path":"a.js"}', durationMs: 42, status: 'done',
  });
  assert.equal(out._toolCalls[1].status, 'error');
  assert.equal(out._toolCalls[1].error, 'boom');

  // _turnStats: elapsed rounded, tokens carried, toolCount from the real log.
  assert.deepEqual(out._turnStats, { elapsedMs: 1235, tokens: 99, toolCount: 2 });
});

test('诚实省略:缺量不补零 —— 无耗时/无 tokens 时对应键整体缺席', () => {
  const out = buildTurnArtifacts({
    timeline: [{ type: 'text', text: 'hi' }],
    toolCallLog: [],
    elapsedMs: 0,
    tokens: 0,
  });
  assert.equal('elapsedMs' in out._turnStats, false, 'elapsedMs=0 不是事实,必须省略');
  assert.equal('tokens' in out._turnStats, false, 'tokens=0 不是事实,必须省略');
  // 空日志数组本身是事实「零工具运行」→ toolCount:0 保留。
  assert.deepEqual(out._turnStats, { toolCount: 0 });
  // 但空日志不产出 _toolCalls(present-only)。
  assert.equal('_toolCalls' in out, false);
});

test('诚实省略:toolCallLog 缺席(非数组)时 toolCount 不虚构', () => {
  const out = buildTurnArtifacts({ timeline: [], toolCallLog: null, elapsedMs: 100 });
  assert.equal('_timeline' in out, false);
  assert.equal('_toolCalls' in out, false);
  assert.deepEqual(out._turnStats, { elapsedMs: 100 });
});

test('空投影返回 {}:调用方可整体跳过挂载,持久化字节与旧格式一致', () => {
  assert.deepEqual(buildTurnArtifacts({}), {});
  assert.deepEqual(buildTurnArtifacts(), {});
  assert.deepEqual(buildTurnArtifacts({ timeline: [], toolCallLog: null, elapsedMs: 0, tokens: 0 }), {});
  // 空文本段被丢弃 → 仍是空投影。
  assert.deepEqual(buildTurnArtifacts({ timeline: [{ type: 'text', text: '' }] }), {});
});

test('paramsSummary 截断:超长参数压平换行并截到 200 字符 + 省略号', () => {
  const longParams = { command: `run ${'x'.repeat(500)}\nsecond line` };
  const out = buildTurnArtifacts({
    timeline: [{ type: 'tool', tool: { name: 'Bash', input: longParams } }],
    toolCallLog: [{ tool: 'Bash', params: longParams, result: { success: true } }],
  });
  for (const ps of [out._timeline[0].tools[0].paramsSummary, out._toolCalls[0].paramsSummary]) {
    assert.equal(ps.length, 201, '200 字符正文 + 1 个省略号');
    assert.ok(ps.endsWith('…'));
    assert.equal(ps.includes('\n'), false, '换行必须压平成空格');
  }
  // 无 result 的 timeline 工具不盖 status(结果未知,不虚构)。
  assert.equal('status' in out._timeline[0].tools[0], false);
  // 无 elapsed 的日志条目不盖 durationMs。
  assert.equal('durationMs' in out._toolCalls[0], false);
});

test('错误摘要有界:结构化 error 对象取 message,超长截断', () => {
  const out = buildTurnArtifacts({
    toolCallLog: [
      { tool: 'Write', params: {}, result: { success: false, error: { message: 'm'.repeat(400) } } },
      { tool: 'Grep', params: {}, result: { success: false, reason: 'denied by  policy\nline2' } },
    ],
  });
  assert.equal(out._toolCalls[0].status, 'error');
  assert.ok(out._toolCalls[0].error.length <= 200);
  assert.equal(out._toolCalls[1].error, 'denied by policy line2');
});
