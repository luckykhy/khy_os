'use strict';

/**
 * normalizeToolName.js — 「工具/标识名归一化」单一真源(lowercase + 去空白/下划线/连字符)。
 *
 * 收敛 src/ 下 6 处 body 逐字节相同的私有归一器(仅函数名不同):
 *   `String(name || '').toLowerCase().replace(/[\s_-]/g, '')`
 *   - `_norm`            : services/devCourseMonitor · adaptiveExecution ·
 *                          falsePositiveFixGuard · permissionPolicy/matchers
 *   - `_normTool`        : services/receiptService
 *   - `_normalizeToolName`: tools/_fileLock
 *   用途一致:把工具名/命令名规整成可宽松匹配的键(read_file / Read File / read-file → readfile)。
 *
 * **语义**:`|| ''` → 0/false/null/undefined/'' 均归 ''(区别于 `== null ? '' :` 变体,后者 0→'0')。
 *
 * **刻意不收敛(C 组·`_norm` 家族高度分叉)**:
 *   - editDiffPreview 的 `String(name == null ? '' : name)…[\s_-]` — nullish 判定不同(0→'0');
 *   - externalAgentDirective/errorEnumerationGuard/intentCoverage 仅 lowercase 无 strip;
 *   - modelIdentityTruth 用 `[\s._/:-]+` 更宽字符集;localWebSolver 折叠空白+trim;
 *   - keyUpdateFlow 剥标点两端;workspaceGitInit/gitTrackWhitelist 走 path.normalize;
 *   - constraintStrategy/uninstallPlan 语义完全不同(枚举/路径)。均留原样。
 *
 * 契约:纯函数、确定性、不 mutate、恒返字符串。
 *
 * 各消费方保留同名本地 `const <原名> = require('.../normalizeToolName')` → 调用点逐字节不变。
 */

function normalizeToolName(name) {
  return String(name || '').toLowerCase().replace(/[\s_-]/g, '');
}

module.exports = normalizeToolName;
