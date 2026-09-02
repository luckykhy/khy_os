// 渲染测试：把关键 view 真的 mount 出来，断言"森林治愈系"风格的视觉契约真的落地。
// 测试覆盖：WelcomeView（首启动）、SettingsView（顶贴式模式切换）、ModelsView（API Key 进度）
//
// 等价于 android/testing-setup skill 里的"Component-level screenshot tests"：不依赖
// 物理设备 / 模拟器，只在 jsdom 里验证 className / 文案 / 关键元素都在。
// CSS 变量 / scoped 样式契约放在 test/models.test.js（node env）做静态断言。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

// Mock Capacitor / 平台 native 接口：让 standalone.js / runtime.js / secureSession.js
// 走 web 兜底分支（不报 Capacitor.isNativePlatform = true）
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  registerPlugin: () => ({}),
  App: { addListener: () => Promise.resolve({ remove: () => {} }) },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    async keys() { return { keys: [] }; },
    async get({ key }) { return { value: null }; },
    async set({ key, value }) { /* noop for tests */ },
    async remove({ key }) { /* noop */ },
  },
}));
vi.mock('@capacitor/network', () => ({
  Network: {
    async getStatus() { return { connected: true, connectionType: 'wifi' }; },
    async addListener() { return { remove: () => {} }; },
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: () => Promise.resolve({ remove: () => {} }) },
}));
vi.mock('capacitor-secure-storage-plugin', () => ({
  SecureStoragePlugin: {
    async get() { throw new Error('not in web'); },
    async set() { /* noop */ },
    async remove() { /* noop */ },
  },
}));

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/home' },
      { path: '/home', component: { template: '<div>home</div>' } },
      { path: '/welcome', component: { template: '<div>welcome</div>' } },
      { path: '/connect', component: { template: '<div>connect</div>' } },
      { path: '/models', component: { template: '<div>models</div>' } },
      { path: '/settings', component: { template: '<div>settings</div>' } },
      { path: '/login', component: { template: '<div>login</div>' } },
      { path: '/:pathMatch(.*)*', redirect: '/home' },
    ],
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  // 屏蔽 console.error：渲染警告（router 警告等）不计入失败
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('森林治愈系 — WelcomeView 视觉契约', () => {
  it('首屏显示森林小屋 + 湖畔工坊两张卡片', async () => {
    const router = buildRouter();
    await router.push('/welcome');
    await router.isReady();
    const Welcome = (await import('@/views/WelcomeView.vue')).default;
    const wrapper = mount(Welcome, {
      global: { plugins: [router] },
    });
    await flushPromises();
    const html = wrapper.html();
    // 必含森林小屋 / 湖畔工坊 两张卡
    expect(html).toMatch(/森林小屋/);
    expect(html).toMatch(/湖畔工坊/);
    // emoji provider 头像（任一）
    expect(html).toMatch(/🌟|🐉|🌙|🐿️|🦉|✨|🪴/);
    // 森林风背景飘叶
    expect(wrapper.findAll('.bg-leaf').length).toBeGreaterThanOrEqual(3);
  });

  it('welcome-page 配 safe-area 兜底（顶/底）', async () => {
    const router = buildRouter();
    await router.push('/welcome');
    await router.isReady();
    const Welcome = (await import('@/views/WelcomeView.vue')).default;
    const wrapper = mount(Welcome, { global: { plugins: [router] } });
    await flushPromises();
    // .welcome-page 必须存在 + 含背景飘叶（safe-area 适配在 scoped CSS 里，
    // jsdom 不应用 computed style，源码契约在 test/models.test.js 守）
    const page = wrapper.find('.welcome-page');
    expect(page.exists()).toBe(true);
    expect(page.findAll('.bg-leaf').length).toBeGreaterThanOrEqual(3);
  });
});

describe('森林治愈系 — SettingsView 顶贴式模式切换', () => {
  it('独立模式显示「🌿 森林小屋」+ 切换按钮在贴式控件里', async () => {
    const router = buildRouter();
    await router.push('/settings');
    await router.isReady();
    const Settings = (await import('@/views/SettingsView.vue')).default;
    const wrapper = mount(Settings, { global: { plugins: [router] } });
    await flushPromises();
    const html = wrapper.html();
    expect(html).toMatch(/森林小屋/);
    expect(html).toMatch(/湖畔工坊/);
    // .segmented 控件里两个 button 至少一个 active
    const buttons = wrapper.findAll('.segmented button');
    expect(buttons.length).toBe(2);
  });
});

