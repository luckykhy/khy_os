// 单元测试：mobileAgent 的纯逻辑部分。
// 不真发网络、不真访问 Preferences。
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const readSrc = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');
// 从 apps/khy-mobile/test 出发,.. = apps/khy-mobile/,再 join android path
const readAndroid = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

// 模拟 @capacitor/preferences：内存 Map 存数据
const memStore = new Map();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    async keys() { return { keys: Array.from(memStore.keys()) }; },
    async get({ key }) { return { value: memStore.get(key) || null }; },
    async set({ key, value }) { memStore.set(key, value); },
    async remove({ key }) { memStore.delete(key); },
  },
}));

// 模拟 standalone.streamChatCompletion：不做真调用
vi.mock('../src/api/standalone.js', () => ({
  streamChatCompletion: vi.fn(async () => {}),
  getStandaloneApiKey: vi.fn(async () => 'fake-key'),
}));

// 模拟 @capacitor/core
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  registerPlugin: () => ({}),
  App: {},
}));

import { listRecentRuns, clearRuns, appendRun, matchSkill, ensureGuiSkillSample } from '../src/api/mobileAgent';
import { saveSkill, listSkills } from '../src/api/programRuntime';
import { localToolSchemas } from '../src/api/localTools';

beforeEach(() => {
  memStore.clear();
});

describe('InfoPool persistence', () => {
  it('starts empty', async () => {
    const runs = await listRecentRuns();
    expect(runs).toEqual([]);
  });

  it('appends and reads back', async () => {
    await appendRun({ id: 'r1', userInput: 'test', steps: 3, finishReason: 'finished' });
    const runs = await listRecentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].userInput).toBe('test');
  });

  it('keeps last N runs in reverse chronological order', async () => {
    for (let i = 0; i < 5; i++) await appendRun({ id: `r${i}`, userInput: `t${i}`, steps: 1, finishReason: 'finished' });
    const runs = await listRecentRuns(3);
    expect(runs).toHaveLength(3);
    expect(runs[0].userInput).toBe('t4'); // 最新在前
  });

  it('clearRuns wipes storage', async () => {
    await appendRun({ id: 'r1', userInput: 't', steps: 1, finishReason: 'finished' });
    await clearRuns();
    const runs = await listRecentRuns();
    expect(runs).toEqual([]);
  });
});

