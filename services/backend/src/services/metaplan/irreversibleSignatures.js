'use strict';

/**
 * irreversibleSignatures.js — 破坏性/不可逆动作的**单一模式库** (Goal 1 收敛).
 *
 * 历史上同一批「删除/drop/抹密钥/毁依赖」正则被实现了两遍：
 *   - `metaConstraint/riskClassifier.js`     —— 给动作分**风险级别**（creative/logic/irreversible）
 *   - `metaplan/constitutionalRedLines.js`   —— 判**宪法红线**（强制 System_Block）
 * 两份正则各自演化、互相漂移。本模块把**签名库**收敛为唯一真源；两个消费者只保留各自
 * 的**判定逻辑**（如何用这些签名），不再各持一份正则。
 *
 * 放在 metaplan/（约束簇的下层）符合依赖方向：metaConstraint → metaplan，单向。
 *
 * 纯函数、无副作用。每个 bank 显式命名、可审计。
 *
 * 参见 `.ai/GUARDS-AI.md` §2「单一真源映射」与 `.ai/GOVERNANCE-LEDGER.md` §C。
 */

// 工具名语义即删除/移除 → 不可逆。(两份历史定义的并集；含 rmdir。)
const DELETE_TOOL_NAMES = new Set([
  'deletefile', 'delete_file', 'removefile', 'remove_file', 'rm', 'unlink', 'rmdir',
]);

// 命令里的删除动词。
const DELETE_CMD_RE = /\b(rm|del|unlink|rmdir)\b/i;

// 不可逆命令签名（删除/drop/强推/低层抹盘/包卸载）。
const IRREVERSIBLE_CMD_PATTERNS = [
  /\b(rm|del|unlink|rmdir)\b/i,
  /\bdrop\s+(database|table)\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+push\b[\s\S]*(-f\b|--force)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b[\s\S]*-[a-z]*f/i,
  /\b(mkfs|dd|shred|wipefs)\b/i,
  /\bnpm\s+(uninstall|remove|rm)\b/i,
  /\b(yarn|pnpm)\s+remove\b/i,
];

// 路径本身高危：依赖清单 / 锁文件 / 机密。
const IRREVERSIBLE_PATH_PATTERNS = [
  /(^|[\\/])package\.json$/i,
  /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
  /(^|[\\/])(Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|requirements\.txt|pyproject\.toml|Pipfile(\.lock)?)$/i,
  /(^|[\\/])\.env(\.[\w-]+)?$/i,
  /(^|[\\/])(secrets?|credentials?)(\.[\w.]+)?$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
];

// 数据库销毁（SQL）。
const DB_DROP_PATTERNS = [
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b[\s\S]*\bwhere\b\s+1\s*=\s*1/i, // delete-all
];

// 数据库销毁（文件系统删除数据存储）。
const DB_FILE_PATTERNS = [
  /\b(rm|del|unlink|rmdir)\b[\s\S]*\.(db|sqlite3?|mdb|frm|ibd)\b/i,
  /\bdropDatabase\s*\(/,
];

// 机密文件路径。
const SECRET_PATH_PATTERNS = [
  /(^|[\\/])\.env(\.[\w-]+)?$/i,
  /(^|[\\/])(secrets?|credentials?)(\.[\w.]+)?$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /id_rsa\b/i,
];

// 内容疑似外泄机密（活凭证写到外发/日志/公共文件）。
const SECRET_EXFIL_PATTERNS = [
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,                      // AWS access key id
  /\bsk-[A-Za-z0-9]{20,}\b/,                          // OpenAI-style secret
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,               // private key blob
  /\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*['"][^'"]{6,}['"]/i,
];

// package.json 破坏性触碰。
const PKG_CORE_DELETE_PATTERNS = [
  /(^|[\\/])package\.json$/i,
];

function _str(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

function _any(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/** 工具名是否语义即删除。 */
function isDeleteTool(tool) {
  return DELETE_TOOL_NAMES.has(String(tool || '').trim().toLowerCase());
}

/** 命令文本是否含删除动词。 */
function isDeleteCommand(text) {
  return DELETE_CMD_RE.test(_str(text));
}

module.exports = {
  DELETE_TOOL_NAMES,
  DELETE_CMD_RE,
  IRREVERSIBLE_CMD_PATTERNS,
  IRREVERSIBLE_PATH_PATTERNS,
  DB_DROP_PATTERNS,
  DB_FILE_PATTERNS,
  SECRET_PATH_PATTERNS,
  SECRET_EXFIL_PATTERNS,
  PKG_CORE_DELETE_PATTERNS,
  _str,
  _any,
  isDeleteTool,
  isDeleteCommand,
};
