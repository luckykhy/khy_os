'use strict';

/**
 * 本地优先 app 启动 —— 回归测试(node:test)。
 *
 * 覆盖两个新行为:
 *   1) toolCalling.hasInstalledAppMatch / _matchInstalledApp:从 open_app handler 抽取的
 *      单一真源匹配器,能命中本机已装应用(含华为应用市场/AppGallery)。
 *   2) gateway/appLaunchInterceptor:白名单未命中时,门控开则按「本机是否已装」决定是否拦截走
 *      open_app(启动本地 exe)而非放行让模型开网页;门控关 KHY_APP_LOCAL_FIRST=0 逐字节回退白名单。
 */

const test = require('node:test');
const assert = require('node:assert');

const toolCalling = require('../../src/services/toolCalling');
const interceptor = require('../../src/services/gateway/appLaunchInterceptor');

// Windows 开始菜单 AppGallery.lnk 形态(nameCn 为空,靠 alias '华为应用市场'→'appgallery' 命中 bin)。
const APPGALLERY_WIN = {
  name: 'AppGallery', nameCn: '', bin: 'appgallery',
  exec: 'C:\\Program Files\\Huawei\\AppGallery\\AppGallery.exe',
  keywords: [], searchText: 'appgallery', file: 'AppGallery.lnk',
};
// Linux .desktop 形态(靠 Name[zh_CN]=华为应用市场 命中 nameCn includes)。
const HUAWEI_CN = {
  name: 'HuaweiAppStore', nameCn: '华为应用市场', bin: 'huaweistore',
  exec: '/usr/bin/huaweistore', keywords: [], searchText: 'huaweistore',
};
const APIFOX = {
  name: 'Apifox', nameCn: '', bin: 'apifox',
  exec: '/usr/bin/apifox', keywords: [], searchText: 'apifox',
};

function withPrimedApps(apps, fn) {
  toolCalling._primeInstalledAppsForTest(apps);
  try { return fn(); } finally { toolCalling._primeInstalledAppsForTest(null); }
}

// ── 别名表 ───────────────────────────────────────────────────────────────────────
test('APP_ALIAS_MAP 增补了应用商店别名;_buildAppCandidates 派生出 appgallery', () => {
  assert.equal(toolCalling.APP_ALIAS_MAP['华为应用市场'], 'appgallery');
  assert.equal(toolCalling.APP_ALIAS_MAP['appgallery'], 'appgallery');
  assert.ok(toolCalling._buildAppCandidates('华为应用市场').includes('appgallery'));
});

// ── hasInstalledAppMatch / _matchInstalledApp ─────────────────────────────────────
test('hasInstalledAppMatch:AppGallery(Win .lnk 形态)经别名命中 bin', () => {
  withPrimedApps([APPGALLERY_WIN], () => {
    assert.equal(toolCalling.hasInstalledAppMatch('华为应用市场'), true);
    assert.equal(toolCalling.hasInstalledAppMatch('appgallery'), true);
    assert.equal(toolCalling.hasInstalledAppMatch('AppGallery'), true);
    const m = toolCalling._matchInstalledApp('华为应用市场');
    assert.ok(m && /AppGallery\.exe$/.test(m.exec));
  });
});

test('hasInstalledAppMatch:Linux 形态经 nameCn(华为应用市场)命中', () => {
  withPrimedApps([HUAWEI_CN], () => {
    assert.equal(toolCalling.hasInstalledAppMatch('华为应用市场'), true);
  });
});

test('hasInstalledAppMatch:本机无此应用 → false(不会误拦)', () => {
  withPrimedApps([APIFOX], () => {
    assert.equal(toolCalling.hasInstalledAppMatch('华为应用市场'), false);
    assert.equal(toolCalling.hasInstalledAppMatch('appgallery'), false);
  });
});

test('hasInstalledAppMatch:防呆 null/空 → false 不抛', () => {
  withPrimedApps([], () => {
    assert.equal(toolCalling.hasInstalledAppMatch(null), false);
    assert.equal(toolCalling.hasInstalledAppMatch(''), false);
  });
});

