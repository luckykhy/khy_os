'use strict';

/**
 * uninstall/installLedger.js — 「安装台账」的纯核心叶子。
 *
 * 背景(承 goal「khy 写进宿主 exe/CLI 后怎么保证卸载干净」):
 *   khy 现有卸载是**允许清单(allowlist)**——`uninstallPlan` 硬编码「东西可能在哪」。
 *   这猜不到运行时才创建、且在包 manifest 之外的副作用(便携 Node、hydrate 的
 *   node_modules、autostart 注册、无 pidfile 的 detached 进程),于是卸载留残留。
 *   正解是**台账(ledger)**:在**创建副作用的当刻**追加记录「实际写了什么」,卸载时
 *   **逆序读台账回滚**。台账是真源,清单是兜底猜测。
 *
 * 本叶子只负责台账的**计算**(记什么 / 怎么逆序回滚),零 IO:
 *   - recordSideEffect(entry, opts)  → 归一化一条可序列化台账记录(不写盘)。
 *   - computeRollback(entries, opts) → 纯函数:逆序 + 去重 + 按 kind 排序,产出回滚步骤。
 *   真正的读写 jsonl / stat / 删除 / 撤注册,是 handler(shell 层)的职责——本叶子不碰盘。
 *   (ledgerPath 只做纯字符串拼接,不 mkdir、不 stat。)
 *
 * 密钥红线:meta 只保留白名单标量字段,且**任何疑似 key/token 形态一律丢弃**,
 *   真 key/token 永不落台账文件。
 *
 * 契约(与全仓纯叶子一致):
 *   - 核心零 IO(只读 env 门控 + path 纯拼接;不 stat / 不删 / 不网络 / 不子进程 / 不时钟 / 不随机)。
 *   - 确定性:同输入恒同输出(逆序/排序稳定)。
 *   - 绝不抛:任何异常路径返回安全值(record → null;rollback → 空步骤)。
 *   - 门控 KHY_INSTALL_LEDGER 默认开;关 → recordSideEffect 返回 null(不记)、
 *     computeRollback 返回空步骤(不回滚),调用方逐字节回退到 allowlist-only 行为。
 */

const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/** 台账记录格式版本(将来字段演进时用于兼容分支)。 */
const LEDGER_VERSION = 1;

/** 台账文件名(落在用户数据家,须比安装目录活得久)。 */
const LEDGER_FILENAME = '.install-ledger.jsonl';

/** 合法副作用类别。 */
const KIND = Object.freeze({
  FILE: 'file',
  DIR: 'dir',
  REGISTRATION: 'registration',
  PROCESS: 'process',
  RUNTIME: 'runtime',
});
const _VALID_KINDS = new Set(Object.values(KIND));

/**
 * 撤销动作白名单(记录「怎么撤」,回滚时 handler 据此分发到既有 unregister/删除逻辑)。
 * 未知 action 不拒收,但 computeRollback 会把它标进 skipped(handler 不认得就别乱执行)。
 */
const _KNOWN_ACTIONS = new Set([
  'unlink',              // 删单文件
  'rmdir',               // 删目录树
  'unregister-autostart', // 撤开机自启(disable_autostart 兜底,幂等)
  'unregister-md-editor', // 撤 md 编辑器文件关联(既有 unregister 脚本)
  'stop-process',        // 停常驻进程(khy stop SSOT 已统一停,这里仅留证)
  'remove-runtime',      // 删运行时创建物(便携 Node / hydrate 的 node_modules)
]);

/** registration/process 必须先于 file/dir 回滚(先撤注册停进程,再删文件避免锁)。 */
const _KIND_ORDER = { registration: 0, process: 1, runtime: 2, dir: 3, file: 4 };

/** meta 允许保留的标量字段(白名单;其余一律丢弃,杜绝密钥/大对象混入)。 */
const _META_ALLOW = new Set(['scope', 'platform', 'package', 'label', 'reason']);

/**
 * 疑似密钥/令牌形态(命中即从 meta 丢弃对应值,真 key 永不落台账)。
 * 无 g 标志(防 lastIndex 粘连);保守偏「宁可丢弃」。
 */
const _SECRETY_RE = /(?:sk-|bearer\s|token|secret|api[_-]?key|password|passwd|[A-Za-z0-9_-]{32,})/i;

/**
 * 门控 KHY_INSTALL_LEDGER 是否启用。flagRegistry 优先(集中真源),失败再退本地 CANON。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isLedgerEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_INSTALL_LEDGER', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_INSTALL_LEDGER;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

/**
 * 台账文件绝对路径(纯字符串拼接,不 mkdir、不 stat)。
 * @param {string} dataHome 用户数据家目录(如 ~/.khy)
 * @returns {string|null} 拼好的路径;dataHome 非法 → null
 */
function ledgerPath(dataHome) {
  if (!dataHome || typeof dataHome !== 'string') return null;
  try { return path.join(path.resolve(dataHome), LEDGER_FILENAME); } catch { return null; }
}

/** 稳定化路径:非法 → null;否则 path.resolve(不触盘)。 */
function _norm(p) {
  if (!p || typeof p !== 'string') return null;
  try { return path.resolve(p); } catch { return null; }
}

