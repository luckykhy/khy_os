'use strict';

/**
 * backupManifest.js — 备份集清单的组装与校验(纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * manifest.json 是备份集的**自描述契约**:恢复端只信 manifest,不靠猜目录结构。它回答
 * 四个问题——这份备份是什么时候、在什么环境、从哪几个数据家目录、按什么分级取的;里面
 * 每个文件的字节数与 sha256 是多少(用于 verify);**以及哪些资产被刻意排除、为什么**。
 * 最后一条尤其重要:一份看起来「成功」的备份如果悄悄漏了主库,用户要到恢复那一刻才知道。
 * 把排除项连同理由写进 manifest,漏备就变成**可读的事实**而不是沉默。
 *
 * `.complete` 标记与 manifest 分开存在,是刻意的:manifest 先写(它要先算完所有 sha256),
 * `.complete` 最后写。没有 `.complete` 的目录 = 写到一半崩了,`list` 标 BROKEN、`restore`
 * 直接拒绝。单靠 manifest 存在无法区分「写完了」和「manifest 写完但文件还在拷」。
 *
 * 契约:零 IO(不碰 fs,只做对象/字符串运算)、确定性、绝不抛;坏输入 → 结构化 errors,
 * 而不是异常。哈希计算与文件读取在 backupService 侧(IO 归 IO)。
 *
 * @module services/backup/backupManifest
 */

// 'cold-export' 是**追加**的 kind,不是替换:旧 manifest 里没有它,读旧备份的代码
// 走的是既有三条分支,一条都没动。恢复端按 kind 分派,遇到不认识的 kind 会跳过并
// 留痕(见 restoreService 的 --kinds 过滤),所以老版本读新备份集也不会崩,
// 只是恢复不出冷数据 —— 这正是可接受的降级方向。
const ENTRY_KINDS = Object.freeze(['sqlite', 'pgdump', 'file', 'cold-export']);

/** 备份集 id:`<紧凑 UTC 时间戳>-<随机后缀>`,按字典序排序即等于按时间排序。 */
const ID_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{6,})$/;

/**
 * 由一个 ISO 时间串与随机后缀拼出备份集 id。时间与随机源由调用方注入,保持本模块确定性。
 * @param {string} isoString 形如 2026-08-16T07:46:00.000Z
 * @param {string} suffix 小写十六进制,至少 6 位
 * @returns {string|null} 非法输入返回 null(绝不抛)
 */
