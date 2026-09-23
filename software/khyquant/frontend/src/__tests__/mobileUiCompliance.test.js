import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const srcRoot = join(process.cwd(), 'src');

const mobileCssPath = join(srcRoot, 'styles', 'mobile.css');
const responsiveCssPath = join(srcRoot, 'styles', 'responsive.css');
const mobileScrollCssPath = join(srcRoot, 'styles', 'mobile-scroll.css');
const themeCssPath = join(srcRoot, 'styles', 'theme.css');

const mobileCss = readFileSync(mobileCssPath, 'utf-8');
const responsiveCss = readFileSync(responsiveCssPath, 'utf-8');
const mobileScrollCss = existsSync(mobileScrollCssPath) ? readFileSync(mobileScrollCssPath, 'utf-8') : '';

const viteConfigPath = join(srcRoot, '..', 'vite.config.js');
const viteConfig = existsSync(viteConfigPath) ? readFileSync(viteConfigPath, 'utf-8') : '';

const capacitorConfigPath = join(srcRoot, '..', 'capacitor.config.ts');
const capacitorConfig = existsSync(capacitorConfigPath) ? readFileSync(capacitorConfigPath, 'utf-8') : '';

function componentExists(name) {
  return existsSync(join(srcRoot, 'components', `${name}.vue`));
}

function readDirRecursive(dir, ext, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      readDirRecursive(full, ext, acc);
    } else if (extname(full) === ext) {
      acc.push(full);
    }
  }
  return acc;
}

describe('M1: Touch Target ≥44px — 触控目标尺寸', () => {
  it('mobile.css 中 button/a/clickable 的 min-height 为 44px', () => {
    expect(mobileCss).toContain('44px');
    expect(mobileCss).toMatch(/min-height:\s*44px/i);
  });

  it('mobile.css 中 button/a/clickable 的 min-width 为 44px', () => {
    expect(mobileCss).toMatch(/min-width:\s*44px/i);
  });
});

describe('M2: Input Font Size ≥16px — 防 iOS 自动缩放', () => {
  it('mobile.css 或组件样式中应包含 font-size: 16px 或更大', () => {
    const has16px = /font-size:\s*1[6-9]px/i.test(mobileCss) ||
      /font-size:\s*1[6-9]px/i.test(responsiveCss);
    expect(has16px).toBe(true);
  });
});

describe('M3: Responsive Breakpoints — 响应式断点', () => {
  it('responsive.css 包含 768px 断点（手机/平板分界）', () => {
    expect(responsiveCss).toContain('768px');
  });

  it('responsive.css 包含 1024px 断点（平板/桌面分界）', () => {
    expect(responsiveCss).toContain('1024px');
  });

  it('responsive.css 包含 480px 断点（小屏手机）', () => {
    expect(responsiveCss).toContain('480px');
  });

  it('mobile.css 包含 768px 媒体查询', () => {
    expect(mobileCss).toContain('768px');
  });
});

