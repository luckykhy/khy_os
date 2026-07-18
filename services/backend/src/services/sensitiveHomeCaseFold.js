'use strict';

/**
 * sensitiveHomeCaseFold.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 tools/inputValidators._isSensitiveHomeWrite 的「敏感 home 写入 denylist 大小写敏感」缺陷:
 * 该 denylist(`.ssh/`、`.bashrc`、`Library/LaunchAgents/` …)封堵「Agent/注入指令写 `~/.ssh/
 * authorized_keys`(远程 root)、shell rc(下次登录代码执行)、LaunchAgents(开机持久化)」等提权
 * 向量,但匹配只做**分隔符归一**、**从不折叠大小写**,而 denylist 全小写(+ 少数混合大小写)。
 * 于是在**大小写不敏感文件系统**(macOS APFS/HFS+ 默认、Windows)上,翻转一个字母即绕过:
 *   `~/.SSH/authorized_keys` / `~/.Ssh/…` / `~/.BASHRC` / `~/Library/launchagents/evil.plist`
 *   → `.SSH/authorized_keys`.startsWith('.ssh/') === false → 判「非敏感」→ 放行 → sshd 仍按
 *     `~/.ssh/authorized_keys` 同一文件读到(全提权)。tool 自校验(inputValidators:144)与 PreToolUse
 *     editBoundaryGuard(toolGuards:76)调**同一** isSensitiveHomeWrite,两道防线一并失守,无下游兜底。
 *
 * 正确语义:敏感路径匹配应**折叠大小写**(至少在大小写不敏感 FS 上,且封锁写入是 fail-closed 安全
 * 方向,过度封锁一个 Linux 上罕见的 `~/.SSH` 写入可由既有 opt-out KHY_ALLOW_SENSITIVE_HOME_WRITE=1
 * 放行)。本叶子提供「用于敏感匹配的折叠形 rel」;调用方保留 legacy 精确大小写匹配(先跑=byte-revert
 * 基准),再用折叠形对**小写化 denylist** 补一次匹配 → 严格超集(只多封锁,绝不少封锁)。
 *
 * 门控 KHY_SENSITIVE_HOME_CASEFOLD(默认开):关(0/false/off/no)/异常/非字符串 → 返回 null,
 * 调用方跳过补充匹配 → 逐字节回退 legacy 精确大小写行为。flagRegistry 优先,失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_SENSITIVE_HOME_CASEFOLD:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function sensitiveHomeCaseFoldEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_SENSITIVE_HOME_CASEFOLD', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_SENSITIVE_HOME_CASEFOLD;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 返回用于敏感 home 匹配的**大小写折叠形** rel(小写)。
 *   - 门关 / 异常 / 非字符串 → null(调用方跳过补充匹配,逐字节回退 legacy 精确大小写);
 *   - 门开 → `rel.toLowerCase()`(调用方据此对小写化 denylist 再匹配一次)。
 * @param {string} rel  分隔符已归一为 `/` 的 home 相对路径
 * @param {Record<string,string>} [env]
 * @returns {string|null}
 */
function foldSensitiveRel(rel, env = process.env) {
  try {
    if (!sensitiveHomeCaseFoldEnabled(env)) return null;
    if (typeof rel !== 'string') return null;
    return rel.toLowerCase();
  } catch {
    return null;
  }
}

module.exports = {
  sensitiveHomeCaseFoldEnabled,
  foldSensitiveRel,
};