function makeBackupId(isoString, suffix) {
  try {
    const compact = String(isoString || '').replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const sfx = String(suffix || '').toLowerCase();
    const id = `${compact}-${sfx}`;
    return ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * 从备份集 id 解析出 UTC 时间(毫秒)。用于保留策略的天数判定 —— 不依赖文件 mtime,
 * 因为拷贝/搬迁会改 mtime,而 id 里的时间戳是备份**创建**时刻的事实。
 * @param {string} id
 * @returns {{ok: boolean, timeMs: number, suffix: string}}
 */
function parseBackupId(id) {
  const out = { ok: false, timeMs: 0, suffix: '' };
  try {
    const m = ID_RE.exec(String(id || ''));
    if (!m) {
      return out;
    }
    const s = m[1];
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) {
      return out;
    }
    out.ok = true;
    out.timeMs = t;
    out.suffix = m[2];
    return out;
  } catch {
    return out;
  }
}

/**
 * 构造一条 entry。
 * @param {object} spec
 * @param {string} spec.kind 'sqlite' | 'pgdump' | 'file'
 * @param {string} spec.home 数据家目录角色('user'|'project'|'app'),pgdump 用 ''
 * @param {string} spec.source 源绝对路径
 * @param {string} spec.target 备份集内的相对路径(POSIX 分隔符)
 * @param {number} spec.bytes
 * @param {string} spec.sha256
 * @param {string} [spec.journalMode] 仅 sqlite
 * @returns {object}
 */
function makeEntry(spec = {}) {
  const e = {
    kind: ENTRY_KINDS.includes(spec.kind) ? spec.kind : 'file',
    home: String(spec.home == null ? '' : spec.home),
    source: String(spec.source == null ? '' : spec.source),
    target: String(spec.target == null ? '' : spec.target).split('\\').join('/'),
    bytes: Number.isFinite(Number(spec.bytes)) ? Number(spec.bytes) : 0,
    sha256: String(spec.sha256 == null ? '' : spec.sha256).toLowerCase(),
  };
  if (spec.journalMode) {
    e.journalMode = String(spec.journalMode);
  }
  if (e.kind === 'cold-export') {
    // 这四个字段只对冷归档有意义,所以只在该 kind 上出现,不给其它 entry 添噪。
    // records 尤其重要:一份 0 记录的归档不该存在(exportColdDir 不产它),
    // 但如果哪天真的出现了,manifest 要能让 verify 一眼看出来。
    e.compression = String(spec.compression || 'gzip');
    e.records = Number.isFinite(Number(spec.records)) ? Number(spec.records) : 0;
    e.sourceFiles = Number.isFinite(Number(spec.sourceFiles)) ? Number(spec.sourceFiles) : 0;
    e.window = spec.window && typeof spec.window === 'object' ? { ...spec.window } : {};
  }
  return e;
}

/**
 * 组装 manifest 对象。
 * @param {object} spec
 * @returns {object}
 */
function buildManifest(spec = {}) {
  return {
    schemaVersion: Number.isFinite(Number(spec.schemaVersion)) ? Number(spec.schemaVersion) : 1,
    id: String(spec.id == null ? '' : spec.id),
    createdAt: String(spec.createdAt == null ? '' : spec.createdAt),
    tier: String(spec.tier == null ? '' : spec.tier),
    note: String(spec.note == null ? '' : spec.note),
    khyVersion: String(spec.khyVersion == null ? '' : spec.khyVersion),
    platform: String(spec.platform == null ? '' : spec.platform),
    nodeVersion: String(spec.nodeVersion == null ? '' : spec.nodeVersion),
    sqliteDriver: String(spec.sqliteDriver == null ? '' : spec.sqliteDriver),
    dbMode: String(spec.dbMode == null ? '' : spec.dbMode),
    dataHomes: spec.dataHomes && typeof spec.dataHomes === 'object' ? { ...spec.dataHomes } : {},
    entries: Array.isArray(spec.entries) ? spec.entries.slice() : [],
    excluded: Array.isArray(spec.excluded) ? spec.excluded.slice() : [],
    // 备份集含 khy-quant.db 的 api_keys/auth_sessions 表与各通道 token,按表裁剪会破坏
    // 引用完整性故不裁 —— 用这个标记 + 0700/0600 权限如实告知,而不是假装里面没有机密。
    containsSecrets: spec.containsSecrets !== false,
    restoreHints: Array.isArray(spec.restoreHints) ? spec.restoreHints.slice() : [],
    totalBytes: (Array.isArray(spec.entries) ? spec.entries : []).reduce(
      (sum, e) => sum + (Number.isFinite(Number(e && e.bytes)) ? Number(e.bytes) : 0),
      0
    ),
  };
}

/**
 * 校验一个从磁盘读回来的 manifest 是否结构可用。
 * @param {*} obj
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateManifest(obj) {
  const errors = [];
  try {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: ['manifest 不是对象'] };
    }
    if (!Number.isFinite(Number(obj.schemaVersion)) || Number(obj.schemaVersion) < 1) {
      errors.push('schemaVersion 缺失或非法');
    }
    if (!parseBackupId(obj.id).ok) {
      errors.push(`id 非法: ${String(obj.id)}`);
    }
    if (!obj.createdAt || !Number.isFinite(Date.parse(String(obj.createdAt)))) {
      errors.push('createdAt 缺失或非法');
    }
    if (!Array.isArray(obj.entries)) {
      errors.push('entries 不是数组');
    } else {
      if (obj.entries.length === 0) {
        errors.push('entries 为空 —— 一份不含任何资产的备份没有恢复价值');
      }
      obj.entries.forEach((e, i) => {
        if (!e || typeof e !== 'object') {
          errors.push(`entries[${i}] 不是对象`);
          return;
        }
        if (!ENTRY_KINDS.includes(e.kind)) {
          errors.push(`entries[${i}].kind 非法: ${String(e.kind)}`);
        }
        if (!e.target) {
          errors.push(`entries[${i}].target 缺失`);
        }
        if (!/^[0-9a-f]{64}$/.test(String(e.sha256 || ''))) {
          errors.push(`entries[${i}].sha256 非法(必须是 64 位小写十六进制)`);
        }
        if (!Number.isFinite(Number(e.bytes)) || Number(e.bytes) < 0) {
          errors.push(`entries[${i}].bytes 非法`);
        }
        if (e.kind === 'cold-export') {
          // 空归档是**契约违反**而不是空数据:导出器在 records===0 时根本不写文件,
          // 所以 manifest 里出现一条 records=0 的 cold-export,只可能是记账错了。
          // 放行它等于让 verify 通过一份恢复不出任何东西的归档。
          if (!Number.isFinite(Number(e.records)) || Number(e.records) <= 0) {
            errors.push(`entries[${i}].records 非法(冷归档必须至少含 1 条记录)`);
          }
          if (Number(e.bytes) <= 0) {
            errors.push(`entries[${i}].bytes 为 0(冷归档不应为空文件)`);
          }
        }
      });
    }
    if (!Array.isArray(obj.excluded)) {
      errors.push('excluded 不是数组');
    }
    if (!obj.dataHomes || typeof obj.dataHomes !== 'object') {
      errors.push('dataHomes 缺失');
    }
    return { ok: errors.length === 0, errors };
  } catch (err) {
    return { ok: false, errors: [String((err && err.message) || err || '校验异常')] };
  }
}

/**
 * 保留策略求解:哪些备份集该删。
 *
 * 语义(明确定义,免歧义):一份被删,当且仅当**同时**满足「按时间倒序排在 keepCount 之外」
 * **且**「早于 keepDays」。最新一份**永不删除**。缺 `.complete` 的残破备份不受这两条保护,
 * 优先清理 —— 它本来就不可用,占着配额只会把可用的备份挤掉。
 *
 * @param {Array<{id: string, complete: boolean}>} sets
 * @param {object} policy
 * @param {number} policy.keepCount
 * @param {number} policy.keepDays
 * @param {number} policy.nowMs 当前时间(注入,保持确定性)
 * @returns {{keep: string[], drop: Array<{id: string, reason: string}>}}
 */
function planRetention(sets, policy = {}) {
  const keep = [];
  const drop = [];
  try {
    const keepCount = Number.isFinite(Number(policy.keepCount)) ? Number(policy.keepCount) : 10;
    const keepDays = Number.isFinite(Number(policy.keepDays)) ? Number(policy.keepDays) : 30;
    const nowMs = Number.isFinite(Number(policy.nowMs)) ? Number(policy.nowMs) : 0;
    const maxAgeMs = keepDays * 24 * 60 * 60 * 1000;

    const rows = (Array.isArray(sets) ? sets : [])
      .map((s) => ({
        id: String((s && s.id) || ''),
        complete: !!(s && s.complete),
        timeMs: parseBackupId(s && s.id).timeMs,
      }))
      .filter((r) => r.id)
      .sort((a, b) => b.timeMs - a.timeMs || (a.id < b.id ? 1 : -1));

    const completeRows = rows.filter((r) => r.complete);
    const newestCompleteId = completeRows.length ? completeRows[0].id : '';

    let completeRank = 0;
    for (const r of rows) {
      if (!r.complete) {
        drop.push({ id: r.id, reason: '缺少 .complete 标记(写入未完成,不可用)' });
        continue;
      }
      // 最新一份永不删除:哪怕它同时超份数又超天数,删掉它等于让用户裸奔。
      if (r.id === newestCompleteId) {
        keep.push(r.id);
        completeRank++;
        continue;
      }
      const overCount = completeRank >= keepCount;
      const tooOld = maxAgeMs > 0 && nowMs > 0 && nowMs - r.timeMs > maxAgeMs;
      if (overCount && tooOld) {
        drop.push({
          id: r.id,
          reason: `超出保留份数(第 ${completeRank + 1} 份 > ${keepCount})且早于 ${keepDays} 天`,
        });
      } else {
        keep.push(r.id);
      }
      completeRank++;
    }
    return { keep, drop };
  } catch {
    // 求解异常 → 一份都不删(保留策略出错时,倾向于留着而不是误删备份)。
    return { keep: (Array.isArray(sets) ? sets : []).map((s) => String((s && s.id) || '')), drop: [] };
  }
}

module.exports = {
  ENTRY_KINDS,
  ID_RE,
  makeBackupId,
  parseBackupId,
  makeEntry,
  buildManifest,
  validateManifest,
  planRetention,
};
