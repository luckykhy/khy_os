'use strict';

// /context-warning 契约测试:纯叶子(阈值/分母/警告带门控/escalation 状态机)。
// 对齐 CC calculateTokenWarningState + TokenWarning.tsx 背后逻辑,参数化为
// khy 真实 auto-compact 触发比(0.8,compactPipeline)。零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/contextWarning');

const WINDOW = 200000;
const RATIO = 0.8;
// 200k window, ratio 0.8 → autoCompactThreshold = 160000.
// warning band starts at threshold - 20000 = 140000.

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_CONTEXT_WARNING: off }), false, `应关: ${off}`);
  }
});

test('effectiveContextWindow:窗口减去 min(reserve,20000)', () => {
  assert.strictEqual(leaf.effectiveContextWindow(200000, 20000), 180000);
  assert.strictEqual(leaf.effectiveContextWindow(200000, 8192), 191808); // 小输出模型预留更少
  assert.strictEqual(leaf.effectiveContextWindow(200000, 100000), 180000); // 封顶 20000
  assert.strictEqual(leaf.effectiveContextWindow(200000, undefined), 180000); // 默认 20000
  assert.strictEqual(leaf.effectiveContextWindow(10000, 20000), 0); // 不为负
});

test('calculateTokenWarningState:阈值=ratio*window(khy 真实触发,非裸 window)', () => {
  const s = leaf.calculateTokenWarningState({ tokenUsage: 0, contextWindow: WINDOW, autoCompactRatio: RATIO });
  assert.strictEqual(s.autoCompactThreshold, 160000);
  assert.strictEqual(s.threshold, 160000); // auto-compact 开 → 阈值=autoCompactThreshold
  assert.strictEqual(s.percentLeft, 100); // 0 用量 → 100% 剩余
});

test('percentLeft:对阈值算分母(非裸 window)', () => {
  // 80000 用量,阈值 160000 → 剩余 (160000-80000)/160000 = 50%
  const s = leaf.calculateTokenWarningState({ tokenUsage: 80000, contextWindow: WINDOW, autoCompactRatio: RATIO });
  assert.strictEqual(s.percentLeft, 50);
  // 对裸 window(200000)算会得 60%,证明分母确实是阈值
  assert.notStrictEqual(s.percentLeft, Math.round((WINDOW - 80000) / WINDOW * 100));
});

test('警告带门控:阈值-20000 以下不显示,以上才显示', () => {
  // 阈值 160000,警告带起点 140000
  const below = leaf.calculateTokenWarningState({ tokenUsage: 139999, contextWindow: WINDOW, autoCompactRatio: RATIO });
  assert.strictEqual(below.isAboveWarningThreshold, false, '139999 < 140000 不显示');
  const at = leaf.calculateTokenWarningState({ tokenUsage: 140000, contextWindow: WINDOW, autoCompactRatio: RATIO });
  assert.strictEqual(at.isAboveWarningThreshold, true, '140000 >= 140000 显示');
});

test('percentLeft 下钳到 0(用量超阈值不为负)', () => {
  const s = leaf.calculateTokenWarningState({ tokenUsage: 300000, contextWindow: WINDOW, autoCompactRatio: RATIO });
  assert.strictEqual(s.percentLeft, 0);
});

test('auto-compact 关 → 阈值=effectiveWindow(非 ratio*window)', () => {
  const s = leaf.calculateTokenWarningState({
    tokenUsage: 0, contextWindow: WINDOW, autoCompactRatio: RATIO, autoCompactEnabled: false,
  });
  assert.strictEqual(s.threshold, 180000); // effectiveWindow = 200000 - 20000
  assert.strictEqual(s.isAboveAutoCompactThreshold, false, 'auto-compact 关 → 永不越 autoCompact 阈');
});

test('buildContextWarning:警告带外 show=false', () => {
  const d = leaf.buildContextWarning({ tokenUsage: 50000, contextWindow: WINDOW, autoCompactRatio: RATIO });
  assert.strictEqual(d.show, false);
  assert.strictEqual(d.text, '');
});

test('buildContextWarning:auto-compact 开 → dim "% until auto-compact"', () => {
  const d = leaf.buildContextWarning({ tokenUsage: 150000, contextWindow: WINDOW, autoCompactRatio: RATIO });
  assert.strictEqual(d.show, true);
  assert.strictEqual(d.style, 'dim');
  assert.match(d.text, /^\d+% until auto-compact$/);
});

