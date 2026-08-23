'use strict';

/**
 * vendor/shared 的「回退锚点」契约。
 *
 * platform/packages/shared 在仓库里位于根下五层，它回退到后端的 require 因此写作
 * `../../../../../services/backend/...`。prepack 把这棵树整份拷进
 * services/backend/vendor/shared —— 那里只剩四层，且下面根本没有 services/backend
 * 这一段。逐字拷贝的结果是安装后解析到 node_modules/services/backend/…，一个永不
 * 存在的路径：sqlite 方言链因此丢掉最后一级回退，在**首次查询**而不是安装时才炸，
 * 所以历史上没人发现。prepack.js 的 rewriteBackendFallbacks() 负责重锚。
 *
 * 这里断言的是结果而不是过程：无论 vendor/shared 是 prepack 现拷的还是仓库里
 * 跟踪的那份，都不许残留五层锚点，且回退目标必须真实存在。
 */

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const VENDOR_SHARED = path.join(BACKEND_DIR, 'vendor', 'shared');
const SOURCE_SHARED = path.resolve(BACKEND_DIR, '..', '..', 'platform', 'packages', 'shared');
const STALE_ANCHOR = '../../../../../services/backend/';

/** 递归收集一棵树里的 .js（跳过 node_modules，那不是我们拷进去的）。 */
function collectJs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(abs, out);
    else if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

/** 从一个文件里抓出所有 require('<相对路径>') 的相对路径。 */
function relativeRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = [];
  const re = /require\(\s*'(\.[^']*)'\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) found.push(m[1]);
  return found;
}

describe('vendor/shared 回退锚点', () => {
  test('拷贝源里确实存在五层锚点（本契约的前提，没了就该重新校对 prepack）', () => {
    const hits = collectJs(SOURCE_SHARED).filter((f) =>
      fs.readFileSync(f, 'utf8').includes(STALE_ANCHOR));
    expect(hits.length).toBeGreaterThan(0);
  });

  test('vendor/shared 里不残留任何五层锚点', () => {
    const offenders = collectJs(VENDOR_SHARED)
      .filter((f) => fs.readFileSync(f, 'utf8').includes(STALE_ANCHOR))
      .map((f) => path.relative(VENDOR_SHARED, f));
    expect(offenders).toEqual([]);
  });

  test('vendor/shared 里指向后端的相对 require 都能落到真实文件', () => {
    const missing = [];
    for (const file of collectJs(VENDOR_SHARED)) {
      for (const rel of relativeRequires(file)) {
        // 只查上溯出 vendor/shared 的那些：包内相对引用由包自己保证。
        if (!rel.startsWith('../../../')) continue;
        const target = path.resolve(path.dirname(file), rel);
        const ok = ['', '.js', '.json', '/index.js'].some((ext) => fs.existsSync(target + ext));
        if (!ok) missing.push(`${path.relative(VENDOR_SHARED, file)} → ${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
