'use strict';
/**
 * 本地优先 app 启动 —�?回归测试(node:test)�?
 *
 * 覆盖两个新行�?
 *   1) toolCalling.hasInstalledAppMatch / _matchInstalledApp:�?open_app handler 抽取�?
 *      单一真源匹配�?能命中本机已装应�?含华为应用市�?AppGallery)�?
 *   2) gateway/appLaunchInterceptor:白名单未命中�?门控开则按「本机是否已装」决定是否拦截走
 *      open_app(启动本地 exe)而非放行让模型开网页;门控�?KHY_APP_LOCAL_FIRST=0 逐字节回退白名单�?
 */
const toolCalling = require('../../src/services/toolCalling');
const interceptor = require('../../src/services/gateway/appLaunchInterceptor');
// Windows 开始菜�?AppGallery.lnk 形�?nameCn 为空,�?alias '华为应用市场'�?appgallery' 命中 bin)�?
const APPGALLERY_WIN = {
  name: 'AppGallery', nameCn: '', bin: 'appgallery',
  exec: 'C:\\Program Files\\Huawei\\AppGallery\\AppGallery.exe',
  keywords: [], searchText: 'appgallery', file: 'AppGallery.lnk',
};
// Linux .desktop 形�?�?Name[zh_CN]=华为应用市场 命中 nameCn includes)�?
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
// ── 别名�?───────────────────────────────────────────────────────────────────────
// ── hasInstalledAppMatch / _matchInstalledApp ─────────────────────────────────────
// ── 拦截器闸�?本地优先 ───────────────────────────────────────────────────────────

describe('Local First App Launch', () => {
  test('APP_ALIAS_MAP 增补了应用商店别�?_buildAppCandidates 派生�?appgallery', async () => {
      expect(toolCalling.APP_ALIAS_MAP['华为应用市场']).toBe('appgallery');
      expect(toolCalling.APP_ALIAS_MAP['appgallery']).toBe('appgallery');
      expect(toolCalling._buildAppCandidates('华为应用市场')).toContain('appgallery');
  });

  test('hasInstalledAppMatch:AppGallery(Win .lnk 形�?经别名命�?bin', async () => {
      withPrimedApps([APPGALLERY_WIN], () => {
        expect(toolCalling.hasInstalledAppMatch('华为应用市场')).toBe(true);
        expect(toolCalling.hasInstalledAppMatch('appgallery')).toBe(true);
        expect(toolCalling.hasInstalledAppMatch('AppGallery')).toBe(true);
        const m = toolCalling._matchInstalledApp('华为应用市场');
        expect(m && /AppGallery\.exe$/.test(m.exec).toBeTruthy());
      });
  });

  test('hasInstalledAppMatch:Linux 形态经 nameCn(华为应用市场)命中', async () => {
      withPrimedApps([HUAWEI_CN], () => {
        expect(toolCalling.hasInstalledAppMatch('华为应用市场')).toBe(true);
      });
  });

  test('hasInstalledAppMatch:本机无此应用 �?false(不会误拦)', async () => {
      withPrimedApps([APIFOX], () => {
        expect(toolCalling.hasInstalledAppMatch('华为应用市场')).toBe(false);
        expect(toolCalling.hasInstalledAppMatch('appgallery')).toBe(false);
      });
  });

  test('hasInstalledAppMatch:防呆 null/�?�?false 不抛', async () => {
      withPrimedApps([], () => {
        expect(toolCalling.hasInstalledAppMatch(null)).toBe(false);
        expect(toolCalling.hasInstalledAppMatch('')).toBe(false);
      });
  });

  test('拦截�?门控开 + 白名单未命中但本机已�?�?拦截�?open_app(启动本地)', async () => {
      const origExec = toolCalling.executeTool;
      const origMatch = toolCalling.hasInstalledAppMatch;
      let called = null;
      toolCalling.executeTool = async (tool, params) => { called = { tool, params }; return { success: true, output: 'launched local' }; };
      toolCalling.hasInstalledAppMatch = () => true; // 非白名单 apifox,模拟本机已装
      const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
      delete process.env.KHY_APP_LOCAL_FIRST; // 默认开
      try {
        const r = await interceptor.tryAppLaunchIntent('打开apifox', { userMessage: '打开apifox', onChunk: () => {} });
        expect(r && r.success).toBeTruthy();
        assert.deepEqual(called, { tool: 'open_app', params: { name: 'apifox' } });
      } finally {
        toolCalling.executeTool = origExec;
        toolCalling.hasInstalledAppMatch = origMatch;
        if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
      }
  });

  test('拦截�?门控�?KHY_APP_LOCAL_FIRST=0)+ 白名单未命中 �?放行(return null),即便本机已装(逐字节回退)', async () => {
      const origExec = toolCalling.executeTool;
      const origMatch = toolCalling.hasInstalledAppMatch;
      let called = false;
      toolCalling.executeTool = async () => { called = true; return { success: true }; };
      toolCalling.hasInstalledAppMatch = () => true;
      const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
      process.env.KHY_APP_LOCAL_FIRST = '0';
      try {
        const r = await interceptor.tryAppLaunchIntent('打开apifox', { userMessage: '打开apifox', onChunk: () => {} });
        expect(r).toBe(null);
        expect(called).toBe(false);
      } finally {
        toolCalling.executeTool = origExec;
        toolCalling.hasInstalledAppMatch = origMatch;
        if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
      }
  });

  test('拦截�?门控开 + 白名单未命中且本机未�?�?放行(return null)', async () => {
      const origExec = toolCalling.executeTool;
      const origMatch = toolCalling.hasInstalledAppMatch;
      let called = false;
      toolCalling.executeTool = async () => { called = true; return { success: true }; };
      toolCalling.hasInstalledAppMatch = () => false; // 本机没装
      const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
      delete process.env.KHY_APP_LOCAL_FIRST;
      try {
        const r = await interceptor.tryAppLaunchIntent('打开某不存在应用xyz', { userMessage: '打开某不存在应用xyz', onChunk: () => {} });
        expect(r).toBe(null);
        expect(called).toBe(false);
      } finally {
        toolCalling.executeTool = origExec;
        toolCalling.hasInstalledAppMatch = origMatch;
        if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
      }
  });

  test('拦截�?白名单命�?火狐)�?始终拦截(不依赖本地优先门�?', async () => {
      const origExec = toolCalling.executeTool;
      const origMatch = toolCalling.hasInstalledAppMatch;
      let called = null;
      toolCalling.executeTool = async (tool, params) => { called = { tool, params }; return { success: true, output: 'ok' }; };
      toolCalling.hasInstalledAppMatch = () => { throw new Error('本地优先不应被触�?白名单已命中)'); };
      const prevEnv = process.env.KHY_APP_LOCAL_FIRST;
      process.env.KHY_APP_LOCAL_FIRST = '0'; // 即便本地优先�?白名单仍命中
      try {
        const r = await interceptor.tryAppLaunchIntent('打开火狐', { userMessage: '打开火狐', onChunk: () => {} });
        expect(r && r.success).toBeTruthy();
        expect(called.tool).toBe('open_app');
        expect(called.params.name).toBe('火狐');
      } finally {
        toolCalling.executeTool = origExec;
        toolCalling.hasInstalledAppMatch = origMatch;
        if (prevEnv === undefined) delete process.env.KHY_APP_LOCAL_FIRST; else process.env.KHY_APP_LOCAL_FIRST = prevEnv;
      }
  });

});

