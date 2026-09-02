'use strict';

/**
 * toolDisplayMatrix.test.js — 工具显示矩阵**完整性**契约测试。
 *
 * 「显示规划清楚」的强制门：services/tools 注册表里的**每一个**工具名（按
 * getToolPolicy 同一归一规则：小写、去 [_-]）都必须命中显式家族 policy——
 * 不得落入 DEFAULT_POLICY（未分类 = 无 tier 语义、无说明文案、显示漂移）。
 * 同时强制每条家族 policy 自带非空 intentLabel（说明文案）与合法 tier/resultStyle。
 *
 * 新增工具时本测试会失败——这是**有意设计**：逼着维护者在矩阵里给新工具一个
 * 明确的显示位（tier + 说明 + 样式），而不是静默漏进默认层。
 */

const assert = require('node:assert');
const { test } = require('node:test');

const policy = require('./toolDisplayPolicy');

const _normalize = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');

const _isDefaultPolicy = (p) =>
  p === policy.DEFAULT_POLICY ||
  (p && p.resultStyle === 'tree' && p.maxLines === 6 && p.foldHead === 3 && p.foldTail === 3 && !p.boxPreview && p.intentLabel === undefined);

function _registryToolNames() {
  const reg = require('../tools');
  const all = reg.getAll ? reg.getAll() : {};
  return all instanceof Map ? [...all.keys()] : Object.keys(all);
}

test('显示矩阵覆盖：注册表每个工具都命中显式家族（不落 DEFAULT）', () => {
  const names = _registryToolNames();
  assert.ok(names.length > 100, `注册表应有大量工具，实际 ${names.length}`);
  const unclassified = [];
  for (const raw of names) {
    const key = _normalize(raw);
    const resolved = policy.getToolPolicy(key);
    if (_isDefaultPolicy(resolved)) {
      unclassified.push(raw);
    }
  }
  assert.deepEqual(
    unclassified,
    [],
    `以下工具未在 toolDisplayPolicy 显示矩阵中分类（ALIASES 缺映射）：\n  ${unclassified.join('\n  ')}`
  );
});

test('每条家族 policy 都有非空 intentLabel（说明文案）与合法 tier/resultStyle', () => {
  const STYLES = new Set(['tree', 'collapsed', 'diff', 'delegate', 'inline']);
  for (const [family, p] of Object.entries(policy.POLICIES)) {
    assert.ok(p.tier === 'core' || p.tier === 'minor', `POLICIES.${family}.tier 非法`);
    assert.ok(
      typeof p.intentLabel === 'string' && p.intentLabel.trim().length > 0,
      `POLICIES.${family}.intentLabel 缺说明文案`
    );
    assert.ok(STYLES.has(p.resultStyle), `POLICIES.${family}.resultStyle 非法: ${p.resultStyle}`);
    assert.ok(
      Number.isInteger(p.maxLines) && p.maxLines >= 0,
      `POLICIES.${family}.maxLines 非法`
    );
  }
});

test('核心家族的说明文案抽样：git 写操作 / 部署 / 桌面控制 / 提问各有专属短语', () => {
  assert.equal(policy.getToolPolicy('gitcommit').intentLabel, '提交变更');
  assert.equal(policy.getToolPolicy('gitpush').intentLabel, '推送远端');
  assert.equal(policy.getToolPolicy('deploy').intentLabel, '部署');
  assert.equal(policy.getToolPolicy('desktopcontrol').intentLabel, '桌面控制');
  assert.equal(policy.getToolPolicy('askuserquestion').intentLabel, '向你提问');
  assert.equal(policy.getToolPolicy('diskcleanup').intentLabel, '清理磁盘');
  assert.equal(policy.getToolPolicy('runtests').intentLabel, '运行测试');
});

test('分级抽样：读/搜索类 minor，shell/写/git 写/媒体生成 core', () => {
  for (const n of ['read', 'grep', 'glob', 'websearch', 'webfetch', 'todowrite', 'coverage_report']) {
    assert.equal(policy.getToolTier(n), 'minor', n);
  }
  for (const n of ['shellCommand', 'write_file', 'edit', 'open_app', 'agent', 'gitCommit', 'gitPush', 'image_generate', 'video_generate', 'deploy', 'DiskCleanup']) {
    assert.equal(policy.getToolTier(n), 'core', n);
  }
});
