#!/usr/bin/env node
'use strict';

/**
 * repair-portable.js — 便携版一键聚合修复（`khy repair` 的实现）。
 *
 * 流程：
 *   1. 复用 scripts/portable-health-check.js 的全部探针
 *   2. 对 FAIL 项执行修复：
 *      - 断链 junction/symlink → 重命名移开残骸后按相对目标重建（junction 兜底）
 *      - 数据指针失配        → 按当前便携根重新校准（写回 dataHome 指针）
 *      - SQLite 驱动失败      → 无法自动修复，输出明确修复指引
 *   3. 复跑健康检查验证，输出修复报告；退出码 0=健康，1=仍有问题
 */

const fs = require('fs');
const path = require('path');
const hc = require('./portable-health-check');

const ROOT = hc.ROOT;

function _log(msg) { console.log(msg); }

function _loadDataHome() {
  try {
    return require(path.join(ROOT, 'services', 'backend', 'src', 'utils', 'dataHome.js'));
  } catch { return null; }
}

/** 把旧链接/残骸移开（删除可能被环境拦截，失败时用重命名替代）。 */
function _moveAside(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { try { fs.unlinkSync(p); return true; } catch { /* fall through */ } }
  } catch { return true; /* 本就不存在 */ }
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { /* fall through */ }
  try { fs.renameSync(p, `${p}.broken-${Date.now()}`); return true; } catch { return false; }
}

/** 重建单条链接：优先相对目标 symlink（可随整目录迁移），失败回退 junction。 */
function fixLink(issue) {
  const { linkPath, target, label } = issue;
  if (!fs.existsSync(target)) {
    return { ok: false, item: label, detail: `目标不存在，无法重建: ${target}` };
  }
  if (!_moveAside(linkPath)) {
    return { ok: false, item: label, detail: `无法移除残骸: ${linkPath}` };
  }
  try { fs.mkdirSync(path.dirname(linkPath), { recursive: true }); } catch { /* ignore */ }
  const relTarget = path.relative(path.dirname(linkPath), target);
  try {
    fs.symlinkSync(relTarget, linkPath, 'dir');
    return { ok: true, item: label, detail: `已重建 symlink → ${relTarget}` };
  } catch {
    try {
      // Windows 无 symlink 权限时回退 junction（junction 目标必须为绝对路径）
      fs.symlinkSync(target, linkPath, 'junction');
      return { ok: true, item: label, detail: `已重建 junction → ${target}` };
    } catch (err) {
      return { ok: false, item: label, detail: `重建失败: ${err && err.message ? err.message : err}` };
    }
  }
}

/** 校准数据指针：读取（dataHome 已内置相对化还原+尾部重定位自愈）后仍缺失的项按便携根兜底。 */
function fixPointer(issue) {
  const results = [];
  const dh = _loadDataHome();
  if (!dh) {
    return [{ ok: false, item: '数据指针', detail: '无法加载 dataHome.js，跳过校准' }];
  }
  let pointer = null;
  try { pointer = dh._readPointer(); } catch { pointer = null; }
  if (!pointer) {
    // 指针损坏/缺失：不强行新建（首启会自动生成），只报告。
    return [{ ok: true, item: '数据指针', detail: '指针缺失或损坏，首启将自动重建，无需手动修复' }];
  }
  for (const m of issue.missing || []) {
    const current = pointer[m.key];
    if (typeof current === 'string' && fs.existsSync(current)) {
      // _readPointer 的相对化/尾部重定位自愈已解决 → 把修好的值固化写回。
      const patch = m.key === 'projectDataHome'
        ? { projectDataHome: current, projectSource: 'repair', projectPinnedReason: 'repair-recalibrate' }
        : { dataHome: current, source: 'repair', pinnedReason: 'repair-recalibrate' };
      dh._writePointer(patch);
      results.push({ ok: true, item: `指针 ${m.key}`, detail: `已校准 → ${current}` });
      continue;
    }
    if (m.key === 'projectDataHome') {
      // 项目数据家随便携目录走：兜底指回当前便携根下的 .khy。
      const fallback = path.join(ROOT, '.khy');
      try {
        fs.mkdirSync(fallback, { recursive: true });
        dh._writePointer({ projectDataHome: fallback, projectSource: 'repair', projectPinnedReason: 'repair-recalibrate' });
        results.push({ ok: true, item: '指针 projectDataHome', detail: `已校准 → ${fallback}` });
      } catch (err) {
        results.push({ ok: false, item: '指针 projectDataHome', detail: `校准失败: ${err && err.message ? err.message : err}` });
      }
    } else {
      // dataHome 可能位于未挂载的可移动盘：绝不自动改写（重新挂载即恢复）。
      results.push({
        ok: false, item: `指针 ${m.key}`,
        detail: `目标 ${m.target} 不可达且无法按便携根重定位（可能是可移动盘未挂载），不自动改写`,
      });
    }
  }
  return results;
}

async function main() {
  _log('══ khy 便携版一键修复 ══');
  _log(`便携根: ${ROOT}`);
  _log('');
  const before = await hc.runHealthCheck();
  const failures = before.issues.filter(i => !i.ok);

  if (failures.length === 0) {
    hc.printReport(before);
    _log('健康状态良好，无需修复。');
    process.exit(0);
  }

  _log(`发现 ${failures.length} 个问题，开始修复：`);
  const report = [];
  for (const issue of failures) {
    if (issue.kind === 'link') {
      report.push(fixLink(issue));
    } else if (issue.kind === 'pointer') {
      report.push(...fixPointer(issue));
    } else if (issue.kind === 'sqlite') {
      report.push({
        ok: false, item: issue.label,
        detail: `无法自动修复（需人工执行）。${issue.fix || hc.SQLITE_FIXES.join('；')}`,
      });
    } else {
      report.push({ ok: false, item: issue.label, detail: `未知问题类型，无自动修复方案：${issue.detail}` });
    }
  }

  _log('');
  _log('── 修复报告 ──');
  for (const r of report) {
    _log(`[${r.ok ? 'FIXED' : 'MANUAL'}] ${r.item} — ${r.detail}`);
  }

  _log('');
  _log('── 复检 ──');
  const after = await hc.runHealthCheck();
  hc.printReport(after);
  process.exit(after.ok ? 0 : 1);
}

module.exports = { fixLink, fixPointer, main };

if (require.main === module) {
  main().catch(err => {
    console.error(`修复流程自身异常: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
