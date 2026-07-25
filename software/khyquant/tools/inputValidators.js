/**
 * Input Validators — reusable semantic validation functions.
 *
 * These go beyond schema type checks. Any tool can use them in its
 * validateInput() method for security and safety checks.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { isBlockedDevicePath } = require('./shellClassifier');

// [SAFE] Sensitive persistence / remote-access sinks INSIDE the user's home.
// validateNoPathTraversal trusts the entire home dir, so without this an Agent
// could WRITE ~/.ssh/authorized_keys (remote root), overwrite a shell rc
// (code-exec on next login), or drop an autostart/systemd/LaunchAgent unit
// (boot persistence) — full privilege escalation that never leaves "trusted"
// home. This denylist is anchored at the home ROOT (matched on the path RELATIVE
// to homedir), so ordinary writes under ~/Desktop, ~/Documents, ~/Downloads and
// project trees that merely live under home are unaffected. Escalation vectors
// are blocked even in non-strict mode; KHY_ALLOW_SENSITIVE_HOME_WRITE=1 is the
// operator-informed opt-out.
const _SENSITIVE_HOME_EXACT = new Set([
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases',
  '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout',
  '.kshrc', '.cshrc', '.tcshrc', '.login', '.xprofile', '.xinitrc',
]);
const _SENSITIVE_HOME_PREFIXES = [
  '.ssh/',
  '.gnupg/',
  '.config/autostart/',
  '.config/systemd/',
  'Library/LaunchAgents/',
  'Library/LaunchDaemons/',
  '.config/environment.d/',
];
// 小写化副本(供 KHY_SENSITIVE_HOME_CASEFOLD 补充匹配用;denylist 是 SSoT,此处只派生)。
const _SENSITIVE_HOME_EXACT_LC = new Set([..._SENSITIVE_HOME_EXACT].map((s) => s.toLowerCase()));
const _SENSITIVE_HOME_PREFIXES_LC = _SENSITIVE_HOME_PREFIXES.map((p) => p.toLowerCase());

function _isSensitiveHomeWrite(resolved) {
  if (String(process.env.KHY_ALLOW_SENSITIVE_HOME_WRITE || '').trim() === '1') return false;
  let home;
  try { home = os.homedir(); } catch { return false; }
  if (!home) return false;
  let rel = path.relative(home, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false; // outside home
  rel = rel.split(path.sep).join('/');
  // Legacy exact-case match (preserved first → byte-revert baseline when gate off).
  if (_SENSITIVE_HOME_EXACT.has(rel)) return true;
  if (_SENSITIVE_HOME_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p))) return true;
  // 门控 KHY_SENSITIVE_HOME_CASEFOLD(默认开):大小写折叠超集,封堵 `.SSH/`/`.BASHRC`/
  // `launchagents/` 等大小写变体绕过(大小写不敏感 FS 上是同一文件)。门关/异常 → foldSensitiveRel
  // 返 null → 跳过 → 逐字节回退 legacy 精确大小写结果。fail-closed:只多封锁,绝不放行 legacy 拦的。
  try {
    const folded = require('../services/sensitiveHomeCaseFold').foldSensitiveRel(rel, process.env);
    if (folded != null && folded !== rel) {
      if (_SENSITIVE_HOME_EXACT_LC.has(folded)) return true;
      if (_SENSITIVE_HOME_PREFIXES_LC.some((p) => folded === p.slice(0, -1) || folded.startsWith(p))) return true;
    }
  } catch { /* fail-soft → legacy result (not sensitive) */ }
  return false;
}

// ── Default limits ─────────────────────────────────────────────────

const MAX_READ_FILE_SIZE = 500 * 1024;   // 500 KB
const MAX_EDIT_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

// ── Validators ─────────────────────────────────────────────────────

/**
 * Block device paths that would hang or exhaust memory.
 * @param {string} filePath
 * @returns {{ valid: boolean, message?: string }}
 */
function validateNotDevicePath(filePath) {
  if (isBlockedDevicePath(filePath)) {
    return {
      valid: false,
      message: `Blocked: "${filePath}" is a device path that could cause the process to hang or exhaust memory.`,
    };
  }
  return { valid: true };
}