/** 清洗 meta:仅保留白名单标量,且丢弃疑似密钥值。绝不抛。 */
function _sanitizeMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const k of _META_ALLOW) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const s = String(v);
    if (_SECRETY_RE.test(s)) continue; // 疑似密钥 → 丢弃,真 key 永不落台账
    out[k] = v;
  }
  return out;
}

/**
 * 归一化一条台账记录(纯计算,不写盘)。门关 → null(不记录)。
 *
 * @param {object} entry
 * @param {string} entry.kind    KIND 之一(file/dir/registration/process/runtime)
 * @param {string} entry.target  被创建物的绝对路径 / 进程标识 / 注册标识
 * @param {string} entry.action  撤销动作(见 _KNOWN_ACTIONS)
 * @param {string} [entry.checksum] 文件内容校验和(回滚时只删匹配的,留住用户改动)
 * @param {object} [entry.meta]  附加标量元数据(白名单 + 去密钥后保留)
 * @param {number} [entry.ts]    创建时间戳(调用方注入;叶子不读时钟)
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {object|null} 可 JSON 序列化的记录;门关或非法入参 → null
 */
function recordSideEffect(entry, opts = {}) {
  try {
    if (!isLedgerEnabled(opts && opts.env)) return null;
    if (!entry || typeof entry !== 'object') return null;
    const kind = String(entry.kind || '').trim();
    if (!_VALID_KINDS.has(kind)) return null;
    const target = (kind === KIND.FILE || kind === KIND.DIR || kind === KIND.RUNTIME)
      ? _norm(entry.target)
      : (entry.target && typeof entry.target === 'string' ? entry.target.trim() : null);
    if (!target) return null;
    const action = String(entry.action || '').trim();
    if (!action) return null;

    const rec = {
      v: LEDGER_VERSION,
      kind,
      target,
      action,
    };
    if (entry.checksum && typeof entry.checksum === 'string') rec.checksum = entry.checksum.trim();
    if (typeof entry.ts === 'number' && Number.isFinite(entry.ts)) rec.ts = entry.ts;
    const meta = _sanitizeMeta(entry.meta);
    if (Object.keys(meta).length) rec.meta = meta;
    return rec;
  } catch {
    return null;
  }
}

/**
 * 计算回滚步骤(纯函数):逆序(后创建先撤)+ 去重(按 target,保留最后一次记录)+
 * 按 kind 排序(registration/process 先于 dir/file,先撤注册停进程再删文件避免锁)。
 * 存在性 / 校验和匹配 / 真正删除,均由 handler 执行——本函数不触盘。
 *
 * @param {Array<object>} entries 台账记录(读盘解析后的对象数组;非法项自动跳过)
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {{steps: Array<object>, skipped: Array<object>}}
 *   steps   已排序的可执行回滚步骤(门关 → 空)
 *   skipped 被跳过的记录(未知 action / 非法),供 handler 报告,不静默吞
 */
function computeRollback(entries, opts = {}) {
  const empty = { steps: [], skipped: [] };
  try {
    if (!isLedgerEnabled(opts && opts.env)) return empty;
    if (!Array.isArray(entries)) return empty;

    // 逆序遍历:后创建者先出现;按 target 去重只留最后一次(即遍历中首次遇到)。
    const seen = new Set();
    const picked = [];
    const skipped = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (!e || typeof e !== 'object') { skipped.push({ reason: 'invalid', raw: e }); continue; }
      const kind = String(e.kind || '').trim();
      const target = typeof e.target === 'string' ? e.target : '';
      const action = String(e.action || '').trim();
      if (!_VALID_KINDS.has(kind) || !target || !action) {
        skipped.push({ reason: 'malformed', raw: e });
        continue;
      }
      if (seen.has(target)) continue; // 同一 target 只回滚一次(最后一次记录已先命中)
      seen.add(target);
      if (!_KNOWN_ACTIONS.has(action)) {
        skipped.push({ reason: 'unknown-action', kind, target, action });
        continue;
      }
      picked.push({
        kind,
        target,
        action,
        ...(e.checksum && typeof e.checksum === 'string' ? { checksum: e.checksum } : {}),
      });
    }

    // 稳定排序:先按 kind 优先级,同级保持逆序遍历得到的相对次序。
    const decorated = picked.map((s, idx) => ({ s, idx }));
    decorated.sort((a, b) => {
      const ka = _KIND_ORDER[a.s.kind] ?? 99;
      const kb = _KIND_ORDER[b.s.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      return a.idx - b.idx;
    });
    return { steps: decorated.map((d) => d.s), skipped };
  } catch {
    return empty;
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeInstallLedger() {
  return {
    gate: 'KHY_INSTALL_LEDGER',
    defaultOn: true,
    filename: LEDGER_FILENAME,
    kinds: Object.values(KIND),
    actions: Array.from(_KNOWN_ACTIONS),
    summary: '在副作用创建当刻记「实际写了什么」到用户数据家的 .install-ledger.jsonl;卸载时逆序读账'
      + '回滚(撤注册/停进程先于删文件),是 allowlist 之外的兜底真源。真 key 永不落台账。'
      + '门控关 → 不记不滚,逐字节回退 allowlist-only 卸载。',
  };
}

module.exports = {
  isLedgerEnabled,
  ledgerPath,
  recordSideEffect,
  computeRollback,
  describeInstallLedger,
  LEDGER_VERSION,
  LEDGER_FILENAME,
  KIND,
};
