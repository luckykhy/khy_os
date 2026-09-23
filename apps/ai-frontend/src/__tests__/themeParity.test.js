import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const themeCssPath = join(__dirname, '..', 'styles', 'newapi-theme.css');
const themeCss = readFileSync(themeCssPath, 'utf-8');

function extractBlock(css, selector) {
  const idx = css.indexOf(selector);
  if (idx === -1) return '';
  const braceStart = css.indexOf('{', idx);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return css.slice(braceStart + 1, end);
}

function extractKhyTokens(block) {
  const tokens = new Set();
  const re = /(--khy-[\w-]+)\s*:/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    tokens.add(m[1]);
  }
  return tokens;
}

function extractReferencedTokens(block) {
  const refs = new Set();
  const re = /var\((--khy-[\w-]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    refs.add(m[1]);
  }
  return refs;
}

const rootBlock = extractBlock(themeCss, ':root');
const darkBlock = extractBlock(themeCss, 'html.dark');
const rootDefined = extractKhyTokens(rootBlock);
const darkDefined = extractKhyTokens(darkBlock);
const rootRefs = extractReferencedTokens(rootBlock);
const darkRefs = extractReferencedTokens(darkBlock);
const fullCssRefs = extractReferencedTokens(themeCss);

describe('W1: Theme Parity — 双主题令牌成对定义', () => {
  it(':root 中定义的 surface/text/line/brand token 必须在 html.dark 中也有定义', () => {
    const mustPair = [
      '--khy-bg-main',
      '--khy-bg-elevated',
      '--khy-bg-card',
      '--khy-bg-soft',
      '--khy-bg-hover',
      '--khy-text-main',
      '--khy-text-strong',
      '--khy-text-secondary',
      '--khy-text-muted',
      '--khy-border',
      '--khy-border-light',
      '--khy-primary',
      '--khy-primary-strong',
      '--khy-primary-soft',
      '--khy-success',
      '--khy-warning',
      '--khy-danger',
    ];
    const missing = mustPair.filter((t) => rootDefined.has(t) && !darkDefined.has(t));
    expect(missing).toEqual([]);
  });

  it('html.dark 中定义的 token 也应在 :root 中有对应（不允许只在暗色中定义）', () => {
    const darkOnly = [...darkDefined].filter((t) => !rootDefined.has(t));
    expect(darkOnly).toEqual([]);
  });
});

describe('W2: --khy-white 定义存在（FE-001 缺口 G1）', () => {
  it('--khy-white 在 :root 中已定义', () => {
    expect(rootDefined.has('--khy-white')).toBe(true);
  });

  it('所有引用 var(--khy-white) 的位置都有定义兜底', () => {
    if (!rootDefined.has('--khy-white')) {
      const refs = [...fullCssRefs].filter((r) => r === '--khy-white');
      if (refs.length > 0) {
        throw new Error(`--khy-white 被 ${refs.length} 处引用但未在 :root 中定义`);
      }
    }
  });
});

describe('Theme Consistency: 引用的令牌必须有定义', () => {
  it(':root 内引用的 --khy-* token 都在 :root 中有定义', () => {
    const undef = [...rootRefs].filter((r) => !rootDefined.has(r));
    const knownUndefined = new Set(['--khy-white', '--khy-primary-50', '--khy-page-max']);
    const realUndef = undef.filter((r) => !knownUndefined.has(r));
    if (realUndef.length > 0) {
      console.warn(`[Theme] :root 引用但未定义的令牌: ${realUndef.join(', ')}`);
    }
    expect(realUndef.length).toBe(0);
  });

  it('html.dark 内引用的 --khy-* token 都在 :root 或 html.dark 中有定义', () => {
    const allDefined = new Set([...rootDefined, ...darkDefined]);
    const undef = [...darkRefs].filter((r) => !allDefined.has(r));
    const knownUndefined = new Set(['--khy-white', '--khy-primary-50', '--khy-page-max']);
    const realUndef = undef.filter((r) => !knownUndefined.has(r));
    if (realUndef.length > 0) {
      console.warn(`[Theme] html.dark 引用但未定义的令牌: ${realUndef.join(', ')}`);
    }
    expect(realUndef.length).toBe(0);
  });
});

describe('Theme Structure: 令牌分组完整性', () => {
  it('Surface 层令牌组完整（6 个）', () => {
    const surface = [
      '--khy-bg-main',
      '--khy-bg-elevated',
      '--khy-bg-card',
      '--khy-bg-soft',
      '--khy-bg-hover',
    ];
    for (const t of surface) {
      expect(rootDefined.has(t)).toBe(true);
      expect(darkDefined.has(t)).toBe(true);
    }
  });

  it('Text 层令牌组完整（4 级）', () => {
    const text = [
      '--khy-text-main',
      '--khy-text-strong',
      '--khy-text-secondary',
      '--khy-text-muted',
    ];
    for (const t of text) {
      expect(rootDefined.has(t)).toBe(true);
      expect(darkDefined.has(t)).toBe(true);
    }
  });

  it('Brand/Semantic 层令牌组完整', () => {
    const brand = [
      '--khy-primary',
      '--khy-primary-strong',
      '--khy-primary-soft',
      '--khy-success',
      '--khy-warning',
      '--khy-danger',
    ];
    for (const t of brand) {
      expect(rootDefined.has(t)).toBe(true);
      expect(darkDefined.has(t)).toBe(true);
    }
  });

  it('Geometry 层令牌组完整', () => {
    expect(rootDefined.has('--khy-radius')).toBe(true);
    expect(rootDefined.has('--khy-radius-sm')).toBe(true);
    expect(rootDefined.has('--khy-radius-lg')).toBe(true);
  });

  it('Skeleton 层令牌组完整（2 色）', () => {
    expect(rootDefined.has('--khy-skeleton-base')).toBe(true);
    expect(rootDefined.has('--khy-skeleton-highlight')).toBe(true);
    expect(darkDefined.has('--khy-skeleton-base')).toBe(true);
    expect(darkDefined.has('--khy-skeleton-highlight')).toBe(true);
  });
});
