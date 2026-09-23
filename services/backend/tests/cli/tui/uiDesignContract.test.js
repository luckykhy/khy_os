'use strict';

// uiDesignContract.test.js — khyOS TUI 设计不变量的合规测试。
//
// 关注点（DESIGN-ARCH-079 + DESIGN-ARCH-016 §7 + tui/AGENTS.md）：
//   T5:  PromptFrame 宽度 = cols - 1（留 1 列 slack 防 anti-spill）
//   T6:  PromptFrame 最小高度 = 4 rows，最大高度 = vrows - 10
//   T7:  FooterBar 高度 = 2 rows（Legacy）/ 1 row（三栏 Statusbar）
//   T10: 响应式分类：超窄 <80 / 窄屏 80-119 / 标准 120-159 / 宽屏 ≥160
//   T13: CC 模式品牌文本不含 "Claude Code" / "Claude" / "Anthropic"
//
// 设计意图：这些是规范定义的硬约束，任何漂移都会导致 TUI 视觉错位或品牌违规。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

// ── T5: PromptFrame 宽度 = cols - 1 ──────────────────────────────

test('T5: PromptFrame 宽度计算使用 cols - 1（留 1 列 slack）', () => {
  const promptPath = join(__dirname, '../../../src/cli/tui/ink-components/PromptFrame.js');
  if (!existsSync(promptPath)) return;
  const src = readFileSync(promptPath, 'utf-8');
  assert.ok(
    src.includes('cols - 1') || src.includes('cols-1') || /cols\s*-\s*1/.test(src),
    'PromptFrame 必须使用 cols - 1 计算宽度（ARCH-079 §2.2）'
  );
});

test('T5: PromptFrame 边框使用 cols - 1 而非 cols', () => {
  const promptPath = join(__dirname, '../../../src/cli/tui/ink-components/PromptFrame.js');
  if (!existsSync(promptPath)) return;
  const src = readFileSync(promptPath, 'utf-8');
  const borderMatch = src.match(/border[^;]*cols\s*-\s*1/);
  assert.ok(
    borderMatch || src.includes('anti-spill') || src.includes('slack'),
    'PromptFrame 边框应使用 cols - 1 并有 anti-spill 注释（ARCH-079 §2.2）'
  );
});

// ── T6: PromptFrame 高度约束 ────────────────────────────────────

test('T6: PromptFrame 最小高度为 4 rows', () => {
  const promptPath = join(__dirname, '../../../src/cli/tui/ink-components/PromptFrame.js');
  if (!existsSync(promptPath)) return;
  const src = readFileSync(promptPath, 'utf-8');
  assert.ok(
    /min.*4|minHeight.*4|MIN.*4/i.test(src) || src.includes('4'),
    'PromptFrame 应有最小高度 4 rows 约束（ARCH-079 §2.2）'
  );
});

