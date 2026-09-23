'use strict';

// BUG-009 回归测试：引用根（@alias/子路径）内的文件补全不再被静默归零。
//
// 病灶：computeFile 的 refRoot 分支引用了上一个 try 块作用域内的解构变量
// `first`（const [first] = partial.split('/')），块外不可见 → ReferenceError
// 被外层 catch 吞掉 → entries=[] → 返回 null → @alias/ 内补全永远为空。
// 修法：在 refRoot 分支内从 partial 重派生别名段。
//
// 本测试锁口径：computeFile('@<alias>/') 必须返回 kind:'file' 的条目，且
// value 保留 `@<alias>/` 前缀（供 referencesService 按别名解析）。
// 谁改动 useCompletions.js 的 computeFile 引用根分支，谁先红。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('BUG-009: @alias/ 引用根内补全保留别名前缀且不再静默归零', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-bug009-'));
  const dataHome = path.join(tmp, 'data');
  const proj = path.join(tmp, 'proj');
  const refRoot = path.join(tmp, 'refroot');
  fs.mkdirSync(path.join(refRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(refRoot, 'sub', 'a.txt'), 'x');
  fs.writeFileSync(path.join(refRoot, 'top.md'), 'x');
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  // 引用别名注册：alias `r` → refRoot（path 类型，绝对目标）
  fs.writeFileSync(
    path.join(dataHome, 'references.json'),
    JSON.stringify({ r: { path: refRoot, description: 'bug009 fixture' } }),
    'utf8'
  );

  const { computeFile } = require('../../../src/cli/tui/hooks/useCompletions');
  const refs = require('../../../src/services/referencesService');

  const prevCwd = process.cwd();
  const prevDataHome = process.env.KHY_DATA_HOME;
  process.env.KHY_DATA_HOME = dataHome;
  try {
    process.chdir(proj);
    refs._clearCache();
    // sanity：别名本身必须可解析，否则本测试的 fixture 无效
    assert.ok(refs.resolveMentionAbs('r', process.cwd()), 'fixture: alias r 应可解析');

    // partial='r/s'：refRoot 分支激活（别名 'r' + 引用根内子路径 's'）。
    // 修复前：map 回调命中未定义的 first → ReferenceError 被吞 → 返回 null。
    const out = computeFile('@r/s', 4);
    assert.ok(out, 'refRoot 内补全不得返回 null（返回 null 即被 first 归零）');
    assert.equal(out.kind, 'file');
    const values = out.items.map((it) => it.value);
    assert.ok(values.includes('@r/sub/'), '应列出引用根内目录且带 @r/ 前缀，实际: ' + values.join(','));
  } finally {
    process.chdir(prevCwd);
    if (prevDataHome === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = prevDataHome;
    refs._clearCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
