'use strict';

/**
 * postEditDiagnosticsSummary.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 承 Goal(Thread 4)「TUI 缺少/不美观的显示都多学习 CC,但更要注重它背后的**逻辑**」。
 * 这一刀对齐 Claude Code 编辑后诊断摘要行(src/components/DiagnosticsDisplay.tsx:63-73):
 *
 *   Found <N> new diagnostic issue|issues in <M> file|files
 *
 * CC 的**背后逻辑**:在 Edit/Write **之前**给文件的诊断打一份基线(beforeFileEdited),
 * 编辑**之后**再取一次,只把「编辑后有、编辑前没有」的诊断当作**新增**报出来
 * (services/diagnosticTracking.ts getNewDiagnostics 的 before/after diff)。khy 唯一活着的
 * 后编辑诊断源是 `verificationAgent.quickSyntaxCheck`(node -c / py_compile 语法层),
 * 故本刀在语法层复刻这套 before/after diff。
 *
 * 本叶子只做**纯字符串判定**——把一条编译错误行归一成稳定签名、对 before/after 两个错误集求差、
 * 产出用户可见摘要串。真正跑 quickSyntaxCheck(子进程 IO)与维护 baseline 状态,在壳服务
 * `services/postEditDiagnostics.js` 里;计数与门控回退在 call-site。
 *
 * 归一(normalizeErrorSignature)的诚实边界:quickSyntaxCheck 的每条错误来自
 * `${file}: ${stderr.slice(0,200)}`(见 verificationAgent._runSyntaxCheck),被 split('\n') 后
 * 一个语法错误摊成多行——含**易变**的绝对路径、`:行:列`、`^` 脱字符、`at …` 栈帧。签名必须:
 *   - 丢栈帧行(/^\s*at\s/)与纯 `^ ~` 指示行;
 *   - 把路径 token 归一成 <path>、去掉 `:行:列` 数字;
 *   - 归一后**若无任何字母**(纯路径/数字的定位头行)→ 视为噪声返回 '';
 *   - 其余压空白、小写 → 作为签名(通常即 `SyntaxError: …` 消息一行)。
 * **去行号**是刻意取舍:编辑增删行会移动**旧**错误的行号,保留行号会把未变的旧错误误判成新增;
 * 去掉行号后,同一消息不同行的两个错误会并成一个签名(对「编辑引入新错误消息」场景是正确取舍,
 * 与 CC「new issues introduced by this edit」口径一致)。
 *
 * 中文无复数 → CC 的 issue/issues + file/files 分支塌缩(同
 * [[project_gateway_retry_countdown_display]] 的「秒」:不强译 CC 的单复数结构)。
 *
 * 门控:KHY_POST_EDIT_DIAGNOSTICS(默认开)。=0/false/off/no → 关 →
 * buildPostEditDiagnosticsSummary 返回 null(壳服务亦 no-op)→ 逐字节回退今日「无摘要」行为。
 */

function postEditDiagnosticsEnabled(env = process.env) {
  const flag = String((env && env.KHY_POST_EDIT_DIAGNOSTICS) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// 路径 token:可选盘符(C:) + 可选前导裸段(相对路径首段如 src、./、~)+ 一段或多段
// (/或\ 后跟路径字符)。既吃绝对路径 /home/x/a.js,也吃相对路径 src/a.js、./a.js、~/a.js。
const _PATH_RE = /(?:[A-Za-z]:)?[\w.@~-]*(?:[\\/][\w.@~-]+)+/g;
// 行:列 数字(如 :12 或 :12:5),编辑增删行会移动它 → 去掉。
const _LINECOL_RE = /:\d+(?::\d+)?/g;

/**
 * 把一条编译错误行归一成稳定签名。噪声行(栈帧/脱字符/纯定位头)→ 返回 ''(调用方据此忽略)。
 * @param {string} line
 * @returns {string} 归一签名(可能为 '')
 */
function normalizeErrorSignature(line) {
  try {
    if (line == null) return '';
    let s = String(line).trim();
    if (!s) return '';
    // 栈帧行(node 的 "    at Object.<anonymous> (…)")
    if (/^at\s+/.test(s)) return '';
    // 纯 `^`/`~`/空白 的指示行
    if (/^[\s^~]+$/.test(s)) return '';
    // 抹平路径与行列号
    s = s.replace(_PATH_RE, ' <path> ').replace(_LINECOL_RE, ' ');
    // 压空白、小写
    s = s.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!s) return '';
    // 归一后若不含任何字母(纯 <path>/标点/数字的定位头行)→ 噪声
    if (!/[a-zÀ-ɏ]/.test(s.replace(/<path>/g, ''))) return '';
    return s;
  } catch {
    return '';
  }
}

/**
 * 把一批错误行归一成签名集合(去空、去重)。供壳服务存 baseline / 建 before 集。
 * @param {string[]} lines
 * @returns {Set<string>}
 */
function toSignatureSet(lines) {
  const set = new Set();
  try {
    if (Array.isArray(lines)) {
      for (const ln of lines) {
        const sig = normalizeErrorSignature(ln);
        if (sig) set.add(sig);
      }
    }
  } catch { /* fail-soft */ }
  return set;
}

/**
 * before/after 求差:返回 after 里签名非空、且**不在** before 集合中的**原始行**(按签名去重)。
 * @param {Set<string>|string[]} beforeSignatures
 * @param {string[]} afterErrorLines
 * @returns {string[]} 新增错误的原始行
 */
function diffNewErrors(beforeSignatures, afterErrorLines) {
  const out = [];
  try {
    const before = beforeSignatures instanceof Set
      ? beforeSignatures
      : new Set(Array.isArray(beforeSignatures) ? beforeSignatures : []);
    const seen = new Set();
    if (Array.isArray(afterErrorLines)) {
      for (const ln of afterErrorLines) {
        const sig = normalizeErrorSignature(ln);
        if (!sig) continue;
        if (before.has(sig)) continue;
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(String(ln).trim());
      }
    }
  } catch { /* fail-soft → 空 */ }
  return out;
}

function _posInt(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * 构造 CC 风格「新增诊断」用户可见摘要串(单一真源)。
 * 门控关 / issueCount<=0 / fileCount<=0 / 坏输入 → null(不渲该行)。
 * @param {{issueCount:number, fileCount:number}} p
 * @param {object} [env=process.env]
 * @returns {string|null} 例如 "发现 2 处新增诊断问题（1 个文件）"
 */
function buildPostEditDiagnosticsSummary(p = {}, env = process.env) {
  try {
    if (!postEditDiagnosticsEnabled(env)) return null;
    const issueCount = _posInt(p && p.issueCount);
    const fileCount = _posInt(p && p.fileCount);
    if (issueCount <= 0 || fileCount <= 0) return null;
    return `发现 ${issueCount} 处新增诊断问题（${fileCount} 个文件）`;
  } catch {
    return null;
  }
}

module.exports = {
  postEditDiagnosticsEnabled,
  normalizeErrorSignature,
  toSignatureSet,
  diffNewErrors,
  buildPostEditDiagnosticsSummary,
};