// ── 拦截器闸门:本地优先 ───────────────────────────────────────────────────────────
test('拦截器:门控开 + 白名单未命中但本机已装 → 拦截走 open_app(启动本地)', async () => {
  const origExec = toolCalling.executeTool;
  const origMatch = toolCalling.hasInstalledAppMatch;
  let called = null;
  toolCalling.executeTool = async (tool, params) => { called = { tool, params }; return { success: true, output: 'launched local' }; };
  toolCalling.hasInstalledAppMatch = () => true; // 非白名单 apifox,模拟本机已装
  const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
  delete process.env.KHY_APP_LOCAL_FIRST; // 默认开
  try {
    const r = await interceptor.tryAppLaunchIntent('打开apifox', { userMessage: '打开apifox', onChunk: () => {} });
    assert.ok(r && r.success, '应拦截并返回成功结果');
    assert.deepEqual(called, { tool: 'open_app', params: { name: 'apifox' } });
  } finally {
    toolCalling.executeTool = origExec;
    toolCalling.hasInstalledAppMatch = origMatch;
    if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
  }
});

test('拦截器:门控关(KHY_APP_LOCAL_FIRST=0)+ 白名单未命中 → 放行(return null),即便本机已装(逐字节回退)', async () => {
  const origExec = toolCalling.executeTool;
  const origMatch = toolCalling.hasInstalledAppMatch;
  let called = false;
  toolCalling.executeTool = async () => { called = true; return { success: true }; };
  toolCalling.hasInstalledAppMatch = () => true;
  const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
  process.env.KHY_APP_LOCAL_FIRST = '0';
  try {
    const r = await interceptor.tryAppLaunchIntent('打开apifox', { userMessage: '打开apifox', onChunk: () => {} });
    assert.equal(r, null, '门控关应回退到仅白名单 → 非白名单放行 null');
    assert.equal(called, false, 'executeTool 不应被调用');
  } finally {
    toolCalling.executeTool = origExec;
    toolCalling.hasInstalledAppMatch = origMatch;
    if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
  }
});

test('拦截器:门控开 + 白名单未命中且本机未装 → 放行(return null)', async () => {
  const origExec = toolCalling.executeTool;
  const origMatch = toolCalling.hasInstalledAppMatch;
  let called = false;
  toolCalling.executeTool = async () => { called = true; return { success: true }; };
  toolCalling.hasInstalledAppMatch = () => false; // 本机没装
  const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
  delete process.env.KHY_APP_LOCAL_FIRST;
  try {
    const r = await interceptor.tryAppLaunchIntent('打开某不存在应用xyz', { userMessage: '打开某不存在应用xyz', onChunk: () => {} });
    assert.equal(r, null);
    assert.equal(called, false);
  } finally {
    toolCalling.executeTool = origExec;
    toolCalling.hasInstalledAppMatch = origMatch;
    if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
  }
});

test('拦截器:白名单命中(火狐)→ 始终拦截(不依赖本地优先门控)', async () => {
  const origExec = toolCalling.executeTool;
  const origMatch = toolCalling.hasInstalledAppMatch;
  let called = null;
  toolCalling.executeTool = async (tool, params) => { called = { tool, params }; return { success: true, output: 'ok' }; };
  toolCalling.hasInstalledAppMatch = () => { throw new Error('本地优先不应被触达(白名单已命中)'); };
  const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
  process.env.KHY_APP_LOCAL_FIRST = '0'; // 即便本地优先关,白名单仍命中
  try {
    const r = await interceptor.tryAppLaunchIntent('打开火狐', { userMessage: '打开火狐', onChunk: () => {} });
    assert.ok(r && r.success);
    assert.equal(called.tool, 'open_app');
    assert.equal(called.params.name, '火狐');
  } finally {
    toolCalling.executeTool = origExec;
    toolCalling.hasInstalledAppMatch = origMatch;
    if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
  }
});
