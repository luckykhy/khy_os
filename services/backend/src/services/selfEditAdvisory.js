'use strict';

/**
 * selfEditAdvisory.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「khy 自维护顾问」的确定性核心:当有人(AI 或人)改动 khy **自身**源码,应在改动现场
 * 主动把维护知识交付给改动者,而不是静默等到提交期守卫/字节一致测试才炸(用户诉求:
 * 「我希望 khy 在被修改时能主动向修改它的 ai 与人反馈消息,辅助修改,而不是静默干等」)。
 *
 * 本叶子只做**纯字符串/路径判定与文案组装**——判某个仓库相对路径是否属于「需三副本镜像
 * 的源」、把它映射成两个 bundle 树下的目标路径、极简侦测文件是否自声明纯叶子、把壳算好的
 * 「镜像漂移事实 + 守卫结果」拼成给人看的一行与给 AI 下一轮的注记。真正的 IO(探仓库根、
 * 读文件逐字节比对、require 守卫核跑评估、fs.watch 监视)全部在壳
 * services/selfEditAdvisoryService.js 与 services/selfEditWatcher.js 里。
 *
 * 门控(两枚,默认开,沿用同族 OFF_VALUES 语义):
 *   - KHY_SELF_EDIT_ADVISORY:总闸(编辑工具路径 + 外部监视路径)。关 → buildSelfEditAdvisory
 *     返回 null、壳 no-op → 逐字节回退今日「无自维护反馈」行为。
 *   - KHY_SELF_EDIT_WATCH:仅外部编辑器监视器(较重一环可单独关,保留工具路径轻量提示)。
 */

