'use strict';

/**
 * toolCalling.pureHelpers.test.js — locks the pure / deterministic helpers that
 * toolCalling.js re-exports from its leaf modules, for the branches the
 * existing toolCalling.* series does not yet cover:
 *   - _normalizeAppQuery / _buildAppCandidates: app-name normalization (trim +
 *     lowercase + strip whitespace/punctuation) and alias candidate expansion
 *     (APP_ALIAS_MAP, e.g. chrome → google-chrome)
 *   - _matchInstalledApp / hasInstalledAppMatch: priority exact > startsWith >
 *     includes > nameCn > keywords/searchText, driven by the injected index
 *     (_primeInstalledAppsForTest) so no filesystem scan is touched
 *   - permissionModeToProfile: canonical mode → permissionStore profile map
 *     (incl. CC alias spellings: bypassPermissions/yolo, acceptedits, dontask,
 *     red-pass) with unknown → 'normal'
 *   - _decisionFromControl: onControlRequest resolution → allow/allow-always/deny
 *     (primitive + object shapes, default deny)
 *   - _checkToolPolicy / _checkActiveSkillPolicy: KHY_TOOL_POLICY=false kill
 *     switch short-circuits to null
 * 纯逻辑 node:test，零网络；_primeInstalledAppsForTest 注入索引避免真实扫描。
 * 谁改别名表 / 权限映射 / 决策归一先红。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  _normalizeAppQuery,
  _buildAppCandidates,
  _matchInstalledApp,
  hasInstalledAppMatch,
  _primeInstalledAppsForTest,
  permissionModeToProfile,
  _decisionFromControl,
  _checkToolPolicy,
  _checkActiveSkillPolicy,
} = require('../src/services/toolCalling');

test('_normalizeAppQuery: trim + 小写 + 去空白/标点', () => {
  assert.strictEqual(_normalizeAppQuery('  Chrome  '), 'chrome');
  assert.strictEqual(_normalizeAppQuery('Fire Fox'), 'firefox');
  assert.strictEqual(_normalizeAppQuery('chrome!'), 'chrome');
  assert.strictEqual(_normalizeAppQuery(''), '');
  assert.strictEqual(_normalizeAppQuery(null), '');
  assert.strictEqual(_normalizeAppQuery(undefined), '');
});

test('_buildAppCandidates: 空输入 → []；别名展开（chrome → google-chrome）', () => {
  assert.deepStrictEqual(_buildAppCandidates(''), []);
  assert.deepStrictEqual(_buildAppCandidates('   '), []);
  const cands = _buildAppCandidates('chrome');
  assert.ok(cands.includes('chrome'), '保留小写原名');
  assert.ok(cands.includes('google-chrome'), '展开别名 google-chrome');
});

describe('toolCalling 已装应用匹配（注入索引）', () => {
  const apps = [
    { bin: 'code', name: 'vscode', nameCn: 'VS Code', keywords: ['code editor'], searchText: 'vscode code editor' },
    { bin: 'notepad', name: 'notepad', nameCn: '记事本', keywords: ['text'], searchText: 'notepad text' },
    { bin: 'explorer', name: 'explorer', nameCn: '资源管理器', keywords: ['files', 'explorer'], searchText: 'explorer files' },
  ];

  test('精确 bin 命中优先', () => {
    _primeInstalledAppsForTest(apps);
    const m = _matchInstalledApp('notepad');
    assert.ok(m);
    assert.strictEqual(m.bin, 'notepad');
  });

  test('nameCn（中文）命中', () => {
    _primeInstalledAppsForTest(apps);
    const m = _matchInstalledApp('记事本');
    assert.ok(m, '中文名应命中');
    assert.strictEqual(m.bin, 'notepad');
  });

  test('keywords / searchText 命中', () => {
    _primeInstalledAppsForTest(apps);
    const m = _matchInstalledApp('code editor');
    assert.ok(m, '关键词应命中');
    assert.strictEqual(m.bin, 'code');
  });

  test('hasInstalledAppMatch: 命中 → true；未命中 → false；绝不抛', () => {
    _primeInstalledAppsForTest(apps);
    assert.strictEqual(hasInstalledAppMatch('notepad'), true);
    assert.strictEqual(hasInstalledAppMatch('definitely-not-installed-xyz'), false);
    _primeInstalledAppsForTest(null); // 复位
    assert.strictEqual(typeof hasInstalledAppMatch('notepad'), 'boolean');
  });

  test('_matchInstalledApp: 完全无匹配 → null', () => {
    _primeInstalledAppsForTest(apps);
    assert.strictEqual(_matchInstalledApp('qqqqqqqq'), null);
    _primeInstalledAppsForTest(null);
  });
});

describe('toolCalling 权限模式 → profile 映射', () => {
  test('标准模式映射', () => {
    assert.strictEqual(permissionModeToProfile('default'), 'normal');
    assert.strictEqual(permissionModeToProfile('plan'), 'strict');
    assert.strictEqual(permissionModeToProfile('acceptEdits'), 'acceptEdits');
    assert.strictEqual(permissionModeToProfile('auto'), 'auto');
    assert.strictEqual(permissionModeToProfile('bypass'), 'yolo');
  });

  test('CC 别名拼写归一（bypassPermissions / yolo → yolo；dontask → dontAsk；red-pass → redpass）', () => {
    assert.strictEqual(permissionModeToProfile('bypassPermissions'), 'yolo');
    assert.strictEqual(permissionModeToProfile('yolo'), 'yolo');
    assert.strictEqual(permissionModeToProfile('dontask'), 'dontAsk');
    assert.strictEqual(permissionModeToProfile('red-pass'), 'redpass');
    assert.strictEqual(permissionModeToProfile('acceptedits'), 'acceptEdits');
  });

  test('未知 / 空模式 → 归一到 default → normal', () => {
    assert.strictEqual(permissionModeToProfile('nonsense-mode'), 'normal');
    assert.strictEqual(permissionModeToProfile(''), 'normal');
    assert.strictEqual(permissionModeToProfile(null), 'normal');
  });
});

describe('toolCalling 决策归一（_decisionFromControl）', () => {
  test('原始布尔/字符串', () => {
    assert.strictEqual(_decisionFromControl(true), 'allow');
    assert.strictEqual(_decisionFromControl('always'), 'allow-always');
    assert.strictEqual(_decisionFromControl('allow-always'), 'allow-always');
    assert.strictEqual(_decisionFromControl(false), 'deny');
    assert.strictEqual(_decisionFromControl(null), 'deny');
    assert.strictEqual(_decisionFromControl(undefined), 'deny');
    assert.strictEqual(_decisionFromControl('no'), 'deny');
  });

  test('对象形态（{behavior} / 嵌套 {response} / control_response）', () => {
    assert.strictEqual(_decisionFromControl({ behavior: 'allow' }), 'allow');
    assert.strictEqual(_decisionFromControl({ behavior: 'allow-always' }), 'allow-always');
    assert.strictEqual(_decisionFromControl({ response: { behavior: 'allow' } }), 'allow');
    assert.strictEqual(
      _decisionFromControl({ type: 'control_response', response: { behavior: 'allow-always' } }),
      'allow-always',
    );
    // 无 behavior 的对象 → 默认 deny
    assert.strictEqual(_decisionFromControl({ other: 1 }), 'deny');
  });
});

describe('toolCalling 能力策略 kill switch', () => {
  const saved = process.env.KHY_TOOL_POLICY;
  test('KHY_TOOL_POLICY=false 时 _checkToolPolicy / _checkActiveSkillPolicy 均短路 null', () => {
    process.env.KHY_TOOL_POLICY = 'false';
    assert.strictEqual(_checkToolPolicy('bash', 'bash'), null);
    assert.strictEqual(_checkActiveSkillPolicy('bash', 'bash'), null);
  });
  test('恢复 env 后不再短路（缺省读策略文件，返回 null 或原因字符串，绝不抛）', () => {
    if (saved === undefined) delete process.env.KHY_TOOL_POLICY;
    else process.env.KHY_TOOL_POLICY = saved;
    // 无策略文件时 → null；关键是调用不抛异常
    assert.doesNotThrow(() => _checkToolPolicy('some_tool', 'some_tool'));
    assert.doesNotThrow(() => _checkActiveSkillPolicy('some_tool', 'some_tool'));
  });
});
