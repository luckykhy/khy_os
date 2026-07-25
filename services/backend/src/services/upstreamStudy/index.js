'use strict';

/**
 * upstreamStudy/index.js — 服务 facade:把一个开源项目更新压缩包「学进来」的编排层。
 *
 * 用户诉求(goal 2026-07-06「Khy 参考了大量开源项目, 这些项目更新时把压缩包给 khyos, 也能取其
 * 精华弃其糟粕进行学习更新」):此前 khy 无任何正规路径吃进「更新包」——弱模型只会手动解压、cat
 * 一堆随机文件 flail,极易走死循环。本 facade 提供**只读、有界**的正规替代:
 *
 *   1. 借 archiveInspectService **只列目录**(零解压、无 zip-slip、条目/尺寸有上限);
 *   2. 交纯叶子 upstreamStudyCatalog 甄别每个条目属**精华**还是**糟粕**、识别这像哪个已学过的项目;
 *   3. 可选:遍历用户给的**旧基线目录**(有界墙钟预算),算出「新增 / 改动 / 删除」;
 *   4. 按学习价值打分排序,取 Top-N 精华阅读清单;
 *   5. 交纯叶子 upstreamStudyReport 产 ASCII 报告。
 *
 * **只忠告不自动合并**:本层绝不写盘、不改 Khy 源码——它给出「该读哪些、忽略哪些、选择性移植」的
 * 策展清单,由模型/人据此取舍。自动合并上游代码有真风险(许可证 / 语义冲突 / 引入糟粕),刻意不做。
 *
 * 这不是纯叶子(要做 fs 遍历基线目录、依赖 archiveInspectService 的异步 I/O)——所有**决策**都下沉到
 * 两个纯叶子,本层只编排。全部依赖经 deps 注入(inspect / fsImpl / now),便于确定性测试。绝不抛。
 *
 * @module services/upstreamStudy
 */

const nodeFs = require('fs');
const nodePath = require('path');

const catalog = require('../upstreamStudyCatalog');
const report = require('../upstreamStudyReport');
const plan = require('../upstreamStudyPlan');
const { createWalkDeadline } = require('../../tools/_walkBudget');

const MAX_BASELINE_ENTRIES = 200000;   // 基线遍历硬上限(叠加墙钟预算),防超大树吃内存。