describe('M4: PWA Manifest — 必需字段', () => {
  it('vite.config.js 包含 PWA 插件配置', () => {
    expect(viteConfig).toMatch(/vite-plugin-pwa|VitePWA/i);
  });

  it('PWA manifest 包含 name', () => {
    expect(viteConfig).toMatch(/name:\s*['"`].*['"`]/);
  });

  it('PWA manifest 包含 short_name', () => {
    expect(viteConfig).toMatch(/short_name:\s*['"`].*['"`]/);
  });

  it('PWA manifest 包含 theme_color', () => {
    expect(viteConfig).toMatch(/theme_color:\s*['"`].*['"`]/i);
  });

  it('PWA manifest 包含 display: standalone', () => {
    expect(viteConfig).toMatch(/display:\s*['"`]standalone['"`]/i);
  });

  it('PWA manifest 包含 icons 配置', () => {
    expect(viteConfig).toMatch(/icons/i);
  });
});

describe('M5: Capacitor Config — 必需字段', () => {
  it('capacitor.config.ts 文件存在', () => {
    expect(existsSync(capacitorConfigPath)).toBe(true);
  });

  it('Capacitor 配置包含 appId', () => {
    expect(capacitorConfig).toMatch(/appId:\s*['"`].*['"`]/);
  });

  it('Capacitor 配置包含 appName', () => {
    expect(capacitorConfig).toMatch(/appName:\s*['"`].*['"`]/);
  });

  it('Capacitor 配置包含 webDir', () => {
    expect(capacitorConfig).toMatch(/webDir:\s*['"`].*['"`]/);
  });
});

describe('M6: Mobile* Component Family — 组件族存在', () => {
  const requiredComponents = [
    'MobileLayout',
    'MobileNav',
    'MobileToast',
  ];

  for (const name of requiredComponents) {
    it(`${name}.vue 存在`, () => {
      expect(componentExists(name)).toBe(true);
    });
  }

  it('至少 3 个 Mobile* 组件存在', () => {
    const componentsDir = join(srcRoot, 'components');
    if (!existsSync(componentsDir)) return;
    const mobileComponents = readdirSync(componentsDir)
      .filter((f) => f.startsWith('Mobile') && f.endsWith('.vue'));
    expect(mobileComponents.length).toBeGreaterThanOrEqual(3);
  });
});

describe('M7: PWA Components — 更新提示与离线指示', () => {
  it('PwaUpdatePrompt.vue 存在', () => {
    expect(componentExists('PwaUpdatePrompt')).toBe(true);
  });

  it('OfflineIndicator.vue 存在', () => {
    expect(componentExists('OfflineIndicator')).toBe(true);
  });
});

describe('M8: Mobile Scroll Behavior — 触摸滚动', () => {
  it('mobile-scroll.css 或 mobile.css 包含 -webkit-overflow-scrolling: touch', () => {
    const combined = mobileCss + mobileScrollCss;
    expect(combined).toContain('-webkit-overflow-scrolling');
  });

  it('mobile-scroll.css 文件存在', () => {
    expect(existsSync(mobileScrollCssPath)).toBe(true);
  });
});

describe('K1/K2: khyquant Token Naming — 令牌命名收敛', () => {
  it('theme.css 不新增 --primary-color 平行命名（回归基线）', () => {
    if (!existsSync(themeCssPath)) return;
    const themeCss = readFileSync(themeCssPath, 'utf-8');
    const parallelTokens = themeCss.match(/--primary-color\s*:/g) || [];
    const BASELINE = 5;
    if (parallelTokens.length > BASELINE) {
      console.warn(`[K2] theme.css has ${parallelTokens.length} --primary-color definitions (baseline=${BASELINE})`);
    }
    expect(parallelTokens.length).toBeLessThanOrEqual(BASELINE);
  });

  it('khyquant 引用 --khy-* 令牌时应有定义（回归基线）', () => {
    if (!existsSync(themeCssPath)) return;
    const themeCss = readFileSync(themeCssPath, 'utf-8');
    const refs = new Set();
    const refRe = /var\((--khy-[\w-]+)/g;
    let m;
    while ((m = refRe.exec(themeCss)) !== null) {
      refs.add(m[1]);
    }
    const defined = new Set();
    const defRe = /(--khy-[\w-]+)\s*:/g;
    while ((m = defRe.exec(themeCss)) !== null) {
      defined.add(m[1]);
    }
    const undef = [...refs].filter((r) => !defined.has(r));
    const BASELINE = 10;
    if (undef.length > BASELINE) {
      console.warn(`[K1] theme.css references ${undef.length} undefined --khy-* tokens (baseline=${BASELINE}): ${undef.slice(0, 5).join(', ')}`);
    }
    expect(undef.length).toBeLessThanOrEqual(BASELINE);
  });
});
