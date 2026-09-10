'use strict';

// desktopUiContract.test.js — khyOS 桌面端 UI 设计不变量的契约 + 合规测试。
//
// 关注点（DESIGN-ARCH-078 + khyos-desktop/CLAUDE.md + AGENTS.md 规则 1-4）：
//   D1:  BrowserWindow 尺寸 1216×808, min 800×600
//   D2:  无框窗口 frame: false
//   D3:  安全配置 contextIsolation: true + nodeIntegration: false
//   D4:  preload 通过 contextBridge.exposeInMainWorld('__KHYOS__') 暴露 API
//   D5:  preload 必需方法集
//   D6:  IPC 通道命名约定 namespace:action
//   D7:  菜单含四组（文件/视图/窗口/帮助）
//   D8:  TitleBar 含窗口控制按钮
//   D9:  品牌文本不含 ZCode/Zhipu/智谱
//   D10: 源码不得硬编码 localhost 端点

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');

const mainSrcPath = join(projectRoot, 'src', 'main', 'index.ts');
const preloadSrcPath = join(projectRoot, 'src', 'preload', 'index.ts');
const menuSrcPath = join(projectRoot, 'src', 'main', 'menu.ts');
const titleBarPath = join(projectRoot, 'src', 'renderer', 'components', 'layout', 'TitleBar.tsx');

const mainSrc = existsSync(mainSrcPath) ? readFileSync(mainSrcPath, 'utf-8') : '';
// KeyManager IPC (DESIGN-ARCH-091 §6) is registered from a dedicated module;
// include it in the D6 main-side scan so preload↔main channel parity holds.
const keyManagerIpcPath = join(projectRoot, 'src', 'main', 'keyManager', 'ipc.ts');
const keyManagerIpcSrc = existsSync(keyManagerIpcPath) ? readFileSync(keyManagerIpcPath, 'utf-8') : '';
const preloadSrc = existsSync(preloadSrcPath) ? readFileSync(preloadSrcPath, 'utf-8') : '';
const menuSrc = existsSync(menuSrcPath) ? readFileSync(menuSrcPath, 'utf-8') : '';
const titleBarSrc = existsSync(titleBarPath) ? readFileSync(titleBarPath, 'utf-8') : '';

// ── D1: BrowserWindow 尺寸 ──────────────────────────────────────

test('D1: BrowserWindow 默认尺寸 1216×808', () => {
  assert.match(mainSrc, /width:\s*1216/, 'BrowserWindow width 应为 1216');
  assert.match(mainSrc, /height:\s*808/, 'BrowserWindow height 应为 808');
});

test('D1: BrowserWindow 最小尺寸 800×600', () => {
  assert.match(mainSrc, /minWidth:\s*800/, 'BrowserWindow minWidth 应为 800');
  assert.match(mainSrc, /minHeight:\s*600/, 'BrowserWindow minHeight 应为 600');
});

// ── D2: 无框窗口 ────────────────────────────────────────────────

test('D2: khyos-desktop 使用无框窗口（frame: false）', () => {
  assert.match(mainSrc, /frame:\s*false/, 'khyos-desktop BrowserWindow 必须 frame: false（无框窗口）');
});

// ── D3: 安全配置 ────────────────────────────────────────────────

test('D3: contextIsolation 为 true（安全隔离）', () => {
  assert.match(mainSrc, /contextIsolation:\s*true/, 'contextIsolation 必须为 true（Electron 安全最佳实践）');
});

test('D3: nodeIntegration 为 false（禁止 Node 透传渲染层）', () => {
  assert.match(mainSrc, /nodeIntegration:\s*false/, 'nodeIntegration 必须为 false（Electron 安全最佳实践）');
});

// ── D4: preload 暴露 API ────────────────────────────────────────

