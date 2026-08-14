#!/usr/bin/env node
'use strict';

/**
 * portable-health-check.js — 便携版启动自检（可独立运行 / 可被 require）。
 *
 * 背景：better-sqlite3 原生模块段错误会直接杀死进程且无任何输出（静默死亡）。
 * 本脚本把危险探测放进子进程隔离执行，主进程永远能给出人类可读的结论。
 *
 * 探针：
 *   1. SQLite 驱动    — 子进程加载 sqlite-adapter 并对 :memory: 跑一条 SQL
 *   2. 数据目录指针    — ~/.khy/.location.json（或 KHY_LOCATION_FILE）指向是否存在
 *   3. junction/symlink — 已知链接（vendor/shared、node_modules/@khy/shared 等）是否断链
 *
 * 用法：
 *   node scripts/portable-health-check.js            # 退出码 0=全部 PASS，1=有 FAIL
 *   const { runHealthCheck } = require('./portable-health-check');
 *   const { ok, issues } = await runHealthCheck();
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_PATH = path.join(
  ROOT, 'platform', 'packages', 'shared', 'src', 'config', 'sqlite-adapter.js'
);

const SQLITE_FIXES = [
  '优先：使用 Node.js >= 23.4（内置 node:sqlite，无需编译原生模块）',
  '或：在项目根用与运行时相同的 Node 版本执行 `npm rebuild better-sqlite3`',
];

// ── 探针 1：SQLite 驱动（子进程隔离，防段错误杀死主进程）─────────────────

function probeSqliteDriver(options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const adapterPath = options.adapterPath || ADAPTER_PATH;
  const result = {
    kind: 'sqlite', label: 'SQLite 驱动', ok: false,
    detail: '', fix: '', fixable: false, driver: '',
  };
  if (!fs.existsSync(adapterPath)) {
    result.detail = `适配器文件缺失: ${adapterPath}`;
    result.fix = '重新同步 platform/packages/shared（安装包可能不完整）';
    return result;
  }
  const script = [
    `const A = require(${JSON.stringify(adapterPath)});`,
    'const Database = A.Database || A;',
    "const db = new Database(':memory:');",
    "db.exec('CREATE TABLE probe_t(v INTEGER)');",
    "db.prepare('INSERT INTO probe_t (v) VALUES (?)').run(42);",
    "const row = db.prepare('SELECT SUM(v) AS s FROM probe_t').get();",
    "if (!row || Number(row.s) !== 42) throw new Error('SQL roundtrip mismatch');",
    'db.close();',
    "process.stdout.write('KHY_SQLITE_OK:' + ((A.__driverInfo && A.__driverInfo.type) || 'unknown'));",
  ].join('\n');
  let child;
  try {
    child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    });
  } catch (err) {
    result.detail = `探针派生失败: ${err && err.message ? err.message : err}`;
    result.probeError = true; // 探针自身异常，不代表驱动损坏
    return result;
  }
  const stdout = String(child.stdout || '');
  const match = stdout.match(/KHY_SQLITE_OK:(\S+)/);
  if (match) {
    result.ok = true;
    result.driver = match[1];
    result.detail = `驱动 ${result.driver} 可用（子进程 :memory: SQL 往返成功）`;
    return result;
  }
  const stderrTail = String(child.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ');
  if (child.error && child.error.code === 'ETIMEDOUT') {
    result.detail = `子进程探针超时（>${timeoutMs}ms）`;
  } else if (child.signal) {
    result.detail = `子进程被信号终止（${child.signal}），疑似原生模块段错误`;
  } else {
    result.detail = `子进程退出码 ${child.status}${stderrTail ? `；stderr: ${stderrTail}` : ''}`;
  }
  result.fix = SQLITE_FIXES.join('；');
  return result;
}

// ── 探针 2：数据目录指针 ─────────────────────────────────────────────────

function _loadDataHomeModule() {
  try {
    return require(path.join(ROOT, 'services', 'backend', 'src', 'utils', 'dataHome.js'));
  } catch { return null; }
}

function probeDataPointer() {
  const result = {
    kind: 'pointer', label: '数据目录指针', ok: false,
    detail: '', fix: '', fixable: false, pointerFile: '', missing: [],
  };
  const mod = _loadDataHomeModule();
  const pointerFile = mod
    ? mod._pointerFile()
    : (process.env.KHY_LOCATION_FILE
      ? path.resolve(process.env.KHY_LOCATION_FILE)
      : path.join(os.homedir(), '.khy', '.location.json'));
  result.pointerFile = pointerFile;
  if (!fs.existsSync(pointerFile)) {
    result.ok = true;
    result.detail = `指针文件尚未创建（${pointerFile}），首启后自动生成，无需修复`;
    return result;
  }
  let pointer = null;
  try {
    pointer = mod ? mod._readPointer()
      : JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  } catch (err) {
    result.detail = `指针文件损坏（${pointerFile}）: ${err && err.message ? err.message : err}`;
    result.fix = '运行 `node scripts/repair-portable.js` 重建指针，或删除该文件后重启 khy';
    result.fixable = true;
    return result;
  }
  const missing = [];
  for (const key of ['dataHome', 'projectDataHome']) {
    const target = pointer && pointer[key];
    if (typeof target === 'string' && target && !fs.existsSync(target)) {
      missing.push({ key, target });
    }
  }
  if (missing.length === 0) {
    const homes = ['dataHome', 'projectDataHome']
      .filter(k => pointer && pointer[k]).map(k => `${k}=${pointer[k]}`).join('，');
    result.ok = true;
    result.detail = homes ? `指针目标全部存在（${homes}）` : '指针文件存在但未记录数据家（合法状态）';
    return result;
  }
  result.missing = missing;
  result.detail = missing.map(m => `${m.key} 指向不存在的路径 ${m.target}`).join('；');
  result.fix = '运行 `node scripts/repair-portable.js` 按当前便携根重新校准指针（整目录迁移后常见）';
  result.fixable = true;
  return result;
}

// ── 探针 3：junction / symlink ───────────────────────────────────────────

/** 已知链接清单（与 scripts/link-shared-dev.js、dataHome._ensureVisibleAlias 对齐）。 */
function getKnownLinks() {
  const links = [
    {
      label: 'services/backend/vendor/shared',
      linkPath: path.join(ROOT, 'services', 'backend', 'vendor', 'shared'),
      target: path.join(ROOT, 'platform', 'packages', 'shared'),
      optional: false,
    },
    {
      label: 'services/backend/node_modules/@khy/shared',
      linkPath: path.join(ROOT, 'services', 'backend', 'node_modules', '@khy', 'shared'),
      target: path.join(ROOT, 'services', 'backend', 'vendor', 'shared'),
      optional: true, // npm 布局差异下可能不存在
    },
    {
      label: 'node_modules/@khy/shared',
      linkPath: path.join(ROOT, 'node_modules', '@khy', 'shared'),
      target: path.join(ROOT, 'platform', 'packages', 'shared'),
      optional: true, // hoisted 布局才有
    },
  ];
  // khy-Trajectory 可见别名（junction，指向项目数据家）
  const mod = _loadDataHomeModule();
  let trajectoryTarget = path.join(ROOT, '.khy');
  try {
    const pointer = mod && mod._readPointer();
    if (pointer && pointer.projectDataHome) trajectoryTarget = pointer.projectDataHome;
  } catch { /* 保持默认 */ }
  links.push({
    label: 'khy-Trajectory（可见别名）',
    linkPath: path.join(ROOT, 'khy-Trajectory'),
    target: trajectoryTarget,
    optional: true, // 首启时自动重建，缺失不算故障
  });
  return links;
}

