'use strict';

/**
 * codexEventStream 叶子契约测试。
 *
 * 覆盖从 codexAdapter.js(上帝文件)抽出的「Codex CLI 事件流解释」子系统:
 * 导出面完整性、纯归一化/推断分支的确定性行为(工具/文件操作推断、进度证据、
 * 重连检测、停滞分类),以及单例稳定性。零可变模块态,均可直接以参数驱动断言。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../../src/services/gateway/adapters/codexEventStream');

test('导出面:23 个函数俱在', () => {
  const fns = [
    'isReconnectChannelClosed', 'compactText', 'appendCodexExecDebugLog',
    'summarizeValue', 'getItemType', 'inferToolName', 'inferToolInput',
    'inferToolOutput', 'isToolLike', 'normalizeTrackedFileOperation',
    'classifyTrackedRelocation', 'dedupeTrackedFileOps',
    'extractTrackedFileOpsFromShellCommand', 'inferTrackedFileOps',
    'createCodexProgressEvidence', 'recordCodexProgressEvent',
    'classifyCodexPreResponseStall', 'snapshotCodexProgressEvidence',
    'formatCodexProgressEvidence', 'createCodexProgressTimeoutError',
    'appendCodexExecProgressLog', 'buildCodexProgressDiagnostics', 'emitCodexEvent',
  ];
  for (const k of fns) assert.strictEqual(typeof leaf[k], 'function', `缺函数导出 ${k}`);
});

test('isReconnectChannelClosed:重连/通道关闭为 true,正常消息为 false', () => {
  assert.strictEqual(leaf.isReconnectChannelClosed('Reconnecting... 1/10 (stream disconnected)'), true);
  assert.strictEqual(leaf.isReconnectChannelClosed('channel closed'), true);
  assert.strictEqual(leaf.isReconnectChannelClosed('failed to record rollout items'), true);
  assert.strictEqual(leaf.isReconnectChannelClosed('transport issue during rollout recording'), true);
  assert.strictEqual(leaf.isReconnectChannelClosed('hello world'), false);
  assert.strictEqual(leaf.isReconnectChannelClosed(''), false);
  assert.strictEqual(leaf.isReconnectChannelClosed(null), false);
});

test('compactText:空→空串·折叠空白·超长截断带省略号', () => {
  assert.strictEqual(leaf.compactText(''), '');
  assert.strictEqual(leaf.compactText(null), '');
  assert.strictEqual(leaf.compactText('a   b\n c'), 'a b c');
  const long = 'x'.repeat(500);
  const out = leaf.compactText(long, 200);
  assert.strictEqual(out.length, 200);
  assert.ok(out.endsWith('…'));
});

test('summarizeValue:字符串/对象 JSON 化·截断', () => {
  assert.strictEqual(leaf.summarizeValue('plain'), 'plain');
  assert.ok(leaf.summarizeValue({ a: 1, b: 'two' }).includes('two'));
  const long = 'y'.repeat(400);
  assert.ok(leaf.summarizeValue(long, 180).endsWith('…'));
});

test('getItemType:从 item.type / item_type / type 归一小写', () => {
  assert.strictEqual(leaf.getItemType({ item: { type: 'Command' } }), 'command');
  assert.strictEqual(leaf.getItemType({ item_type: 'FILE_WRITE' }), 'file_write');
  assert.strictEqual(leaf.getItemType({ type: 'Reasoning' }), 'reasoning');
  assert.strictEqual(leaf.getItemType({}), '');
});

test('inferToolName:command→bash·write→file_write·edit→file_edit', () => {
  assert.strictEqual(leaf.inferToolName('command', { command: 'ls' }), 'bash');
  assert.strictEqual(leaf.inferToolName('file_write', {}), 'file_write');
  assert.strictEqual(leaf.inferToolName('file_edit', {}), 'file_edit');
  assert.strictEqual(leaf.inferToolName('other', { name: 'grep' }), 'grep');
});

test('normalizeTrackedFileOperation:rm→delete·mv→move·未知→空', () => {
  assert.strictEqual(leaf.normalizeTrackedFileOperation('rm'), 'delete');
  assert.strictEqual(leaf.normalizeTrackedFileOperation('unlink'), 'delete');
  assert.strictEqual(leaf.normalizeTrackedFileOperation('mv'), 'move');
  assert.strictEqual(leaf.normalizeTrackedFileOperation('create'), 'create');
  assert.strictEqual(leaf.normalizeTrackedFileOperation('edit'), 'modify');
  assert.strictEqual(leaf.normalizeTrackedFileOperation('rename'), 'rename');
  assert.strictEqual(leaf.normalizeTrackedFileOperation('nonsense'), '');
  assert.strictEqual(leaf.normalizeTrackedFileOperation(''), '');
});

test('classifyTrackedRelocation:同目录→rename·跨目录→move·缺参→move', () => {
  assert.strictEqual(leaf.classifyTrackedRelocation('/a/x.txt', '/a/y.txt'), 'rename');
  assert.strictEqual(leaf.classifyTrackedRelocation('/a/x.txt', '/b/x.txt'), 'move');
  assert.strictEqual(leaf.classifyTrackedRelocation('', '/b/x.txt'), 'move');
});

test('dedupeTrackedFileOps:去重·过滤非法·归一 operation', () => {
  const ops = leaf.dedupeTrackedFileOps([
    { path: '/a.txt', operation: 'rm' },
    { path: '/a.txt', operation: 'delete' }, // 与上等价 → 去重
    { path: '/b.txt', op: 'create' },
    null,
    { operation: 'edit' }, // 无 path → 丢弃
    'junk',
  ]);
  assert.strictEqual(ops.length, 2);
  assert.deepStrictEqual(ops[0], { path: '/a.txt', operation: 'delete', fromPath: '', toPath: '' });
  assert.strictEqual(ops[1].operation, 'create');
});

test('extractTrackedFileOpsFromShellCommand:rm→delete·重定向>→create', () => {
  const rmOps = leaf.extractTrackedFileOpsFromShellCommand('rm -f /tmp/x.txt');
  assert.ok(rmOps.some((o) => o.operation === 'delete' && o.path.includes('x.txt')));
  const redirOps = leaf.extractTrackedFileOpsFromShellCommand('echo hi > /tmp/out.log');
  assert.ok(redirOps.some((o) => o.operation === 'create' && o.path.includes('out.log')));
  assert.deepStrictEqual(leaf.extractTrackedFileOpsFromShellCommand(''), []);
});

test('createCodexProgressEvidence:初始快照零计数', () => {
  const p = leaf.createCodexProgressEvidence();
  assert.strictEqual(p.reconnectWarnings, 0);
  assert.strictEqual(p.furthestStage, 'spawned');
  assert.strictEqual(p.stdoutJsonEvents, 0);
});

test('recordCodexProgressEvent:reconnectWarning 累加·turn/thread 计数', () => {
  const p = leaf.createCodexProgressEvidence();
  leaf.recordCodexProgressEvent(p, { channel: 'stdout_json', kind: 'error', reconnectWarning: true });
  leaf.recordCodexProgressEvent(p, { channel: 'stdout_json', kind: 'error', reconnectWarning: true });
  assert.strictEqual(p.reconnectWarnings, 2);
  // null progress 安全返回
  assert.doesNotThrow(() => leaf.recordCodexProgressEvent(null, {}));
});

test('classifyCodexPreResponseStall:重连循环→对应 code·无快照→unknown', () => {
  assert.strictEqual(leaf.classifyCodexPreResponseStall(null).code, 'unknown');
  assert.strictEqual(
    leaf.classifyCodexPreResponseStall({ reconnectWarnings: 3, turnStartedCount: 1 }).code,
    'turn_started_reconnect_loop',
  );
  assert.strictEqual(
    leaf.classifyCodexPreResponseStall({ reconnectWarnings: 3, threadStartedCount: 1 }).code,
    'thread_started_reconnect_loop',
  );
  assert.strictEqual(
    leaf.classifyCodexPreResponseStall({ reconnectWarnings: 3 }).code,
    'transport_reconnect_before_turn',
  );
  assert.strictEqual(
    leaf.classifyCodexPreResponseStall({}).code,
    'no_subprocess_output',
  );
});

test('单例稳定:重复 require 同引用', () => {
  const again = require('../../../../src/services/gateway/adapters/codexEventStream');
  assert.strictEqual(again, leaf);
  assert.strictEqual(again.isReconnectChannelClosed, leaf.isReconnectChannelClosed);
});
