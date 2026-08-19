'use strict';

/**
 * @pattern Strategy, Chain of Responsibility
 *
 * runtimePlacementGuard.js — 生产 runtime 产物里「不该出现的东西」的判定层
 * （纯叶子：零 IO、确定性、绝不抛、可单测）。
 *
 * 背景：khy 模块的 bundle 是 19.3 MB，它的 source map 是 66.9 MB——3.5 倍。
 * 发布路径（packaging/npm、便携包）一直只拷 bundle.mjs，所以 map 没真的漏出去，
 * 但那是**巧合**：靠的是「拷贝清单恰好只列了一个文件」，而不是任何一道检查。
 * 任何一次把 `copyFileSync` 改成 `copyTree`，66.9 MB 就跟着进产物了。
 *
 * 这道门守的是「产物里不许有什么」，与 buildArtifactGuard（守版本库跟踪集合）
 * 互补：那一个防的是二进制进 git 历史，这一个防的是调试符号和运行期数据进
 * 分发包。
 *
 * 口径同样保守——只认那些**确定不属于生产 runtime** 的东西：
 *   调试符号  .map / .map.gz          —— 体积大且只对开发有意义
 *   运行期数据 .khy/ .khyquant/ logs/  —— 用户数据，进了分发包就是泄漏
 *   数据库    .db / .sqlite / -wal    —— 同上，且可能含密钥
 *   历史构建  dist/ 嵌套              —— 产物里再套一层产物，必是回写事故
 *
 * 源码、配置、资源一律不碰。误杀一个 .json 配置会让运行时起不来，
 * 比多带几 MB 严重得多。
 *
 * env 门控 KHY_RUNTIME_PLACEMENT_GUARD（默认开，仅显式 0/false/off/no 关闭）。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。纯字符串运算。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_RUNTIME_PLACEMENT_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

/**
 * 违规规则。每条带 why，便于门禁报错时直接说清「凭什么它不该在这」。
 * exts 比后缀，dirs 比**精确路径段**，files 比完整文件名。
 */
const RULES = Object.freeze([
  Object.freeze({
    id: 'debug-symbols',
    exts: Object.freeze(['.map']),
    why: 'source map 只属于 debug artifact；生产 runtime 带它等于把 3 倍体积和全部源码一起发出去',
  }),
  Object.freeze({
    id: 'runtime-state',
    dirs: Object.freeze(['.khy', '.khyquant', '.khyquant-data', 'logs', 'cache', '__pycache__']),
    why: '运行期数据/缓存属于用户的数据家，绝不能随分发包出厂',
  }),
  Object.freeze({
    id: 'database',
    exts: Object.freeze(['.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3']),
    why: '数据库文件属活体数据，可能含密钥；分发包里出现即是泄漏',
  }),
  Object.freeze({
    id: 'nested-build',
    dirs: Object.freeze(['dist']),
    why: '产物目录里再嵌一层 dist，说明构建把输出回写进了工作树',
  }),
]);

/** 统一成 posix 分隔符，让 Windows 上的路径与规则同口径。 */
function toPosix(value) {
  return String(value == null ? '' : value).split('\\').join('/');
}

function extensionOf(posixPath) {
  const base = posixPath.slice(posixPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * 单条路径判定。命中返回 { path, ruleId, reason, why }，否则 null。
 *
 * 目录段用**精确段比较**而非 includes：`includes('dist')` 会把
 * `src/utils/distance.js` 这种源码一起打掉。
 */
function classifyPath(filePath) {
  const posix = toPosix(filePath);
  if (!posix) return null;

  const segments = posix.split('/');
  const dirSegments = segments.slice(0, -1);
  const ext = extensionOf(posix);

  for (const rule of RULES) {
    if (rule.dirs) {
      const hit = dirSegments.find((segment) => rule.dirs.includes(segment));
      if (hit) {
        return { path: posix, ruleId: rule.id, reason: '位于 ' + hit + '/', why: rule.why };
      }
    }
    if (rule.exts && ext && rule.exts.includes(ext)) {
      return { path: posix, ruleId: rule.id, reason: '后缀 ' + ext, why: rule.why };
    }
  }
  return null;
}

/**
 * 批量判定。非字符串条目直接跳过而不抛——门禁绝不因一条脏输入中断整次检查。
 */
function inspect(paths, env) {
  if (!isEnabled(env)) return { disabled: true, violations: [], checked: 0 };
  const list = Array.isArray(paths) ? paths : [];
  const violations = [];
  let checked = 0;
  for (const item of list) {
    if (typeof item !== 'string' || item.length === 0) continue;
    checked++;
    const hit = classifyPath(item);
    if (hit) violations.push(hit);
  }
  return { disabled: false, violations, checked };
}

/** 文本呈现。纯字符串拼接，供 CLI 直接打印。 */
function render(result) {
  if (!result || result.disabled) {
    return 'runtime-placement guard: disabled (KHY_RUNTIME_PLACEMENT_GUARD)';
  }
  if (result.violations.length === 0) {
    return '✓ 生产 runtime 布局检查通过(' + result.checked + ' 条，无调试符号/运行期数据)';
  }
  const lines = ['✗ 生产 runtime 产物里出现了不该有的文件：'];
  for (const violation of result.violations) {
    lines.push('  ' + violation.path);
    lines.push('      ' + violation.reason + ' —— ' + violation.why);
  }
  lines.push('');
  lines.push('修复：调整对应打包脚本的拷贝清单/过滤器，不要把这些文件放进 runtime 目录。');
  return lines.join('\n');
}

module.exports = { isEnabled, classifyPath, inspect, render, RULES };
