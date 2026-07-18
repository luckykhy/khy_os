'use strict';

/**
 * upstreamStudyReport.js — 纯叶子:把 UpstreamStudy 引擎的结构化结果渲染成 ASCII 学习报告框。
 *
 * 仿 diskAnalyzeReport 的盒式风格,给弱模型/用户一份「一眼能读」的更新包学习摘要:
 * 识别到的参考项目、精华阅读清单(Top-N,带 NEW/CHANGED 标记)、糟粕拒绝桶(按类计数)、
 * 相对旧基线的新增/改动/删除、以及**下一步该读哪些、注意别自动合并**的引导。
 *
 * 契约:零 I/O(纯字符串拼装,不碰 fs/网络/子进程)、确定性(无时钟/随机;输入已定序则输出定序)、
 * 绝不抛(fail-soft 返回退化串)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_UPSTREAM_STUDY_REPORT  默认 on —— 关 ⇒ 返回最小单行 legacy 串(逐字节回退,不产盒式报告)。
 *
 * @module services/upstreamStudyReport
 */

const WIDTH = 66;                       // 盒内文本可视宽度(不含左右边框)

const _isEnabled = require('../utils/isEnabledDefaultOn');

function isReportEnabled(env) {
  return _isEnabled('KHY_UPSTREAM_STUDY_REPORT', env);
}

// 字节 → 人类可读(带空格、到 TB)收敛到单一真源 byteFormat.humanBytes
// (与 diskAnalyzeReport / diskCleanup/planner 同口径,逐字节等价)。
const { humanBytes: _humanBytes } = require('./byteFormat');

// 盒式行/分隔线基元收敛到单一真源 asciiBox(宽度参数化;本地 _row/_rule 传 WIDTH)。
const { boxRow: _boxRow, boxRule: _boxRule } = require('./asciiBox');

function _ellipsize(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  if (max <= 1) return str.slice(0, max);
  return '…' + str.slice(str.length - (max - 1));   // 尾部保留(路径尾更有辨识度)
}

function _row(text) {
  return _boxRow(text, WIDTH);
}

function _rule(label) {
  return _boxRule(label, WIDTH);
}

function _legacy(result) {
  try {
    const r = result || {};
    const ess = Array.isArray(r.essence) ? r.essence.length : 0;
    const dross = r.drossTotal != null ? Number(r.drossTotal) : 0;
    return `更新包学习: 精华候选 ${ess} · 糟粕 ${dross} 项已过滤`;
  } catch {
    return '更新包学习: (无结果)';
  }
}

function _tag(item) {
  if (item && item.isChanged) return '[改]';
  if (item && item.isNew) return '[新]';
  return '';
}

// 移植安全性标记:caution=谨慎(不能整段覆盖)/ safe=可改(择优移植)。
function _portTag(p) {
  if (p === 'caution') return '⚠改';
  if (p === 'safe') return '可改';
  return '';
}

/**
 * 渲染「移植计划」段:先改→后改波次(每波内标能改/谨慎)+ 不能改清单。plan 缺失则整段跳过。
 * 直接 push 进 lines(复用外层 _row/_rule);绝不抛。
 */
function _renderPlan(lines, plan) {
  try {
    if (!plan || typeof plan !== 'object') return;
    const waves = Array.isArray(plan.waves) ? plan.waves : [];
    const forbidden = Array.isArray(plan.forbidden) ? plan.forbidden : [];
    if (!waves.length && !forbidden.length) return;

    lines.push(_rule('移植计划 · 先改→后改'));
    for (const w of waves) {
      const items = Array.isArray(w.items) ? w.items : [];
      if (!items.length) continue;
      lines.push(_row(`${Number(w.wave)}) ${_ellipsize(String(w.label || ''), WIDTH - 3)}`));
      for (const it of items) {
        const pt = _portTag(it && it.portability);
        const head = pt ? `${pt} ` : '';
        const path = _ellipsize(String((it && it.path) || ''), WIDTH - head.length - 4);
        lines.push(_row(`   ${head}${path}`));
      }
    }
    if (forbidden.length) {
      lines.push(_rule('不能改 · 勿移植'));
      for (const it of forbidden.slice(0, 8)) {
        const path = _ellipsize(String((it && it.path) || ''), WIDTH - 4);
        lines.push(_row(`  ✗ ${path}`));
      }
      // 给出典型缘由(取首条 reason,避免逐条刷屏)。
      const why = forbidden[0] && forbidden[0].reason;
      if (why) lines.push(_row(`    ${_ellipsize(String(why), WIDTH - 4)}`));
    }
  } catch { /* fail-soft: 计划段可省,不影响其余报告 */ }
}

