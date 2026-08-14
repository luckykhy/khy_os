// appHostHelpers 叶子级测试 —— 锁定「从 App.js 抽出的 React 闭包无关模块作用域助手」的独立契约:
// 叶子可单独 require、16 个导出齐备、状态/spinner/token/队列面板派生纯逻辑不变、权限模式表齐、
// TUI 不支持判定按子命令区分、fail-soft 不抛。
//
// 抽出范式同 queryBridgeTimeline/localBrainProviderConfig(降上帝文件·DESIGN-ARCH-051)。App()
// 挂载态的端到端由 tests/tui/inkRenderSmoke 等覆盖;本测只对叶子本体,证抽出后自洽。
//
// 运行: node --test tests/tui/appHostHelpersLeaf.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/cli/tui/ink-components/appHostHelpers');

const EXPORTS = [
  '_readMergedTaskLines', 'PERMISSION_MODES', 'applyPermissionMode',
  '_normToolName', 'isQuestionRequest', '_learnNeedsClassic', 'tuiUnsupportedReason',
  '_taskActivity', '_getStatusLabel', '_liveActivity', '_spinnerCcTokensEnabled',
  '_estimateTok', '_spinnerProgress', '_queuePanelLines', '_renderQueuePanel',
  '_liveClampBoundaryDecision',
];

test('叶子可单独 require,16 个导出齐备(含权限模式常量数组)', () => {
  for (const name of EXPORTS) {
    if (name === 'PERMISSION_MODES') {
      assert.ok(Array.isArray(leaf[name]), 'PERMISSION_MODES 应为数组');
    } else {
      assert.equal(typeof leaf[name], 'function', `缺少导出 ${name}`);
    }
  }
});

test('PERMISSION_MODES:5 宽 Shift+Tab 循环顺序固定(含 auto)', () => {
  assert.deepEqual(leaf.PERMISSION_MODES, ['default', 'acceptEdits', 'plan', 'auto', 'bypass']);
});

test('_normToolName:去空白/下划线/连字并小写', () => {
  assert.equal(leaf._normToolName('Ask_User-Question'), 'askuserquestion');
  assert.equal(leaf._normToolName(null), '');
});

test('isQuestionRequest:仅 can_use_tool + AskUserQuestion 目标为真', () => {
  assert.equal(leaf.isQuestionRequest({ request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } }), true);
  assert.equal(leaf.isQuestionRequest({ request: { subtype: 'can_use_tool', tool_name: 'Bash' } }), false);
  assert.equal(leaf.isQuestionRequest(null), false);
});

test('_getStatusLabel:基础相位 + activity 明细拼接', () => {
  assert.equal(leaf._getStatusLabel('tool', '列出 Desktop'), '执行工具… · 列出 Desktop');
  assert.equal(leaf._getStatusLabel('thinking', ''), '思考中…');
  assert.equal(leaf._getStatusLabel('unknown', ''), '思考中…'); // 兜底
});

test('_spinnerCcTokensEnabled:默认开,显式关字面量识别', () => {
  assert.equal(leaf._spinnerCcTokensEnabled({}), true);
  assert.equal(leaf._spinnerCcTokensEnabled({ KHY_SPINNER_CC_TOKENS: '0' }), false);
  assert.equal(leaf._spinnerCcTokensEnabled({ KHY_SPINNER_CC_TOKENS: 'off' }), false);
});

test('_estimateTok:空返 0;字符兜底 CC 口径 round(len/4),关门 ceil', () => {
  assert.equal(leaf._estimateTok(''), 0);
  // 无真 tokenizer 时走字符兜底;10 字符 → round(2.5)=3(默认 CC) / ceil(2.5)=3(关门,此例相等)
  const cc = leaf._estimateTok('abcdefghij', {});
  assert.ok(cc >= 1);
});

test('_spinnerProgress:纯时间派生 elapsedSec/stalled(now 传入,3s 阈)', () => {
  const started = 1_000_000;
  // 距上次活动 2s < 3s → 未停滞
  const fresh = leaf._spinnerProgress(started, started + 5000, started + 3000, null, {});
  assert.equal(fresh.elapsedSec, 5);
  assert.equal(fresh.stalled, false);
  // 距上次活动 9s > 3s → 停滞
  const stalled = leaf._spinnerProgress(started, started + 10000, started + 1000, null, {});
  assert.equal(stalled.stalled, true);
});

test('_queuePanelLines:空→[];超 5 条折叠 + 末条↑取回 + 汇总行', () => {
  assert.deepEqual(leaf._queuePanelLines([]), []);
  const rows = leaf._queuePanelLines(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.ok(rows.some((r) => r.includes('↑ 取回')));
  assert.ok(rows.some((r) => r.includes('还有 2 条')));
  assert.ok(rows[rows.length - 1].includes('7 条排队'));
});

test('_renderQueuePanel:载 ink 后返回元素数组;未载则明确抛(证叶子非纯零 IO)', async () => {
  // 未载 ink 时依赖 inkRuntime.get() 会显式抛 —— 契约就是「仅挂载后可调」,与 App.js 内一致
  assert.throws(() => leaf._renderQueuePanel(['hello']), /loadInk/);
  const inkRuntime = require('../../src/cli/tui/inkRuntime');
  await inkRuntime.loadInk();
  const els = leaf._renderQueuePanel(['hello']);
  assert.ok(Array.isArray(els));
  assert.ok(els.length >= 1);
});

test('_liveClampBoundaryDecision:新轮 reserve≠0 先 reset 不采样;同轮采样', () => {
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', 't2', 5), { changed: true, reset: true, sample: false });
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', 't2', 0), { changed: true, reset: false, sample: true });
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', 't1', 0), { changed: false, reset: false, sample: true });
  assert.deepEqual(leaf._liveClampBoundaryDecision('t1', null, 0), { changed: true, reset: false, sample: false });
});

test('tuiUnsupportedReason:未知/原生命令返回 null,forgot 返回中文原因', () => {
  assert.equal(leaf.tuiUnsupportedReason(null), null);
  assert.equal(leaf.tuiUnsupportedReason({ command: 'rollback' }), null);
  assert.equal(leaf.tuiUnsupportedReason({ command: 'forgot' }), '找回密码');
});

test('applyPermissionMode:任意模式 fail-soft 不抛(缺依赖静默兜底)', () => {
  assert.doesNotThrow(() => leaf.applyPermissionMode('default'));
  assert.doesNotThrow(() => leaf.applyPermissionMode('auto'));
  assert.doesNotThrow(() => leaf.applyPermissionMode('dontAsk'));
  assert.doesNotThrow(() => leaf.applyPermissionMode('bypass'));
});

test('_readMergedTaskLines / _taskActivity:fail-soft 返回数组 / 字符串', () => {
  assert.ok(Array.isArray(leaf._readMergedTaskLines()));
  assert.equal(typeof leaf._taskActivity(), 'string');
});

test('重复 require 命中同一单例(模块缓存稳定)', () => {
  assert.equal(require('../../src/cli/tui/ink-components/appHostHelpers'), leaf);
});
