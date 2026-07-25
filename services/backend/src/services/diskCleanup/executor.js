'use strict';

/**
 * diskCleanup/executor.js — 唯一执行删除的模块（dry-run 默认 + TOCTOU 重检 + 锁重试）。
 *
 * 安全四原则：
 *   1. dry-run 默认：不传 apply:true 就只演练，绝不动磁盘。
 *   2. TOCTOU 重检：删每一项「之前的最后一刻」再过一次 protectedGuard.assertSafeToDelete
 *      （含用户数据信号扫描），堵住「扫描→执行」之间状态变化的竞态。
 *   3. 只清内容不删根：清空目录里的条目，但保留目录本身（应用下次启动即可重建缓存）。
 *   4. 逐项 fail-soft：单项删除失败（权限/占用）不影响其余；Windows 文件锁经 retryOnBusy 重试。
 *
 * 符号链接只删链接、绝不跟随。
 */

const path = require('path');
const catalog = require('./junkCatalog');
const guard = require('./protectedGuard');

let _platformUtils = null;
function platformUtils() {
  if (!_platformUtils) _platformUtils = require('../../tools/platformUtils');
  return _platformUtils;
}

/** 删除单个条目（文件/符号链接/子目录树），fail-soft 计量。 */
async function _removePath(full, deps, acc) {
  const fsImpl = deps.fsImpl;
  let st;
  try { st = fsImpl.lstatSync(full); } catch { return; }

  const doRemove = async () => {
    if (st.isDirectory()) {
      // rmSync recursive；不跟随符号链接（lstat 已区分，目录内链接由 rm 按链接删）。
      if (fsImpl.rmSync) {
        fsImpl.rmSync(full, { recursive: true, force: true });
      } else {
        fsImpl.rmdirSync(full, { recursive: true });
      }
    } else {
      fsImpl.unlinkSync(full);
    }
  };

  try {
    const sizeBefore = _safeSize(full, st, deps);
    await platformUtils().retryOnBusyAsync(doRemove);
    acc.freedBytes += sizeBefore;
    acc.removedItems += 1;
  } catch (err) {
    acc.failures.push({ path: full, error: err && err.code ? err.code : String(err && err.message) });
  }
}

function _safeSize(full, st, deps) {
  try {
    if (st.isFile()) return st.size || 0;
    if (st.isDirectory()) {
      // 复用 scanner.measure 太重；这里小递归量一次（删前体积）。
      return _treeSize(full, deps, 0);
    }
  } catch { /* ignore */ }
  return 0;
}
function _treeSize(dir, deps, depth) {
  if (depth > catalog.thresholds.maxScanDepth) return 0;
  let total = 0;
  let entries;
  try { entries = deps.fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let st;
    try { st = deps.fsImpl.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) total += _treeSize(full, deps, depth + 1);
    else if (st.isFile()) total += st.size || 0;
  }
  return total;
}

/**
 * 清空一个候选目录的内容（保留目录本身）。
 * @returns {{ freedBytes, removedItems, failures }}
 */
async function _cleanDirContents(dir, deps) {
  const acc = { freedBytes: 0, removedItems: 0, failures: [] };
  let entries;
  try { entries = deps.fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    await _removePath(full, deps, acc);
  }
  return acc;
}

/**
 * 执行清理计划。
 * @param {object} plan - planner.buildPlan() 返回
 * @param {object} [opts] - {apply:boolean, deps}
 * @returns {object} report
 */
async function execute(plan, opts = {}) {
  const deps = opts.deps || catalog.defaultDeps();
  const apply = opts.apply === true;

  const items = [];
  let totalFreed = 0;
  let totalRemoved = 0;
  const allFailures = [];

  for (const cand of plan.selected) {
    const entry = {
      id: cand.id,
      label: cand.label,
      path: cand.path,
      category: cand.category,
      plannedBytes: cand.sizeBytes || 0,
      freedBytes: 0,
      removedItems: 0,
      status: 'dry-run',
      failures: [],
    };

    // TOCTOU 重检：执行前最后一刻再否决一次（含用户数据信号）。
    try {
      guard.assertSafeToDelete(cand.path, deps, { checkUserData: true });
    } catch (err) {
      entry.status = 'vetoed';
      entry.vetoReason = err && err.message;
      items.push(entry);
      continue;
    }

    if (!apply) {
      entry.status = 'dry-run';
      items.push(entry);
      continue;
    }

    const acc = await _cleanDirContents(cand.path, deps);
    entry.freedBytes = acc.freedBytes;
    entry.removedItems = acc.removedItems;
    entry.failures = acc.failures;
    entry.status = acc.failures.length ? (acc.removedItems ? 'partial' : 'failed') : 'cleaned';
    totalFreed += acc.freedBytes;
    totalRemoved += acc.removedItems;
    if (acc.failures.length) allFailures.push(...acc.failures.map((f) => ({ ...f, candidate: cand.id })));
    items.push(entry);
  }

  return {
    applied: apply,
    items,
    totals: {
      plannedBytes: plan.totals.selectedBytes,
      plannedHuman: plan.totals.selectedHuman,
      freedBytes: totalFreed,
      freedHuman: require('./planner')._humanBytes(totalFreed),
      removedItems: totalRemoved,
      vetoedCount: items.filter((i) => i.status === 'vetoed').length,
      failureCount: allFailures.length,
    },
    failures: allFailures,
  };
}

module.exports = { execute, _cleanDirContents, _treeSize };