/**
 * Check file size before reading/editing.
 * @param {string} filePath - Resolved absolute path
 * @param {number} [maxBytes] - Maximum allowed file size
 * @returns {{ valid: boolean, message?: string }}
 */
function validateFileSize(filePath, maxBytes = MAX_READ_FILE_SIZE) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      const maxMB = (maxBytes / 1024 / 1024).toFixed(1);
      return {
        valid: false,
        message: `File too large: ${sizeMB} MB (max ${maxMB} MB). Use a shell command to read specific portions.`,
      };
    }
  } catch {
    // File doesn't exist or can't be stat'd — let the tool handle that
  }
  return { valid: true };
}

/**
 * Detect no-op edits (old_string === new_string).
 * @param {string} oldStr
 * @param {string} newStr
 * @returns {{ valid: boolean, message?: string }}
 */
function validateNotNoop(oldStr, newStr) {
  if (oldStr === newStr) {
    return {
      valid: false,
      message: 'No-op edit: old_string and new_string are identical.',
    };
  }
  return { valid: true };
}

/**
 * Block UNC paths to prevent NTLM credential leakage.
 * On Windows, fs operations on UNC paths (\\server\share) trigger SMB
 * authentication, potentially leaking NTLM hashes to malicious servers.
 *
 * @param {string} filePath
 * @returns {{ valid: boolean, message?: string }}
 */
function validateNotUNCPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return { valid: true };
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
    return {
      valid: false,
      message: 'Blocked: UNC network paths are not allowed (security: prevents NTLM credential leakage).',
    };
  }
  return { valid: true };
}

/**
 * Detect path traversal attempts that escape the working directory.
 * @param {string} filePath
 * @param {string} [baseCwd] - Base directory to enforce
 * @returns {{ valid: boolean, message?: string }}
 */
function validateNoPathTraversal(filePath, baseCwd) {
  if (!baseCwd) baseCwd = process.env.KHYQUANT_CWD || process.cwd();
  try {
    const resolved = path.resolve(baseCwd, filePath);
    const normalizedBase = path.resolve(baseCwd);
    // [SAFE] Block home-internal escalation/persistence sinks FIRST — these are
    // refused even when the path is under a trusted root (or the project itself
    // lives under home). See _isSensitiveHomeWrite above.
    if (_isSensitiveHomeWrite(resolved)) {
      return {
        valid: false,
        message:
          `Refused to write "${filePath}": the resolved path targets a sensitive ` +
          `home location (SSH keys, shell startup file, GPG, or an autostart/` +
          `systemd/LaunchAgent persistence dir). Writing here is a privilege-` +
          `escalation vector and is blocked. Set KHY_ALLOW_SENSITIVE_HOME_WRITE=1 ` +
          `only if you explicitly intend this.`,
      };
    }
    // 门控 KHY_PROJECT_BOUNDARY_ANCHOR(默认开):裸 startsWith 会把共享名字前缀的兄弟目录
    // (proj-secrets vs proj)误判「项目内」而绕过边界;锚定分隔符边界收紧。门关/异常 → 回退 legacy。
    let _withinBase = resolved.startsWith(normalizedBase);
    try {
      const _a = require('../services/projectBoundaryAnchor').anchorWithinBase(resolved, normalizedBase, path.sep, process.env);
      if (_a !== null) _withinBase = _a;
    } catch { /* fail-soft → legacy startsWith */ }
    if (!_withinBase) {
      // Outside the project CWD. Still allow the user's OWN data folders
      // (home / Desktop / Documents / Downloads), including drive-relocated
      // ones (OneDrive, Huawei PC Manager → D:\HuaweiMoveData\...). System
      // locations remain blocked. Set KHY_STRICT_WRITE_BOUNDARY=1 to opt out.
      const strict = String(process.env.KHY_STRICT_WRITE_BOUNDARY || '').trim() === '1';
      let trusted = false;
      if (!strict) {
        try { trusted = require('./_userDirs').isUnderTrustedRoot(resolved); } catch { trusted = false; }
      }
      if (!trusted) {
        return {
          valid: false,
          message:
            `Refused to write "${filePath}": the resolved path is outside the project ` +
            `directory (${normalizedBase}) and not under your home / Desktop / Documents / ` +
            `Downloads. Write to a path under one of those, or set KHY_WRITE_EXTRA_ROOTS to ` +
            `allow this location.`,
        };
      }
    }
  } catch {
    // Path resolution failed — likely invalid path
  }
  return { valid: true };
}