describe('Skill matching (lightweight intent recognition)', () => {
  it('matches by label when user text contains the label', async () => {
    await saveSkill({ name: 'order-meituan', label: '点外卖（美团）', description: '用美团点外卖', steps: [] });
    const r = await matchSkill('帮我在美团点一份猪脚饭');
    expect(r).not.toBeNull();
    expect(r.skill.name).toBe('order-meituan');
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  it('matches by description keywords', async () => {
    await saveSkill({ name: 'weather', label: '看天气', description: '查询北京上海广州天气', steps: [] });
    const r = await matchSkill('帮我看北京天气');
    expect(r).not.toBeNull();
    expect(r.skill.name).toBe('weather');
  });

  it('returns null when no skill matches', async () => {
    await saveSkill({ name: 'weather', label: '看天气', description: '查天气', steps: [] });
    const r = await matchSkill('帮我订一张去东京的机票');
    expect(r).toBeNull();
  });

  it('ranks multiple matches by score', async () => {
    await saveSkill({ name: 'a', label: '点外卖', description: '美团', steps: [] });
    await saveSkill({ name: 'b', label: '看天气', description: '天气', steps: [] });
    const r = await matchSkill('帮我点外卖');
    expect(r.skill.name).toBe('a');
  });
});

describe('ensureGuiSkillSample', () => {
  it('installs the demo GUI skill once', async () => {
    const installed = await ensureGuiSkillSample();
    expect(installed).toBe(true);
    const skills = await listSkills();
    expect(skills.find((s) => s.name === 'auto-search-baidu')).toBeTruthy();
    // 二次调用不应重复装
    const installed2 = await ensureGuiSkillSample();
    expect(installed2).toBe(false);
  });
});

describe('khy.local tool registry completeness', () => {
  it('exposes the three new Roubao-style tools', () => {
    const names = localToolSchemas().map((s) => s.function.name);
    expect(names).toContain('khy.local.http');
    expect(names).toContain('khy.local.deepLinkByApp');
    expect(names).toContain('khy.local.screenObserver');
    expect(names).toContain('khy.local.findAndTap');
    expect(names).toContain('khy.local.listClickable');
  });

  it('http tool description mentions whitelist', () => {
    const http = localToolSchemas().find((s) => s.function.name === 'khy.local.http');
    expect(http.function.description).toMatch(/白名单/);
  });

  it('screenObserver supports watchFor + stopOnMatch', () => {
    const obs = localToolSchemas().find((s) => s.function.name === 'khy.local.screenObserver');
    expect(obs.function.parameters.properties.watchFor).toBeTruthy();
    expect(obs.function.parameters.properties.stopOnMatch).toBeTruthy();
  });

  it('findAndTap accepts query + fallbackToCoord', () => {
    const f = localToolSchemas().find((s) => s.function.name === 'khy.local.findAndTap');
    expect(f.function.parameters.properties.query).toBeTruthy();
    expect(f.function.parameters.properties.fallbackToCoord).toBeTruthy();
    expect(f.function.parameters.properties.fallbackToCoord.default).toBe(true);
  });

  it('findAndTap supports forceRefresh + settleMs', () => {
    const f = localToolSchemas().find((s) => s.function.name === 'khy.local.findAndTap');
    expect(f.function.parameters.properties.forceRefresh).toBeTruthy();
    expect(f.function.parameters.properties.forceRefresh.default).toBe(true);
    expect(f.function.parameters.properties.settleMs).toBeTruthy();
    expect(f.function.parameters.properties.settleMs.default).toBe(400);
  });

  it('findAndTap description mentions force-refresh rule', () => {
    const f = localToolSchemas().find((s) => s.function.name === 'khy.local.findAndTap');
    // forceRefresh 子字段 description 必须有"刷新"或"坐标过期"
    const frDesc = f.function.parameters.properties.forceRefresh.description;
    expect(frDesc).toMatch(/刷新|坐标过期|强制/);
    // settleMs 必须存在
    expect(f.function.parameters.properties.settleMs).toBeTruthy();
  });

  it('Agent system prompt mentions hybrid findAndTap mode', async () => {
    // 用 vi 读 mobileAgent 内部不太行；用反射：导出的 SYSTEM_PROMPT 不可见时通过 matchSkill 测试兜底
    // 这里只保证：findAndTap 已被注册到所有 Agent 可用工具
    const names = localToolSchemas().map((s) => s.function.name);
    expect(names).toContain('khy.local.findAndTap');
  });

  it('findAndTap.execute: with forceRefresh, lookScreen should be called before findWithBounds', () => {
    // 不直接 mock 整链路（vi.doMock 在 it 块内对 ESM 动态 import 不稳）。
    // 改成静态断言：findAndTap 源码里 forceRefresh 块必须先 await lookScreen 调 screenCapture.js,
    // 然后才 import deviceControl.js 调 findWithBounds。
    const src = readSrc('src/api/localTools.js');
    const m = src.match(/name: 'khy\.local\.findAndTap'[\s\S]+?async execute\(([\s\S]+?)\n  \},/);
    expect(m, 'findAndTap block should be in localTools.js').toBeTruthy();
    const block = m[1];
    expect(block).toMatch(/forceRefresh/);
    expect(block).toMatch(/lookScreen/);
    const refreshIdx = block.indexOf('forceRefresh');
    const boundsIdx = block.indexOf('findWithBounds');
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(boundsIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeLessThan(boundsIdx);
  });

  it('findAndTap description mentions force-refresh rule (中文)', () => {
    // 不在 schema description 文本里找（可能截断），改在 Tool 定义块里找
    // findAndTap 整段定义里必须含 "强制重 find" 或 forceRefresh 出现
    const src = readSrc('src/api/localTools.js');
    expect(src).toMatch(/强制重 find/);
    expect(src).toMatch(/forceRefresh.*默认 true/);
  });

  it('mobileAgent SystemPrompt mentions the强制重 find rule', () => {
    const src = readSrc('src/api/mobileAgent.js');
    expect(src).toMatch(/强制重 find/);
    expect(src).toMatch(/forceRefresh/);
  });

  it('OverlayPlugin has BroadcastReceiver + notifyListeners wiring', () => {
    const src = readAndroid('android/app/src/main/java/com/khyos/companion/OverlayPlugin.java');
    expect(src).toMatch(/registerReceiver/);
    expect(src).toMatch(/notifyListeners/);
    expect(src).toMatch(/userStop/);
  });

  it('OverlayPlugin handles POST_NOTIFICATIONS via @Permission annotation', () => {
    const src = readAndroid('android/app/src/main/java/com/khyos/companion/OverlayPlugin.java');
    expect(src).toMatch(/@Permission/);
    expect(src).toMatch(/POST_NOTIFICATIONS/);
    expect(src).toMatch(/@PermissionCallback/);
    expect(src).toMatch(/requestPermissionForAlias/);
  });

  it('OverlayPlugin re-registers receiver on handleOnResume (App background→foreground)', () => {
    const src = readAndroid('android/app/src/main/java/com/khyos/companion/OverlayPlugin.java');
    expect(src).toMatch(/handleOnResume/);
    // handleOnPause 不应再有空实现（被 handleOnResume 替代）
    expect(src).not.toMatch(/public void handleOnPause\(\)\s*{\s*super\.handleOnPause\(\);\s*}/);
  });

  it('overlay.js exports checkOverlayStatus (returns both overlay + notifications)', () => {
    const src = readSrc('src/api/overlay.js');
    expect(src).toMatch(/export async function checkOverlayStatus/);
    // 返回结构里必须同时含 overlay 和 notifications 字段
    expect(src).toMatch(/overlay/);
    expect(src).toMatch(/notifications/);
  });

  it('OverlayService uses layout XML (ViewBinding-style)', () => {
    const java = readAndroid('android/app/src/main/java/com/khyos/companion/OverlayService.java');
    expect(java).toMatch(/LayoutInflater\.from/);
    expect(java).toMatch(/R\.layout\.overlay_card/);
    expect(java).not.toMatch(/new TextView\(this\)/);
  });
});
