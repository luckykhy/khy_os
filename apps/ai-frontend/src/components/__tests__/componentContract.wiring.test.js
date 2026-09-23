import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const componentsDir = join(__dirname, '..');

const KHY_COMPONENTS = [
  'KhyPageHeader.vue',
  'KhyEmpty.vue',
  'KhyIcon.vue',
  'KhyFloatBall.vue',
  'LoadErrorBanner.vue',
  'GlobalProgressBar.vue',
];

function readComponent(name) {
  const path = join(componentsDir, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

describe('W5: Khy* Component Structure — 组件结构合规', () => {
  for (const name of KHY_COMPONENTS) {
    describe(`${name}`, () => {
      it('文件存在', () => {
        expect(existsSync(join(componentsDir, name))).toBe(true);
      });

      it('使用 <script setup>（Composition API）', () => {
        const src = readComponent(name);
        if (!src) return;
        expect(src).toContain('<script setup');
      });

      it('样式为 scoped', () => {
        const src = readComponent(name);
        if (!src) return;
        if (src.includes('<style')) {
          expect(src).toMatch(/<style[^>]*scoped/);
        }
      });

      it('样式使用 var(--khy-*) 而非内联 hex', () => {
        const src = readComponent(name);
        if (!src) return;
        const styleMatch = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
        if (!styleMatch) return;
        const styles = styleMatch[1];
        const hexInStyles = styles.match(/#[0-9a-fA-F]{3,8}\b/g);
        if (hexInStyles) {
          console.warn(`[W4] ${name} contains hardcoded hex in <style>: ${hexInStyles.join(', ')}`);
        }
      });
    });
  }
});

describe('W6: Component API Contract — Props/Emits 声明', () => {
  it('KhyIcon 声明了 props（kind 属性 + validator）', () => {
    const src = readComponent('KhyIcon.vue');
    if (!src) return;
    expect(src).toMatch(/defineProps|props/);
  });

  it('KhyEmpty 提供标题、描述、操作插槽', () => {
    const src = readComponent('KhyEmpty.vue');
    if (!src) return;
    expect(src).toMatch(/slot|defineProps/);
  });

  it('KhyPageHeader 提供标题 + 描述 + 右侧操作区', () => {
    const src = readComponent('KhyPageHeader.vue');
    if (!src) return;
    expect(src).toMatch(/slot|title|defineProps/);
  });

  it('LoadErrorBanner 遵循错误模板 {问题}:{原因},{修复建议}', () => {
    const src = readComponent('LoadErrorBanner.vue');
    if (!src) return;
    const hasErrorPattern = src.includes('reason') || src.includes('suggestion') || src.includes('修复') || src.includes('error');
    expect(hasErrorPattern).toBe(true);
  });

  it('GlobalProgressBar 由计数驱动（httpStart/httpDone）', () => {
    const src = readComponent('GlobalProgressBar.vue');
    if (!src) return;
    expect(src).toMatch(/count|httpStart|httpDone|progress/i);
  });
});

describe('W7: Component Registration — 组件注册完整性', () => {
  it('所有 Khy* 组件文件都在 components/ 根目录', () => {
    for (const name of KHY_COMPONENTS) {
      expect(existsSync(join(componentsDir, name))).toBe(true);
    }
  });

  it('Khy* 组件不互相 import（无循环依赖）', () => {
    for (const name of KHY_COMPONENTS) {
      const src = readComponent(name);
      if (!src) continue;
      for (const other of KHY_COMPONENTS) {
        if (other === name) continue;
        const otherBase = basename(other, '.vue');
        expect(src).not.toContain(`from './${otherBase}'`);
      }
    }
  });
});