function probeSingleLink(link) {
  const result = {
    kind: 'link', label: link.label, ok: false, detail: '', fix: '',
    fixable: true, linkPath: link.linkPath, target: link.target, status: '',
  };
  let st = null;
  try { st = fs.lstatSync(link.linkPath); } catch { /* missing */ }
  if (!st) {
    if (link.optional) {
      result.ok = true;
      result.status = 'absent-optional';
      result.detail = '不存在（该布局下为可选链接，跳过）';
      return result;
    }
    result.status = 'missing';
    result.detail = `链接缺失: ${link.linkPath}`;
    result.fix = '运行 `node scripts/repair-portable.js` 重建（相对目标 symlink/junction）';
    return result;
  }
  if (!st.isSymbolicLink()) {
    result.ok = true;
    result.status = 'real-copy';
    result.detail = '实体目录（发布包为真实拷贝，健康）';
    return result;
  }
  try {
    const real = fs.realpathSync(link.linkPath);
    result.ok = true;
    result.status = 'linked';
    result.detail = `链接有效 → ${real}`;
    return result;
  } catch (err) {
    result.status = 'broken';
    result.detail = `断链（目标不可达: ${err && err.code ? err.code : err}）`;
    result.fix = '运行 `node scripts/repair-portable.js` 重建断链（整目录迁移后常见）';
    return result;
  }
}

function probeLinks() {
  return getKnownLinks().map(probeSingleLink);
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

/**
 * 运行全部探针。
 * @returns {Promise<{ok: boolean, issues: Array<object>}>} issues 为全部探针结果
 */
async function runHealthCheck(options = {}) {
  const issues = [];
  issues.push(probeSqliteDriver(options));
  issues.push(probeDataPointer());
  for (const linkResult of probeLinks()) issues.push(linkResult);
  const ok = issues.every(i => i.ok);
  return { ok, issues };
}

function printReport(report) {
  for (const item of report.issues) {
    const tag = item.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${item.label} — ${item.detail}`);
    if (!item.ok && item.fix) console.log(`       修复指引: ${item.fix}`);
  }
  console.log('');
  console.log(report.ok
    ? '健康检查全部通过。'
    : '发现问题：可运行 `node scripts/repair-portable.js` 一键修复可修复项。');
}

async function main() {
  const report = await runHealthCheck();
  printReport(report);
  process.exit(report.ok ? 0 : 1);
}

module.exports = {
  ROOT,
  ADAPTER_PATH,
  SQLITE_FIXES,
  runHealthCheck,
  probeSqliteDriver,
  probeDataPointer,
  probeLinks,
  getKnownLinks,
  printReport,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`[FAIL] 健康检查自身异常: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
