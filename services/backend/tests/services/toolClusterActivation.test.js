'use strict';

/**
 * toolClusterActivation — 工具簇预激活的单测(node:test)。
 *
 * 回归目标(khyos 自审 #4「工具发现成本高」):
 *   ① 用**真实** registry 锁死不变量:每个簇声明的工具名都必须确为「可延迟工具」
 *      (shouldDefer && !alwaysLoad)——工具改名/去 defer 而此表不更新 → 守卫失败。
 *   ② 信号命中:能力专有词命中对应簇;无关文本零命中(低假阳)。
 *   ③ 门控字节回退(关 → []);fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/services/toolClusterActivation');

// ── 真实 registry 不变量守卫(核心)──────────────────────────────────────────
test('真实 registry:每个簇声明的工具名都确为可延迟工具(无漂移)', () => {
  const reg = require('../../src/tools');
  if (reg.loadTools) reg.loadTools();
  const all = reg.getAll();
  const deferrable = new Set();
  for (const [name, t] of all.entries()) {
    if (t && t.shouldDefer && !t.alwaysLoad) deferrable.add(name);
  }
  const declared = mod.declaredClusterTools();
  assert.ok(declared.length > 0, '簇表不应为空');
  const missing = declared.filter((n) => !deferrable.has(n));
  assert.deepStrictEqual(
    missing, [],
    `簇里的工具名不是可延迟工具(改名或去 defer 了?应更新 TOOL_CLUSTERS):${missing.join(', ')}`,
  );
});

// ── 信号命中(中英双语)──────────────────────────────────────────────────────
test('selectToolsToActivate:浏览器信号 → WebBrowser', () => {
  const picked = mod.selectToolsToActivate('帮我打开网页看一下', { env: {} });
  assert.ok(picked.includes('WebBrowser'), `期望含 WebBrowser,实得 ${JSON.stringify(picked)}`);
});

test('selectToolsToActivate:编译信号 → compile_file', () => {
  const picked = mod.selectToolsToActivate('把这个文件编译一下', { env: {} });
  assert.ok(picked.includes('compile_file'));
  const en = mod.selectToolsToActivate('please compile this with gcc', { env: {} });
  assert.ok(en.includes('compile_file'));
});

test('selectToolsToActivate:配置模型密钥 → configureModelProvider', () => {
  const picked = mod.selectToolsToActivate('我要配置一个新模型的 api key', { env: {} });
  assert.ok(picked.includes('configureModelProvider'));
});

test('selectToolsToActivate:workflow 信号 → Workflow', () => {
  const picked = mod.selectToolsToActivate('用 workflow 编排这几个任务', { env: {} });
  assert.ok(picked.includes('Workflow'));
});

test('selectToolsToActivate:去重且确定式排序', () => {
  // desktop-control 簇含 DesktopControl+TerminalCapture,截图信号触发
  const picked = mod.selectToolsToActivate('给屏幕截图并模拟鼠标点击', { env: {} });
  assert.ok(picked.includes('DesktopControl'));
  const sorted = picked.slice().sort();
  assert.deepStrictEqual(picked, sorted, '返回应确定式排序');
  assert.strictEqual(new Set(picked).size, picked.length, '不应重复');
});

// ── 低假阳:无关文本零命中 ────────────────────────────────────────────────────
test('selectToolsToActivate:无关闲聊零命中', () => {
  for (const t of ['你好,今天天气怎么样', '帮我改个变量名', '解释一下这段逻辑', '写个 hello world']) {
    assert.deepStrictEqual(mod.selectToolsToActivate(t, { env: {} }), [], `不应命中:${t}`);
  }
});

// ── 门控字节回退 ──────────────────────────────────────────────────────────────
test('selectToolsToActivate:门控关 → [](字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      mod.selectToolsToActivate('打开网页并编译文件', { env: { KHY_TOOL_CLUSTER_ACTIVATION: off } }),
      [], off,
    );
  }
});

test('isActivationEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.isActivationEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.isActivationEnabled({ KHY_TOOL_CLUSTER_ACTIVATION: off }), false, off);
  }
});

// ── fail-soft ─────────────────────────────────────────────────────────────────
test('fail-soft:异常输入绝不抛,返 []', () => {
  assert.doesNotThrow(() => mod.selectToolsToActivate(null, null));
  assert.doesNotThrow(() => mod.selectToolsToActivate(undefined));
  assert.doesNotThrow(() => mod.matchClusters(null));
  assert.deepStrictEqual(mod.selectToolsToActivate(null, { env: {} }), []);
  assert.deepStrictEqual(mod.selectToolsToActivate(12345, { env: {} }), []);
});

// ── 诊断:matchClusters 不受门控影响(纯映射)──────────────────────────────────
test('matchClusters:返回命中的簇 id 与工具(不受门控影响)', () => {
  const hits = mod.matchClusters('用浏览器打开网页');
  assert.ok(hits.some((h) => h.id === 'web-browse'));
  // 即便门控词在 env 也不影响 matchClusters(它不读 env)
  assert.ok(mod.matchClusters('编译这个文件').some((h) => h.id === 'compile'));
});