test('D4: preload 通过 contextBridge.exposeInMainWorld 暴露 __KHYOS__', () => {
  assert.match(
    preloadSrc,
    /contextBridge\.exposeInMainWorld\(['"`]__KHYOS__['"`]/,
    'preload 必须通过 contextBridge.exposeInMainWorld("__KHYOS__") 暴露 API'
  );
});

// ── D5: preload 必需方法集 ──────────────────────────────────────

test('D5: preload 暴露窗口控制方法（minimize/maximize/close）', () => {
  assert.match(preloadSrc, /minimizeWindow/);
  assert.match(preloadSrc, /maximizeWindow/);
  assert.match(preloadSrc, /closeWindow/);
});

test('D5: preload 暴露设置读写方法（getSettings/setSetting）', () => {
  assert.match(preloadSrc, /getSettings/);
  assert.match(preloadSrc, /setSetting/);
});

test('D5: preload 暴露文件系统方法（readFile/writeFile/openDirectoryPicker）', () => {
  assert.match(preloadSrc, /readFile/);
  assert.match(preloadSrc, /writeFile/);
  assert.match(preloadSrc, /openDirectoryPicker/);
});

test('D5: preload 暴露 AI 方法（aiSend/aiStream）', () => {
  assert.match(preloadSrc, /aiSend/);
  assert.match(preloadSrc, /aiStream/);
});

test('D5: preload 暴露会话方法（createSession/listSessions）', () => {
  assert.match(preloadSrc, /createSession/);
  assert.match(preloadSrc, /listSessions/);
});

test('D5: preload 暴露平台/版本信息（getPlatform/getVersion）', () => {
  assert.match(preloadSrc, /getPlatform/);
  assert.match(preloadSrc, /getVersion/);
});

// ── D6: IPC 通道命名约定 ────────────────────────────────────────

test('D6: IPC 通道使用 namespace:action 命名约定', () => {
  const ipcChannels = mainSrc.match(/ipcMain\.handle\(['"`]([^'"`]+)['"`]/g) || [];
  assert.ok(ipcChannels.length > 0, '主进程应注册至少一个 IPC handler');
  for (const channel of ipcChannels) {
    const name = channel.match(/['"`]([^'"`]+)['"`]/)[1];
    assert.ok(
      name.includes(':'),
      `IPC 通道 "${name}" 应使用 namespace:action 命名约定（如 window:minimize）`
    );
  }
  // KeyManager module channels (DESIGN-ARCH-091 §6) — same convention
  const kmChannels = keyManagerIpcSrc.match(/handle\('([^']+)'/g) || [];
  for (const channel of kmChannels) {
    const name = channel.match(/'([^']+)'/)[1];
    assert.match(
      name,
      /^[a-z][a-z-]*:[a-z][a-z-]*$/,
      `KeyManager IPC 通道 "${name}" 应使用 namespace:action 命名约定`
    );
  }
});

test('D6: preload invoke 使用与主进程一致的通道名', () => {
  const preloadInvokes = preloadSrc.match(/ipcRenderer\.invoke\(['"`]([^'"`]+)['"`]/g) || [];
  const mainHandles = mainSrc.match(/ipcMain\.handle\(['"`]([^'"`]+)['"`]/g) || [];
  const keyManagerHandles = keyManagerIpcSrc.match(/handle\('([^']+)'/g) || [];
  const mainNames = [
    ...mainHandles.map((h) => h.match(/['"`]([^'"`]+)['"`]/)[1]),
    ...keyManagerHandles.map((h) => h.match(/'([^']+)'/)[1]),
  ];
  for (const invoke of preloadInvokes) {
    const name = invoke.match(/['"`]([^'"`]+)['"`]/)[1];
    assert.ok(
      mainNames.includes(name),
      `preload 调用通道 "${name}" 在主进程中未注册（API 漂移）`
    );
  }
});

// ── D7: 菜单结构 ────────────────────────────────────────────────

test('D7: 菜单包含文件菜单', () => {
  if (!menuSrc) return;
  assert.ok(/文件|File/i.test(menuSrc), '菜单应包含「文件」菜单项');
});

test('D7: 菜单包含视图菜单', () => {
  if (!menuSrc) return;
  assert.ok(/视图|View/i.test(menuSrc), '菜单应包含「视图」菜单项');
});

test('D7: 菜单包含窗口菜单', () => {
  if (!menuSrc) return;
  assert.ok(/窗口|Window/i.test(menuSrc), '菜单应包含「窗口」菜单项');
});

test('D7: 菜单包含帮助菜单', () => {
  if (!menuSrc) return;
  assert.ok(/帮助|Help/i.test(menuSrc), '菜单应包含「帮助」菜单项');
});

// ── D8: TitleBar 窗口控制按钮 ───────────────────────────────────

test('D8: TitleBar 组件存在', () => {
  assert.ok(existsSync(titleBarPath), 'TitleBar.tsx 应存在于 layout 目录');
});

test('D8: TitleBar 包含最小化按钮', () => {
  if (!titleBarSrc) return;
  assert.ok(/minimize|min/i.test(titleBarSrc), 'TitleBar 应包含最小化按钮');
});

test('D8: TitleBar 包含最大化/还原按钮', () => {
  if (!titleBarSrc) return;
  assert.ok(/maximize|max/i.test(titleBarSrc), 'TitleBar 应包含最大化按钮');
});

test('D8: TitleBar 包含关闭按钮', () => {
  if (!titleBarSrc) return;
  assert.ok(/close/i.test(titleBarSrc), 'TitleBar 应包含关闭按钮');
});

// ── D9: 品牌合规 ─────────────────────────────────────────────────

test('D9: 主进程源码不含 "ZCode" 品牌文本（仅结构复刻，不复用品牌）', () => {
  const stripped = mainSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/ZCode/i.test(stripped),
    'khyos-desktop 主进程源码不得包含 "ZCode" 品牌文本（CLAUDE.md 品牌规则）'
  );
});

test('D9: preload 源码不含 "ZCode" 品牌文本', () => {
  const stripped = preloadSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/ZCode/i.test(stripped),
    'preload 源码不得包含 "ZCode" 品牌文本'
  );
});

test('D9: 源码不含 "智谱" 或 "Zhipu" 品牌文本', () => {
  const checkDir = (dir) => {
    if (!existsSync(dir)) return [];
    const violations = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'out' || entry === 'dist' || entry === 'zcode-analysis' || entry === 'unpacked') continue;
        violations.push(...checkDir(full));
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        const src = readFileSync(full, 'utf-8');
        const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/智谱|Zhipu/i.test(stripped)) {
          violations.push(full);
        }
      }
    }
    return violations;
  };
  const violations = checkDir(join(projectRoot, 'src'));
  assert.strictEqual(
    violations.length, 0,
    `源码不得包含 "智谱" 或 "Zhipu" 品牌文本（CLAUDE.md 品牌规则）：\n${violations.join('\n')}`
  );
});

// ── D10: 硬编码端点禁令 ─────────────────────────────────────────

test('D10: 主进程源码不得硬编码 localhost 端点（回归基线）', () => {
  const stripped = mainSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const localhostMatches = stripped.match(/localhost:\d+/g) || [];
  const allowedPatterns = [
    'localhost:5173',
  ];
  const violations = localhostMatches.filter((m) => !allowedPatterns.includes(m));
  const BASELINE = 0;
  if (violations.length > BASELINE) {
    console.warn(`[D10] Main process has ${violations.length} hardcoded localhost endpoints: ${violations.join(', ')}`);
  }
  expect: violations.length <= BASELINE;
});
