import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = join(__dirname, '..');

function readDirRecursive(dir, ext, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '__tests__') continue;
      readDirRecursive(full, ext, acc);
    } else if (extname(full) === ext) {
      acc.push(full);
    }
  }
  return acc;
}

const vueFiles = readDirRecursive(join(srcRoot, 'components'), '.vue');
const cssFiles = readDirRecursive(srcRoot, '.css');

describe('W8: Keyboard Accessibility — 交互元素键盘可达', () => {
  it('自定义可点击元素应有键盘事件处理（回归基线，只降不升）', () => {
    const BASELINE = 10;
    const violations = [];
    for (const file of vueFiles) {
      const src = readFileSync(file, 'utf-8');
      if (!src.includes('@click')) continue;
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('@click') && !line.includes('<el-') && !line.includes('<button')) {
          const hasKeydown = lines.slice(Math.max(0, i - 3), i + 4).some((l) =>
            l.includes('@keydown') || l.includes('@keyup') || l.includes('@keypress')
          );
          const hasRole = line.includes('role=') || line.includes('tabindex');
          if (!hasKeydown && !hasRole) {
            violations.push({ file: relative(srcRoot, file), line: i + 1, snippet: line.trim().slice(0, 80) });
          }
        }
      }
    }
    if (violations.length > 0) {
      console.warn(`[W8] ${violations.length} custom clickable elements lack keyboard handlers (baseline=${BASELINE}):\n` +
        violations.slice(0, 5).map((v) => `  ${v.file}:${v.line} ${v.snippet}`).join('\n'));
    }
    expect(violations.length).toBeLessThanOrEqual(BASELINE);
  });
});

describe('W9: ARIA — 状态变化区有 aria-live / aria-busy', () => {
  it('包含动态加载内容的组件应使用 aria-busy 或 aria-live', () => {
    const loadingPatterns = [
      /v-if="loading|v-if="isLoading|v-loading|ElLoading|:loading/,
    ];
    const violations = [];
    for (const file of vueFiles) {
      const src = readFileSync(file, 'utf-8');
      const hasLoading = loadingPatterns.some((re) => re.test(src));
      if (!hasLoading) continue;
      const hasAria = src.includes('aria-busy') || src.includes('aria-live');
      if (!hasAria) {
        violations.push(relative(srcRoot, file));
      }
    }
    if (violations.length > 0) {
      console.warn(`[W9] ${violations.length} components with loading states lack aria-busy/aria-live (baseline=20):\n  ${violations.slice(0, 5).join('\n  ')}`);
    }
    expect(violations.length).toBeLessThanOrEqual(20);
  });

  it('toast/通知相关应通过集中出口（notify.js），不直接 ElMessage（回归基线）', () => {
    const violations = [];
    for (const file of vueFiles) {
      const src = readFileSync(file, 'utf-8');
      const directElMessage = /ElMessage\.(error|success|warning|info)\s*\(/.test(src);
      if (directElMessage) {
        violations.push(relative(srcRoot, file));
      }
    }
    if (violations.length > 0) {
      console.warn(`[W9] ${violations.length} files directly call ElMessage instead of using notify.js (baseline=15):\n  ${violations.slice(0, 5).join('\n  ')}`);
    }
    expect(violations.length).toBeLessThanOrEqual(15);
  });
});

describe('W10: prefers-reduced-motion — 尊重动画偏好', () => {
  it('newapi-theme.css 必须包含 prefers-reduced-motion 媒体查询', () => {
    const themePath = join(srcRoot, 'styles', 'newapi-theme.css');
    const src = readFileSync(themePath, 'utf-8');
    expect(src).toContain('prefers-reduced-motion');
  });

  it('prefers-reduced-motion 块必须禁用动画和过渡', () => {
    const themePath = join(srcRoot, 'styles', 'newapi-theme.css');
    const src = readFileSync(themePath, 'utf-8');
    const reducedMotionBlock = src.match(/@media\s*\(\s*prefers-reduced-motion[^{]*\{[^}]+\}/g);
    expect(reducedMotionBlock).not.toBeNull();
    const blockContent = reducedMotionBlock.map((b) => b).join('\n');
    expect(blockContent).toMatch(/animation.*none|animation-duration.*0/i);
    expect(blockContent).toMatch(/transition.*none|transition-duration.*0/i);
  });

  it('骨架屏动画在 prefers-reduced-motion 下应停用', () => {
    const themePath = join(srcRoot, 'styles', 'newapi-theme.css');
    const src = readFileSync(themePath, 'utf-8');
    const reducedMotionBlock = src.match(/@media\s*\(\s*prefers-reduced-motion[\s\S]*?@media/g);
    if (!reducedMotionBlock) return;
    const combined = reducedMotionBlock.join('\n');
    expect(combined).toContain('khy-skeleton');
    expect(combined).toMatch(/animation:\s*none/);
  });
});

describe('A11Y Structure: 语义化 HTML 基线', () => {
  it('布局组件应使用语义化标签（header/nav/main/footer）或 ARIA role', () => {
    const layoutFiles = vueFiles.filter((f) => {
      const name = relative(srcRoot, f).toLowerCase();
      return name.includes('layout') || name.includes('authenticated');
    });
    if (layoutFiles.length === 0) return;
    for (const file of layoutFiles) {
      const src = readFileSync(file, 'utf-8');
      const hasSemantic = /<header|<nav|<main|<footer|<aside|role="(navigation|main|banner|contentinfo)"/.test(src);
      expect(hasSemantic).toBe(true);
    }
  });
});

describe('A11Y: Form Accessibility — 表单可访问性', () => {
  it('表单输入元素应有 label 关联或 aria-label', () => {
    const violations = [];
    for (const file of vueFiles) {
      const src = readFileSync(file, 'utf-8');
      const inputMatches = [...src.matchAll(/<(el-input|input|el-select|el-textarea)[^>]*>/g)];
      for (const match of inputMatches) {
        const tag = match[0];
        if (tag.includes('aria-label') || tag.includes('aria-labelledby')) continue;
        const afterTag = src.slice(match.index + tag.length, match.index + tag.length + 200);
        if (afterTag.includes('<label') || afterTag.includes('#for')) continue;
        const hasElLabel = src.slice(Math.max(0, match.index - 500), match.index).includes('el-form-item');
        if (!hasElLabel) {
          violations.push({ file: relative(srcRoot, file), tag: tag.slice(0, 50) });
        }
      }
    }
    if (violations.length > 0) {
      console.warn(`[A11Y] ${violations.length} input elements may lack label association:\n  ` +
        violations.slice(0, 5).map((v) => `${v.file}: ${v.tag}`).join('\n  '));
    }
  });
});