/** 归一路径分隔符为 '/',去首尾多余分隔。 */
function _norm(p) {
  return String(p || '').replace(/[\\]+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 计算所有条目共享的顶层目录名(压缩包常见 `Proj-main/…` 前缀)。无共享则返 ''。 */
function _commonTopDir(paths) {
  let top = null;
  for (const p of paths) {
    const norm = _norm(p);
    const idx = norm.indexOf('/');
    if (idx <= 0) return '';                 // 有条目在顶层无目录 → 无公共前缀可剥
    const first = norm.slice(0, idx);
    if (top === null) top = first;
    else if (top !== first) return '';
  }
  return top || '';
}

/** 剥掉公共顶层目录,得到用于与基线对齐的相对路径。 */
function _relOf(p, topDir) {
  const norm = _norm(p);
  if (topDir && (norm === topDir || norm.startsWith(topDir + '/'))) {
    return norm.slice(topDir.length + 1);
  }
  return norm;
}

/**
 * 有界遍历基线目录 → Map(相对路径 → size)。绝不抛;超预算/超上限 → truncated:true。
 * @returns {{ map: Map<string, number>, truncated: boolean }}
 */
function _walkBaseline(root, fsImpl, env, nowFn) {
  const map = new Map();
  let truncated = false;
  try {
    const fs = fsImpl || nodeFs;
    const deadline = createWalkDeadline(env, nowFn);
    const stack = [String(root || '')];
    let count = 0;
    while (stack.length) {
      if (deadline && deadline.exceeded()) { truncated = true; break; }
      if (count >= MAX_BASELINE_ENTRIES) { truncated = true; break; }
      const dir = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) {
        if (count >= MAX_BASELINE_ENTRIES) { truncated = true; break; }
        const name = ent && ent.name;
        if (!name || name === '.' || name === '..') continue;
        const full = nodePath.join(dir, name);
        let isDir = false;
        let isSymlink = false;
        try {
          if (typeof ent.isDirectory === 'function') { isDir = ent.isDirectory(); isSymlink = ent.isSymbolicLink && ent.isSymbolicLink(); }
        } catch { /* ignore */ }
        if (isSymlink) continue;             // 不跟 symlink(防环)
        if (isDir) { stack.push(full); continue; }
        let size = 0;
        try { const st = fs.lstatSync(full); size = Number(st && st.size) || 0; } catch { /* ignore */ }
        const rel = _norm(nodePath.relative(String(root || ''), full));
        if (rel) { map.set(rel, size); count += 1; }
      }
    }
  } catch { /* fail-soft: 返回已收集部分 */ }
  return { map, truncated };
}

/**
 * 学习一个更新压缩包。绝不抛;失败以 {success:false,error} 诚实上报。
 *
 * @param {object} opts
 *   opts.archive   {string}  压缩包路径(.zip / .tar / .tar.gz),必填。
 *   opts.baseline  {string=} 旧基线目录(已解压的上一版),给了就算新增/改动/删除。
 *   opts.top       {number=} 精华清单条目数(覆盖 KHY_UPSTREAM_STUDY_TOP)。
 *   opts.env       {object=} 环境(默认 process.env)。
 * @param {object} deps  注入:{ inspect, fsImpl, now }
 * @returns {Promise<object>}
 */
async function study(opts = {}, deps = {}) {
  const env = opts.env || process.env;
  try {
    const archive = String(opts.archive || '');
    if (!archive) return { success: false, error: '未提供压缩包路径(archive)' };

    const inspectFn = deps.inspect
      || require('../archiveInspectService').inspectArchive;
    const fsImpl = deps.fsImpl || nodeFs;
    const nowFn = typeof deps.now === 'function' ? deps.now : undefined;

    // 逐参覆盖 top(不污染全局 env,仅本次)。
    const runEnv = Object.assign({}, env);
    if (Number.isFinite(opts.top) && opts.top > 0) runEnv.KHY_UPSTREAM_STUDY_TOP = String(Math.floor(opts.top));

    // 1) 只读列目录。
    const inspected = await inspectFn(archive, opts.mimeType, { env: runEnv, name: opts.name });
    if (!inspected || inspected.success === false) {
      return {
        success: false,
        archive,
        error: (inspected && inspected.error) || '无法列出压缩包内容',
        skipped: !!(inspected && inspected.skipped),
      };
    }
    const rawEntries = Array.isArray(inspected.entries) ? inspected.entries : [];
    const entries = rawEntries
      .filter((e) => e && !e.isDirectory)
      .map((e) => ({ path: String(e.name || ''), size: Number(e.size) || 0 }))
      .filter((e) => e.path);

    // 2) 识别参考项目 + 逐条分类。
    const recognized = catalog.recognizeProject(entries, nodePath.basename(archive), runEnv);
    const topDir = _commonTopDir(entries.map((e) => e.path));

    // 3) 基线差异(可选)。
    let baselineMap = null;
    let diffTruncated = false;
    if (opts.baseline) {
      const walked = _walkBaseline(opts.baseline, fsImpl, runEnv, nowFn);
      baselineMap = walked.map;
      diffTruncated = walked.truncated;
    }

    const essenceAll = [];
    const drossBuckets = {};
    let essenceCount = 0;
    let drossCount = 0;
    let neutralCount = 0;
    const archiveRelSet = baselineMap ? new Set() : null;

    for (const e of entries) {
      const c = catalog.classifyEntry(e, runEnv);
      const rel = _relOf(e.path, topDir);
      if (archiveRelSet) archiveRelSet.add(rel);

      // 差异标记。
      let isNew = false;
      let isChanged = false;
      if (baselineMap) {
        if (!baselineMap.has(rel)) isNew = true;
        else if (Number(baselineMap.get(rel)) !== e.size) isChanged = true;
      }

      if (c.verdict === 'dross') {
        drossCount += 1;
        drossBuckets[c.bucket] = (drossBuckets[c.bucket] || 0) + 1;
      } else if (c.verdict === 'essence') {
        essenceCount += 1;
        const item = {
          path: e.path, size: e.size, bucket: c.bucket, reason: c.reason,
          tooLarge: !!c.tooLarge, isNew, isChanged,
        };
        item._score = catalog.scoreEssence(item, { isNew, isChanged }, runEnv);
        essenceAll.push(item);
      } else {
        neutralCount += 1;
      }
    }

    // 删除项(在基线、不在更新包)。
    let removed = [];
    if (baselineMap && archiveRelSet) {
      for (const rel of baselineMap.keys()) {
        if (!archiveRelSet.has(rel)) removed.push(rel);
        if (removed.length >= 200) break;      // 有界
      }
    }

    // 4) 排序取 Top-N。
    essenceAll.sort((a, b) => (b._score - a._score) || String(a.path).localeCompare(String(b.path)));
    const top = catalog.resolveTop(runEnv);
    const shortlist = essenceAll.slice(0, top).map((it) => {
      const { _score, ...rest } = it;   // eslint-disable-line no-unused-vars
      // 5) 逐项附「能改/不能改(portability)」与「先改/后改波次(wave)」——门关时叶子返空档/null,
      //    rest 保持原样(逐字节回退)。
      const port = plan.portabilityOf(rest, runEnv);
      if (port && port.verdict) { rest.portability = port.verdict; rest.portabilityReason = port.reason; }
      const w = plan.portWaveOf(rest, runEnv);
      if (w) { rest.wave = w.wave; rest.waveLabel = w.label; }
      return rest;
    });

    // 6) 汇成移植计划(能改的按波次分组、不能改的进 forbidden 桶)。门关 ⇒ null(不产 plan 字段)。
    const studyPlan = plan.buildStudyPlan(shortlist, runEnv);

    let diff = null;
    if (baselineMap) {
      // 精确计新增/改动(遍历全部条目,不只精华类;按剥前缀后的相对路径与基线比对)。
      let newC = 0;
      let chC = 0;
      for (const e of entries) {
        const rel = _relOf(e.path, topDir);
        if (!baselineMap.has(rel)) newC += 1;
        else if (Number(baselineMap.get(rel)) !== e.size) chC += 1;
      }
      diff = {
        newCount: newC,
        changedCount: chC,
        removedCount: removed.length,
        removed,
        note: diffTruncated ? '基线遍历达上限/超预算, 差异为部分视图。' : '',
      };
    }

    const truncated = !!inspected.truncated || diffTruncated;
    const totals = {
      files: entries.length,
      essence: essenceCount,
      dross: drossCount,
      neutral: neutralCount,
    };

    const result = {
      success: true,
      archive,
      format: inspected.kindToken || '',
      recognized,
      totals,
      essence: shortlist,
      essenceTotal: essenceCount,
      dross: { buckets: drossBuckets },
      drossTotal: drossCount,
      diff,
      truncated,
    };
    if (studyPlan) result.plan = studyPlan;
    result.report = report.renderStudyReport(result, runEnv);
    return result;
  } catch (err) {
    return { success: false, archive: String(opts.archive || ''), error: `学习失败: ${(err && err.message) || 'unknown'}` };
  }
}

module.exports = { study, _commonTopDir, _relOf, _walkBaseline };