/**
 * 渲染更新包学习报告。门控关/异常 → 最小 legacy 串。绝不抛。
 * @param {object} result study() 的返回:{ archive, format, recognized, totals,
 *                        essence:[{path,size,bucket,isNew,isChanged,tooLarge}], dross:{buckets:{k:n}},
 *                        drossTotal, diff:{newCount,changedCount,removedCount,removed:[...]}, truncated }
 * @param {object} [env]
 * @returns {string}
 */
function renderStudyReport(result, env) {
  try {
    if (!isReportEnabled(env)) return _legacy(result);
    const r = result || {};
    const essence = Array.isArray(r.essence) ? r.essence : [];
    const buckets = (r.dross && r.dross.buckets) || {};
    const totals = r.totals || {};
    const diff = r.diff || null;

    const lines = [];
    const title = '─ khyos 更新包学习(取其精华弃其糟粕)';
    lines.push(`┌${title}${'─'.repeat(Math.max(0, WIDTH + 2 - title.length))}┐`);
    lines.push(_row(`包 ${_ellipsize(String(r.archive || '?'), WIDTH - 6)}`));
    if (r.recognized && r.recognized.name) {
      lines.push(_row(`识别 这像 ${r.recognized.name}(Khy 学过)`));
      lines.push(_row(`     可对比 ${_ellipsize(String(r.recognized.doc || ''), WIDTH - 9)}`));
    }
    lines.push(_row(`条目 ${Number(totals.files || 0)} · 精华 ${Number(totals.essence || 0)}`
      + ` · 糟粕 ${Number(totals.dross || 0)} · 中性 ${Number(totals.neutral || 0)}`
      + (r.truncated ? ' · 列表已截断' : '')));

    // 精华阅读清单(Top-N)
    lines.push(_rule('精华 · 建议按序读'));
    if (essence.length) {
      for (const f of essence) {
        const size = _humanBytes(Number(f && f.size) || 0);
        const tag = _tag(f);
        const flag = (f && f.tooLarge) ? '(大)' : '';
        const tail = `${tag}${flag} ${size}`.trim();
        const path = _ellipsize(String((f && f.path) || ''), WIDTH - tail.length - 3);
        lines.push(_row(`${path}  ${tail}`));
      }
    } else {
      lines.push(_row('(未识别到值得优先读的精华文件)'));
    }

    // 糟粕拒绝桶
    lines.push(_rule('糟粕 · 已过滤'));
    const bucketKeys = Object.keys(buckets).filter((k) => Number(buckets[k]) > 0).sort();
    if (bucketKeys.length) {
      const label = {
        vendored: '依赖/生成物目录', lockfile: '锁文件', minified: '压缩/生成产物',
        binary: '二进制/媒体', oversized: '超大 blob', secret: '密钥/机密', 'os-junk': 'OS 垃圾',
      };
      for (const k of bucketKeys) {
        lines.push(_row(`${(label[k] || k).padEnd(16, ' ').slice(0, 16)} ${Number(buckets[k])} 项`));
      }
    } else {
      lines.push(_row('(无)'));
    }

    // 相对旧基线的差异(可选)
    if (diff) {
      lines.push(_rule('相对旧基线'));
      lines.push(_row(`新增 ${Number(diff.newCount || 0)} · 改动 ${Number(diff.changedCount || 0)}`
        + ` · 删除 ${Number(diff.removedCount || 0)}`));
      const removed = Array.isArray(diff.removed) ? diff.removed.slice(0, 5) : [];
      for (const p of removed) {
        lines.push(_row(`  − ${_ellipsize(String(p || ''), WIDTH - 4)}`));
      }
      if (diff.note) lines.push(_row(_ellipsize(String(diff.note), WIDTH)));
    }

    // 移植计划:能改/不能改 + 先改/后改(可选;门关 plan 叶子时 facade 不产 r.plan)
    _renderPlan(lines, r.plan);

    // 下一步引导
    lines.push(_rule('下一步'));
    lines.push(_row('1) 用 Read 逐个读上面「精华」清单里的文件。'));
    lines.push(_row('2) 只挑真正的改进(取其精华), 忽略糟粕桶。'));
    lines.push(_row('3) 选择性移植到 Khy 对应处 —— 不要整包合并。'));
    if (r.truncated) {
      lines.push(_row('列表被上限截断:可调 KHY_ARCHIVE_MAX_LIST_ENTRIES 再看。'));
    }

    lines.push(`└${'─'.repeat(WIDTH + 2)}┘`);
    return lines.join('\n');
  } catch {
    return _legacy(result);
  }
}

module.exports = {
  isReportEnabled,
  renderStudyReport,
  _humanBytes,
};
