'use strict';

/**
 * @pattern Strategy, Chain of Responsibility
 *
 * buildArtifactGuard.js — 可再生构建产物是否漏进版本库的判定层
 * （纯叶子：零 IO、确定性、绝不抛、可单测）。
 *
 * 背景：`apps/khy-mobile/android/app/build` 现存 118 MB 产物，`.gradle` 另有 2.7 MB。
 * 当前 ignore 规则**是对的**——`git ls-files` 查无一条被跟踪。但「此刻是对的」和
 * 「以后一直对」是两件事：Android 模板那份 .gitignore 靠 `build/`、`.gradle/`
 * 两条裸规则守着，任何一次 `git add -f`、或有人在子目录补一条 `!` 反否定，
 * 都能悄悄把几百 MB 二进制钉进历史，而 review 时只看见一行 diff。
 *
 * 因此这里守的不是「现在干不干净」，而是**跟踪集合本身**：只要有文件路径落进
 * 可再生产物区，就是回归。判定全在本文件，`git ls-files` 的调用留在
 * scripts/ci/check-build-artifacts.js。
 *
 * 口径刻意保守：只认那些**确定由构建重新生成**的路径。源码、Gradle wrapper、
 * 配置和资源一律不碰——收窄 ignore 是本计划的明文约束，误杀一个 wrapper
 * 会让 clean checkout 直接构建失败，比漏掉几 MB 严重得多。
 *
 * env 门控 KHY_BUILD_ARTIFACT_GUARD（默认开，仅显式 0/false/off/no 关闭）。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。纯字符串运算。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_BUILD_ARTIFACT_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

/**
 * 可再生产物规则。每条都带 why：门禁报错时要能直接告诉人「凭什么说它是产物」，
 * 否则下一个人只会 `git add -f` 绕过去。
 *
 * dirs 匹配「路径中出现该目录段」；exts 匹配文件后缀。两者都只在 scopes
 * 指定的前缀下生效，避免一条 `build/` 把 `packaging/build/`（CI 源码脚本，
 * 根 .gitignore 里专门 `!` 放行过）误判成产物。
 */
const RULES = Object.freeze([
  Object.freeze({
    id: 'android-build',
    scopes: Object.freeze(['apps/khy-mobile/android/']),
    dirs: Object.freeze(['build', '.gradle', '.cxx', 'intermediates', 'outputs']),
    exts: Object.freeze(['.apk', '.aab', '.aar', '.dex', '.ap_', '.hprof']),
    why: 'Gradle 每次构建重新生成；APK/AAB 只应作为 CI artifact 上传',
  }),
]);

/** 允许豁免的具体路径：占位文件本身不是产物，它是让空目录能进 git 的手段。 */
const ALLOWLIST = Object.freeze([
  'apps/khy-mobile/android/app/build/.npmkeep',
]);

/** 统一成 posix 分隔符，让 Windows 上的 `git ls-files` 输出与规则同口径。 */
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
 * 目录段用**精确段比较**而非 includes：`includes('build')` 会把
 * `app/src/main/java/.../buildConfig.kt` 这种源码文件一起打掉。
 */
function classifyPath(filePath) {
  const posix = toPosix(filePath);
  if (!posix) return null;
  if (ALLOWLIST.includes(posix)) return null;

  for (const rule of RULES) {
    if (!rule.scopes.some((scope) => posix.startsWith(scope))) continue;

    const segments = posix.split('/');
    // 最后一段是文件名，不参与目录段匹配。
    const dirSegments = segments.slice(0, -1);
    const hitDir = dirSegments.find((segment) => rule.dirs.includes(segment));
    if (hitDir) {
      return {
        path: posix,
        ruleId: rule.id,
        reason: '位于可再生目录 ' + hitDir + '/',
        why: rule.why,
      };
    }

    const ext = extensionOf(posix);
    if (ext && rule.exts.includes(ext)) {
      return {
        path: posix,
        ruleId: rule.id,
        reason: '可再生产物后缀 ' + ext,
        why: rule.why,
      };
    }
  }
  return null;
}

/**
 * 批量判定。输入是已跟踪路径列表（或 status 输出的路径），输出违规集合。
 * 任何非字符串条目直接跳过而不抛——门禁绝不因一条脏输入而中断整次检查。
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
    return 'build-artifact guard: disabled (KHY_BUILD_ARTIFACT_GUARD)';
  }
  if (result.violations.length === 0) {
    return '✓ check-build-artifacts 通过(已跟踪 ' + result.checked + ' 条，无可再生产物)';
  }
  const lines = ['✗ 可再生构建产物进入了版本库：'];
  for (const violation of result.violations) {
    lines.push('  ' + violation.path);
    lines.push('      ' + violation.reason + ' —— ' + violation.why);
  }
  lines.push('');
  lines.push('修复：git rm --cached <path> 后确认对应 .gitignore 规则未被反否定覆盖。');
  return lines.join('\n');
}

module.exports = {
  isEnabled,
  classifyPath,
  inspect,
  render,
  RULES,
  ALLOWLIST,
};
