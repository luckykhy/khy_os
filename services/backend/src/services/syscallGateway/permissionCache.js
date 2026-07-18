'use strict';

/**
 * permissionCache.js — 会话级权限缓存（**仅内存，绝不落盘**）。
 *
 * 两件事，一个铁律：
 *   ① PreApprovalManifest（宏观意图预审批清单）：模型在元规划阶段一次性申报它预计要用的
 *      L1 权限范围；用户一次性批准后，清单内的同类动作自动放行，不再逐次打断——防体验断裂。
 *   ② SessionGrants（L1 会话免审）：用户在某次 L1 询问时勾选「本会话内同类免审」，
 *      之后同 (动作+作用域) 的 L1 调用自动放行。
 *
 * 铁律（防呆②）：两者都 **只活在内存**，绝不写盘。进程一退，授权清零；khy-os 重启即归零。
 *
 * **L2 会话免审——用户知情决定，经门控可逆**：历史不变量为「L2 永远不可被会话免审（红灯无
 * 快捷键）」。现按用户知情选择，新增**独立**的 L2 会话免审通道（`_l2Grants`），与 L1 的 `_grants`
 * 物理隔离，且整条受 env 门控 `KHY_L2_SESSION_ALLOW`（默认开，`0/false/off/no` 关）管控：
 *   - 门控开 → 用户在某次 L2 高危询问时选「本会话内总是允许此类」，之后同 (动作+作用域) 的 L2
 *     自动放行，本会话内不再逐次打断；
 *   - 门控关 → `grantL2SessionExempt` no-op、`hasL2SessionExempt` 恒 false，**逐字节恢复**红线铁律。
 * 仍只活内存、绝不写盘、重启清零。L1 的 `grantSessionExempt` 维持「非 L1 硬拒」语义不变。
 * 预审批清单（submitManifest）仍**绝不接纳 L2**（清单是批量预授权，语义比逐次确认更危险）。
 *
 * 「同类」的归一键 = `${level}:${action}:${scope}`。范围比对刻意粗到「类」而非「具体资源」，
 * 这样「允许写项目内文件」覆盖项目内所有写，但不会溢出到家目录或系统级。
 */

const { LEVELS, isExemptible } = require('./resourceClassifier');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** L2 会话免审是否启用（纯函数，门控默认开；仅 0/false/off/no 关闭即恢复红线铁律）。 */
function isL2SessionAllowEnabled(env = process.env) {
  const raw = env && env.KHY_L2_SESSION_ALLOW;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

function _key(intent, level) {
  return `${level}:${intent.action}:${intent.scope}`;
}

class PermissionCache {
  constructor() {
    this._manifest = new Set();   // 预审批清单的归一键集合
    this._grants = new Set();     // L1 会话免审的归一键集合
    this._l2Grants = new Set();   // L2 会话免审的归一键集合（门控 KHY_L2_SESSION_ALLOW，与 _grants 物理隔离）
    this._manifestRaw = [];       // 原始清单条目（仅供展示/审计）
  }

  /**
   * 提交宏观预审批清单。items: [{action, scope}]，level 由 intentSchema 语义推导，
   * 但 **任何 L2 条目被静默拒收**——清单不能批红灯。返回被接纳的条目数。
   */
  submitManifest(items, classifier) {
    const accepted = [];
    for (const it of items || []) {
      // 用真实分级器评估，杜绝调用方伪造 level 把红灯塞进清单。
      const level = (classifier ? classifier({ action: it.action, scope: it.scope, risk: it.risk, isReadOnly: it.isReadOnly, isDestructive: it.isDestructive }).level : it.level);
      if (!isExemptible(level)) continue; // L2 拒收
      const k = `${level}:${it.action}:${it.scope}`;
      this._manifest.add(k);
      accepted.push({ ...it, level });
    }
    this._manifestRaw = accepted;
    return accepted.length;
  }

  /** 意图是否落在已批准的预审批清单内。L2 永远返回 false。 */
  inManifest(intent, level) {
    if (!isExemptible(level)) return false;
    return this._manifest.has(_key(intent, level));
  }

  /** 记录一次 L1 会话免审授权。L2 调用是 no-op（红灯不可免审）。 */
  grantSessionExempt(intent, level) {
    if (level !== LEVELS.L1) return false; // 只有 L1 可免审；L0 本就自动放行，L2 严禁
    this._grants.add(_key(intent, level));
    return true;
  }

  /** 该意图是否已获 L1 会话免审。 */
  hasSessionExempt(intent, level) {
    if (level !== LEVELS.L1) return false;
    return this._grants.has(_key(intent, level));
  }

  /**
   * 记录一次 L2 会话免审授权（用户知情决定）。门控关 → no-op 返回 false（红线铁律生效）。
   * 与 L1 通道物理隔离，归一键固定带 L2 前缀，绝不溢出到 L1/清单。
   */
  grantL2SessionExempt(intent) {
    if (!isL2SessionAllowEnabled()) return false; // 门控关：恢复「L2 不可会话免审」红线
    this._l2Grants.add(_key(intent, LEVELS.L2));
    return true;
  }

  /** 该意图是否已获 L2 会话免审。门控关 → 恒 false（逐字节恢复红线铁律）。 */
  hasL2SessionExempt(intent) {
    if (!isL2SessionAllowEnabled()) return false;
    return this._l2Grants.has(_key(intent, LEVELS.L2));
  }

  /** 当前清单快照（展示/审计用，不可变副本）。 */
  describeManifest() {
    return this._manifestRaw.map((x) => ({ ...x }));
  }

  /** 清空——会话结束/重置时调用。无落盘故无需清磁盘。 */
  clear() {
    this._manifest.clear();
    this._grants.clear();
    this._l2Grants.clear();
    this._manifestRaw = [];
  }
}

module.exports = { PermissionCache, isL2SessionAllowEnabled };
