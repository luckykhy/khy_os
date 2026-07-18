'use strict';

/**
 * uninstall/ledgerWriter.js — 安装台账的**唯一写入 IO 边界**(薄封装)。
 *
 * 纯计算(记什么/怎么归一)在 installLedger 叶子;本模块只负责把归一化后的记录
 * **追加**到用户数据家的 .install-ledger.jsonl。分层理由:副作用创建点(mdEditorRegister /
 * runtimeProvisioner 等)散落各处,它们只需 `require` 本模块调一个 appendSideEffect,
 * 无需各自重复解析数据家/拼路径/写盘。
 *
 * 契约:
 *   - 绝不抛、绝不影响调用方主流程(记台账失败 ≠ 注册/装运行时失败)。
 *   - 门控 KHY_INSTALL_LEDGER 关 → recordSideEffect 返回 null → 本模块直接 no-op(不写盘)。
 *   - append-only:只追加不改写,天然记录「实际发生的顺序」,供逆序回滚。
 */

const fs = require('fs');
const path = require('path');

/** 解析台账文件绝对路径(安装期允许 mkdir 数据家,因为此刻本就在往里写东西)。 */
function _resolveLedgerFile(env) {
  try {
    const { ledgerPath } = require('./installLedger');
    const src = env || process.env;
    // 数据家优先级与读取侧一致:KHY_DATA_HOME > getDataHome()(安装期会确保目录存在)> ~/.khy。
    let home = null;
    if (src && src.KHY_DATA_HOME) home = src.KHY_DATA_HOME;
    if (!home) { try { home = require('../../utils/dataHome').getDataHome(); } catch { /* fall through */ } }
    if (!home) home = path.join(require('os').homedir(), '.khy');
    return ledgerPath(home);
  } catch { return null; }
}

/**
 * 追加一条副作用记录到台账。fail-soft、绝不抛、门关自动 no-op。
 *
 * @param {object} entry  见 installLedger.recordSideEffect 的 entry 契约(kind/target/action/...)
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {number} [opts.ts] 时间戳(调用方注入;缺省用 Date.now,IO 层可用时钟)
 * @returns {boolean} 是否真的写入了一条(门关/失败 → false)
 */
function appendSideEffect(entry, opts = {}) {
  try {
    const env = (opts && opts.env) || process.env;
    const { recordSideEffect } = require('./installLedger');
    const withTs = { ...entry };
    if (withTs.ts == null) {
      const ts = typeof opts.ts === 'number' ? opts.ts : Date.now();
      withTs.ts = ts;
    }
    const rec = recordSideEffect(withTs, { env });
    if (!rec) return false; // 门关或非法 → 不写
    const file = _resolveLedgerFile(env);
    if (!file) return false;
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch { /* best-effort */ }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch {
    return false; // 记台账绝不拖累主流程
  }
}

module.exports = {
  appendSideEffect,
  _resolveLedgerFile,
};
