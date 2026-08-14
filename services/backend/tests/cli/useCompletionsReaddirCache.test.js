'use strict';

/**
 * useCompletionsReaddirCache.test.js — 证明 @-mention 补全的 readdir 缓存**真的接在**
 * useCompletions.computeFile 的热路径上(node:test,真实 fs + 临时目录 + 计数 readdirSync)。
 *
 *  - 门控开:同一 @-token 连续两次 computeFile → fs.readdirSync 只真正跑一次(命中缓存),
 *    且结果仍是真实目录项(过滤/映射正确)。
 *  - 门控关:两次 computeFile → readdirSync 跑两次(逐字节回退今日每键直读)。
 *
 * 运行:node --test services/backend/tests/cli/useCompletionsReaddirCache.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `khy-compl-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'foo.txt'), 'x');
fs.writeFileSync(path.join(TMP, 'foobar.js'), 'x');
fs.writeFileSync(path.join(TMP, 'bar.md'), 'x');
fs.mkdirSync(path.join(TMP, 'sub'), { recursive: true });

const { computeFile } = require('../../src/cli/tui/hooks/useCompletions');
const dc = require('../../src/cli/tui/completionDirCache');

const _origCwd = process.cwd();
const _origReaddir = fs.readdirSync;
let _readdirCalls = 0;
fs.readdirSync = function (...args) { _readdirCalls++; return _origReaddir.apply(fs, args); };

test.before(() => { process.chdir(TMP); });
test.after(() => {
  fs.readdirSync = _origReaddir;
  try { process.chdir(_origCwd); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('门控开:同一 @-token 连续两次 → readdirSync 只跑一次(命中缓存),结果为真实目录项', () => {
  delete process.env.KHY_COMPLETION_READDIR_CACHE; // 默认 on
  dc._clearCache();
  _readdirCalls = 0;

  const a = computeFile('@f', 2);   // partial='f' → 匹配 foo.txt / foobar.js
  const b = computeFile('@fo', 3);  // 同目录 '.' → 应命中缓存(base 变化仅影响过滤)

  assert.equal(_readdirCalls, 1, '连续按键同目录应只读一次系统调用');
  assert.ok(a && a.kind === 'file', '应产出文件补全');
  const labels = a.items.map((i) => i.label).sort();
  assert.deepEqual(labels, ['foo.txt', 'foobar.js'], '过滤/映射仍产出真实目录项');
  // 第二次 base='fo' 同样匹配这两个。
  assert.deepEqual(b.items.map((i) => i.label).sort(), ['foo.txt', 'foobar.js']);
});

test('门控关:两次 → readdirSync 跑两次(逐字节回退每键直读)', () => {
  process.env.KHY_COMPLETION_READDIR_CACHE = 'off';
  dc._clearCache();
  _readdirCalls = 0;

  computeFile('@f', 2);
  computeFile('@fo', 3);

  assert.equal(_readdirCalls, 2, '门控关应每次直读');
  delete process.env.KHY_COMPLETION_READDIR_CACHE;
});