// ── 门控(默认开,仅显式 0/false/off/no 关)──────────────────────────────
const OFF_VALUES = ['0', 'false', 'off', 'no'];
function _flagOn(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 总闸:自维护顾问默认开;仅显式 falsy 关。 */
function selfEditAdvisoryEnabled(env = process.env) {
  return _flagOn(env && env.KHY_SELF_EDIT_ADVISORY);
}

/** 子闸:外部编辑器监视器默认开;仅显式 falsy 关。 */
function selfEditWatchEnabled(env = process.env) {
  return _flagOn(env && env.KHY_SELF_EDIT_WATCH);
}

// ── 三副本镜像规则(镜像 scripts/release/pip_packaging_rules.py 的 BASE_COPY_PAYLOADS)──
// 两个 bundle 树根:
const MIRROR_ROOTS = ['platform/khy_os/bundled', 'packaging/npm/bundled'];
// 源根 → bundle 内相对根 的映射(kernel/alpine 落到 alpine/,其余原样)。
const SOURCE_PAYLOADS = [
  { src: 'services/backend', dst: 'services/backend' },
  { src: 'docs', dst: 'docs' },
  { src: 'kernel/alpine', dst: 'alpine' },
];

/** 归一仓库相对路径:反斜杠 → 正斜杠,去前导 ./ 与 /。永不抛。 */
function _normRel(repoRel) {
  let s = String(repoRel == null ? '' : repoRel).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

/** 路径 p 是否等于 root 或落在 root/ 下。 */
function _under(p, root) {
  return p === root || p.startsWith(root + '/');
}

/**
 * 判仓库相对路径是否为「需三副本镜像的源文件」。排除:bundle 树内自身、测试文件。
 * @param {string} repoRel  仓库相对路径(如 services/backend/src/x.js)
 * @returns {{mirrored:boolean, payloadRel?:string, dst?:string}}
 */
function isMirroredSourcePath(repoRel) {
  try {
    const rel = _normRel(repoRel);
    if (!rel) return { mirrored: false };
    // bundle 树内的文件不是「源」(避免监视器自噬 / 把镜像当源)。
    for (const root of MIRROR_ROOTS) {
      if (_under(rel, root)) return { mirrored: false };
    }
    // 测试文件不进 bundle 载荷。
    if (/\.test\.[cm]?jsx?$/.test(rel)) return { mirrored: false };
    for (const payload of SOURCE_PAYLOADS) {
      if (_under(rel, payload.src)) {
        const payloadRel = rel === payload.src ? '' : rel.slice(payload.src.length + 1);
        return { mirrored: true, payloadRel, dst: payload.dst };
      }
    }
    return { mirrored: false };
  } catch {
    return { mirrored: false };
  }
}

/**
 * 把源文件仓库相对路径映射成两个 bundle 树下的仓库相对目标路径。非镜像源 → []。永不抛。
 * @param {string} repoRel
 * @returns {string[]}  如 [platform/khy_os/bundled/services/backend/src/x.js, packaging/npm/bundled/...]
 */
function computeMirrorPaths(repoRel) {
  try {
    const info = isMirroredSourcePath(repoRel);
    if (!info.mirrored) return [];
    const tail = info.payloadRel ? `${info.dst}/${info.payloadRel}` : info.dst;
    return MIRROR_ROOTS.map((root) => `${root}/${tail}`);
  } catch {
    return [];
  }
}

// ── 极简纯叶子自声明侦测 ────────────────────────────────────────────────
// 因 scripts/lib/leafContractGuard 不在 bundled 载荷内(安装态无法 require),此处自带一份
// **最小**启发式:仅用于决定「是否在提示里追加纯叶子契约一行」。权威判定仍是提交期
// check-leaf-contract 守卫;这里从宽从简,漏判只是少提示一行、绝不误挡编辑。
const _LEAF_MARKER_RE = /纯叶子|pure[\s-]?leaf/i;
const _CONTRACT_TERMS_RE = /零\s*IO|确定性|绝不抛|单一真源|env\s*门控|可单测|无副作用|无状态/;

/** 取首个块注释(头部 docstring);无 → ''。 */
function _firstBlockComment(source) {
  const text = String(source || '');
  const start = text.indexOf('/*');
  if (start < 0) return '';
  const end = text.indexOf('*/', start + 2);
  return end < 0 ? text.slice(start) : text.slice(start, end + 2);
}

/**
 * 文件是否自声明纯叶子:标记与契约词同现于首个块注释。永不抛。
 * @param {string} source
 * @returns {boolean}
 */
function detectPureLeaf(source) {
  try {
    const header = _firstBlockComment(source);
    if (!header) return false;
    return _LEAF_MARKER_RE.test(header) && _CONTRACT_TERMS_RE.test(header);
  } catch {
    return false;
  }
}

// ── 文案组装 ────────────────────────────────────────────────────────────
function _guardLineHuman(g) {
  const mark = g && g.ok ? '✓' : '✗';
  const name = (g && g.name) || 'guard';
  if (g && g.ok) return `${mark} ${name}`;
  const errs = Number(g && g.errorCount) || 0;
  const warns = Number(g && g.warnCount) || 0;
  const parts = [];
  if (errs > 0) parts.push(`${errs} error`);
  if (warns > 0) parts.push(`${warns} warn`);
  return `${mark} ${name}${parts.length ? `(${parts.join('/')})` : ''}`;
}

function _guardLineAi(g) {
  const name = (g && g.name) || 'guard';
  if (g && g.ok) return `   - ${name}: 通过`;
  const errs = Number(g && g.errorCount) || 0;
  const warns = Number(g && g.warnCount) || 0;
  const sample = g && g.sample ? ` — ${String(g.sample).slice(0, 160)}` : '';
  return `   - ${name}: ${errs} error / ${warns} warning${sample}`;
}

/**
 * 组装自维护反馈(给人看的一行 + 给 AI 下一轮的注记)。壳把已算好的事实传进来。
 * 门控关 / 非镜像源 / 异常 → null(调用方据此不发)。
 *
 * @param {object} p
 * @param {string} p.repoRel        改动文件的仓库相对路径
 * @param {boolean} [p.isLeaf]      是否自声明纯叶子(壳用 detectPureLeaf 算好)
 * @param {{missing?:string[], drift?:string[]}} [p.mirrorState]  bundle 镜像漂移事实
 * @param {Array<{name:string,ok:boolean,errorCount?:number,warnCount?:number,sample?:string}>} [p.guardResults]
 * @param {boolean} [p.guardsAvailable]  守卫核是否可用(dev checkout 才有)
 * @param {object} [p.env]
 * @returns {{humanLine:string, aiNote:string}|null}
 */
function buildSelfEditAdvisory(p = {}, env = process.env) {
  try {
    const _env = (p && p.env) || env;
    if (!selfEditAdvisoryEnabled(_env)) return null;
    const rel = _normRel(p && p.repoRel);
    const mirrors = computeMirrorPaths(rel);
    if (mirrors.length === 0) return null; // 非 khy 镜像源 → 不反馈

    const mirrorState = (p && p.mirrorState) || {};
    const missing = Array.isArray(mirrorState.missing) ? mirrorState.missing : [];
    const drift = Array.isArray(mirrorState.drift) ? mirrorState.drift : [];
    const outOfSync = missing.length + drift.length > 0;
    const isLeaf = !!(p && p.isLeaf);
    const guardResults = Array.isArray(p && p.guardResults) ? p.guardResults : [];
    const guardsAvailable = !!(p && p.guardsAvailable);

    // ── 人面(终端可见,紧凑多行)────────────────────────────────────
    const hLines = [`🔧 khy 自维护 · 已改动 ${rel}`];
    if (outOfSync) {
      hLines.push(`  ├ ⚠ 需同步 ${mirrors.length} 处 bundle 镜像:${mirrors.join('  ')}`);
    } else {
      hLines.push(`  ├ ✓ ${mirrors.length} 处 bundle 镜像已同步`);
    }
    if (isLeaf) {
      hLines.push('  ├ 纯叶子契约:零 IO · 确定性 · 永不抛 · 门控默认开 · 关时逐字节 legacy');
    }
    if (guardsAvailable && guardResults.length > 0) {
      hLines.push(`  └ 守卫:${guardResults.map(_guardLineHuman).join('  ')}`);
    } else {
      hLines.push('  └ 守卫:安装态无 scripts/,请在 dev checkout 手动运行');
    }
    const humanLine = hLines.join('\n');

    // ── AI 面(下一轮注记,可直接照做)────────────────────────────────
    const aLines = [`[khy 自维护提示] 你刚改动了 khy 自身源码 ${rel}。收尾前请完成:`];
    aLines.push('1) 三副本镜像(逐字节一致):');
    for (const m of mirrors) aLines.push(`   - ${m}`);
    if (outOfSync) {
      if (missing.length) aLines.push(`   当前缺失:${missing.join(' , ')}`);
      if (drift.length) aLines.push(`   当前漂移(内容不一致):${drift.join(' , ')}`);
    } else {
      aLines.push('   当前:已同步 ✓');
    }
    if (isLeaf) {
      aLines.push('2) 纯叶子契约(本文件自声明为纯叶子):保持零 IO、确定性、永不抛、KHY_* 门控默认开、关时逐字节 legacy。');
    }
    if (guardsAvailable && guardResults.length > 0) {
      aLines.push('3) 守卫(已当场运行):');
      for (const g of guardResults) aLines.push(_guardLineAi(g));
      aLines.push(`   未自动运行的请手动:node scripts/check-agent-rules.js ${rel}`);
    } else {
      aLines.push(`3) 守卫:当前为安装态(无 scripts/),请在 dev checkout 手动运行 node scripts/check-leaf-contract.js / check-agent-rules.js / check-model-hardcoding.js ${rel}`);
    }
    const aiNote = aLines.join('\n');

    return { humanLine, aiNote };
  } catch {
    return null;
  }
}

module.exports = {
  OFF_VALUES,
  MIRROR_ROOTS,
  SOURCE_PAYLOADS,
  selfEditAdvisoryEnabled,
  selfEditWatchEnabled,
  isMirroredSourcePath,
  computeMirrorPaths,
  detectPureLeaf,
  buildSelfEditAdvisory,
};