/**
 * Read-access policy — the READ mirror of validateNoPathTraversal.
 *
 * User requirement「全局可读，没有权限时向用户申请权限而不是直接失败」: reads default to
 * GLOBALLY ALLOWED. Out-of-project reads are NOT hard-failed at the tool layer —
 * the PreToolUse readBoundaryGuard owns the approve-on-demand prompt
 * (approvable:true) and remembers granted directories. Hard-failing here is exactly
 * the bug that made an already-approved read still return "Refused ... outside the
 * project directory" on Windows.
 *
 * Defense-in-depth opt-in: set KHY_STRICT_READ_BOUNDARY=1 to confine reads to the
 * project tree, trusted user roots (home/Desktop/Documents/Downloads), and
 * session-granted additional directories. Anything else becomes an *approvable*
 * denial so the caller can still escalate to a user prompt instead of dead-ending.
 *
 * This NEVER touches the sensitive-home WRITE denylist (that protection stays in
 * validateNoPathTraversal, unchanged) —「只增加拒绝，绝不放松既有保护」.
 *
 * @param {string} filePath
 * @param {string} [baseCwd]
 * @returns {{ valid: boolean, message?: string, approvable?: boolean }}
 */
function validateReadAccess(filePath, baseCwd) {
  const strict = String(process.env.KHY_STRICT_READ_BOUNDARY || '').trim() === '1';
  if (!strict) return { valid: true }; // 全局可读：默认放行，越界审批交给 readBoundaryGuard
  if (!baseCwd) baseCwd = process.env.KHYQUANT_CWD || process.cwd();
  try {
    const resolved = path.resolve(baseCwd, filePath);
    const normalizedBase = path.resolve(baseCwd);
    // 门控 KHY_PROJECT_BOUNDARY_ANCHOR(默认开):同写路径,锚定分隔符边界防兄弟目录名前缀绕过。
    let _within = resolved.startsWith(normalizedBase);
    try {
      const _a = require('../services/projectBoundaryAnchor').anchorWithinBase(resolved, normalizedBase, path.sep, process.env);
      if (_a !== null) _within = _a;
    } catch { /* fail-soft → legacy startsWith */ }
    if (_within) return { valid: true };
    let trusted = false;
    try { trusted = require('./_userDirs').isUnderTrustedRoot(resolved); } catch { trusted = false; }
    if (trusted) return { valid: true };
    let granted = false;
    try { granted = require('../services/additionalDirectories').isUnderAdditionalDir(resolved); } catch { granted = false; }
    if (granted) return { valid: true };
    return {
      valid: false,
      approvable: true, // 可升级为用户审批，而非直接失败
      message:
        `Read of "${filePath}" is outside the project directory (${normalizedBase}) and not ` +
        `under a trusted or granted location. KHY_STRICT_READ_BOUNDARY is on — approve this ` +
        `read to grant access, or unset the flag for global read.`,
    };
  } catch {
    return { valid: true }; // 解析失败：交给后续 stat 报真实错误，不在此误拦
  }
}

/**
 * Run multiple validators in sequence. Stops at the first failure.
 * @param {...{ valid: boolean, message?: string }} results
 * @returns {{ valid: boolean, message?: string }}
 */
function composeValidations(...results) {
  for (const r of results) {
    if (!r.valid) return r;
  }
  return { valid: true };
}

module.exports = {
  validateNotDevicePath,
  validateFileSize,
  validateNotNoop,
  validateNotUNCPath,
  validateNoPathTraversal,
  validateReadAccess,
  isSensitiveHomeWrite: _isSensitiveHomeWrite,
  composeValidations,
  MAX_READ_FILE_SIZE,
  MAX_EDIT_FILE_SIZE,
};