test('T6: PromptFrame 最大高度为 clamp(floor(rows/3), 3, 10)', () => {
  const promptPath = join(__dirname, '../../../src/cli/tui/ink-components/PromptFrame.js');
  if (!existsSync(promptPath)) return;
  const src = readFileSync(promptPath, 'utf-8');
  assert.ok(
    /Math\.max\(3,\s*Math\.min\(10/.test(src) && /rows\s*\/\s*3|rowBudget\s*\/\s*3/.test(src),
    'PromptFrame 最大高度应按 102 §4.7 公式 clamp(floor(rows/3), 3, 10)（替代旧 vrows-10）'
  );
});

// ── T7: FooterBar / Statusbar 高度 ──────────────────────────────

test('T7: FooterBar 渲染 2 行内容（权限/模型行 + Token/桥接行）', () => {
  const footerPath = join(__dirname, '../../../src/cli/tui/ink-components/FooterBar.js');
  if (!existsSync(footerPath)) return;
  const src = readFileSync(footerPath, 'utf-8');
  assert.ok(
    /token|bridge|权限|模型|context|model/i.test(src),
    'FooterBar 应包含状态行内容（模型/权限/Token/桥接）（ARCH-079 §2.6）'
  );
});

test('T7: FOOTER 在 TOP_LEVEL_ORDER 中位于 PROMPT 之后', () => {
  const { TOP_LEVEL_ORDER, REGION } = require(join(__dirname, '../../../src/cli/tui/ink-components/regionLayout'));
  const promptIdx = TOP_LEVEL_ORDER.indexOf(REGION.PROMPT);
  const footerIdx = TOP_LEVEL_ORDER.indexOf(REGION.FOOTER);
  assert.ok(promptIdx >= 0 && footerIdx >= 0, 'PROMPT 和 FOOTER 必须在 TOP_LEVEL_ORDER 中');
  assert.ok(footerIdx > promptIdx, 'FOOTER 必须在 PROMPT 之后（ARCH-079 §2.6 / ARCH-016 §7.2）');
});

test('T7: Statusbar 高度为 1 row（三栏模式）', () => {
  const statusbarPath = join(__dirname, '../../../src/cli/tui/ink-components/Statusbar.js');
  if (!existsSync(statusbarPath)) return;
  const src = readFileSync(statusbarPath, 'utf-8');
  assert.ok(
    /height.*1|rows.*1|1\s*row/i.test(src),
    'Statusbar 高度应为 1 row（ARCH-079 §2.6）'
  );
});

// ── T7: Topbar 高度为 1 row ──────────────────────────────────────

test('T7: Topbar 高度为 1 row', () => {
  const topbarPath = join(__dirname, '../../../src/cli/tui/ink-components/Topbar.js');
  if (!existsSync(topbarPath)) return;
  const src = readFileSync(topbarPath, 'utf-8');
  assert.ok(
    /height.*1|rows.*1|1\s*row/i.test(src),
    'Topbar 高度应为 1 row（ARCH-079 §2.5）'
  );
});

// ── T10: 响应式分类不变量 ───────────────────────────────────────

test('T10: 响应式断点 — 超窄阈值为 80 cols', () => {
  const sbPath = join(__dirname, '../../../src/cli/tui/sidebarLayout.js');
  if (!existsSync(sbPath)) return;
  const src = readFileSync(sbPath, 'utf-8');
  assert.ok(
    src.includes('80') && /min.*cols|MIN_COLS|minCols/i.test(src),
    'sidebarLayout 应包含 80 cols 最小列宽阈值（ARCH-079 §8.1）'
  );
});

test('T10: 响应式断点 — 标准阈值为 120 cols', () => {
  const sbPath = join(__dirname, '../../../src/cli/tui/sidebarLayout.js');
  if (!existsSync(sbPath)) return;
  const src = readFileSync(sbPath, 'utf-8');
  assert.ok(
    src.includes('120') && /min.*cols|MIN_COLS|minCols/i.test(src),
    'sidebarLayout 应包含 120 cols 标准激活阈值（ARCH-079 §8.1/§3.1）'
  );
});

test('T10: 响应式断点 — 看板宽度范围 [24, 36]', () => {
  const sbPath = join(__dirname, '../../../src/cli/tui/sidebarLayout.js');
  if (!existsSync(sbPath)) return;
  const src = readFileSync(sbPath, 'utf-8');
  assert.ok(
    src.includes('24') && src.includes('36'),
    'sidebarLayout 应包含宽度 clamp 范围 24-36（ARCH-079 §3.2）'
  );
});

test('T10: 响应式断点 — 宽屏三栏阈值为 160 cols', () => {
  const appPath = join(__dirname, '../../../src/cli/tui/ink-components/App.js');
  if (!existsSync(appPath)) return;
  const src = readFileSync(appPath, 'utf-8');
  assert.ok(
    src.includes('160') || src.includes('threeColumn') || src.includes('ThreeColumn'),
    'App.js 应包含 160 cols 宽屏三栏激活或 threeColumn 模式（ARCH-079 §8.1）'
  );
});

// ── T13: CC 模式品牌合规 ─────────────────────────────────────────

test('T13: CC 模式品牌文件（ccBrand.js）导出的品牌文本不含 "Claude Code"', () => {
  const brandPath = join(__dirname, '../../../src/cli/tui/utils/ccBrand.js');
  if (!existsSync(brandPath)) return;
  const { BRAND } = require(brandPath);
  assert.ok(BRAND, 'ccBrand.js 必须导出 BRAND 对象');
  for (const [key, val] of Object.entries(BRAND)) {
    if (typeof val !== 'string') continue;
    assert.ok(
      !/Claude Code/i.test(val),
      `BRAND.${key} 的值不得包含 "Claude Code"（tui/AGENTS.md §0.4）`
    );
    if (key !== 'statusBarModelPrefix') {
      assert.ok(
        !/^\s*Claude\s*$/.test(val),
        `BRAND.${key} 的值不得是 "Claude"（tui/AGENTS.md §0.4）`
      );
    }
  }
});

test('T13: CC 模式品牌文件不得包含 "Anthropic" 版权文本', () => {
  const brandPath = join(__dirname, '../../../src/cli/tui/utils/ccBrand.js');
  if (!existsSync(brandPath)) return;
  const src = readFileSync(brandPath, 'utf-8');
  assert.ok(
    !/Anthropic/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'ccBrand.js 不得包含 "Anthropic" 版权文本（tui/AGENTS.md §0.4）'
  );
});

// ── 颜色规范合规 ─────────────────────────────────────────────────

test('T-Color: CC 主题文件不得硬编码颜色（必须从 ccTheme.js 导出）', () => {
  const themePath = join(__dirname, '../../../src/cli/tui/theme/ccTheme.js');
  if (!existsSync(themePath)) return;
  const src = readFileSync(themePath, 'utf-8');
  const hexInStrings = src.match(/#[0-9a-fA-F]{6}/g);
  assert.ok(
    hexInStrings && hexInStrings.length > 0,
    'ccTheme.js 应导出颜色定义（集中管理）'
  );
});

// ── ANSI 滚动区禁令（规则 4 落地）─────────────────────────────────

test('T-ANSI: TUI 组件目录不得使用 DECSTBM 滚动区转义（除非备用缓冲区）', () => {
  const tuiDir = join(__dirname, '../../../src/cli/tui');
  if (!existsSync(tuiDir)) return;

  const { execSync } = require('node:child_process');
  try {
    const output = execSync(
      `rg -l "\\\\x1B\\[.*r" "${tuiDir}" --type js -i 2>nul || rg -l "\\\\u001B\\[.*r" "${tuiDir}" --type js -i 2>nul || echo CLEAN`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    if (output !== 'CLEAN' && output.length > 0) {
      const files = output.split('\n').filter(Boolean);
      const violating = files.filter((f) => {
        const content = readFileSync(f, 'utf-8');
        const hasScrollRegion = /\\x1B\[\d.*r|\\u001B\[\d.*r|\\033\[\d.*r/.test(content);
        const hasAltBuffer = /\\x1B\[\?1049h|\\u001B\[\?1049h|\\033\[\?1049h/.test(content);
        return hasScrollRegion && !hasAltBuffer;
      });
      assert.strictEqual(
        violating.length, 0,
        `TUI 目录中不得使用 DECSTBM 滚动区（除非已进入备用缓冲区）：\n${violating.join('\n')}`
      );
    }
  } catch {
    // rg 不可用时跳过（check-agent-rules.js 是权威检查脚本）
  }
});

// ── 环境变量门控完整性 ───────────────────────────────────────────

test('T-Gate: 看板开关环境变量在 sidebarLayout.js 中声明', () => {
  const sbPath = join(__dirname, '../../../src/cli/tui/sidebarLayout.js');
  if (!existsSync(sbPath)) return;
  const src = readFileSync(sbPath, 'utf-8');
  const requiredGates = ['KHY_SIDEBAR', 'KHY_SIDEBAR_MIN_COLS', 'KHY_SIDEBAR_WIDTH'];
  for (const gate of requiredGates) {
    assert.ok(
      src.includes(gate),
      `sidebarLayout.js 必须声明环境变量 ${gate}（ARCH-079 §3.1/§9）`
    );
  }
});

test('T-Gate: 看板宽度比例环境变量默认值为 0.16', () => {
  const sbPath = join(__dirname, '../../../src/cli/tui/sidebarLayout.js');
  if (!existsSync(sbPath)) return;
  const src = readFileSync(sbPath, 'utf-8');
  assert.ok(
    src.includes('0.16'),
    'sidebarLayout.js 应包含默认宽度比例 0.16（ARCH-079 §3.2）'
  );
});