test('buildContextWarning:auto-compact 关 → escalation "Context low … Run /compact"', () => {
  const d = leaf.buildContextWarning({
    tokenUsage: 175000, contextWindow: WINDOW, autoCompactRatio: RATIO, autoCompactEnabled: false,
  });
  assert.strictEqual(d.show, true);
  assert.match(d.text, /Context low \(\d+% remaining\) · Run \/compact to compact & continue/);
  // 175000 >= errorThreshold(180000-20000=160000) → error 色
  assert.strictEqual(d.style, 'error');
});

test('坏比/坏数防呆:ratio 越界回退 0.8·非数用量→0', () => {
  const s1 = leaf.calculateTokenWarningState({ tokenUsage: 'x', contextWindow: WINDOW, autoCompactRatio: 5 });
  assert.strictEqual(s1.autoCompactThreshold, 160000, 'ratio 5 越界 → 回退 0.8');
  assert.strictEqual(s1.percentLeft, 100, '非数用量 → 0');
  const s2 = leaf.calculateTokenWarningState({ tokenUsage: 100, contextWindow: 0, autoCompactRatio: RATIO });
  assert.strictEqual(s2.percentLeft, 0, '零窗口 → 阈值 0 → percentLeft 0 不崩');
  assert.strictEqual(s2.isAboveWarningThreshold, false);
});

// ── 刀62:压缩后警告抑制(对齐 CC compactWarningState 背后逻辑)──
test('isCompactionStale:lastCompactionUsed<=0 → 从不抑制(向后兼容旧 caller)', () => {
  assert.strictEqual(leaf.isCompactionStale(180000, 0), false);
  assert.strictEqual(leaf.isCompactionStale(180000, undefined), false);
  assert.strictEqual(leaf.isCompactionStale(180000, -1), false);
  assert.strictEqual(leaf.isCompactionStale(180000, 'x'), false);
});

test('isCompactionStale:用量仍 >= 压缩前陈旧值 → 抑制;跌破 → 解除(自清)', () => {
  // 压缩后 used 仍为陈旧高值 155000 >= lastCompactionUsed 155000 → 抑制。
  assert.strictEqual(leaf.isCompactionStale(155000, 155000), true, '未刷新(相等)→ 抑制');
  assert.strictEqual(leaf.isCompactionStale(160000, 155000), true, '涨了(仍未刷新)→ 抑制');
  // 新一轮 API 响应带来更低计数 → 自然解除。
  assert.strictEqual(leaf.isCompactionStale(70000, 155000), false, '跌破 → 解除');
});

test('buildContextWarning:压缩后陈旧窗口内应抑制(show=false·suppressed=true),即便越警告带', () => {
  // 150000 本会越警告带(140000)显示 dim 行;但 lastCompactionUsed=150000 → 抑制。
  const suppressed = leaf.buildContextWarning({
    tokenUsage: 150000, contextWindow: WINDOW, autoCompactRatio: RATIO, lastCompactionUsed: 150000,
  });
  assert.strictEqual(suppressed.show, false, '陈旧窗口内不显示');
  assert.strictEqual(suppressed.suppressed, true);
  assert.strictEqual(suppressed.text, '');
  // 对照:同样用量但无 lastCompactionUsed(新计数已刷新)→ 正常显示。
  const shown = leaf.buildContextWarning({
    tokenUsage: 150000, contextWindow: WINDOW, autoCompactRatio: RATIO,
  });
  assert.strictEqual(shown.show, true, '刷新后照常显示');
  assert.match(shown.text, /^\d+% until auto-compact$/);
});

test('buildContextWarning:压缩释放后计数刷新到低位 → 一次性门解除,不再抑制', () => {
  // 压缩把 used 从 150000 降到 70000(下一次响应),此时 lastCompactionUsed 已被壳清 0。
  const d = leaf.buildContextWarning({
    tokenUsage: 70000, contextWindow: WINDOW, autoCompactRatio: RATIO, lastCompactionUsed: 0,
  });
  assert.strictEqual(d.show, false, '70000 在警告带外,本就不显示(非抑制路径)');
  assert.strictEqual(d.suppressed, undefined, '未走抑制分支');
});
