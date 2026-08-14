'use strict';

const { renderRepoMap, _internal } = require('../../../src/services/repoMap/repoMapRenderer');

/** Build a minimal ctx like the one _collectContext produces. */
function makeCtx(overrides = {}) {
  return {
    projectName: 'demo',
    det: {
      entryPoints: [{ kind: 'node-main', path: 'src/index.js', hint: 'package.json#main' }],
      inferred: [],
    },
    tree: '- `src/` — 源代码主目录\n  - `src/services/` — 服务/业务逻辑',
    symbolFiles: [
      { rel: 'src/utils/helper.js', lang: 'javascript', symbols: [{ kind: 'fn', name: 'helperA' }] },
      {
        rel: 'src/index.js',
        lang: 'javascript',
        symbols: [
          { kind: 'fn', name: 'main' },
          { kind: 'const', name: 'app' },
        ],
      },
      {
        rel: 'src/services/big.js',
        lang: 'javascript',
        symbols: [
          { kind: 'fn', name: 'a' },
          { kind: 'fn', name: 'b' },
          { kind: 'fn', name: 'c' },
        ],
      },
    ],
    srcTree: [],
    limits: {},
    ...overrides,
  };
}

describe('repoMapRenderer.renderRepoMap', () => {
  test('output contains the directory tree and per-file symbol signatures', () => {
    const out = renderRepoMap(makeCtx(), { tokenBudget: 4000 });
    expect(out.text).toContain('## 目录结构');
    expect(out.text).toContain('src/services/');
    expect(out.text).toContain('## 文件符号');
    // Symbol signatures rendered as `kind name`.
    expect(out.text).toContain('fn main');
    expect(out.text).toContain('const app');
    expect(out.truncated).toBe(false);
    expect(out.fileCount).toBe(3);
  });

  test('tokenCount stays within the supplied budget', () => {
    const budget = 4000;
    const out = renderRepoMap(makeCtx(), { tokenBudget: budget });
    expect(out.tokenCount).toBeLessThanOrEqual(budget);
  });

  test('entry-point files are ordered first', () => {
    const out = renderRepoMap(makeCtx(), { tokenBudget: 4000 });
    const idxEntry = out.text.indexOf('`src/index.js`');
    const idxHelper = out.text.indexOf('`src/utils/helper.js`');
    const idxBig = out.text.indexOf('`src/services/big.js`');
    expect(idxEntry).toBeGreaterThan(-1);
    // Entry point precedes both non-entry files.
    expect(idxEntry).toBeLessThan(idxHelper);
    expect(idxEntry).toBeLessThan(idxBig);
  });

  test('non-entry files rank by descending symbol count (documented fallback)', () => {
    // big.js (3 symbols) should precede helper.js (1 symbol) among non-entries.
    const out = renderRepoMap(makeCtx(), { tokenBudget: 4000 });
    const idxBig = out.text.indexOf('`src/services/big.js`');
    const idxHelper = out.text.indexOf('`src/utils/helper.js`');
    expect(idxBig).toBeLessThan(idxHelper);
  });

  test('over-budget truncation adds a footer and sets truncated:true', () => {
    // Many files with a tiny budget forces truncation.
    const symbolFiles = [];
    for (let i = 0; i < 40; i++) {
      symbolFiles.push({
        rel: `src/mod${String(i).padStart(2, '0')}.js`,
        lang: 'javascript',
        symbols: [{ kind: 'fn', name: `func${i}` }],
      });
    }
    const ctx = makeCtx({ symbolFiles, det: { entryPoints: [], inferred: [] } });
    const budget = 120;
    const out = renderRepoMap(ctx, { tokenBudget: budget });
    expect(out.truncated).toBe(true);
    expect(out.text).toMatch(/…\s*\(还有\s*\d+\s*个文件未展示\)/);
    expect(out.tokenCount).toBeLessThanOrEqual(budget);
    expect(out.fileCount).toBeLessThan(symbolFiles.length);
  });

  test('never throws on malformed input; returns a safe empty-ish result', () => {
    expect(() => renderRepoMap(null, {})).not.toThrow();
    const out = renderRepoMap(undefined, undefined);
    expect(typeof out.text).toBe('string');
    expect(out.fileCount).toBe(0);
    expect(out.truncated).toBe(false);
  });

  test('_rankFiles honours inferred entry points when entryPoints is empty', () => {
    const ctx = makeCtx({
      det: { entryPoints: [], inferred: [{ kind: 'inferred-entry', path: 'src/services/big.js' }] },
    });
    const ranked = _internal._rankFiles(ctx);
    expect(_internal._normalizeRel(ranked[0].rel)).toBe('src/services/big.js');
  });
});
