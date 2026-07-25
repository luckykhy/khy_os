'use strict';

// selfLocation 契约测试 — 纯叶子（khy 自我定位 + 命令自知 SSOT）。
// 零 IO、确定性、绝不抛、门控 KHY_SELF_LOCATION 默认开(关 → 定位/命令概览块产出 '')。
const test = require('node:test');
const assert = require('node:assert');

const {
  selfLocationEnabled,
  classifyInstallKind,
  resolveSelfLocation,
  formatLocationForSystemPrompt,
  formatCommandOverviewForSystemPrompt,
} = require('../../src/services/selfLocation');

// ─── 门控 ─────────────────────────────────────────────────────────────────────

test('门控默认开(空/缺 env)', () => {
  assert.strictEqual(selfLocationEnabled({}), true);
  assert.strictEqual(selfLocationEnabled({ KHY_SELF_LOCATION: '' }), true);
  assert.strictEqual(selfLocationEnabled(undefined), true);
});

test('门控显式关闭词才禁用', () => {
  for (const v of ['0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF']) {
    assert.strictEqual(selfLocationEnabled({ KHY_SELF_LOCATION: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.strictEqual(selfLocationEnabled({ KHY_SELF_LOCATION: v }), true, v);
  }
});

// ─── installKind 三分支(纯字符串派生,零 IO) ───────────────────────────────────

test('classifyInstallKind: npm / pip / dev 三分支', () => {
  assert.strictEqual(classifyInstallKind('/home/u/.nvm/versions/node/v20/lib/node_modules/khy-os'), 'npm');
  assert.strictEqual(classifyInstallKind('/some/path/node_modules'), 'npm');
  assert.strictEqual(classifyInstallKind('/usr/lib/python3.11/site-packages/khy_os'), 'pip');
  assert.strictEqual(classifyInstallKind('/opt/khy/platform/khy_os/bundled'), 'pip');
  assert.strictEqual(classifyInstallKind('/opt/khy/platform/khy_os/bundled/services/backend/src'), 'pip');
  assert.strictEqual(classifyInstallKind('/home/dev/Khy-OS'), 'dev');
  assert.strictEqual(classifyInstallKind(''), 'dev');
  assert.strictEqual(classifyInstallKind(null), 'dev');
});

test('classifyInstallKind: Windows 反斜杠归一', () => {
  assert.strictEqual(classifyInstallKind('C:\\Users\\u\\node_modules\\khy-os'), 'npm');
  assert.strictEqual(classifyInstallKind('C:\\py\\Lib\\site-packages\\khy_os'), 'pip');
});

// ─── resolveSelfLocation(纯派生) ──────────────────────────────────────────────

test('resolveSelfLocation: 透传路径 + 派生 installKind', () => {
  const loc = resolveSelfLocation({
    appRoot: '/opt/khy/platform/khy_os/bundled',
    selfSrcDir: '/opt/khy/platform/khy_os/bundled/services/backend/src',
    dataHome: '/home/u/.khy',
    projectDataHome: '/opt/khy/.khy',
    baseHome: '/home/u/.khyos',
  }, {});
  assert.strictEqual(loc.installKind, 'pip');
  assert.strictEqual(loc.selfSrcDir, '/opt/khy/platform/khy_os/bundled/services/backend/src');
  assert.strictEqual(loc.dataHome, '/home/u/.khy');
  assert.strictEqual(loc.enabled, true);
});

test('resolveSelfLocation: 缺省/坏输入不抛,返回空串字段', () => {
  const loc = resolveSelfLocation({}, {});
  assert.strictEqual(loc.appRoot, '');
  assert.strictEqual(loc.selfSrcDir, '');
  assert.strictEqual(loc.installKind, 'dev');
  const loc2 = resolveSelfLocation(undefined, undefined);
  assert.strictEqual(typeof loc2.appRoot, 'string');
});

// ─── formatLocationForSystemPrompt ────────────────────────────────────────────

test('定位块: 门控开且有源码目录 → 含绝对路径与安装类型', () => {
  const loc = resolveSelfLocation({
    appRoot: '/home/dev/Khy-OS',
    selfSrcDir: '/home/dev/Khy-OS/services/backend/src',
    dataHome: '/home/dev/.khy',
  }, {});
  const out = formatLocationForSystemPrompt(loc, {});
  assert.match(out, /Your install location/);
  assert.match(out, /Source: \/home\/dev\/Khy-OS\/services\/backend\/src/);
  assert.match(out, /Install root: \/home\/dev\/Khy-OS \(dev\)/);
  assert.match(out, /Data home: \/home\/dev\/\.khy/);
  // 明确提示 agent 可用绝对路径搜索
  assert.match(out, /ABSOLUTE path to Grep\/Glob\/Read/);
  // 指向可查询的自省工具
  assert.match(out, /call the KhySelf tool/);
});

test('定位块: 门控关 → 空串(字节回退)', () => {
  const loc = resolveSelfLocation({
    appRoot: '/home/dev/Khy-OS',
    selfSrcDir: '/home/dev/Khy-OS/services/backend/src',
  }, {});
  assert.strictEqual(formatLocationForSystemPrompt(loc, { KHY_SELF_LOCATION: 'off' }), '');
});

test('定位块: 无路径/坏输入 → 空串', () => {
  assert.strictEqual(formatLocationForSystemPrompt(null, {}), '');
  assert.strictEqual(formatLocationForSystemPrompt({}, {}), '');
  assert.strictEqual(formatLocationForSystemPrompt({ selfSrcDir: '', appRoot: '' }, {}), '');
});

// ─── formatCommandOverviewForSystemPrompt ─────────────────────────────────────

function fakeCatalog() {
  return {
    total: 7,
    categories: [
      { key: 'system', label: '系统与平台', commands: [
        { cmd: '/status' }, { cmd: '/env' }, { cmd: '/self' }, { cmd: '/features' }, { cmd: '/doctor' },
      ] },
      { key: 'dev', label: '开发与工程', commands: [{ cmd: '/commit' }, { cmd: '/diff' }] },
      { key: 'empty', label: '空类', commands: [] },
    ],
  };
}

test('命令概览: 门控开 → 分类 + 计数 + 每类截断 + 全量入口', () => {
  const out = formatCommandOverviewForSystemPrompt(fakeCatalog(), {}, { perCategory: 4 });
  assert.match(out, /Your own commands \(7 total/);
  assert.match(out, /系统与平台: \/status, \/env, \/self, \/features, \+1/); // 5 条截断到 4 + "+1"
  assert.match(out, /开发与工程: \/commit, \/diff/);
  assert.doesNotMatch(out, /空类/); // 空命令类别跳过
  assert.match(out, /Full catalog: run `\/features`/);
});

test('命令概览: 门控关 → 空串(字节回退)', () => {
  assert.strictEqual(formatCommandOverviewForSystemPrompt(fakeCatalog(), { KHY_SELF_LOCATION: '0' }), '');
});

test('命令概览: 空目录/坏输入 → 空串', () => {
  assert.strictEqual(formatCommandOverviewForSystemPrompt(null, {}), '');
  assert.strictEqual(formatCommandOverviewForSystemPrompt({ categories: [] }, {}), '');
  assert.strictEqual(formatCommandOverviewForSystemPrompt({ categories: [{ label: 'x', commands: [] }] }, {}), '');
});

test('命令概览: perCategory 缺省=4', () => {
  const out = formatCommandOverviewForSystemPrompt(fakeCatalog(), {});
  // 默认 4 → system 类显示 4 条 + "+1"
  assert.match(out, /系统与平台: \/status, \/env, \/self, \/features, \+1/);
});