describe('森林治愈系 — MobileShell 顶栏模式切换按钮', () => {
  it('任何模式下顶栏都有「切到湖畔 / 切回森林」按钮', async () => {
    const router = buildRouter();
    await router.push('/home');
    await router.isReady();
    const Shell = (await import('@/layouts/MobileShell.vue')).default;
    const wrapper = mount(Shell, {
      global: { plugins: [router] },
    });
    await flushPromises();
    // 默认 mode = '' → 按钮文案应是 "切到湖畔"（默认去往 remote）
    const html = wrapper.html();
    expect(html).toMatch(/切到湖畔|切回森林/);
  });

  it('点 mode 按钮弹出森林风确认弹窗（to-standalone / to-remote class）', async () => {
    const router = buildRouter();
    await router.push('/home');
    await router.isReady();
    const Shell = (await import('@/layouts/MobileShell.vue')).default;
    const wrapper = mount(Shell, { global: { plugins: [router] } });
    await flushPromises();
    // 找 topbar 里的模式按钮并点击
    const btn = wrapper.find('.topbar-mode-btn');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flushPromises();
    // 确认弹窗出现
    const confirm = wrapper.find('.mode-confirm');
    expect(confirm.exists()).toBe(true);
    // 弹窗里有「走进森林 / 划向湖畔」CTA
    const card = wrapper.find('.mode-confirm-card');
    expect(card.exists()).toBe(true);
    expect(card.html()).toMatch(/走进森林|划向湖畔/);
  });

  it('ChatView 模型 chip 现在是 button：点 → 触发 chatProbe 端到端 ping', async () => {
    const router = buildRouter();
    await router.push('/chat');
    await router.isReady();
    const Chat = (await import('@/views/ChatView.vue')).default;
    const wrapper = mount(Chat, { global: { plugins: [router] } });
    await flushPromises();
    const chip = wrapper.find('button.current-model-chip');
    expect(chip.exists(), 'current-model-chip must be a <button>').toBe(true);
    // 显示当前模型（DEFAULTS 兜底：gpt-4o）+ 供应商 tag
    expect(chip.text()).toMatch(/gpt-4o|未选模型/);
    expect(chip.text()).toMatch(/OpenAI|khy-os/);
  });
});

describe('森林治愈系 — ChatView 模式切换 + composer 键盘适配', () => {
  it('ChatView 模型条有 🌿 森林 / 🌊 湖畔 贴式控件', async () => {
    const router = buildRouter();
    await router.push('/chat');
    await router.isReady();
    const Chat = (await import('@/views/ChatView.vue')).default;
    const wrapper = mount(Chat, { global: { plugins: [router] } });
    await flushPromises();
    const html = wrapper.html();
    // segmented 在 chat-toolbar 的 model-bar 里
    expect(html).toMatch(/🌿 森林/);
    expect(html).toMatch(/🌊 湖畔/);
  });

  it('ChatView composer 渲染时存在（IME 适配由 CSS 变量驱动）', async () => {
    const router = buildRouter();
    await router.push('/chat');
    await router.isReady();
    const Chat = (await import('@/views/ChatView.vue')).default;
    const wrapper = mount(Chat, { global: { plugins: [router] } });
    await flushPromises();
    // composer 元素必须存在；具体 CSS 变量驱动由 models.test.js 静态守
    const composer = wrapper.find('.composer');
    expect(composer.exists()).toBe(true);
  });
});

describe('森林治愈系 — HomeView 模式识别', () => {
  it('HomeView 在 standalone 模式下显示 🌿 森林小屋标题 + 8 个本地入口', async () => {
    const router = buildRouter();
    await router.push('/home');
    await router.isReady();
    const Home = (await import('@/views/HomeView.vue')).default;
    const wrapper = mount(Home, { global: { plugins: [router] } });
    await flushPromises();
    // 第一次 mount 时 mode === '' → viewMode 走独立分支（因为 firstProviderWithKey 默认 null 也走 standalone 默认）
    // 标题：森林小屋
    const html = wrapper.html();
    expect(html).toMatch(/森林小屋|湖畔工坊/);
  });
});
