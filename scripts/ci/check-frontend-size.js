#!/usr/bin/env node
/**
 * 前端产物体积门禁（零依赖）。
 *
 *   node scripts/ci/check-frontend-size.js                 # 报告态：只打表，永远 exit 0
 *   node scripts/ci/check-frontend-size.js --strict        # 超过容差则 exit 1
 *   node scripts/ci/check-frontend-size.js --update        # 用当前产物重写基线
 *   node scripts/ci/check-frontend-size.js --app apps/ai-frontend   # 只查一个应用
 *
 * 为什么需要它：`apps/ai-frontend/dist` 目前 13.12 MB，其中 10.52 MB 是
 * `public/vendor/khyos-muya.{js,css}` 这一对静态文件（直接拷贝，不过 Rollup）。
 * 也就是说**八成体积不由应用代码决定**。如果把两者混在一个数字里比，应用代码
 * 涨 30% 也只体现为总量涨 6%，门禁形同虚设。因此本脚本把两者**分开计量**：
 *
 *   - appAssetsBytes  = dist 内**不在** vendor/ 目录下的文件（Rollup 产物，日常 PR 会动）
 *   - vendorBytes     = dist/**\/vendor/** 下的文件（静态拷贝，只在换版本时动）
 *
 * 只对 appAssetsBytes 施加容差；vendorBytes 变化单独提示，因为它一变就是几 MB，
 * 用百分比容差没有意义。
 *
 * 基线文件：scripts/ci/frontend-size-baseline.json（人可读、可 review、进版本库）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(__dirname, 'frontend-size-baseline.json');

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const update = argv.includes('--update');
const onlyApp = (() => {
  const flag = argv.find((a) => a.startsWith('--app='));
  if (flag) return flag.slice('--app='.length);
  const idx = argv.indexOf('--app');
  return idx >= 0 ? argv[idx + 1] : null;
})();

const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.isFile()) acc.push([p, fs.statSync(p).size]);
  }
  return acc;
}

/** 度量一个 dist 目录，返回 { appAssetsBytes, vendorBytes, fileCount, byExt }。 */
function measure(distDir) {
  const files = walk(distDir, []);
  const isVendor = ([p]) => toPosix(p).includes('/vendor/');
  const sum = (list) => list.reduce((s, [, n]) => s + n, 0);
  const app = files.filter((f) => !isVendor(f));
  const vendor = files.filter(isVendor);
  const byExt = {};
  for (const [p, n] of app) {
    const ext = path.extname(p) || '(none)';
    byExt[ext] = (byExt[ext] || 0) + n;
  }
  return {
    appAssetsBytes: sum(app),
    vendorBytes: sum(vendor),
    fileCount: files.length,
    byExt,
  };
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const signed = (n) => (n >= 0 ? '+' : '') + n;
const pct = (cur, base) => (base === 0 ? 0 : ((cur - base) / base) * 100);

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`[size] 基线文件不存在：${toPosix(path.relative(ROOT, BASELINE_PATH))}`);
    console.error('[size] 先构建产物，再执行：node scripts/ci/check-frontend-size.js --update');
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

const baseline = loadBaseline();
const tolerance = Number(baseline.tolerancePct);
if (!Number.isFinite(tolerance) || tolerance <= 0) {
  console.error('[size] 基线文件的 tolerancePct 必须是正数');
  process.exit(2);
}

let appNames = Object.keys(baseline.apps || {});
if (onlyApp) {
  if (!appNames.includes(onlyApp)) {
    console.error(`[size] 基线中没有应用 "${onlyApp}"。已登记：${appNames.join(', ')}`);
    process.exit(2);
  }
  appNames = [onlyApp];
}

let exceeded = 0;
let missing = 0;
const updated = { ...(baseline.apps || {}) };

console.log(`[size] 容差：应用产物 ≤ +${tolerance}%（vendor 静态拷贝单独提示，不计容差）`);
console.log('');

for (const name of appNames) {
  const entry = baseline.apps[name];
  const distDir = path.join(ROOT, name, entry.dist || 'dist');
  const rel = toPosix(path.relative(ROOT, distDir));

  if (!fs.existsSync(distDir)) {
    // 产物缺失不等于体积没变 —— 只能说明没构建。不能静默当作通过。
    console.log(`[size] ${name}: 产物目录不存在（${rel}），跳过。请先 npm run build --prefix ${name}`);
    missing += 1;
    continue;
  }

  const cur = measure(distDir);
  const baseApp = Number(entry.appAssetsBytes) || 0;
  const baseVendor = Number(entry.vendorBytes) || 0;
  const dApp = cur.appAssetsBytes - baseApp;
  const dAppPct = pct(cur.appAssetsBytes, baseApp);
  const dVendor = cur.vendorBytes - baseVendor;

  console.log(`${name}`);
  console.log(
    `  应用产物  基线 ${mb(baseApp)} → 当前 ${mb(cur.appAssetsBytes)}` +
      `  (${signed(dApp)} B, ${signed(dAppPct.toFixed(2))}%)`
  );
  console.log(
    `  vendor    基线 ${mb(baseVendor)} → 当前 ${mb(cur.vendorBytes)}  (${signed(dVendor)} B)`
  );
  console.log(
    '  分类      ' +
      Object.entries(cur.byExt)
        .sort((a, b) => b[1] - a[1])
        .map(([e, n]) => `${e}=${kb(n)}`)
        .join(', ')
  );

  if (dAppPct > tolerance) {
    console.log(
      `  ⚠ 应用产物增长 ${dAppPct.toFixed(2)}% 超过容差 ${tolerance}%。` +
        '请在 PR 描述里说明原因与取舍；确认可接受则用 --update 更新基线。'
    );
    exceeded += 1;
  }
  if (dVendor !== 0) {
    console.log(`  ⚠ vendor 体积变化 ${signed(dVendor)} B —— 静态依赖被换过，请在 PR 中说明。`);
  }
  console.log('');

  updated[name] = {
    ...entry,
    appAssetsBytes: cur.appAssetsBytes,
    vendorBytes: cur.vendorBytes,
    fileCount: cur.fileCount,
  };
}

if (update) {
  const next = {
    ...baseline,
    measuredAt: new Date().toISOString().slice(0, 10),
    apps: updated,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`[size] 已更新基线：${toPosix(path.relative(ROOT, BASELINE_PATH))}`);
  process.exit(0);
}

if (missing > 0 && appNames.length === missing) {
  console.error('[size] 所有登记应用的产物都不存在 —— 没有任何东西被实际度量。');
  process.exit(2);
}

if (exceeded > 0) {
  console.log(`[size] ${exceeded} 个应用超出容差。`);
  process.exit(strict ? 1 : 0);
}

console.log('[size] 全部在容差内。');
process.exit(0);
