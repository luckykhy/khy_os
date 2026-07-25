'use strict';

/**
 * constitutionalRedLines.js — the uncoverable floor (目标11 §5 "宪法级红线").
 *
 * A handful of destructive / irreversible operations are forced to
 * "System_Block" by the underlying code REGARDLESS of what the model's meta-plan
 * chose. The model can never relax these — they are matched on the concrete
 * action (tool + params), not on the model's self-assessment, so a mis-judging or
 * adversarial plan cannot route around them.
 *
 * 红线 (constitutional):
 *   1. 删除数据库 / drop database / 删除 *.db|*.sqlite 等数据文件
 *   2. 暴露机密 (.env / secrets / 私钥 / 凭证) 到外部或日志
 *   3. 删除 package.json 或其核心依赖 (核心依赖块)
 *
 * This layer is deliberately conservative and pattern-based: a match forces
 * System_Block; a non-match changes nothing (returns null). It never relaxes —
 * `escalate` guarantees the result is the strictest of {model choice, red line}.
 *
 * Pure + side-effect free.
 */

const strategy = require('./constraintStrategy');
// 破坏性签名库唯一真源（Goal 1 收敛，见 .ai/GUARDS-AI.md §2）。
const {
  DB_DROP_PATTERNS,
  DB_FILE_PATTERNS,
  SECRET_PATH_PATTERNS,
  SECRET_EXFIL_PATTERNS,
  PKG_CORE_DELETE_PATTERNS,
  DELETE_TOOL_NAMES,
  _str,
  _any,
} = require('./irreversibleSignatures');

/**
 * @typedef {Object} RedLineHit
 * @property {string} rule    machine id of the red line tripped
 * @property {string} reason  human-readable explanation (zh)
 * @property {string} forced  always strategy.STRATEGIES.SYSTEM_BLOCK
 */

/**
 * Inspect a concrete action and return a red-line hit if one is tripped, else
 * null. The action is described loosely so this works for shell, file, and SQL
 * tools alike.
 *
 * @param {object} action
 * @param {string} [action.tool]      tool/executor name being invoked
 * @param {object} [action.params]    tool params (path, command, content, sql…)
 * @param {string} [action.command]   convenience: raw shell command
 * @param {string} [action.path]      convenience: target file path
 * @param {string} [action.content]   convenience: content to be written
 * @returns {RedLineHit|null}
 */
function checkAction(action = {}) {
  const params = action.params || {};
  const tool = String(action.tool || params.tool || '').trim().toLowerCase();
  const command = _str(action.command != null ? action.command : params.command);
  const sql = _str(params.sql != null ? params.sql : params.query);
  const path = _str(action.path != null ? action.path : (params.path || params.file || params.filename));
  const content = _str(action.content != null ? action.content : params.content);

  const commandish = `${command}\n${sql}`;
  const isDelete = DELETE_TOOL_NAMES.has(tool)
    || /\b(rm|del|unlink|rmdir)\b/i.test(command);

  // 红线 1: database destruction.
  if (_any(DB_DROP_PATTERNS, commandish) || _any(DB_FILE_PATTERNS, `${command} ${path}`)) {
    return _hit('db_destruction', '检测到删除/清空数据库或数据文件的操作（宪法红线 1）。');
  }
  if (isDelete && _any(DB_FILE_PATTERNS, `rm ${path}`)) {
    return _hit('db_destruction', '检测到删除数据库文件（宪法红线 1）。');
  }

  // 红线 2: secret exposure — deleting/leaking a secrets file, or content that
  // embeds a live credential being written/emitted.
  if (_any(SECRET_PATH_PATTERNS, path) && (isDelete || /(>|>>|tee|curl|wget|fetch|post)/i.test(command))) {
    return _hit('secret_exposure', '检测到对机密文件的删除/外泄操作（宪法红线 2）。');
  }
  if (_any(SECRET_EXFIL_PATTERNS, content) && /(curl|wget|fetch|http|post|console\.log|process\.stdout|>>?)/i.test(`${command}${content}`)) {
    return _hit('secret_exposure', '检测到疑似将机密/私钥写入外发或日志（宪法红线 2）。');
  }

  // 红线 3: deleting package.json, blanking it, or gutting its dependency block.
  if (_any(PKG_CORE_DELETE_PATTERNS, path)) {
    if (isDelete || content.trim() === '') {
      return _hit('package_core_delete', '检测到删除/清空 package.json（宪法红线 3）。');
    }
    if (_stripsDependencies(content)) {
      return _hit('package_core_delete', '检测到 package.json 写入将清空核心依赖块（宪法红线 3）。');
    }
  }

  return null;
}

/** Heuristic: a package.json candidate that drops the dependencies block. */
function _stripsDependencies(content) {
  if (!content || !/[{]/.test(content)) return false;
  try {
    const obj = JSON.parse(content);
    if (!obj || typeof obj !== 'object') return false;
    const deps = obj.dependencies;
    return deps != null && typeof deps === 'object' && Object.keys(deps).length === 0;
  } catch {
    return false; // unparseable → not our call to make here
  }
}

function _hit(rule, reason) {
  return { rule, reason, forced: strategy.STRATEGIES.SYSTEM_BLOCK };
}

/**
 * Apply the red lines on top of a (possibly already-escalated) strategy. Returns
 * the strictest of the two and the hit (if any). Never relaxes.
 *
 * @param {string} currentStrategy  the strategy so far (model + circuit-breaker)
 * @param {object} action
 * @returns {{strategy:string, redLine:(RedLineHit|null)}}
 */
function enforce(currentStrategy, action) {
  const hit = checkAction(action);
  if (!hit) return { strategy: currentStrategy, redLine: null };
  return { strategy: strategy.escalate(currentStrategy, hit.forced), redLine: hit };
}

module.exports = {
  checkAction,
  enforce,
};
